import { useCallback, useState } from 'react'

import { api, type WorkspaceImage } from '../../api.ts'
import { errorMessage, Field, formatTime, Modal, Spinner } from '../../ui.tsx'
import { Loading, useLoad } from '../Admin.tsx'

export function ImagesSection({ showToast }: { showToast: (m: string) => void }) {
  const load = useCallback(async () => {
    const [images, overview] = await Promise.all([api.images(), api.overview()])
    return { images, defaultImage: overview.default_image }
  }, [])
  const { data, error, reload } = useLoad(load)
  const [editing, setEditing] = useState<WorkspaceImage | 'new' | null>(null)
  const [checking, setChecking] = useState<number | null>(null)

  if (!data) return <Loading error={error} />

  async function check(image: WorkspaceImage) {
    setChecking(image.id)
    try {
      await api.checkImage(image.id)
      showToast(`${image.name} 可用，且与默认镜像兼容`)
      reload()
    } catch (err) {
      showToast(errorMessage(err))
    } finally {
      setChecking(null)
    }
  }

  async function remove(image: WorkspaceImage) {
    try {
      await api.deleteImage(image.id)
      showToast(`已删除 ${image.name}`)
      reload()
    } catch (err) {
      showToast(errorMessage(err))
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>镜像</h2>
          <p>工作空间运行在哪个镜像上由用户组决定。镜像决定系统软件，用户的对话、文件、记忆和插件不受影响，切换后原样保留。</p>
        </div>
        <button className="btn primary" onClick={() => setEditing('new')}>
          登记镜像
        </button>
      </div>
      <div className="stack">
        <section className="card">
          <h3>默认镜像</h3>
          <p className="sub">未指定镜像的用户组使用它；它也是其他镜像的兼容性基准（由网关配置 SANDBOX_DOCKER_IMAGE 决定）。</p>
          <span className="mono">{data.defaultImage}</span>
        </section>
        <div className="table-wrap">
          {data.images.length ? (
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>镜像地址</th>
                  <th>dsh 版本</th>
                  <th>用户组</th>
                  <th>上次检查</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.images.map((image) => (
                  <tr key={image.id}>
                    <td>
                      <div>{image.name}</div>
                      {image.description ? <div className="muted">{image.description}</div> : null}
                    </td>
                    <td className="mono">{image.ref}</td>
                    <td className="mono">{image.dsh_version || '—'}</td>
                    <td>{image.group_count ? `${image.group_count} 个` : <span className="muted">未使用</span>}</td>
                    <td className="muted">{formatTime(image.checked_at)}</td>
                    <td className="actions">
                      <button className="btn ghost sm" onClick={() => check(image)} disabled={checking !== null}>
                        {checking === image.id ? <Spinner /> : '检查'}
                      </button>
                      <button className="btn ghost sm" onClick={() => setEditing(image)}>
                        编辑
                      </button>
                      <button className="btn danger sm" onClick={() => remove(image)} disabled={image.group_count > 0}>
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">还没有登记团队镜像。用 sandbox-image/build.sh 构建后，在这里登记，再到「用户组」里选择。</div>
          )}
        </div>
      </div>
      {editing ? (
        <ImageEditor
          image={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null)
            showToast(message)
            reload()
          }}
        />
      ) : null}
    </div>
  )
}

function ImageEditor({
  image,
  onClose,
  onSaved,
}: {
  image: WorkspaceImage | null
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [name, setName] = useState(image?.name ?? '')
  const [ref, setRef] = useState(image?.ref ?? '')
  const [description, setDescription] = useState(image?.description ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      if (image) await api.updateImage(image.id, { name, description })
      else await api.createImage({ name, ref: ref.trim(), description })
      onSaved(`已保存 ${name}`)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={image ? `编辑 ${image.name}` : '登记镜像'}
      onClose={busy ? () => undefined : onClose}
      width={600}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !name || !ref}>
            {busy ? <Spinner /> : image ? '保存' : '检查并登记'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="名称">
          <input className="input" value={name} placeholder="数据科学" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="说明">
          <input className="input" value={description} placeholder="pandas、numpy、scikit-learn……" onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field
          label="镜像地址"
          wide
          hint={image ? '登记后不能修改。要升级，请登记新标签，再把用户组切过去。' : '用不可变的标签（日期或版本号），不要用 latest。本机没有时网关会拉取，镜像较大时需要等一会儿。'}
        >
          <input
            className="input mono"
            value={ref}
            disabled={!!image}
            placeholder="registry.example.com/dsh-sandbox-data-science:2026-10-20"
            onChange={(e) => setRef(e.target.value)}
          />
        </Field>
        {image ? null : (
          <div className="wide notice">
            登记时网关会确认镜像存在，且与默认镜像来自同一个基础镜像（dsh 版本和运行时一致），否则拒绝登记，避免用户切换后会话、插件或 venv 失效。
          </div>
        )}
        {error ? <div className="error-text wide">{error}</div> : null}
      </div>
    </Modal>
  )
}
