import { type FormEvent, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { api } from '../api.ts'
import { useSession } from '../App.tsx'
import { errorMessage, FishLogo, Spinner } from '../ui.tsx'

export function LoginPage() {
  const { refresh } = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.login(username, password)
      await refresh()
      const from = (location.state as { from?: string } | null)?.from
      navigate(from && from !== '/login' ? from : '/', { replace: true })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <span style={{ color: 'var(--dsw-static-deepseek-500)' }}>
            <FishLogo size={44} />
          </span>
          <div className="wordmark">DeepSeek Harness Cloud</div>
          <p>登录后进入你的专属云电脑</p>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label className="field">
            <span>用户名</span>
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoFocus
              required
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error ? <div className="error-text">{error}</div> : null}
          <button className="btn brand block" disabled={busy || !username || !password} style={{ height: 42, marginTop: 4 }}>
            {busy ? <Spinner /> : '登录'}
          </button>
        </form>
        <div className="login-foot">账号由管理员创建；忘记密码请联系管理员重置。</div>
      </div>
    </div>
  )
}
