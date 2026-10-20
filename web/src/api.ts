/** Typed client for the gateway JSON API. Errors carry the gateway's message. */

export type Role = 'admin' | 'user'
export type SandboxStatus = 'running' | 'starting' | 'stopped' | 'failed'
export type PluginKind = 'bundle' | 'mcp' | 'patch'

export interface SandboxInfo {
  status: SandboxStatus
  error: string | null
  sandbox_id?: string
  uptime_s?: number
  idle_s?: number
  connections?: number
  idle_timeout_s?: number
  max_lifetime_s?: number
}

export interface UserInfo {
  id: number
  username: string
  display_name: string
  role: Role
  disabled: boolean
  group_id: number
  group_name: string
  has_api_key: boolean
  created_at: number
  last_login_at: number | null
}

export interface Me extends UserInfo {
  api_key_hint: string | null
  shared_key_available: boolean
  quota: { daily_request_limit: number; requests_today: number }
  plugins: { name: string; kind: PluginKind; description: string }[]
  sandbox: SandboxInfo
}

export interface Usage {
  requests: number
  input_tokens: number
  output_tokens: number
}

export interface AdminUser extends UserInfo {
  plugin_ids: number[]
  usage_today: Usage
  sandbox: SandboxInfo
}

export interface Group {
  id: number
  name: string
  description: string
  mem_limit: string
  cpus: number
  idle_timeout_s: number
  max_lifetime_s: number
  allow_shared_key: boolean
  daily_request_limit: number
  allowed_models: string[]
  plugin_ids: number[]
  user_count: number
}

export interface McpConfig {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  install?: string
}

export interface Plugin {
  id: number
  key: string
  kind: PluginKind
  name: string
  description: string
  config: { spec?: string; yaml?: string } & Partial<McpConfig>
}

export interface Overview {
  users: number
  disabled_users: number
  groups: number
  plugins: number
  running_sandboxes: number
  requests_today: number
  tokens_today: number
  shared_key_configured: boolean
  backend: string
  instance_id: string
  usage_by_day: (Usage & { day: string; users: number })[]
}

export interface AuditEntry {
  id: number
  ts: number
  actor: string
  action: string
  target: string
  detail: string
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const data: unknown = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new ApiError(response.status, describeError(data, response.status))
  }
  return data as T
}

function describeError(data: unknown, status: number): string {
  if (data && typeof data === 'object' && 'detail' in data) {
    const detail = (data as { detail: unknown }).detail
    if (typeof detail === 'string') return detail
    // Pydantic validation errors: a list of { loc, msg }.
    if (Array.isArray(detail)) {
      return detail.map((d: { loc?: unknown[]; msg?: string }) => `${(d.loc ?? []).slice(1).join('.')}: ${d.msg}`).join('；')
    }
  }
  return `请求失败（${status}）`
}

export const api = {
  login: (username: string, password: string) => request<UserInfo>('POST', '/api/auth/login', { username, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  me: () => request<Me>('GET', '/api/me'),
  sandbox: () => request<SandboxInfo>('GET', '/api/me/sandbox'),
  startSandbox: () => request<SandboxInfo>('POST', '/api/me/sandbox/start'),
  releaseSandbox: () => request<SandboxInfo>('POST', '/api/me/sandbox/release'),
  changePassword: (old_password: string, new_password: string) =>
    request<{ ok: true }>('POST', '/api/me/password', { old_password, new_password }),
  setApiKey: (api_key: string) => request<{ api_key_hint: string }>('PUT', '/api/me/api-key', { api_key }),
  clearApiKey: () => request<{ api_key_hint: null }>('DELETE', '/api/me/api-key'),

  overview: () => request<Overview>('GET', '/api/admin/overview'),
  users: () => request<AdminUser[]>('GET', '/api/admin/users'),
  createUser: (body: { username: string; password: string; display_name: string; role: Role; group_id: number }) =>
    request<UserInfo>('POST', '/api/admin/users', body),
  updateUser: (id: number, body: Partial<{ display_name: string; role: Role; group_id: number; disabled: boolean; password: string; plugin_ids: number[] }>) =>
    request<UserInfo>('PATCH', `/api/admin/users/${id}`, body),
  deleteUser: (id: number, purge: boolean) => request<{ ok: true }>('DELETE', `/api/admin/users/${id}?purge=${purge}`),
  groups: () => request<Group[]>('GET', '/api/admin/groups'),
  createGroup: (body: Partial<Group>) => request<Group>('POST', '/api/admin/groups', body),
  updateGroup: (id: number, body: Partial<Group>) => request<Group>('PATCH', `/api/admin/groups/${id}`, body),
  deleteGroup: (id: number) => request<{ ok: true }>('DELETE', `/api/admin/groups/${id}`),
  plugins: () => request<Plugin[]>('GET', '/api/admin/plugins'),
  createPlugin: (body: Omit<Plugin, 'id'>) => request<Plugin>('POST', '/api/admin/plugins', body),
  updatePlugin: (id: number, body: Partial<Omit<Plugin, 'id'>>) => request<Plugin>('PATCH', `/api/admin/plugins/${id}`, body),
  deletePlugin: (id: number) => request<{ ok: true }>('DELETE', `/api/admin/plugins/${id}`),
  sandboxes: () => request<(SandboxInfo & { username: string })[]>('GET', '/api/admin/sandboxes'),
  releaseUserSandbox: (username: string) => request<SandboxInfo>('POST', `/api/admin/sandboxes/${username}/release`),
  audit: () => request<AuditEntry[]>('GET', '/api/admin/audit?limit=300'),
}
