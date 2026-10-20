/** Sandbox status polling and the progress model shared by the portal and the exit dialog. */
import { useCallback, useEffect, useRef, useState } from 'react'

import { api, type SandboxInfo } from './api.ts'

interface Step {
  phase: string
  label: string
  from: number
  to: number
  /** Typical seconds in this step; progress approaches `to` asymptotically. */
  expected: number
}

const STEPS: Record<'starting' | 'releasing', Step[]> = {
  starting: [
    { phase: 'queued', label: '排队中', from: 0, to: 5, expected: 0.5 },
    { phase: 'prepare', label: '读取你的数据', from: 5, to: 15, expected: 0.5 },
    { phase: 'create', label: '创建云电脑', from: 15, to: 30, expected: 1 },
    { phase: 'restore', label: '恢复文件和会话', from: 30, to: 45, expected: 1 },
    { phase: 'boot', label: '启动 DeepSeek Harness', from: 45, to: 98, expected: 5 },
  ],
  releasing: [
    { phase: 'queued', label: '排队中', from: 0, to: 5, expected: 0.5 },
    { phase: 'stop', label: '停止 DeepSeek Harness 并写盘', from: 5, to: 35, expected: 1.5 },
    { phase: 'archive', label: '打包文件和会话', from: 35, to: 65, expected: 1 },
    { phase: 'save', label: '保存数据', from: 65, to: 85, expected: 0.5 },
    { phase: 'destroy', label: '释放云电脑', from: 85, to: 98, expected: 0.5 },
  ],
}

export interface Progress {
  percent: number
  label: string
}

/** Progress of a start or release, or null when none is running. */
export function progressOf(info: SandboxInfo | null, elapsedSinceFetch: number): Progress | null {
  if (!info || (info.status !== 'starting' && info.status !== 'releasing')) return null
  const steps = STEPS[info.status]
  const step = steps.find((s) => s.phase === info.phase) ?? steps[0]
  const elapsed = (info.phase_elapsed_s ?? 0) + elapsedSinceFetch
  const percent = step.from + (step.to - step.from) * (1 - Math.exp(-elapsed / step.expected))
  return { percent, label: step.label }
}

/** Polls while a start or release runs, and ticks so progress moves between polls. */
export function useSandbox(initial: SandboxInfo | null) {
  const [info, setInfo] = useState<SandboxInfo | null>(initial)
  const fetchedAt = useRef(performance.now())
  const [, setTick] = useState(0)

  const accept = useCallback((next: SandboxInfo) => {
    fetchedAt.current = performance.now()
    setInfo(next)
    return next
  }, [])

  const busy = info?.status === 'starting' || info?.status === 'releasing'
  const running = info?.status === 'running'
  // While running, refresh slowly so uptime, connections, and idle releases show up.
  useEffect(() => {
    if (!running) return
    const poll = window.setInterval(() => {
      api.sandbox().then(accept, () => undefined)
    }, 5000)
    return () => window.clearInterval(poll)
  }, [running, accept])

  useEffect(() => {
    if (!busy) return
    const poll = window.setInterval(() => {
      api.sandbox().then(accept, () => undefined)
    }, 700)
    const tick = window.setInterval(() => setTick((t) => t + 1), 120)
    return () => {
      window.clearInterval(poll)
      window.clearInterval(tick)
    }
  }, [busy, accept])

  const progress = progressOf(info, (performance.now() - fetchedAt.current) / 1000)
  return {
    info,
    progress,
    refresh: useCallback(() => api.sandbox().then(accept), [accept]),
    start: useCallback(() => api.startSandbox().then(accept), [accept]),
    release: useCallback(() => api.releaseSandbox().then(accept), [accept]),
  }
}

/** Starts a release and resolves once the sandbox is stopped. */
export async function releaseAndWait(onUpdate: (info: SandboxInfo) => void): Promise<void> {
  let info = await api.releaseSandbox()
  onUpdate(info)
  while (info.status === 'releasing' || info.status === 'starting') {
    await new Promise((resolve) => window.setTimeout(resolve, 600))
    info = await api.sandbox()
    onUpdate(info)
  }
}
