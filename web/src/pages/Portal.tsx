import { type FormEvent, useState } from 'react'

import { api, type SandboxInfo } from '../api.ts'
import { useSession } from '../App.tsx'
import { ProgressBar } from '../ExitDialog.tsx'
import { useSandbox } from '../sandbox.ts'
import { TopBar } from '../TopBar.tsx'
import { errorMessage, Field, formatDuration, StatusBadge, useToast } from '../ui.tsx'

const KIND_LABEL = { bundle: '插件', mcp: 'MCP', patch: '配置' } as const

export function PortalPage() {
  const { me, refresh } = useSession()
  const [toast, showToast] = useToast()

  if (!me) return null
  const quota = me.quota
  const used = quota.daily_request_limit ? Math.min(1, quota.requests_today / quota.daily_request_limit) : 0

  return (
    <>
      <TopBar />
      <main className="portal stack">
        <div>
          <h1>你好，{me.display_name || me.username}</h1>
          <div className="muted">
            用户组 {me.group_name} · 你的会话、文件、记忆和自己安装的插件都会保存，下次启动自动恢复。
          </div>
        </div>

        <PowerPanel username={me.username} initial={me.sandbox} showToast={showToast} />

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

/** Start and save-release controls; DeepSeek Harness opens only on a running sandbox. */
function PowerPanel({
  username,
  initial,
  showToast,
}: {
  username: string
  initial: SandboxInfo
  showToast: (message: string) => void
}) {
  const { info, progress, start, release } = useSandbox(initial)
  const status = info?.status ?? 'stopped'
  const running = status === 'running'
  const busy = status === 'starting' || status === 'releasing'

  async function act(action: () => Promise<SandboxInfo>) {
    try {
      await action()
    } catch (err) {
      showToast(errorMessage(err))
    }
  }

  return (
    <section className={`power${running ? ' on' : ''}`}>
      <div className="power-head">
        <div className="power-icon" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 3v8" />
            <path d="M6.3 6.8a8 8 0 1 0 11.4 0" />
          </svg>
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="row">
            <h3 style={{ margin: 0 }}>我的云电脑</h3>
            <StatusBadge status={status} />
          </div>
          <div className="hero-meta" style={{ marginTop: 4 }}>
            {running ? (
              <>
                <span>已运行 {formatDuration(info?.uptime_s)}</span>
                <span>连接 {info?.connections ?? 0} 个</span>
                <span>空闲 {formatDuration(info?.idle_timeout_s)} 后自动保存并释放</span>
              </>
            ) : status === 'starting' ? (
              <span>正在启动，并恢复你上次的文件、会话和设置</span>
            ) : status === 'releasing' ? (
              <span>正在保存你的数据，完成后释放云电脑</span>
            ) : status === 'failed' ? (
              <span className="error-text">启动失败：{info?.error}</span>
            ) : (
              <span>云电脑未运行，你的数据已安全保存。启动后才能进入 DeepSeek Harness。</span>
            )}
          </div>
        </div>
      </div>

      {busy && progress ? <ProgressBar percent={progress.percent} label={progress.label} /> : null}

      <div className="power-actions">
        {running ? (
          <button className="btn power-btn release" onClick={() => act(release)}>
            保存并释放
          </button>
        ) : (
          <button className="btn power-btn start" onClick={() => act(start)} disabled={busy}>
            {status === 'failed' ? '重新启动' : status === 'releasing' ? '正在保存…' : status === 'starting' ? '正在启动…' : '启动云电脑'}
          </button>
        )}
        {running ? (
          <a className="btn power-btn enter" href={`/u/${username}/`}>
            进入 DeepSeek Harness →
          </a>
        ) : (
          <button className="btn power-btn enter" disabled title="先启动云电脑">
            进入 DeepSeek Harness →
          </button>
        )}
      </div>
    </section>
  )
}
