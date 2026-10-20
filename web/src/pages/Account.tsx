import { type FormEvent, useState } from 'react'
import { Link } from 'react-router-dom'

import { api } from '../api.ts'
import { useSession } from '../App.tsx'
import { errorMessage, Field, FishLogo, useToast } from '../ui.tsx'

const KIND_LABEL = { bundle: '插件', mcp: 'MCP', patch: '配置' } as const

/** Inside the workspace's account panel (an iframe) the page drops its own header. */
const EMBEDDED = window.self !== window.top

/** Account settings: API key, usage, assigned plugins, password. */
export function AccountPage() {
  const { me, refresh } = useSession()
  const [toast, showToast] = useToast()

  if (!me) return null
  const quota = me.quota
  const used = quota.daily_request_limit ? Math.min(1, quota.requests_today / quota.daily_request_limit) : 0

  return (
    <>
      {EMBEDDED ? null : (
        <header className="topbar">
          <span className="brand-link">
            <FishLogo size={26} />
            <span className="wordmark">DeepSeek Harness</span>
            <span className="tag">· 账号设置</span>
          </span>
          <a className="btn ghost sm" href="/">
            返回工作空间
          </a>
        </header>
      )}
      <main className={`portal stack${EMBEDDED ? ' embedded' : ''}`}>
        <div className="row" style={{ gap: 14 }}>
          <span className="avatar large">{(me.display_name || me.username).slice(0, 1).toUpperCase()}</span>
          <div>
            <h1 style={{ fontSize: 18, lineHeight: '26px' }}>{me.display_name || me.username}</h1>
            <div className="muted">
              {me.username} · 用户组 {me.group_name}
              {me.role === 'admin' ? (
                <>
                  {' · '}
                  <Link to="/admin" target={EMBEDDED ? '_top' : undefined}>
                    管理后台
                  </Link>
                </>
              ) : null}
            </div>
          </div>
        </div>

        <ApiKeyCard onChange={refresh} showToast={showToast} />

        <section className="card">
          <h3>今日用量</h3>
          <p className="sub">今天发出的模型请求次数</p>
          <div className="row between" style={{ marginBottom: 8 }}>
            <span style={{ fontSize: 22, fontWeight: 500 }}>{quota.requests_today}</span>
            <span className="muted">{quota.daily_request_limit ? `上限 ${quota.daily_request_limit} 次 / 天` : '不限次数'}</span>
          </div>
          {quota.daily_request_limit ? (
            <div className="meter">
              <div style={{ width: `${used * 100}%` }} />
            </div>
          ) : null}
        </section>

        <section className="card">
          <h3>团队为你预装的插件</h3>
          <p className="sub">首次打开工作空间时在后台安装，装好后出现在插件页；之后你可以自由增删，改动会一直保留。</p>
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
      <p className="sub">加密保存，只用于转发你的模型请求，不会出现在工作空间里。</p>
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
