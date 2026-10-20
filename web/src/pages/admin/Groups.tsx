import { useCallback, useState } from 'react'

import { api, type Group, type Plugin } from '../../api.ts'
import { errorMessage, Field, formatDuration, Modal } from '../../ui.tsx'
import { Loading, useLoad } from '../Admin.tsx'
import { PluginPicker } from './Plugins.tsx'
import { RestartHint, RestartPrompt, runningAffected } from './RestartPrompt.tsx'

export function GroupsSection({ showToast }: { showToast: (m: string) => void }) {
  const load = useCallback(async () => {
    const [groups, plugins, users] = await Promise.all([api.groups(), api.plugins(), api.users()])
    return { groups, plugins, users }
  }, [])
  const { data, error, reload } = useLoad(load)
  const [editing, setEditing] = useState<Group | 'new' | null>(null)
  const [restart, setRestart] = useState<string[]>([])

  if (!data) return <Loading error={error} />
  const pluginName = new Map(data.plugins.map((p) => [p.id, p.name]))

  async function remove(group: Group) {
    try {
      await api.deleteGroup(group.id)
      showToast(`已删除用户组 ${group.name}`)
      reload()
    } catch (err) {
      showToast(errorMessage(err))
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>用户组</h2>
          <p>每个用户属于一个组：组决定工作空间的资源、模型权限、配额和预装插件。修改在工作空间下次启动时生效。</p>
        </div>
        <button className="btn primary" onClick={() => setEditing('new')}>
          新建用户组
        </button>
      </div>
      <div className="stack">
        {data.groups.map((g, index) => (
          <section key={g.id} className="card">
            <div className="row between">
              <div>
                <h3>
                  {g.name} <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>· {g.user_count} 位用户{index === 0 ? ' · 默认组' : ''}</span>
                </h3>
                {g.description ? <div className="muted">{g.description}</div> : null}
              </div>
              <div className="row">
                <button className="btn ghost sm" onClick={() => setEditing(g)}>
                  编辑
                </button>
                {index === 0 ? null : (
                  <button className="btn danger sm" onClick={() => remove(g)}>
                    删除
                  </button>
                )}
              </div>
            </div>
            <div className="hero-meta" style={{ marginTop: 10 }}>
              <span>内存 {g.mem_limit}</span>
              <span>CPU {g.cpus} 核</span>
              <span>空闲 {formatDuration(g.idle_timeout_s)} 后休眠</span>
              <span>最长运行 {formatDuration(g.max_lifetime_s)}</span>
              <span>{g.allow_shared_key ? '可用共享 Key' : '必须使用自有 Key'}</span>
              <span>{g.daily_request_limit ? `每日 ${g.daily_request_limit} 次请求` : '请求不限次'}</span>
              <span>{g.allowed_models.length ? `模型：${g.allowed_models.join('、')}` : '模型不限'}</span>
            </div>
            <div className="chip-list" style={{ marginTop: 12 }}>
              {g.plugin_ids.length ? (
                g.plugin_ids.map((id) => (
                  <span key={id} className="chip">
                    {pluginName.get(id)}
                  </span>
                ))
              ) : (
                <span className="muted">未分配默认插件</span>
              )}
            </div>
          </section>
        ))}
      </div>
      {editing ? (
        <GroupEditor
          group={editing === 'new' ? null : editing}
          plugins={data.plugins}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            const affected = editing === 'new' ? [] : runningAffected(data.users, data.groups, { groupId: editing.id })
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

function GroupEditor({
  group,
  plugins,
  onClose,
  onSaved,
}: {
  group: Group | null
  plugins: Plugin[]
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [name, setName] = useState(group?.name ?? '')
  const [description, setDescription] = useState(group?.description ?? '')
  const [memLimit, setMemLimit] = useState(group?.mem_limit ?? '2g')
  const [cpus, setCpus] = useState(String(group?.cpus ?? 2))
  const [idleMinutes, setIdleMinutes] = useState(String(Math.round((group?.idle_timeout_s ?? 900) / 60)))
  const [lifetimeHours, setLifetimeHours] = useState(String((group?.max_lifetime_s ?? 28800) / 3600))
  const [allowShared, setAllowShared] = useState(group?.allow_shared_key ?? true)
  const [dailyLimit, setDailyLimit] = useState(String(group?.daily_request_limit ?? 0))
  const [models, setModels] = useState((group?.allowed_models ?? []).join(', '))
  const [pluginIds, setPluginIds] = useState<number[]>(group?.plugin_ids ?? [])
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setError(null)
    const body: Partial<Group> = {
      name,
      description,
      mem_limit: memLimit.trim(),
      cpus: Number(cpus),
      idle_timeout_s: Math.round(Number(idleMinutes) * 60),
      max_lifetime_s: Math.round(Number(lifetimeHours) * 3600),
      allow_shared_key: allowShared,
      daily_request_limit: Number(dailyLimit) || 0,
      allowed_models: models.split(/[,，\s]+/).filter(Boolean),
      plugin_ids: pluginIds,
    }
    try {
      if (group) await api.updateGroup(group.id, body)
      else await api.createGroup(body)
      onSaved(`已保存用户组 ${name}`)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Modal
      title={group ? `编辑用户组 ${group.name}` : '新建用户组'}
      onClose={onClose}
      width={640}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save} disabled={!name}>
            保存
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="组名">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!group} />
        </Field>
        <Field label="说明">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="内存上限" hint="Docker 格式，如 2g、4g、512m">
          <input className="input" value={memLimit} onChange={(e) => setMemLimit(e.target.value)} />
        </Field>
        <Field label="CPU 核数">
          <input className="input" type="number" min={0.5} step={0.5} value={cpus} onChange={(e) => setCpus(e.target.value)} />
        </Field>
        <Field label="空闲多久后休眠（分钟）" hint="没有浏览器连接且无模型请求时开始计时">
          <input className="input" type="number" min={1} value={idleMinutes} onChange={(e) => setIdleMinutes(e.target.value)} />
        </Field>
        <Field label="单次最长运行（小时）">
          <input className="input" type="number" min={0.1} step={0.5} value={lifetimeHours} onChange={(e) => setLifetimeHours(e.target.value)} />
        </Field>
        <Field label="每日模型请求上限" hint="0 表示不限">
          <input className="input" type="number" min={0} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} />
        </Field>
        <Field label="允许的模型" hint="逗号分隔，留空表示不限">
          <input className="input" value={models} placeholder="deepseek-chat, deepseek-reasoner" onChange={(e) => setModels(e.target.value)} />
        </Field>
        <div className="field wide">
          <label className="checkbox">
            <input type="checkbox" checked={allowShared} onChange={(e) => setAllowShared(e.target.checked)} />
            允许使用团队共享 API Key（关闭后组内用户必须在账号设置里填写自己的 Key）
          </label>
        </div>
        <div className="field wide">
          <span>默认插件</span>
          <PluginPicker plugins={plugins} selected={pluginIds} onChange={setPluginIds} />
        </div>
        {group ? (
          <div className="wide">
            <RestartHint />
          </div>
        ) : null}
        {error ? <div className="error-text wide">{error}</div> : null}
      </div>
    </Modal>
  )
}
