/**
 * Workspace capabilities plugin, host face: one read-only route that reports
 * the MCP servers and skills of this workspace for the Settings section in
 * ./client.js.
 *
 * dsh's MCP client exposes no status service, so each server's state is
 * derived from three places: its loader entry (configuration, disabled,
 * fiber state and load error), the tools registry (tools named
 * `mcp__<server>__*` exist while the server is connected and synced), and the
 * client's recent log messages, labelled `mcp-client(<server>)`, which a
 * logger exporter keeps in memory from this plugin's start (dsh Web prints
 * them nowhere). The loader entry and fiber fields are dsh pre-stable internals: a
 * source that cannot be read is reported as unavailable instead of failing
 * the whole report. Secrets never leave this file: environment and header
 * values are dropped, and arguments, URLs, and log lines are masked.
 * Written as plain ESM so the image ships it without a build step.
 */

import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export const name = 'workspace-capabilities'

/** Browser route, document-relative under the dsh mount. */
const OVERVIEW_PATH = '/api/dshCloudCapabilities/overview'
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
/** Entry ids the image itself mounts. */
const BUILTIN_IDS = new Set(['dsh-cloud-browser-mcp'])
/** Entry id prefix of MCP rows the dsh-cloud gateway's admin console provisions. */
const TEAM_PREFIX = 'dsh-cloud-mcp-'
/** The MCP client's log label; the server name follows its serverName rule. */
const LABEL = /mcp-client\(([A-Za-z0-9_-]{1,32})\)/
/** cordis LoggerLevel WARN: export errors, information, and warnings, not debug output. */
const LOGGER_WARN = 2
/** How long a skill listing is reused: listing borrows an agent preset's scope, which is not free. */
const SKILLS_TTL_MS = 30_000
/** cordis FiberState: PENDING, LOADING, ACTIVE, FAILED, DISPOSED, UNLOADING. */
const FIBER = { pending: 0, loading: 1, active: 2, failed: 3, disposed: 4, unloading: 5 }

const DEFAULTS = {
  // Recent log messages kept and shown per server.
  logLines: 5,
  // Project directories whose project skills are listed: Session working
  // directories, then the projects under projectsDir.
  maxProjects: 10,
  // Where dsh-cloud keeps users' projects (sandbox-image/base/defaults.cordis.yml).
  projectsDir: '~/workspaces',
}

const SECRET_NAME = /key|token|secret|passw|auth|credential|cookie|session/i
const OPAQUE = /^[A-Za-z0-9+_\-.=~]{24,}$/
const MASK = '••••'

/** An argument list with values that look like secrets replaced. */
export function maskArgs(args) {
  const masked = []
  let secretFlag = false
  for (const raw of args) {
    const arg = String(raw)
    const assignment = /^(-{0,2}[A-Za-z0-9_.-]+)=(.*)$/.exec(arg)
    if (secretFlag && !arg.startsWith('-')) masked.push(MASK)
    else if (assignment && SECRET_NAME.test(assignment[1])) masked.push(`${assignment[1]}=${MASK}`)
    else if (OPAQUE.test(arg) && !arg.includes('/')) masked.push(MASK)
    else masked.push(arg)
    secretFlag = arg.startsWith('-') && !assignment && SECRET_NAME.test(arg)
  }
  return masked
}

/** A URL without credentials and with secret-looking query values replaced. */
export function maskUrl(value) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    // Not a URL (an unevaluated expression): show nothing that could carry a secret.
    return MASK
  }
  url.username = ''
  url.password = ''
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_NAME.test(key)) url.searchParams.set(key, MASK)
  }
  return url.toString().replaceAll(encodeURIComponent(MASK), MASK)
}

/** A log line with bearer tokens, `secret=value` pairs, and opaque strings replaced. */
export function maskLine(line) {
  return line
    .replace(/(bearer\s+)\S+/gi, `$1${MASK}`)
    .replace(/([A-Za-z0-9_-]*(?:key|token|secret|passw|auth)[A-Za-z0-9_-]*["']?\s*[=:]\s*["']?)[^\s"',}]+/gi, `$1${MASK}`)
    .replace(/[A-Za-z0-9+_\-=]{32,}/g, MASK)
}

/** Where a server's row comes from. */
export function sourceOf(id) {
  if (BUILTIN_IDS.has(id)) return 'builtin'
  if (id.startsWith(TEAM_PREFIX)) return 'team'
  return 'personal'
}

/**
 * The state shown for one server.
 * @param {{ disabled: boolean, fiberState: number | undefined, toolCount: number }} facts
 */
export function stateOf({ disabled, fiberState, toolCount }) {
  if (disabled) return 'disabled'
  if (fiberState === FIBER.failed) return 'failed'
  if (fiberState === undefined || fiberState === FIBER.pending || fiberState === FIBER.loading) return 'loading'
  if (fiberState !== FIBER.active) return 'stopped'
  return toolCount > 0 ? 'online' : 'no-tools'
}

const str = (value) => (typeof value === 'string' ? value : undefined)

/** A logger call's arguments as one line: printf placeholders filled, the rest appended. */
export function formatLog(args) {
  const text = (value) => (value instanceof Error ? value.message : typeof value === 'string' ? value : JSON.stringify(value))
  const [first, ...rest] = args
  if (typeof first !== 'string') return args.map(text).join(' ')
  const line = first.replace(/%[sdifoOcC%]/g, (token) => (token === '%%' ? '%' : rest.length > 0 ? text(rest.shift()) : token))
  return [line, ...rest.map(text)].join(' ')
}

export function apply(ctx, config = {}) {
  // The package has no dependencies of its own (it is linked from the image), so the config is checked here.
  const cfg = { ...DEFAULTS, ...config }
  for (const key of ['logLines', 'maxProjects']) {
    if (!Number.isSafeInteger(cfg[key]) || cfg[key] < 0) {
      throw new Error(`workspace-capabilities: ${key} must be a non-negative integer, got ${JSON.stringify(config[key])}`)
    }
  }
  for (const key of ['projectsDir']) {
    if (typeof cfg[key] !== 'string' || cfg[key] === '') {
      throw new Error(`workspace-capabilities: ${key} must be a non-empty path, got ${JSON.stringify(config[key])}`)
    }
  }

  // Server name -> its recent log messages, oldest first.
  const recentByServer = new Map()
  let logging = false
  if (typeof ctx.logger?.exporter === 'function' && cfg.logLines > 0) {
    ctx.logger.exporter({
      levels: { default: LOGGER_WARN },
      export(message) {
        const text = formatLog(message.args)
        const server = LABEL.exec(text)?.[1]
        if (server === undefined) return
        const recent = recentByServer.get(server) ?? []
        recent.push({ ts: message.ts, type: message.type, text: maskLine(text).slice(0, 500) })
        recentByServer.set(server, recent.slice(-cfg.logLines))
      },
    })
    logging = true
  }

  function mcpServers(unavailable) {
    const loader = ctx.get('loader')
    if (typeof loader?.entries !== 'function') {
      unavailable.push('mcp')
      return []
    }
    let definitions = []
    try {
      definitions = ctx.get('tools')?.definitions() ?? []
    } catch (e) {
      ctx.logger.warn('cannot list tools: %s', e?.message ?? e)
      unavailable.push('tools')
    }
    const servers = []
    for (const entry of loader.entries()) {
      const options = entry.options ?? {}
      if (options.name !== MCP_CLIENT) continue
      const raw = options.config ?? {}
      const server = str(raw.serverName) ?? '?'
      const prefix = `mcp__${server}__`
      const tools = definitions
        .filter(d => typeof d?.name === 'string' && d.name.startsWith(prefix))
        .map(d => ({ name: d.name.slice(prefix.length), description: String(d.description ?? '').split('\n')[0].slice(0, 200) }))
        .sort((a, b) => a.name.localeCompare(b.name))
      const fiber = entry.fiber
      const fiberState = typeof fiber?.state === 'number' ? fiber.state : undefined
      const state = stateOf({ disabled: Boolean(entry.disabled ?? options.disabled), fiberState, toolCount: tools.length })
      const loadError = state === 'failed' ? maskLine(String(fiber?._error?.message ?? fiber?._error ?? '')) : undefined
      const recent = logging ? recentByServer.get(server) ?? [] : undefined
      const transport = str(raw.transport) ?? '?'
      servers.push({
        id: String(options.id ?? entry.id ?? ''),
        server,
        source: sourceOf(String(options.id ?? entry.id ?? '')),
        transport,
        command: transport === 'stdio'
          ? [str(raw.command) ?? MASK, ...maskArgs(Array.isArray(raw.args) ? raw.args : [])].join(' ')
          : undefined,
        url: transport === 'stdio' ? undefined : maskUrl(raw.url),
        envNames: raw.env && typeof raw.env === 'object' ? Object.keys(raw.env).sort() : [],
        headerNames: raw.headers && typeof raw.headers === 'object' ? Object.keys(raw.headers).sort() : [],
        state,
        error: loadError || undefined,
        tools,
        recent,
      })
    }
    const order = { builtin: 0, team: 1, personal: 2 }
    return servers.sort((a, b) => order[a.source] - order[b.source] || a.server.localeCompare(b.server))
  }

  let skillsCache
  async function skills(unavailable) {
    if (skillsCache && Date.now() - skillsCache.at < SKILLS_TTL_MS) return skillsCache.value
    const registry = ctx.get('skills')
    if (typeof registry?.list !== 'function') {
      unavailable.push('skills')
      return { projects: [], skills: [] }
    }
    // Skill providers are mounted by agent presets, so the global layer alone is
    // empty: list in the default preset's scope, as dsh's own skills/list Remote
    // does for a Session without a running agent.
    let lease
    try {
      lease = await ctx.get('agentPresets')?.acquireScope(undefined)
    } catch (e) {
      ctx.logger.warn('cannot acquire the default agent preset scope: %s', e?.message ?? e)
    }
    try {
      const value = await listSkills(registry, lease?.key)
      skillsCache = { at: Date.now(), value }
      return value
    } finally {
      await lease?.[Symbol.asyncDispose]?.()
    }
  }

  async function listSkills(registry, scope) {
    const cwds = new Set()
    try {
      for (const snapshot of await ctx.get('sessionPersistence')?.list() ?? []) {
        const cwd = snapshot?.header?.cwd
        if (typeof cwd === 'string' && cwd !== '' && cwds.size < cfg.maxProjects) cwds.add(cwd)
      }
    } catch (e) {
      ctx.logger.warn('cannot list sessions: %s', e?.message ?? e)
    }
    const projectsDir = cfg.projectsDir.replace(/^~(?=\/|$)/, homedir())
    try {
      for (const entry of await readdir(projectsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && cwds.size < cfg.maxProjects) cwds.add(join(projectsDir, entry.name))
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') ctx.logger.warn('cannot list %s: %s', projectsDir, e?.message ?? e)
    }
    if (cwds.size === 0) cwds.add(homedir())
    const byPath = new Map()
    for (const cwd of cwds) {
      let listed
      try {
        listed = await registry.list({ cwd, scope })
      } catch (e) {
        ctx.logger.warn('cannot list skills for %s: %s', cwd, e?.message ?? e)
        continue
      }
      for (const skill of listed) {
        const key = skill.path ?? `${skill.source}:${skill.name}`
        const project = String(skill.source).startsWith('project-') ? basename(cwd) : undefined
        const known = byPath.get(key)
        if (known) {
          if (project && !known.projects.includes(project)) known.projects.push(project)
          continue
        }
        byPath.set(key, {
          name: skill.name,
          description: String(skill.description ?? '').slice(0, 300),
          whenToUse: skill.whenToUse ? String(skill.whenToUse).slice(0, 300) : undefined,
          source: skill.source,
          path: skill.path,
          modelInvocable: skill.invocation?.modelInvocable !== false,
          userInvocable: skill.invocation?.userInvocable !== false,
          projects: project ? [project] : [],
        })
      }
    }
    return {
      projects: [...cwds].map(cwd => basename(cwd)),
      skills: [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name)),
    }
  }

  async function overview() {
    const unavailable = []
    if (!logging && cfg.logLines > 0) unavailable.push('logs')
    const mcp = mcpServers(unavailable)
    const { projects, skills: list } = await skills(unavailable)
    return new Response(JSON.stringify({ mcp, skills: list, projects, unavailable }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  ctx.inject(['connection'], (web) => {
    web.effect(() => web.connection.fetch.register({
      path: OVERVIEW_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: overview,
    }), 'workspace-capabilities: overview route')
  })
}
