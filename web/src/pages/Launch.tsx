import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { api, type SandboxInfo } from '../api.ts'
import { useSession } from '../App.tsx'
import { progressOf } from '../sandbox.ts'
import { errorMessage, FishLogo } from '../ui.tsx'

/**
 * The page between sign-in and the workspace: wakes the workspace, shows progress,
 * and replaces itself with DeepSeek Harness once it is ready.
 */
export function LaunchPage() {
  const { me } = useSession()
  const [params] = useSearchParams()
  const [info, setInfo] = useState<SandboxInfo | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const fetchedAt = useRef(performance.now())
  const [, setTick] = useState(0)

  const username = me?.username ?? ''
  const home = `/u/${username}/`
  const next = params.get('next')
  const target = next && next.startsWith(home) ? next : home

  useEffect(() => {
    if (!username) return
    let cancelled = false
    const accept = (value: SandboxInfo) => {
      fetchedAt.current = performance.now()
      setInfo(value)
    }
    async function run() {
      setFailure(null)
      let current = await api.sandbox()
      while (!cancelled) {
        accept(current)
        if (current.status === 'running') {
          window.location.replace(target)
          return
        }
        // A sleeping workspace is woken; one still saving is waited for first.
        current = current.status === 'stopped' || current.status === 'failed' ? await api.startSandbox() : current
        if (current.status === 'failed') {
          setFailure(current.error ?? '')
          return
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500))
        current = await api.sandbox()
        if (current.status === 'failed') {
          accept(current)
          setFailure(current.error ?? '')
          return
        }
      }
    }
    run().catch((err) => setFailure(errorMessage(err)))
    const tick = window.setInterval(() => setTick((t) => t + 1), 120)
    return () => {
      cancelled = true
      window.clearInterval(tick)
    }
  }, [username, target, attempt])

  if (!me) return null
  const progress = progressOf(info, (performance.now() - fetchedAt.current) / 1000)
  const saving = info?.status === 'releasing'
  const title = saving ? '正在保存上一次的工作' : me.workspace_saved ? '正在恢复你的工作空间' : '正在准备你的工作空间'
  const percent = info?.status === 'running' ? 100 : (progress?.percent ?? 2)

  return (
    <div className="launch">
      <div className="launch-body">
        <span className="launch-logo">
          <FishLogo size={52} />
        </span>
        {failure !== null ? (
          <>
            <div className="launch-title">工作空间暂时无法打开</div>
            <div className="launch-sub">请稍后重试；如果一直失败，请联系管理员。</div>
            {me.role === 'admin' && failure ? <pre className="launch-detail">{failure}</pre> : null}
            <button className="btn brand" style={{ marginTop: 20 }} onClick={() => setAttempt((a) => a + 1)}>
              重试
            </button>
          </>
        ) : (
          <>
            <div className="launch-title">{title}</div>
            <div className="launch-track">
              <div className="launch-fill" style={{ width: `${percent}%` }} />
            </div>
            <div className="launch-sub">{progress?.label ?? '请稍候'}</div>
          </>
        )}
      </div>
      <div className="launch-foot">DeepSeek Harness</div>
    </div>
  )
}
