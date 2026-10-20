import { useState } from 'react'

import { api, type McpConfig, type Plugin, type PluginKind } from '../../api.ts'
import { errorMessage, Field, Modal } from '../../ui.tsx'
import { Loading, useLoad } from '../Admin.tsx'
import { RestartHint, RestartPrompt, runningAffected } from './RestartPrompt.tsx'

const KIND_LABEL: Record<PluginKind, string> = { bundle: 'dsh 插件', mcp: 'MCP 服务', patch: '配置补丁' }
const KIND_HELP: Record<PluginKind, string> = {
  bundle: '首次启动时用 dsh plugin add 装进用户的 profile 并启用，只装一次；之后用户可以自己删除。',
  mcp: '每次启动都通过管理员 overlay 注入 dsh-mcp-client，工具以 mcp__<serverName>__<tool> 出现。填写安装包时，会在 dsh 启动前为每个用户 npm install -g 一次（保存在用户目录）。',
  patch: '原样追加到管理员 overlay 的 Cordis 补丁行（id 覆盖或 insert），每次启动生效，优先于用户自己的补丁。',
}

const loadCatalog = async () => {
  const [plugins, groups, users] = await Promise.all([api.plugins(), api.groups(), api.users()])
  return { plugins, groups, users }
}

export function PluginsSection({ showToast }: { showToast: (m: string) => void }) {
  const { data: catalog, error, reload } = useLoad(loadCatalog)
  const [editing, setEditing] = useState<Plugin | 'new' | null>(null)
  const [restart, setRestart] = useState<string[]>([])

  if (!catalog) return <Loading error={error} />
  const data = catalog.plugins

  async function remove(plugin: Plugin) {
    try {
      await api.deletePlugin(plugin.id)
      showToast(`已删除 ${plugin.name}`)
      reload()
    } catch (err) {
      showToast(errorMessage(err))
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>插件与 MCP</h2>
          <p>在这里维护插件目录，再到「用户组」或「用户」里分配。用户自己在 dsh 里装的插件不受影响，会随数据一起保留。</p>
        </div>
        <button className="btn primary" onClick={() => setEditing('new')}>
          添加
        </button>
      </div>
      <div className="table-wrap">
        {data.length ? (
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>配置</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div>{p.name}</div>
                    <div className="muted mono">{p.key}</div>
                  </td>
                  <td>
                    <span className="badge plain">{KIND_LABEL[p.kind]}</span>
                  </td>
                  <td className="mono" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {summary(p)}
                  </td>
                  <td className="actions">
                    <button className="btn ghost sm" onClick={() => setEditing(p)}>
                      编辑
                    </button>
                    <button className="btn danger sm" onClick={() => remove(p)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">还没有插件。点击「添加」登记一个 dsh 插件包、MCP 服务或配置补丁。</div>
        )}
      </div>
      {editing ? (
        <PluginEditor
          plugin={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            const affected =
              editing === 'new' ? [] : runningAffected(catalog.users, catalog.groups, { pluginId: editing.id })
            setEditing(null)
            showToast(message)
            setRestart(affected)
            reload()
          }}
        />
      ) : null}
      {restart.length ? <RestartPrompt usernames={restart} onClose={() => setRestart([])} showToast={showToast} /> : null}
    </div>
  )
}

function summary(p: Plugin): string {
  if (p.kind === 'bundle') return p.config.spec ?? ''
  if (p.kind === 'mcp') {
    return p.config.transport === 'stdio'
      ? `${p.config.serverName} · ${[p.config.command, ...(p.config.args ?? [])].join(' ')}`
      : `${p.config.serverName} · ${p.config.url}`
  }
  return (p.config.yaml ?? '').split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) ?? ''
}

function toLines(map: Record<string, string> | undefined, sep: string): string {
  return Object.entries(map ?? {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n')
}

function fromLines(text: string, sep: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const index = line.indexOf(sep)
    if (index > 0) result[line.slice(0, index).trim()] = line.slice(index + sep.length).trim()
  }
  return result
}

function PluginEditor({ plugin, onClose, onSaved }: { plugin: Plugin | null; onClose: () => void; onSaved: (m: string) => void }) {
  const [kind, setKind] = useState<PluginKind>(plugin?.kind ?? 'bundle')
  const [key, setKey] = useState(plugin?.key ?? '')
  const [name, setName] = useState(plugin?.name ?? '')
  const [description, setDescription] = useState(plugin?.description ?? '')
  const [spec, setSpec] = useState(plugin?.config.spec ?? '')
  const [yaml, setYaml] = useState(plugin?.config.yaml ?? '- id: \n  disabled: true\n')
  const [serverName, setServerName] = useState(plugin?.config.serverName ?? '')
  const [transport, setTransport] = useState<McpConfig['transport']>(plugin?.config.transport ?? 'stdio')
  const [command, setCommand] = useState(plugin?.config.command ?? '')
  const [args, setArgs] = useState((plugin?.config.args ?? []).join('\n'))
  const [env, setEnv] = useState(toLines(plugin?.config.env, '='))
  const [url, setUrl] = useState(plugin?.config.url ?? '')
  const [headers, setHeaders] = useState(toLines(plugin?.config.headers, ': '))
  const [install, setInstall] = useState(plugin?.config.install ?? '')
  const [error, setError] = useState<string | null>(null)

  function config(): Plugin['config'] {
    if (kind === 'bundle') return { spec }
    if (kind === 'patch') return { yaml }
    return transport === 'stdio'
      ? { serverName, transport, command, args: args.split('\n').filter((a) => a.trim()), env: fromLines(env, '='), install }
      : { serverName, transport, url, headers: fromLines(headers, ':') }
  }

  async function save() {
    setError(null)
    try {
      const body = { key, kind, name, description, config: config() }
      if (plugin) await api.updatePlugin(plugin.id, body)
      else await api.createPlugin(body)
      onSaved(`已保存 ${name}`)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Modal
      title={plugin ? `编辑 ${plugin.name}` : '添加插件'}
      onClose={onClose}
      width={640}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save} disabled={!key || !name}>
            保存
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="field wide">
          <span>类型</span>
          <div className="segmented" style={{ alignSelf: 'flex-start' }}>
            {(Object.keys(KIND_LABEL) as PluginKind[]).map((k) => (
              <button key={k} type="button" className={kind === k ? 'on' : ''} onClick={() => setKind(k)} disabled={!!plugin && plugin.kind !== k}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <div className="hint">{KIND_HELP[kind]}</div>
        </div>
        <Field label="名称">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="标识" hint="小写字母、数字、连字符；作为下发记录的键">
          <input className="input" value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Field label="说明" wide>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {kind === 'bundle' ? (
          <Field label="插件包 spec" wide hint="pnpm add 接受的写法：npm 包名@版本、git 地址或 tarball URL。云电脑需要能访问对应的源。">
            <input className="input mono" value={spec} placeholder="@deepseek-ai/dsh-subagent-codex@0.2.1-rc.2" onChange={(e) => setSpec(e.target.value)} />
          </Field>
        ) : null}
        {kind === 'patch' ? (
          <Field label="Cordis 补丁（YAML 列表）" wide hint="可以用 dsh --profile web --dump-config 查看可覆盖的行 id；支持 !!js 表达式。">
            <textarea className="input" rows={10} value={yaml} onChange={(e) => setYaml(e.target.value)} />
          </Field>
        ) : null}
        {kind === 'mcp' ? (
          <>
            <Field label="serverName" hint="工具名前缀，字母数字 _ -">
              <input className="input mono" value={serverName} onChange={(e) => setServerName(e.target.value)} />
            </Field>
            <Field label="传输方式">
              <div className="segmented">
                <button type="button" className={transport === 'stdio' ? 'on' : ''} onClick={() => setTransport('stdio')}>
                  stdio
                </button>
                <button type="button" className={transport === 'streamable-http' ? 'on' : ''} onClick={() => setTransport('streamable-http')}>
                  Streamable HTTP
                </button>
              </div>
            </Field>
            {transport === 'stdio' ? (
              <>
                <Field label="安装包（可选）" hint="npm spec，如 @modelcontextprotocol/server-memory@2026.7.4">
                  <input className="input mono" value={install} onChange={(e) => setInstall(e.target.value)} />
                </Field>
                <Field label="command" hint="安装包提供的命令名，或镜像里已有的可执行文件；不建议用 npx">
                  <input className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} />
                </Field>
                <Field label="args（每行一个）">
                  <textarea className="input" rows={4} value={args} onChange={(e) => setArgs(e.target.value)} />
                </Field>
                <Field label="env（每行 KEY=VALUE）" hint="会写进云电脑里的配置文件，用户可读">
                  <textarea className="input" rows={4} value={env} onChange={(e) => setEnv(e.target.value)} />
                </Field>
              </>
            ) : (
              <>
                <Field label="URL" wide>
                  <input className="input mono" value={url} placeholder="https://mcp.example.com/mcp" onChange={(e) => setUrl(e.target.value)} />
                </Field>
                <Field label="headers（每行 Name: Value）" wide hint="会写进云电脑里的配置文件，用户可读">
                  <textarea className="input" rows={3} value={headers} onChange={(e) => setHeaders(e.target.value)} />
                </Field>
              </>
            )}
          </>
        ) : null}
        {plugin ? (
          <div className="wide">
            <RestartHint />
          </div>
        ) : null}
        {error ? <div className="error-text wide">{error}</div> : null}
      </div>
    </Modal>
  )
}

/** Checkbox list of catalog entries; `inherited` ones come from the group and show as fixed. */
export function PluginPicker({
  plugins,
  selected,
  inherited = [],
  onChange,
}: {
  plugins: Plugin[]
  selected: number[]
  inherited?: number[]
  onChange: (ids: number[]) => void
}) {
  if (!plugins.length) return <div className="muted">插件目录为空，先到「插件与 MCP」添加。</div>
  return (
    <div className="stack" style={{ gap: 8 }}>
      {plugins.map((p) => {
        const fromGroup = inherited.includes(p.id)
        return (
          <label key={p.id} className="checkbox" style={fromGroup ? { opacity: 0.6 } : undefined}>
            <input
              type="checkbox"
              checked={fromGroup || selected.includes(p.id)}
              disabled={fromGroup}
              onChange={(e) => onChange(e.target.checked ? [...selected, p.id] : selected.filter((id) => id !== p.id))}
            />
            <span>
              {p.name} <span className="muted">· {KIND_LABEL[p.kind]}{fromGroup ? ' · 来自用户组' : ''}</span>
            </span>
          </label>
        )
      })}
    </div>
  )
}
