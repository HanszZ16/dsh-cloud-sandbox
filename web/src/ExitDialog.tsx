import { useState } from 'react'

import { api, type SandboxInfo } from './api.ts'
import { progressOf, releaseAndWait } from './sandbox.ts'
import { errorMessage, Modal } from './ui.tsx'

/** Confirms, saves the workspace with a progress bar, then signs out. */
export function ExitDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [info, setInfo] = useState<SandboxInfo | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function exit() {
    setRunning(true)
    setError(null)
    try {
      await releaseAndWait(setInfo)
      await api.logout()
      onDone()
    } catch (err) {
      setError(errorMessage(err))
      setRunning(false)
    }
  }

  const progress = progressOf(info, 0)
  return (
    <Modal
      title="退出登录"
      onClose={running ? () => undefined : onClose}
      footer={
        running ? null : (
          <>
            <button className="btn ghost" onClick={onClose}>
              取消
            </button>
            <button className="btn brand" onClick={exit}>
              退出登录
            </button>
          </>
        )
      }
    >
      {running ? (
        <ProgressBar percent={progress?.percent ?? 100} label={progress?.label ?? '正在退出'} />
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <div>退出前会保存你的工作空间，下次登录时一切会回到现在的样子。</div>
          <div className="muted">正在进行的任务会被中断。</div>
          {error ? <div className="error-text">{error}</div> : null}
        </div>
      )}
    </Modal>
  )
}

export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-head">
        <span>{label}</span>
        <span className="mono">{Math.round(percent)}%</span>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}
