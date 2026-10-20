import { type FormEvent, useEffect, useState } from 'react'

import { api, type SandboxInfo } from '../api.ts'
import { useSession } from '../App.tsx'
import { TopBar } from '../TopBar.tsx'
import { errorMessage, Field, formatDuration, Spinner, StatusBadge, useToast } from '../ui.tsx'

const KIND_LABEL = { bundle: '插件', mcp: 'MCP', patch: '配置' } as const

export function PortalPage() {
  const { me, refresh } = useSession()
  const [sandbox, setSandbox] = useState<SandboxInfo | null>(me?.sandbox ?? null)
  const [toast, showToast] = useToast()

  // Opening the portal starts the sandbox, so "进入" is usually instant.
  useEffect(() => {
    api.startSandbox().then(setSandbox, (err) => showToast(errorMessage(err)))
  }, [showToast])

  useEffect(() => {
    if (sandbox?.status !== 'starting') return
    const timer = window.setInterval(() => {
      api.sandbox().then(setSandbox, () => undefined)
    }, 1500)
    return () => window.clearInterval(timer)
  }, [sandbox?.status])

  if (!me) return null
  const status = sandbox?.status ?? 'stopped'

  async function release() {
    try {
      setSandbox(await api.releaseSandbox())
      showToast('已保存数据并释放云电脑')
    } catch (err) {
      showToast(errorMessage(err))
    }
  }

  async function start() {
    try {
      setSandbox(await api.startSandbox())
    } catch (err) {
      showToast(errorMessage(err))
    }
  }

  const quota = me.quota
  const used = quota.daily_request_limit ? Math.min(1, quota.requests_today / quota.daily_request_limit) : 0

  return (
    <>
      <TopBar />
      <main className="portal stack">
        <div>
          <h1>你好，{me.display_name || me.username}</h1>
          <div className="muted">
            用户组 {me.group_name} · 你的会话、文件、记忆和自己安装的插件都会保存，下次登录自动恢复。
          </div>
        </div>

        <section className="card hero">
          <div>
            <div className="row">
              <h3 style={{ margin: 0 }}>我的云电脑</h3>
              <StatusBadge status={status} />
            </div>
            <div className="hero-meta">
              {status === 'running' ? (
                <>
                  <span>已运行 {formatDuration(sandbox?.uptime_s)}</span>
                  <span>空闲 {formatDuration(sandbox?.idle_s)}</span>
                  <span>连接 {sandbox?.connections ?? 0} 个</span>
                  <span>空闲 {formatDuration(sandbox?.idle_timeout_s)} 后自动保存并释放</span>
                </>
              ) : status === 'starting' ? (
                <span>正在准备环境并恢复你的数据，通常几秒钟。</span>
              ) : status === 'failed' ? (
                <span className="error-text">{sandbox?.error}</span>
              ) : (
                <span>云电脑已释放，数据已保存。</span>
              )}
            </div>
          </div>
          <div className="row">
            {status === 'running' ? (
              <button className="btn outline" onClick={release}>
                保存并释放
              </button>
            ) : null}
            {status === 'stopped' || status === 'failed' ? (
              <button className="btn outline" onClick={start}>
                {status === 'failed' ? '重试启动' : '启动'}
              </button>
            ) : null}
            <a
              className="btn brand"
              href={`/u/${me.username}/`}
              style={{ height: 40, padding: '0 20px' }}
            >
              {status === 'starting' ? <Spinner /> : null}
              进入 DeepSeek Harness
            </a>
          </div>
        </section>

        <div className="grid-2">
          <ApiKeyCard onChange={refresh} showToast={showToast} />
          <section className="card">
            <h3>今日用量</h3>
            <p className="sub">通过网关的模型请求次数</p>
            <div className="row between" style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 22, fontWeight: 500 }}>{quota.requests_today}</span>
              <span className="muted">
                {quota.daily_request_limit ? `上限 ${quota.daily_request_limit} 次 / 天` : '不限次数'}
              </span>
            </div>
            {quota.daily_request_limit ? (
              <div className="meter">
                <div style={{ width: `${used * 100}%` }} />
              </div>
            ) : null}
          </section>
        </div>

        <section className="card">
          <h3>管理员为你分配的插件</h3>
          <p className="sub">
            首次启动时在后台安装，装好后自动出现在 dsh 的插件页（安装期间 dsh 暂时无法保存插件和设置的修改）。之后你可以自由增删，你的改动会保留。
          </p>
          {me.plugins.length ? (
            <div className="chip-list">
              {me.plugins.map((p) => (
                <span key={p.name} className="chip" title={p.description}>
                  <b style={{ fontWeight: 500 }}>{KIND_LABEL[p.kind]}</b> {p.name}
                </span>
              ))}
            </div>
          ) : (
            <div className="muted">暂无</div>
          )}
        </section>

        <PasswordCard showToast={showToast} />
      </main>
      {toast}
    </>
  )
}

function ApiKeyCard({ onChange, showToast }: { onChange: () => Promise<unknown>; showToast: (m: string) => void }) {
  const { me } = useSession()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  if (!me) return null

  async function save(event: FormEvent) {
    event.preventDefault()
    try {
      await api.setApiKey(value)
      setValue('')
      setEditing(false)
      await onChange()
      showToast('API Key 已保存，下一次模型请求生效')
    } catch (err) {
      showToast(errorMessage(err))
    }
  }

  async function clear() {
    await api.clearApiKey()
    await onChange()
    showToast('已删除你的 API Key')
  }

  return (
    <section className="card">
      <h3>模型 API Key</h3>
      <p className="sub">加密保存在网关，不会进入云电脑。</p>
      {me.api_key_hint ? (
        <div className="row between">
          <span>
            使用你自己的 Key <span className="mono">{me.api_key_hint}</span>
          </span>
          <div className="row">
            <button className="btn ghost sm" onClick={() => setEditing(true)}>
              更换
            </button>
            <button className="btn danger sm" onClick={clear}>
              删除
            </button>
          </div>
        </div>
      ) : (
        <div className="row between">
          <span className={me.shared_key_available ? 'muted' : 'error-text'}>
            {me.shared_key_available ? '正在使用团队共享 Key' : '未设置 Key，模型暂不可用'}
          </span>
          <button className="btn outline sm" onClick={() => setEditing(true)}>
            设置我的 Key
          </button>
        </div>
      )}
      {editing ? (
        <form className="row" style={{ marginTop: 12 }} onSubmit={save}>
          <input
            className="input"
            type="password"
            placeholder="sk-..."
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
          <button className="btn primary" disabled={value.length < 8}>
            保存
          </button>
          <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
            取消
          </button>
        </form>
      ) : null}
    </section>
  )
}

function PasswordCard({ showToast }: { showToast: (m: string) => void }) {
  const [oldPassword, setOld] = useState('')
  const [newPassword, setNew] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      await api.changePassword(oldPassword, newPassword)
      setOld('')
      setNew('')
      showToast('密码已修改')
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <section className="card">
      <h3>修改密码</h3>
      <form className="form-grid" onSubmit={submit} style={{ marginTop: 10 }}>
        <Field label="原密码">
          <input className="input" type="password" value={oldPassword} onChange={(e) => setOld(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label="新密码" hint="至少 8 位">
          <input className="input" type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" />
        </Field>
        {error ? <div className="error-text wide">{error}</div> : null}
        <div className="wide">
          <button className="btn outline" disabled={!oldPassword || newPassword.length < 8}>
            修改密码
          </button>
        </div>
      </form>
    </section>
  )
}
