import { Link, useNavigate } from 'react-router-dom'

import { api } from './api.ts'
import { useSession } from './App.tsx'
import { FishLogo } from './ui.tsx'

export function TopBar({ section }: { section?: string }) {
  const { me, refresh } = useSession()
  const navigate = useNavigate()
  if (!me) return null

  async function logout() {
    await api.logout()
    await refresh()
    navigate('/login', { replace: true })
  }

  return (
    <header className="topbar">
      <Link to="/" className="brand-link">
        <FishLogo size={26} />
        <span className="wordmark">DeepSeek Harness Cloud</span>
        {section ? <span className="tag">· {section}</span> : null}
      </Link>
      <div className="row">
        {me.role === 'admin' ? (
          <Link to={section ? '/' : '/admin'} className="btn ghost sm">
            {section ? '我的云电脑' : '管理后台'}
          </Link>
        ) : null}
        <span className="avatar" title={me.username}>
          {(me.display_name || me.username).slice(0, 1).toUpperCase()}
        </span>
        <button className="btn ghost sm" onClick={logout} title="退出时保存数据并释放云电脑">
          退出
        </button>
      </div>
    </header>
  )
}
