import { useState } from 'react'

import { type AdminUser, api, type Group } from '../../api.ts'
import { errorMessage, Modal } from '../../ui.tsx'

/** Running users whose sandbox starts with `group`'s settings or with `pluginId`. */
export function runningAffected(
  users: AdminUser[],
  groups: Group[],
  change: { groupId?: number; pluginId?: number; userId?: number },
): string[] {
  const groupPlugins = new Map(groups.map((g) => [g.id, g.plugin_ids]))
  return users
    .filter((u) => u.sandbox.status === 'running')
    .filter(
      (u) =>
        u.id === change.userId ||
        u.group_id === change.groupId ||
        (change.pluginId !== undefined &&
          (u.plugin_ids.includes(change.pluginId) || (groupPlugins.get(u.group_id) ?? []).includes(change.pluginId))),
    )
    .map((u) => u.username)
}

/**
 * Tells the admin that the change applies on the next sandbox start, and offers to
 * restart the affected running sandboxes now (each is saved first).
 */
export function RestartPrompt({
  usernames,
  onClose,
  showToast,
}: {
  usernames: string[]
  onClose: () => void
  showToast: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)

  async function restartAll() {
    setBusy(true)
    const failed: string[] = []
    for (const username of usernames) {
      try {
        await api.restartUserSandbox(username)
      } catch (err) {
        failed.push(`${username}：${errorMessage(err)}`)
      }
    }
    showToast(failed.length ? `部分重启失败：${failed.join('；')}` : `已开始重启 ${usernames.length} 台云电脑`)
    onClose()
  }

  return (
    <Modal
      title="配置已保存，需要重启云电脑才能生效"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            稍后，用户下次启动时生效
          </button>
          <button className="btn primary" onClick={restartAll} disabled={busy}>
            立即重启
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 10 }}>
        <div>
          插件、MCP、资源和用户组的设置只在云电脑启动时读取。以下 {usernames.length} 位用户的云电脑正在运行，仍在使用旧配置：
        </div>
        <div className="chip-list">
          {usernames.map((name) => (
            <span key={name} className="chip">
              {name}
            </span>
          ))}
        </div>
        <div className="muted">立即重启会先保存他们的数据，再用新配置启动；他们正在进行的任务会被中断，dsh 页面需要刷新。</div>
      </div>
    </Modal>
  )
}

/** Inline reminder shown inside editors whose changes apply on the next start. */
export function RestartHint() {
  return <div className="notice">保存后，正在运行的云电脑需要重启才会使用新配置；保存时会提示你是否立即重启。</div>
}
