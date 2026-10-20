import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { useSession } from './App.tsx'
import { ExitDialog } from './ExitDialog.tsx'
import { FishLogo } from './ui.tsx'

export function TopBar({ section }: { section?: string }) {
  const { me, refresh } = useSession()
  const navigate = useNavigate()
  const [exiting, setExiting] = useState(false)
  if (!me) return null

  async function done() {
    await refresh()
    navigate('/login', { replace: true })
  }

  return (
    <header className="topbar">
      <Link to="/admin" className="brand-link">
        <FishLogo size={26} />
        <span className="wordmark">DeepSeek Harness</span>
        {section ? <span className="tag">· {section}</span> : null}
      </Link>
      <div className="row">
        <a href="/" className="btn ghost sm">
          返回工作空间
        </a>
        <span className="avatar" title={me.username}>
          {(me.display_name || me.username).slice(0, 1).toUpperCase()}
        </span>
        <button className="btn ghost sm" onClick={() => setExiting(true)}>
          退出登录
        </button>
      </div>
      {exiting ? <ExitDialog onClose={() => setExiting(false)} onDone={done} /> : null}
    </header>
  )
}
