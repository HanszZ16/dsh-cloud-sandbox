import { useCallback, useState } from 'react'

import { api, type AdminUser, type Group, type Plugin, type Role } from '../../api.ts'
import { useSession } from '../../App.tsx'
import { errorMessage, Field, formatNumber, formatTime, Modal, StatusBadge } from '../../ui.tsx'
import { Loading, useLoad } from '../Admin.tsx'
import { PluginPicker } from './Plugins.tsx'
import { RestartHint, RestartPrompt } from './RestartPrompt.tsx'

interface Catalog {
  users: AdminUser[]
  groups: Group[]
  plugins: Plugin[]
}

export function UsersSection({ showToast }: { showToast: (m: string) => void }) {
  const load = useCallback(async (): Promise<Catalog> => {
    const [users, groups, plugins] = await Promise.all([api.users(), api.groups(), api.plugins()])
    return { users, groups, plugins }
  }, [])
  const { data, error, reload } = useLoad(load)
  const [editing, setEditing] = useState<AdminUser | 'new' | null>(null)
  const [deleting, setDeleting] = useState<AdminUser | null>(null)
  const [query, setQuery] = useState('')
  const [restart, setRestart] = useState<string[]>([])
  const { me } = useSession()

  if (!data) return <Loading error={error} />
  const groupName = new Map(data.groups.map((g) => [g.id, g.name]))
  const shown = data.users.filter((u) => `${u.username} ${u.display_name}`.toLowerCase().includes(query.toLowerCase()))

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>用户</h2>
          <p>账号由管理员创建。用户名创建后不可修改，它对应用户云电脑数据的存储目录。</p>
        </div>
        <div className="row">
          <input className="input" style={{ width: 200, height: 36 }} placeholder="搜索用户" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn primary" onClick={() => setEditing('new')}>
            新建用户
          </button>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>用户</th>
              <th>角色</th>
              <th>用户组</th>
              <th>云电脑</th>
              <th>今日请求 / tokens</th>
              <th>API Key</th>
              <th>最近登录</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((u) => (
              <tr key={u.id} style={u.disabled ? { opacity: 0.5 } : undefined}>
                <td>
                  <div>{u.display_name || u.username}</div>
                  <div className="muted mono">{u.username}</div>
                </td>
                <td>{u.role === 'admin' ? '管理员' : '用户'}{u.disabled ? '（已停用）' : ''}</td>
                <td>{groupName.get(u.group_id)}</td>
                <td>
                  <StatusBadge status={u.sandbox.status} />
                </td>
                <td>
                  {u.usage_today.requests} / {formatNumber(u.usage_today.input_tokens + u.usage_today.output_tokens)}
                </td>
                <td>{u.has_api_key ? '自有' : <span className="muted">共享</span>}</td>
                <td className="muted">{formatTime(u.last_login_at)}</td>
                <td className="actions">
                  <button className="btn ghost sm" onClick={() => setEditing(u)}>
                    编辑
                  </button>
                  {u.id !== me?.id ? (
                    <button className="btn danger sm" onClick={() => setDeleting(u)}>
                      删除
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length ? null : <div className="empty">没有匹配的用户</div>}
      </div>
      {editing ? (
        <UserEditor
          user={editing === 'new' ? null : editing}
          groups={data.groups}
          plugins={data.plugins}
          onClose={() => setEditing(null)}
          onSaved={(message, needsRestart) => {
            setEditing(null)
            showToast(message)
            if (needsRestart && editing !== 'new') setRestart([editing.username])
            reload()
          }}
        />
      ) : null}
      {restart.length ? <RestartPrompt usernames={restart} onClose={() => setRestart([])} showToast={showToast} /> : null}
      {deleting ? (
        <DeleteUser
          user={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null)
            showToast(`已删除 ${deleting.username}`)
            reload()
          }}
        />
      ) : null}
    </div>
  )
}

function UserEditor({
  user,
  groups,
  plugins,
  onClose,
  onSaved,
}: {
  user: AdminUser | null
  groups: Group[]
  plugins: Plugin[]
  onClose: () => void
  onSaved: (message: string, needsRestart: boolean) => void
}) {
  const [username, setUsername] = useState(user?.username ?? '')
  const [displayName, setDisplayName] = useState(user?.display_name ?? '')
  const [role, setRole] = useState<Role>(user?.role ?? 'user')
  const [groupId, setGroupId] = useState(user?.group_id ?? groups[0]?.id ?? 0)
  const [disabled, setDisabled] = useState(user?.disabled ?? false)
  const [password, setPassword] = useState('')
  const [pluginIds, setPluginIds] = useState<number[]>(user?.plugin_ids ?? [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const group = groups.find((g) => g.id === groupId)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      if (user) {
        await api.updateUser(user.id, {
          display_name: displayName,
          role,
          group_id: groupId,
          disabled,
          plugin_ids: pluginIds,
          ...(password ? { password } : {}),
        })
        const samePlugins = [...pluginIds].sort().join() === [...user.plugin_ids].sort().join()
        const changed = groupId !== user.group_id || !samePlugins
        onSaved(`已保存 ${user.username}`, changed && !disabled && user.sandbox.status === 'running')
      } else {
        const created = await api.createUser({ username, password, display_name: displayName, role, group_id: groupId })
        if (pluginIds.length) await api.updateUser(created.id, { plugin_ids: pluginIds })
        onSaved(`已创建 ${created.username}`, false)
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={user ? `编辑用户 ${user.username}` : '新建用户'}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save} disabled={busy || (!user && (!username || password.length < 8))}>
            保存
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="用户名" hint={user ? '不可修改' : '小写字母、数字、连字符'}>
          <input className="input" value={username} disabled={!!user} onChange={(e) => setUsername(e.target.value)} autoFocus={!user} />
        </Field>
        <Field label="显示名称">
          <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label={user ? '重置密码' : '初始密码'} hint={user ? '留空则不修改；重置后该用户需重新登录' : '至少 8 位'}>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="用户组">
          <select className="input" value={groupId} onChange={(e) => setGroupId(Number(e.target.value))}>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="角色">
          <div className="segmented">
            <button type="button" className={role === 'user' ? 'on' : ''} onClick={() => setRole('user')}>
              用户
            </button>
            <button type="button" className={role === 'admin' ? 'on' : ''} onClick={() => setRole('admin')}>
              管理员
            </button>
          </div>
        </Field>
        {user ? (
          <Field label="账号状态" hint="停用会立即下线并保存、释放其云电脑">
            <label className="checkbox" style={{ height: 36 }}>
              <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
              停用此账号
            </label>
          </Field>
        ) : null}
        <div className="field wide">
          <span>额外分配的插件</span>
          <div className="hint" style={{ marginBottom: 4 }}>
            在用户组「{group?.name}」的插件之外，单独分配给此用户。
          </div>
          <PluginPicker plugins={plugins} selected={pluginIds} inherited={group?.plugin_ids ?? []} onChange={setPluginIds} />
        </div>
        {user ? (
          <div className="wide">
            <RestartHint />
          </div>
        ) : null}
        {error ? <div className="error-text wide">{error}</div> : null}
      </div>
    </Modal>
  )
}

function DeleteUser({ user, onClose, onDeleted }: { user: AdminUser; onClose: () => void; onDeleted: () => void }) {
  const [purge, setPurge] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    try {
      await api.deleteUser(user.id, purge)
      onDeleted()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Modal
      title={`删除用户 ${user.username}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={confirm}>
            删除
          </button>
        </>
      }
    >
      <div className="stack">
        <div>账号会被删除，正在运行的云电脑会先保存再释放。</div>
        <label className="checkbox">
          <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
          同时删除该用户保存的全部数据（会话、文件、记忆、插件），不可恢复
        </label>
        {!purge ? <div className="muted">保留数据时，以后用同名账号重新创建即可恢复。</div> : null}
        {error ? <div className="error-text">{error}</div> : null}
      </div>
    </Modal>
  )
}
