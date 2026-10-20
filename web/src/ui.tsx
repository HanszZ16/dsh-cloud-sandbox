import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import type { SandboxStatus } from './api.ts'
import { FISH_LOGO_PATH } from './logo-path.ts'

export function FishLogo({ size = 24 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={(size * 17.04) / 23.16} viewBox="0 0 23.16 17.04" aria-hidden="true">
      <path d={FISH_LOGO_PATH} fill="currentColor" />
    </svg>
  )
}

const STATUS_LABEL: Record<SandboxStatus, string> = {
  running: '活跃',
  starting: '恢复中',
  releasing: '保存中',
  stopped: '休眠',
  failed: '打开失败',
}

export function StatusBadge({ status }: { status: SandboxStatus }) {
  return <span className={`badge ${status}`}>{STATUS_LABEL[status]}</span>
}

export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`field${wide ? ' wide' : ''}`}>
      <span>{label}</span>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </label>
  )
}

export function Modal({
  title,
  children,
  onClose,
  footer,
  width,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  footer: ReactNode | null
  width?: number
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-layer" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-mask" onClick={onClose} />
      <div className="modal" style={width ? { maxWidth: width } : undefined}>
        <header>{title}</header>
        <div className="body">{children}</div>
        {footer ? <footer>{footer}</footer> : <div style={{ height: 20 }} />}
      </div>
    </div>
  )
}

/** One transient message at a time, shown at the bottom of the page. */
export function useToast(): [ReactNode, (message: string) => void] {
  const [message, setMessage] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const show = useCallback((next: string) => {
    window.clearTimeout(timer.current)
    setMessage(next)
    timer.current = window.setTimeout(() => setMessage(null), 2600)
  }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return [message ? <div className="toast">{message}</div> : null, show]
}

export function Spinner() {
  return <span className="spinner" aria-label="加载中" />
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) return '—'
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
}

export function formatTime(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return '—'
  return new Date(epochSeconds * 1000).toLocaleString('zh-CN', { hour12: false })
}

export function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`
  return value.toLocaleString('zh-CN')
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
