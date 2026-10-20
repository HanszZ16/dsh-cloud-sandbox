import { useCallback, useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'

import { api, type AuditEntry, type Overview, type SandboxInfo } from '../api.ts'
import { TopBar } from '../TopBar.tsx'
import { errorMessage, formatDuration, formatNumber, formatTime, Spinner, StatusBadge, useToast } from '../ui.tsx'
import { GroupsSection } from './admin/Groups.tsx'
import { ImagesSection } from './admin/Images.tsx'
import { PluginsSection } from './admin/Plugins.tsx'
import { UsersSection } from './admin/Users.tsx'

const NAV = [
  { to: 'overview', label: '概览' },
  { to: 'users', label: '用户' },
  { to: 'groups', label: '用户组' },
  { to: 'plugins', label: '插件与 MCP' },
  { to: 'images', label: '镜像' },
  { to: 'sandboxes', label: '活跃工作空间' },
  { to: 'audit', label: '审计日志' },
]

export function AdminPage() {
  const [toast, showToast] = useToast()
  return (
    <>
      <TopBar section="管理后台" />
      <div className="admin">
        <nav className="admin-nav">
          <div className="title">管理后台</div>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-cell${isActive ? ' active' : ''}`}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <main className="admin-main">
          <Routes>
            <Route index element={<Navigate to="overview" replace />} />
            <Route path="overview" element={<OverviewSection />} />
            <Route path="users" element={<UsersSection showToast={showToast} />} />
            <Route path="groups" element={<GroupsSection showToast={showToast} />} />
            <Route path="plugins" element={<PluginsSection showToast={showToast} />} />
            <Route path="images" element={<ImagesSection showToast={showToast} />} />
            <Route path="sandboxes" element={<SandboxesSection showToast={showToast} />} />
            <Route path="audit" element={<AuditSection />} />
            <Route path="*" element={<Navigate to="overview" replace />} />
          </Routes>
        </main>
      </div>
      {toast}
    </>
  )
}

/** Load once, reload on demand; errors render in place of the data. */
export function useLoad<T>(load: () => Promise<T>): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    load().then(
      (value) => {
        setData(value)
        setError(null)
      },
      (err) => setError(errorMessage(err)),
    )
  }, [load])
  useEffect(reload, [reload])
  return { data, error, reload }
}

export function Loading({ error }: { error: string | null }) {
  return <div className="empty">{error ? <span className="error-text">{error}</span> : <Spinner />}</div>
}

function OverviewSection() {
  const { data, error } = useLoad<Overview>(api.overview)
  if (!data) return <Loading error={error} />
  const max = Math.max(1, ...data.usage_by_day.map((d) => d.requests))
  const stats = [
    { label: '用户', value: data.users, note: data.disabled_users ? `${data.disabled_users} 个已停用` : '' },
    { label: '活跃工作空间', value: data.running_sandboxes },
    { label: '今日模型请求', value: data.requests_today },
    { label: '今日 tokens', value: data.tokens_today },
    { label: '用户组', value: data.groups },
    { label: '插件与 MCP', value: data.plugins },
  ]
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h2>概览</h2>
          <p>
            沙箱后端 {data.backend} · 网关实例 <span className="mono">{data.instance_id}</span> · 共享 Key
            {data.shared_key_configured ? '已配置' : '未配置'}
          </p>
        </div>
      </div>
      <div className="stats">
        {stats.map((s) => (
          <div key={s.label} className="card stat">
            <div className="label">{s.label}</div>
            <div className="value">{formatNumber(s.value)}</div>
            {s.note ? <div className="muted" style={{ fontSize: 12 }}>{s.note}</div> : null}
          </div>
        ))}
      </div>
      <section className="card">
        <h3>近 14 天模型请求</h3>
        {data.usage_by_day.length ? (
          <div className="bars">
            {data.usage_by_day.map((d) => (
              <div key={d.day} className="bar" title={`${d.day}：${d.requests} 次，${d.users} 位用户，${formatNumber(d.input_tokens + d.output_tokens)} tokens`}>
                <span>{d.requests}</span>
                <div style={{ height: `${(d.requests / max) * 80}%` }} />
                <span>{d.day.slice(5)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted">还没有模型请求</div>
        )}
      </section>
    </div>
  )
}

function SandboxesSection({ showToast }: { showToast: (m: string) => void }) {
  const { data, error, reload } = useLoad<(SandboxInfo & { username: string })[]>(api.sandboxes)
  useEffect(() => {
    const timer = window.setInterval(reload, 5000)
    return () => window.clearInterval(timer)
  }, [reload])

  async function act(username: string, action: 'release' | 'restart') {
    try {
      if (action === 'release') await api.releaseUserSandbox(username)
      else await api.restartUserSandbox(username)
      showToast(action === 'release' ? `正在让 ${username} 的工作空间休眠` : `正在重启 ${username} 的工作空间`)
      reload()
    } catch (err) {
      showToast(errorMessage(err))
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>活跃工作空间</h2>
          <p>休眠和重启都会先保存用户的工作空间。修改用户组、插件或用户分配后，重启即可让新配置生效。</p>
        </div>
        <button className="btn outline sm" onClick={reload}>
          刷新
        </button>
      </div>
      {!data ? (
        <Loading error={error} />
      ) : (
        <div className="table-wrap">
          {data.length ? (
            <table>
              <thead>
                <tr>
                  <th>用户</th>
                  <th>状态</th>
                  <th>沙箱</th>
                  <th>镜像</th>
                  <th>已运行</th>
                  <th>空闲</th>
                  <th>连接</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((s) => (
                  <tr key={s.username}>
                    <td>{s.username}</td>
                    <td>
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="mono">{s.sandbox_id}</td>
                    <td className="mono">{s.image}</td>
                    <td>{formatDuration(s.uptime_s)}</td>
                    <td>{formatDuration(s.idle_s)}</td>
                    <td>{s.connections}</td>
                    <td className="actions">
                      <button className="btn ghost sm" onClick={() => act(s.username, 'restart')} disabled={s.status !== 'running'}>
                        重启
                      </button>
                      <button className="btn danger sm" onClick={() => act(s.username, 'release')} disabled={s.status !== 'running'}>
                        休眠
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">当前没有活跃的工作空间</div>
          )}
        </div>
      )}
    </div>
  )
}

const ACTION_LABEL: Record<string, string> = {
  login: '登录',
  logout: '退出',
  'bootstrap-admin': '创建初始管理员',
  'change-password': '修改密码',
  'set-api-key': '设置 API Key',
  'clear-api-key': '删除 API Key',
  'release-sandbox': '工作空间休眠',
  'restart-sandbox': '重启工作空间',
  'create-image': '登记镜像',
  'update-image': '修改镜像',
  'delete-image': '删除镜像',
  'create-user': '创建用户',
  'update-user': '修改用户',
  'delete-user': '删除用户',
  'create-group': '创建用户组',
  'update-group': '修改用户组',
  'delete-group': '删除用户组',
  'create-plugin': '添加插件',
  'update-plugin': '修改插件',
  'delete-plugin': '删除插件',
}

function AuditSection() {
  const { data, error } = useLoad<AuditEntry[]>(api.audit)
  return (
    <div>
      <div className="page-head">
        <div>
          <h2>审计日志</h2>
          <p>最近 300 条账号与配置操作</p>
        </div>
      </div>
      {!data ? (
        <Loading error={error} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>操作人</th>
                <th>操作</th>
                <th>对象</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{formatTime(e.ts)}</td>
                  <td>{e.actor}</td>
                  <td>{ACTION_LABEL[e.action] ?? e.action}</td>
                  <td>{e.target}</td>
                  <td className="muted">{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
