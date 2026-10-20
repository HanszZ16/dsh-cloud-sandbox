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
        <button className="btn ghost sm" onClick={() => setExiting(true)} title="保存数据并释放云电脑，然后退出登录">
          保存并退出
        </button>
      </div>
      {exiting ? <ExitDialog onClose={() => setExiting(false)} onDone={done} /> : null}
    </header>
  )
}
