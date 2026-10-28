/*
 * Workspace capabilities plugin, client face: a Settings section ("MCP 与技能")
 * listing this workspace's MCP servers with their state, tools, and recent
 * log lines, and its skills with their source and how they are invoked.
 *
 * Written directly in dsh's client bundle format (the closure factory that
 * dsh's tsdown preset emits) so it needs no build step; `require` resolves
 * React from dsh's module table. The `settings.section` slot is pre-stable:
 * re-check after upgrading dsh.
 *
 * The data comes from the host face's `api/dshCloudCapabilities/overview`
 * route (./index.js), document-relative under the dsh mount. The section
 * reloads it every few seconds while it is shown.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cloud-workspace-capabilities',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const NS = 'dshCloudWorkspaceCapabilities'
    const SECTION_ID = 'dsh-cloud-capabilities'
    const OVERVIEW = 'api/dshCloudCapabilities/overview'
    const REFRESH_MS = 5000
    const COPY = {
      zh: {
        nav: 'MCP 与技能',
        mcpTitle: 'MCP 服务器', skillsTitle: '技能', refresh: '刷新', loading: '正在读取…', failed: '读取失败：{error}', retry: '重试',
        mcpEmpty: '还没有 MCP 服务器。', skillsEmpty: '还没有技能。把 SKILL.md 放进 ~/.dsh/skills/<名称>/ 或项目的 .agents/skills/<名称>/ 即可。',
        source_builtin: '内置', source_team: '团队', source_personal: '个人',
        state_online: '在线 · {n} 个工具', state_online1: '在线 · 1 个工具', state_loading: '正在启动', state_failed: '启动失败',
        state_no_tools: '无可用工具', state_disabled: '已停用', state_stopped: '已停止',
        noToolsHint: '可能正在连接或重连，也可能连续失败后已放弃重连；重启工作空间可重试。',
        command: '命令', url: '地址', env: '环境变量', headers: '请求头', tools: '工具', recent: '最近日志', error: '错误',
        noRecent: '工作空间启动以来没有相关日志', toolPrefix: '模型看到的名称：mcp__{server}__<工具名>',
        skill_user: '用户', skill_project: '项目 {projects}', skill_custom: '自定义目录', skill_bundled: '随包提供', skill_runtime: '插件提供',
        invokeBoth: '模型自动使用 · /{name}', invokeModel: '仅模型自动使用', invokeUser: '仅 /{name} 调用', invokeNone: '已禁用',
        projects: '扫描的项目：{list}',
        unavailable_mcp: '当前 dsh 版本无法读取 MCP 配置。', unavailable_tools: '当前 dsh 版本无法读取工具列表，在线状态不准确。',
        unavailable_skills: '当前 dsh 版本无法读取技能列表。', unavailable_logs: '当前 dsh 版本无法收集 MCP 日志，不显示最近日志。',
      },
      en: {
        nav: 'MCP & skills',
        mcpTitle: 'MCP servers', skillsTitle: 'Skills', refresh: 'Refresh', loading: 'Loading…', failed: 'Could not load: {error}', retry: 'Retry',
        mcpEmpty: 'No MCP servers yet.', skillsEmpty: 'No skills yet. Put a SKILL.md in ~/.dsh/skills/<name>/ or a project\'s .agents/skills/<name>/.',
        source_builtin: 'Built-in', source_team: 'Team', source_personal: 'Personal',
        state_online: 'Online · {n} tools', state_online1: 'Online · 1 tool', state_loading: 'Starting', state_failed: 'Failed to start',
        state_no_tools: 'No tools available', state_disabled: 'Disabled', state_stopped: 'Stopped',
        noToolsHint: 'It may be connecting or reconnecting, or it gave up after repeated failures; restart the workspace to retry.',
        command: 'Command', url: 'URL', env: 'Environment', headers: 'Headers', tools: 'Tools', recent: 'Recent log', error: 'Error',
        noRecent: 'No related messages since the workspace started', toolPrefix: 'Names the model sees: mcp__{server}__<tool>',
        skill_user: 'User', skill_project: 'Project {projects}', skill_custom: 'Custom directory', skill_bundled: 'Bundled', skill_runtime: 'From a plugin',
        invokeBoth: 'Used by the model · /{name}', invokeModel: 'Model only', invokeUser: '/{name} only', invokeNone: 'Disabled',
        projects: 'Projects scanned: {list}',
        unavailable_mcp: 'This dsh version does not expose MCP configuration.', unavailable_tools: 'This dsh version does not expose the tool list; online states may be wrong.',
        unavailable_skills: 'This dsh version does not expose the skill list.', unavailable_logs: 'This dsh version cannot collect MCP log messages, so recent messages are not shown.',
      },
    }

    const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''))
    const STATE_COLOR = {
      online: 'var(--dsw-alias-state-success-primary)',
      loading: 'var(--dsw-alias-state-warn-primary)',
      'no-tools': 'var(--dsw-alias-state-warn-primary)',
      failed: 'var(--dsw-alias-state-error-primary)',
      disabled: 'var(--dsw-alias-label-tertiary)',
      stopped: 'var(--dsw-alias-label-tertiary)',
    }
    const css = {
      page: { display: 'flex', flexDirection: 'column', gap: 18, fontSize: 13, color: 'var(--dsw-alias-label-primary)' },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
      title: { fontSize: 14, fontWeight: 500 },
      button: { display: 'inline-flex', alignItems: 'center', height: 28, padding: '0 10px', border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 8, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer' },
      list: { display: 'flex', flexDirection: 'column', border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 12, overflow: 'hidden' },
      row: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'transparent', border: 'none', color: 'inherit', font: 'inherit', textAlign: 'left', width: '100%', cursor: 'pointer' },
      divider: { borderTop: '0.5px solid var(--dsw-alias-border-l3)' },
      dot: (state) => ({ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: STATE_COLOR[state] ?? STATE_COLOR.stopped }),
      name: { fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: { flex: 'none', padding: '1px 6px', borderRadius: 6, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-skeleton)' },
      muted: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 },
      grow: { flex: 1 },
      detail: { display: 'flex', flexDirection: 'column', gap: 8, padding: '0 12px 12px 30px' },
      label: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 2 },
      code: { fontFamily: 'var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)', fontSize: 12, wordBreak: 'break-all', whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-label-secondary)' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, wordBreak: 'break-word' },
      note: { padding: '8px 12px', borderRadius: 8, fontSize: 12, color: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))', background: 'var(--dsw-alias-state-warn-tertiary)' },
      empty: { padding: '12px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
      skill: { display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 12px' },
    }

    function stateText(T, server) {
      if (server.state === 'online') return server.tools.length === 1 ? T.state_online1 : fill(T.state_online, { n: server.tools.length })
      return T[`state_${server.state.replace('-', '_')}`] ?? server.state
    }

    function Field({ label, children }) {
      return h('div', null, h('div', { style: css.label }, label), children)
    }

    function McpRow({ T, server, first }) {
      const [open, setOpen] = useState(server.state === 'failed')
      return h('div', { style: first ? null : css.divider },
        h('button', { type: 'button', style: css.row, 'aria-expanded': open, onClick: () => setOpen(!open) },
          h('span', { style: css.dot(server.state) }),
          h('span', { style: css.name }, server.server),
          h('span', { style: css.badge }, T[`source_${server.source}`] ?? server.source),
          h('span', { style: css.muted }, server.transport),
          h('span', { style: css.grow }),
          h('span', { style: { ...css.muted, color: STATE_COLOR[server.state] } }, stateText(T, server)),
          h('span', { style: css.muted, 'aria-hidden': true }, open ? '▾' : '▸')),
        open ? h('div', { style: css.detail },
          server.error ? h(Field, { label: T.error }, h('div', { style: css.error }, server.error)) : null,
          server.state === 'no-tools' ? h('div', { style: css.muted }, T.noToolsHint) : null,
          server.command ? h(Field, { label: T.command }, h('div', { style: css.code }, server.command)) : null,
          server.url ? h(Field, { label: T.url }, h('div', { style: css.code }, server.url)) : null,
          server.envNames.length > 0 ? h(Field, { label: T.env }, h('div', { style: css.code }, server.envNames.join(', '))) : null,
          server.headerNames.length > 0 ? h(Field, { label: T.headers }, h('div', { style: css.code }, server.headerNames.join(', '))) : null,
          server.tools.length > 0 ? h(Field, { label: `${T.tools} · ${fill(T.toolPrefix, { server: server.server })}` },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } }, server.tools.map(tool =>
              h('div', { key: tool.name, style: css.code },
                h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, tool.name),
                tool.description ? ` — ${tool.description}` : '')))) : null,
          server.recent !== undefined ? h(Field, { label: T.recent },
            server.recent.length > 0
              ? h('div', { style: css.code }, server.recent.map(entry => `${new Date(entry.ts).toLocaleTimeString()} ${entry.text}`).join('\n'))
              : h('div', { style: css.muted }, T.noRecent)) : null) : null)
    }

    function skillSource(T, skill) {
      const source = String(skill.source)
      if (source.startsWith('project-')) return fill(T.skill_project, { projects: skill.projects.join(', ') })
      if (source.startsWith('user-')) return T.skill_user
      return T[`skill_${source}`] ?? source
    }

    function skillInvocation(T, skill) {
      if (skill.modelInvocable && skill.userInvocable) return fill(T.invokeBoth, { name: skill.name })
      if (skill.modelInvocable) return T.invokeModel
      if (skill.userInvocable) return fill(T.invokeUser, { name: skill.name })
      return T.invokeNone
    }

    function CapabilitiesSection({ t }) {
      const T = new Proxy({}, { get: (_, key) => t(key) })
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        setBusy(true)
        try {
          const response = await fetch(new URL(OVERVIEW, document.baseURI), { credentials: 'same-origin', cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          setData(await response.json())
          setError(null)
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => {
        void load()
        const timer = window.setInterval(() => {
          if (document.visibilityState === 'visible') void load()
        }, REFRESH_MS)
        return () => window.clearInterval(timer)
      }, [load])

      if (data === null) {
        return h('div', { style: css.page }, error === null
          ? h('div', { style: css.muted }, T.loading)
          : h('div', null, h('span', { style: css.error }, fill(T.failed, { error })), ' ',
            h('button', { type: 'button', style: css.button, onClick: () => void load() }, T.retry)))
      }
      return h('div', { style: css.page },
        data.unavailable.map(key => h('div', { key, style: css.note }, T[`unavailable_${key}`] ?? key)),
        error !== null ? h('div', { style: css.error }, fill(T.failed, { error })) : null,
        h('div', { style: css.head },
          h('span', { style: css.title }, T.mcpTitle),
          h('button', { type: 'button', style: { ...css.button, opacity: busy ? 0.6 : 1 }, disabled: busy, onClick: () => void load() }, T.refresh)),
        h('div', { style: css.list }, data.mcp.length === 0
          ? h('div', { style: css.empty }, T.mcpEmpty)
          : data.mcp.map((server, index) => h(McpRow, { key: server.id || server.server, T, server, first: index === 0 }))),
        h('div', { style: css.head }, h('span', { style: css.title }, T.skillsTitle)),
        h('div', { style: css.list }, data.skills.length === 0
          ? h('div', { style: css.empty }, T.skillsEmpty)
          : data.skills.map((skill, index) => h('div', { key: skill.path ?? `${skill.source}:${skill.name}`, style: { ...css.skill, ...(index === 0 ? null : css.divider) } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { style: css.name }, skill.name),
              h('span', { style: css.badge }, skillSource(T, skill)),
              h('span', { style: css.grow }),
              h('span', { style: css.muted }, skillInvocation(T, skill))),
            skill.description ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, skill.description) : null,
            skill.path ? h('div', { style: css.code }, skill.path) : null))),
        data.projects.length > 0 ? h('div', { style: css.muted }, fill(T.projects, { list: data.projects.join(', ') })) : null)
    }

    module.exports.inject = ['slots', 'locale']
    module.exports.apply = (ctx) => {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, COPY), 'dsh-cloud-workspace-capabilities: copy')
      // Ordered after Agent presets (20): this section only reports.
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: 30,
        label: () => t('nav'),
        locale: NS,
      }, CapabilitiesSection)), 'dsh-cloud-workspace-capabilities: settings section')
    }
    return module.exports
  },
})
