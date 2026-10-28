/*
 * Knowledge base plugin, client face: a right-Sidebar tab to upload, list,
 * delete, and re-index documents, and a Settings → Plugins tab for the search
 * settings.
 *
 * Written directly in dsh's client bundle format (the closure factory that
 * dsh's tsdown preset emits) so it needs no build step; `require` resolves
 * React and dsh's UI primitives from dsh's module table. The right-Sidebar
 * contract (`sidebarRightTabs.register`, the keyed `sidebar.right.pane.tab`
 * slot) is pre-stable: re-check after upgrading dsh.
 *
 * Requests are document-relative: `api/dshCloudKb/...` reaches the host face
 * (./index.js) through dsh's authenticated connection, and
 * `_dsh-cloud/kb/limits` asks the dsh-cloud gateway for the upload limits
 * (absent without the gateway).
 */
window.__ModuleLoader__.load({
  id: 'dsh-cloud-rag-kb',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { GuideArtworkFiles, IconDatabaseOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular, fileSizeText } = primitives

    const ID = 'dsh-cloud-rag-kb'
    const KIND = 'knowledge-base'
    const NS = 'dshCloudRagKb'
    const SETTINGS_NS = 'rag-kb'
    const COPY = {
      zh: {
        title: '知识库', description: '上传文档，Agent 回答时检索并标注出处',
        upload: '上传文档', reindex: '全部重建索引', reindexDone: '已开始重建 {n} 个文档',
        drop: '松开以上传到知识库', empty: '还没有文档。点「上传文档」或把文件拖到这里；也可以在对话里说「把 ~/docs/手册.pdf 加入知识库」。',
        types: '支持 {types}，单个文件不超过 {max}',
        usage: '{n} 个文档 · {used}', quota: '{n} 个文档 · {used} / {quota}', document: '', documentPlural: '',
        chunks: '{n} 块', queued: '排队中', indexing: '正在索引', progress: '正在索引 {done}/{total}', failed: '失败：{error}',
        uploading: '正在上传', uploadFailed: '上传失败：{error}',
        remove: '删除', confirmRemove: '从知识库删除？', confirmRemoveFile: '删除文档和 ~/knowledge 里的文件？', cancel: '取消',
        tooLarge: '文件超过 {max}', quotaExceeded: '超过知识库空间（{quota}）', unsupported: '不支持的文件类型', invalidName: '文件名不可用',
        unavailable: '知识库暂时不可用：{error}', saved: '对话保存', retry: '重试', dismiss: '关闭',
        settingsTab: '知识库', settingsTitle: '检索设置', settingsLoading: '正在读取设置…', settingsFailed: '读取设置失败：{error}',
        save: '保存', saving: '正在保存…', discard: '放弃更改', savedOk: '已保存，下次检索生效', noChanges: '没有更改', saveFailed: '保存失败：{error}',
        on: '开', off: '关',
        f_description: '知识库描述', h_description: 'Agent 检索前会读这段描述，知道库里有什么',
        f_searchMode: '检索时机', h_searchMode: '默认「仅在要求时」：只有你说「在知识库里查…」时才检索；「主动检索」会在问题可能涉及知识库文档时先查知识库',
        o_searchMode_explicit: '仅在要求时', o_searchMode_proactive: '主动检索',
        f_topK: '检索返回条数', h_topK: '默认 5',
        f_minScore: '相似度阈值', h_minScore: '0～1，默认 0.3；越低结果越多、噪音越多',
        f_enableReranker: 'Reranker 重排序', h_enableReranker: '首次使用会下载约 1 GB 的模型并占用更多内存',
        f_rerankTopN: '重排后返回条数', h_rerankTopN: '默认 3',
      },
      en: {
        title: 'Knowledge base', description: 'Upload documents; the agent searches them and cites its sources',
        upload: 'Upload', reindex: 'Re-index all', reindexDone: 'Re-indexing {n} documents',
        drop: 'Drop to add to the knowledge base', empty: 'No documents yet. Upload or drop files here, or say "add ~/docs/handbook.pdf to the knowledge base" in a conversation.',
        types: 'Supports {types}, up to {max} per file',
        usage: '{n} {documents} · {used}', quota: '{n} {documents} · {used} of {quota}', document: 'document', documentPlural: 'documents',
        chunks: '{n} chunks', queued: 'Queued', indexing: 'Indexing', progress: 'Indexing {done}/{total}', failed: 'Failed: {error}',
        uploading: 'Uploading', uploadFailed: 'Upload failed: {error}',
        remove: 'Delete', confirmRemove: 'Remove from the knowledge base?', confirmRemoveFile: 'Delete the document and its file in ~/knowledge?', cancel: 'Cancel',
        tooLarge: 'Larger than {max}', quotaExceeded: 'Exceeds the knowledge base space ({quota})', unsupported: 'Unsupported file type', invalidName: 'Unusable file name',
        unavailable: 'The knowledge base is unavailable: {error}', saved: 'Saved from a conversation', retry: 'Retry', dismiss: 'Dismiss',
        settingsTab: 'Knowledge base', settingsTitle: 'Search settings', settingsLoading: 'Loading settings…', settingsFailed: 'Could not load settings: {error}',
        save: 'Save', saving: 'Saving…', discard: 'Discard', savedOk: 'Saved; applies to the next search', noChanges: 'No changes', saveFailed: 'Could not save: {error}',
        on: 'On', off: 'Off',
        f_description: 'Description', h_description: 'The agent reads this before searching, to know what the knowledge base holds',
        f_searchMode: 'When to search', h_searchMode: 'By default the agent searches only when you ask it to look in the knowledge base; Proactive also searches first when a question may concern its documents',
        o_searchMode_explicit: 'Only when asked', o_searchMode_proactive: 'Proactive',
        f_topK: 'Results per search', h_topK: 'Default 5',
        f_minScore: 'Similarity threshold', h_minScore: '0–1, default 0.3; lower returns more results and more noise',
        f_enableReranker: 'Reranker', h_enableReranker: 'Downloads a model of about 1 GB at first use and needs more memory',
        f_rerankTopN: 'Results after reranking', h_rerankTopN: 'Default 3',
      },
    }
    /** Replace `{name}` placeholders in a localized string. */
    const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''))

    const DOCUMENTS = 'api/dshCloudKb/documents'
    const REINDEX = 'api/dshCloudKb/reindex'
    const UPLOAD = 'api/dshCloudKb/upload'
    const LIMITS = '_dsh-cloud/kb/limits'

    async function request(path, init) {
      const response = await fetch(new URL(path, document.baseURI), { credentials: 'same-origin', ...init })
      let body = null
      try {
        body = await response.json()
      } catch (err) {
        // Not JSON (e.g. an HTML error page from a proxy): the status says enough.
        console.debug('dsh-cloud-rag-kb: non-JSON response', err)
      }
      return { status: response.status, ok: response.ok, body }
    }

    /** Localized reason for a refused upload. */
    function uploadError(T, result, limits) {
      const code = result.body?.code
      const max = fileSizeText(result.body?.limit ?? limits.maxFileBytes ?? 0)
      if (code === 'too-large' || (result.status === 413 && code !== 'quota')) return fill(T.tooLarge, { max })
      if (code === 'quota') return fill(T.quotaExceeded, { quota: fileSizeText(limits.quotaBytes ?? 0) })
      if (code === 'unsupported-type') return T.unsupported
      if (code === 'invalid-name') return T.invalidName
      return result.body?.detail ?? result.body?.message ?? `HTTP ${result.status}`
    }

    const css = {
      root: { position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: 'var(--dsw-alias-label-primary)', fontSize: 13 },
      header: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px 8px', borderBottom: '0.5px solid var(--dsw-alias-border-l4)' },
      summary: { flex: 1, minWidth: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      button: { display: 'inline-flex', alignItems: 'center', gap: 4, height: 28, padding: '0 10px', border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 8, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' },
      primary: { border: 'none', background: 'var(--dsw-static-deepseek-500, #4d6bfe)', color: '#fff' },
      icon: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, border: 'none', borderRadius: 8, background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', flex: 'none' },
      list: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 4px 12px' },
      row: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 8px', borderRadius: 8 },
      name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      error: { color: 'var(--dsw-alias-label-error, #e5484d)' },
      note: { padding: '10px 12px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
      empty: { padding: 24, textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.7 },
      drop: { position: 'absolute', inset: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 12, border: '1.5px dashed var(--dsw-static-deepseek-500, #4d6bfe)', background: 'color-mix(in srgb, var(--dsw-static-deepseek-500, #4d6bfe) 8%, transparent)', pointerEvents: 'none' },
      bar: { height: 3, borderRadius: 2, marginTop: 4, background: 'var(--dsw-alias-border-l4)', overflow: 'hidden' },
    }

    function KnowledgeBaseTitle({ t }) {
      return h(React.Fragment, null,
        h('span', { style: { display: 'inline-flex', flex: '0 0 auto', marginRight: 4 } }, h(IconDatabaseOutlineRegular, null)),
        h('span', { style: { minWidth: 0, marginRight: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t('title')))
    }

    function KnowledgeBase({ t }) {
      const T = new Proxy({}, { get: (_, key) => t(key) })
      const [view, setView] = useState(null)
      const [error, setError] = useState(null)
      const [limits, setLimits] = useState({})
      const [uploads, setUploads] = useState([])
      const [confirming, setConfirming] = useState(null)
      const [dragging, setDragging] = useState(false)
      const [notice, setNotice] = useState(null)
      const picker = useRef(null)
      const dragDepth = useRef(0)

      const load = useCallback(async () => {
        try {
          const result = await request(DOCUMENTS)
          if (!result.ok) throw new Error(result.body?.message ?? `HTTP ${result.status}`)
          setView(result.body)
          setError(null)
        } catch (err) {
          setError(String(err?.message ?? err))
        }
      }, [])

      useEffect(() => {
        void request(LIMITS).then(r => { if (r.ok && r.body) setLimits(r.body) }, () => undefined)
      }, [])

      // Poll quickly while something is being indexed, rarely otherwise, and not while the page is hidden.
      const busy = uploads.some(u => u.status === 'uploading') || (view?.documents ?? []).some(d => d.status === 'queued' || d.status === 'indexing')
      useEffect(() => {
        let timer = 0
        let stopped = false
        const tick = async () => {
          if (document.visibilityState === 'visible') await load()
          if (!stopped) timer = window.setTimeout(tick, busy ? 1000 : 10000)
        }
        void tick()
        return () => {
          stopped = true
          window.clearTimeout(timer)
        }
      }, [load, busy])

      const maxFileBytes = Math.min(view?.maxFileBytes ?? Infinity, limits.maxFileBytes ?? Infinity)
      const extensions = view?.extensions ?? []

      async function uploadFiles(files) {
        for (const file of files) {
          const key = `${file.name}:${Date.now()}:${Math.random()}`
          const fail = (message) => setUploads(list => list.map(u => (u.key === key ? { ...u, status: 'failed', message } : u)))
          setUploads(list => [...list, { key, name: file.name, status: 'uploading' }])
          const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : ''
          if (extensions.length > 0 && !extensions.includes(ext)) {
            fail(T.unsupported)
            continue
          }
          if (file.size > maxFileBytes) {
            fail(fill(T.tooLarge, { max: fileSizeText(maxFileBytes) }))
            continue
          }
          try {
            const result = await request(`${UPLOAD}?name=${encodeURIComponent(file.name)}`, {
              method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' },
            })
            if (!result.ok) {
              fail(uploadError(T, result, { ...limits, maxFileBytes }))
              continue
            }
            setUploads(list => list.filter(u => u.key !== key))
          } catch (err) {
            fail(String(err?.message ?? err))
          }
          await load()
        }
      }

      async function remove(doc) {
        setConfirming(null)
        const result = await request(`${DOCUMENTS}?id=${encodeURIComponent(doc.id)}`, { method: 'DELETE' })
        if (!result.ok && result.status !== 404) setNotice(result.body?.message ?? `HTTP ${result.status}`)
        await load()
      }

      async function reindex() {
        const result = await request(REINDEX, { method: 'POST' })
        setNotice(result.ok ? fill(T.reindexDone, { n: result.body?.queued ?? 0 }) : `HTTP ${result.status}`)
        await load()
      }

      function statusText(doc) {
        if (doc.status === 'queued') return T.queued
        if (doc.status === 'indexing') return doc.progress ? fill(T.progress, doc.progress) : T.indexing
        if (doc.status === 'failed') return h('span', { style: css.error }, fill(T.failed, { error: doc.error || '?' }))
        return fill(T.chunks, { n: doc.chunks })
      }

      const documents = view?.documents ?? []
      const used = fileSizeText(view?.usedBytes ?? 0)
      const counted = { n: documents.length, documents: documents.length === 1 ? T.document : T.documentPlural, used }
      const summary = limits.quotaBytes
        ? fill(T.quota, { ...counted, quota: fileSizeText(limits.quotaBytes) })
        : fill(T.usage, counted)

      return h('div', {
        style: css.root,
        onDragEnter: (e) => {
          if (![...e.dataTransfer.types].includes('Files')) return
          dragDepth.current++
          setDragging(true)
        },
        onDragLeave: () => {
          if (--dragDepth.current <= 0) setDragging(false)
        },
        onDragOver: (e) => {
          if ([...e.dataTransfer.types].includes('Files')) e.preventDefault()
        },
        onDrop: (e) => {
          e.preventDefault()
          dragDepth.current = 0
          setDragging(false)
          void uploadFiles([...e.dataTransfer.files])
        },
      },
      h('div', { style: css.header },
        h('span', { style: css.summary, title: summary }, summary),
        h('button', { type: 'button', style: css.icon, title: T.reindex, 'aria-label': T.reindex, disabled: documents.length === 0, onClick: () => void reindex() }, h(IconRefreshOutlineRegular, null)),
        h('button', { type: 'button', style: { ...css.button, ...css.primary }, onClick: () => picker.current?.click() }, h(IconPlusOutlineRegular, null), T.upload),
        h('input', {
          ref: picker, type: 'file', multiple: true, hidden: true, accept: extensions.join(','),
          onChange: (e) => {
            const files = [...e.target.files]
            e.target.value = ''
            void uploadFiles(files)
          },
        }),
      ),
      error !== null ? h('div', { style: { ...css.note, ...css.error } }, fill(T.unavailable, { error }), ' ',
        h('button', { type: 'button', style: css.button, onClick: () => void load() }, T.retry)) : null,
      notice !== null ? h('div', { style: { ...css.note, display: 'flex', alignItems: 'center', gap: 8 } },
        h('span', { style: { flex: 1 } }, notice),
        h('button', { type: 'button', style: css.button, onClick: () => setNotice(null) }, T.dismiss)) : null,
      h('div', { style: css.list },
        uploads.map(u => h('div', { key: u.key, style: css.row },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: css.name }, u.name),
            h('div', { style: { ...css.meta, ...(u.status === 'failed' ? css.error : {}) } }, u.status === 'failed' ? fill(T.uploadFailed, { error: u.message }) : T.uploading)),
          u.status === 'failed' ? h('button', { type: 'button', style: css.button, onClick: () => setUploads(list => list.filter(x => x.key !== u.key)) }, T.dismiss) : null,
        )),
        documents.map(doc => h('div', { key: doc.id, style: css.row },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: css.name, title: doc.name }, doc.name),
            confirming === doc.id
              ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 } },
                h('span', { style: { ...css.meta, flex: 1 } }, doc.inKnowledgeDir ? T.confirmRemoveFile : T.confirmRemove),
                h('button', { type: 'button', style: { ...css.button, ...css.primary }, onClick: () => void remove(doc) }, T.remove),
                h('button', { type: 'button', style: css.button, onClick: () => setConfirming(null) }, T.cancel))
              : h('div', { style: css.meta },
                doc.source === 'save' ? `${T.saved} · ` : doc.bytes ? `${fileSizeText(doc.bytes)} · ` : '',
                statusText(doc)),
            doc.progress ? h('div', { style: css.bar }, h('div', { style: { height: '100%', width: `${(100 * doc.progress.done) / doc.progress.total}%`, background: 'var(--dsw-static-deepseek-500, #4d6bfe)' } })) : null,
          ),
          doc.removable && confirming !== doc.id
            ? h('button', { type: 'button', style: css.icon, title: T.remove, 'aria-label': T.remove, onClick: () => setConfirming(doc.id) }, h(IconTrashOutlineRegular, null))
            : null,
        )),
        view !== null && documents.length === 0 && uploads.length === 0 ? h('div', { style: css.empty }, T.empty) : null,
        extensions.length > 0 ? h('div', { style: css.note }, fill(T.types, { types: extensions.join(' '), max: fileSizeText(maxFileBytes) })) : null,
      ),
      dragging ? h('div', { style: css.drop }, T.drop) : null)
    }

    // ── Settings → Plugins → Knowledge base ──
    const FIELDS = [
      { key: 'description', type: 'string' },
      { key: 'searchMode', type: 'choice', options: ['explicit', 'proactive'] },
      { key: 'topK', type: 'number' },
      { key: 'minScore', type: 'number' },
      { key: 'enableReranker', type: 'boolean' },
      { key: 'rerankTopN', type: 'number' },
    ]

    function KnowledgeBaseSettings({ t, settings }) {
      const T = new Proxy({}, { get: (_, key) => t(key) })
      const [view, setView] = useState(null)
      const [error, setError] = useState(null)
      const [draft, setDraft] = useState(null)
      const [saving, setSaving] = useState(false)
      const [message, setMessage] = useState(null)

      const reload = useCallback(async () => {
        setError(null)
        const response = await settings.describe()
        if (!response.ok) {
          setError(response.error?.message ?? 'settings.describe failed')
          return
        }
        const hit = (response.value?.namespaces ?? []).find(row => row.ns === SETTINGS_NS)
        if (!hit) {
          setError(`no ${SETTINGS_NS} settings`)
          return
        }
        setView(hit)
        setDraft(null)
      }, [settings])
      useEffect(() => {
        reload().catch(err => setError(String(err?.message ?? err)))
      }, [reload])

      if (error !== null) return h('div', { style: css.note }, fill(T.settingsFailed, { error }), ' ', h('button', { type: 'button', style: css.button, onClick: () => void reload() }, T.retry))
      if (view === null) return h('div', { style: css.note }, T.settingsLoading)
      const current = view.value ?? {}
      const shown = draft ?? current

      async function save() {
        setSaving(true)
        try {
          const ops = []
          for (const field of FIELDS) {
            if (draft[field.key] === undefined) continue
            const value = field.type === 'number' ? Number(draft[field.key]) : draft[field.key]
            if (field.type === 'number' && (draft[field.key] === '' || Number.isNaN(value))) continue
            if (JSON.stringify(value) !== JSON.stringify(current[field.key])) ops.push({ op: 'set', path: [field.key], value })
          }
          if (ops.length > 0) {
            const response = await settings.mutate(view.ns, ops, view.revision)
            if (!response.ok) throw new Error(response.error?.message ?? 'settings.mutate failed')
          }
          setMessage(ops.length > 0 ? T.savedOk : T.noChanges)
          await reload()
        } catch (err) {
          setMessage(fill(T.saveFailed, { error: String(err?.message ?? err) }))
        } finally {
          setSaving(false)
        }
      }

      const input = { width: '100%', boxSizing: 'border-box', height: 30, padding: '0 10px', border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', color: 'inherit', font: 'inherit' }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
        h('strong', null, T.settingsTitle),
        FIELDS.map(field => h('label', { key: field.key, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('span', null, t(`f_${field.key}`)),
          field.type === 'boolean' || field.type === 'choice'
            ? h('span', { style: { display: 'flex', gap: 12 } }, (field.options ?? [true, false]).map(value => h('label', { key: String(value), style: { display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' } },
              h('input', { type: 'radio', name: field.key, checked: field.type === 'boolean' ? (shown[field.key] === true) === value : shown[field.key] === value, onChange: () => setDraft({ ...(draft ?? current), [field.key]: value }) }),
              field.type === 'boolean' ? (value ? T.on : T.off) : t(`o_${field.key}_${value}`))))
            : h('input', { style: input, value: String(shown[field.key] ?? ''), inputMode: field.type === 'number' ? 'decimal' : undefined, onChange: (e) => setDraft({ ...(draft ?? current), [field.key]: e.target.value }) }),
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t(`h_${field.key}`)))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('button', { type: 'button', style: { ...css.button, ...css.primary, opacity: draft === null ? 0.6 : 1 }, disabled: saving || draft === null, onClick: () => void save() }, saving ? T.saving : T.save),
          draft !== null ? h('button', { type: 'button', style: css.button, disabled: saving, onClick: () => { setDraft(null); setMessage(null) } }, T.discard) : null,
          message !== null ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, message) : null))
    }

    module.exports.inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.settings']
    module.exports.apply = (ctx) => {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, COPY), 'dsh-cloud-rag-kb: copy')
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        priority: 'extension',
        title: () => t('title'),
        guide: [{ id: 'open', order: 32, title: () => t('title'), description: () => t('description'), icon: GuideArtworkFiles }],
      }), 'dsh-cloud-rag-kb: type')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: ID, locale: NS,
      }, KnowledgeBase)), 'dsh-cloud-rag-kb: body')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title', key: ID, locale: NS,
      }, KnowledgeBaseTitle)), 'dsh-cloud-rag-kb: title')
      ctx.effect(() => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: SETTINGS_NS,
        order: 50,
        label: () => t('settingsTab'),
        locale: NS,
        inject: () => ({ settings: ctx.remote.settings }),
      }, KnowledgeBaseSettings)), 'dsh-cloud-rag-kb: settings tab')
    }
    return module.exports
  },
})
