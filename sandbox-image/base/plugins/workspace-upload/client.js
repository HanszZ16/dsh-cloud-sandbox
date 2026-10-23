/*
 * Workspace upload plugin, client face: an upload button in the Files panel's
 * header (the `sidebar.right.tab.files.actions` slot) that sends files, or a
 * whole folder with its subfolders, into the Session's working directory.
 *
 * Written directly in dsh's client bundle format (the closure factory that
 * dsh's tsdown preset emits) so it needs no build step; `require` resolves
 * React and dsh's UI primitives from dsh's module table. The slot is
 * pre-stable: re-check after upgrading dsh.
 *
 * Requests are document-relative: `api/dshCloudFiles/...` reaches the host
 * face (./index.js) through dsh's authenticated connection, and
 * `_dsh-cloud/files/limits` asks the dsh-cloud gateway for its upload limit
 * (absent without the gateway). Files are sent one at a time through
 * XMLHttpRequest, which reports upload progress.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cloud-workspace-upload',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const { useEffect, useLayoutEffect, useRef, useState } = React
    const { Tooltip, fileSizeText } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'dshCloudWorkspaceUpload'
    const COPY = {
      zh: {
        upload: '上传', uploadFiles: '上传文件', uploadFolder: '上传文件夹',
        into: '上传到 {root}', limit: '单个文件不超过 {max}',
        checking: '正在检查…', progress: '正在上传 {done}/{total}', cancel: '取消',
        conflict: '{n} 个文件已存在', conflictOne: '1 个文件已存在', overwrite: '覆盖', keepBoth: '保留两个', skip: '跳过',
        done: '已上传 {n} 个文件', doneWithFailures: '已上传 {n} 个，{failed} 个失败', cancelled: '已取消，上传了 {n} 个文件',
        dismiss: '关闭', nothing: '没有可上传的文件（空文件夹不会上传）',
        tooLarge: '超过 {max}', exists: '已存在', isDirectory: '同名文件夹已存在', notDirectory: '路径里有同名文件，不是文件夹', notFile: '同名的不是普通文件',
        invalidPath: '文件名不可用', outside: '目标在工作区外', noWorkspace: '这个会话没有工作区', asleep: '工作空间已休眠，请刷新页面',
        file: '', filePlural: '', network: '网络中断', failed: '失败：{error}', failureLine: '{path}：{message}',
      },
      en: {
        upload: 'Upload', uploadFiles: 'Upload files', uploadFolder: 'Upload folder',
        into: 'Uploads to {root}', limit: 'Up to {max} per file',
        checking: 'Checking…', progress: 'Uploading {done} of {total}', cancel: 'Cancel',
        conflict: '{n} files already exist', conflictOne: '1 file already exists', overwrite: 'Replace', keepBoth: 'Keep both', skip: 'Skip',
        done: 'Uploaded {n} {files}', doneWithFailures: 'Uploaded {n}, {failed} failed', cancelled: 'Cancelled after {n} {files}',
        dismiss: 'Dismiss', nothing: 'Nothing to upload (empty folders are not uploaded)',
        tooLarge: 'Larger than {max}', exists: 'Already exists', isDirectory: 'A folder has this name', notDirectory: 'A file on the path is not a folder', notFile: 'Something other than a file has this name',
        invalidPath: 'Unusable file name', outside: 'Outside the workspace', noWorkspace: 'This conversation has no workspace', asleep: 'The workspace is asleep; reload the page',
        file: 'file', filePlural: 'files', network: 'Connection lost', failed: 'Failed: {error}', failureLine: '{path}: {message}',
      },
    }
    /** Replace `{name}` placeholders in a localized string. */
    const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''))

    const CHECK = 'api/dshCloudFiles/check'
    const UPLOAD = 'api/dshCloudFiles/upload'
    const LIMITS = '_dsh-cloud/files/limits'
    const url = (path) => new URL(path, document.baseURI)

    async function requestJson(path, init) {
      const response = await fetch(url(path), { credentials: 'same-origin', ...init })
      let body = null
      try {
        body = await response.json()
      } catch (err) {
        // Not JSON (e.g. an HTML error page from a proxy): the status says enough.
        console.debug('dsh-cloud-workspace-upload: non-JSON response', err)
      }
      return { status: response.status, ok: response.ok, body }
    }

    /** POST one file; resolves with the status and JSON body, rejects on a network failure or `signal`. */
    function sendFile(path, file, onProgress, signal) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', url(path))
        xhr.withCredentials = true
        xhr.setRequestHeader('content-type', 'application/octet-stream')
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded) }
        xhr.onload = () => {
          let body = null
          try {
            body = JSON.parse(xhr.responseText)
          } catch (err) {
            console.debug('dsh-cloud-workspace-upload: non-JSON response', err)
          }
          resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, body })
        }
        xhr.onerror = () => reject(new Error('network'))
        xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'))
        signal.addEventListener('abort', () => xhr.abort(), { once: true })
        xhr.send(file)
      })
    }

    /** Localized reason for a refused file. */
    function reason(T, code, status, maxFileBytes) {
      if (code === 'too-large' || status === 413) return fill(T.tooLarge, { max: fileSizeText(maxFileBytes) })
      if (code === 'exists') return T.exists
      if (code === 'is-directory') return T.isDirectory
      if (code === 'not-directory') return T.notDirectory
      if (code === 'not-file') return T.notFile
      if (code === 'invalid-path') return T.invalidPath
      if (code === 'outside-workspace') return T.outside
      if (code === 'no-workspace') return T.noWorkspace
      if (status === 503) return T.asleep
      return fill(T.failed, { error: code ?? `HTTP ${status}` })
    }

    function IconUpload({ size = 16 }) {
      return h('svg', { width: size, height: size, 'aria-hidden': true, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M8 10.4V2.6M4.9 5.6L8 2.5L11.1 5.6' }),
        h('path', { d: 'M2.6 9.6V12.2C2.6 12.86 3.14 13.4 3.8 13.4H12.2C12.86 13.4 13.4 12.86 13.4 12.2V9.6' }))
    }

    const css = {
      // The Files header's own icon buttons: a 28px square around a 15px glyph.
      tool: { display: 'inline-flex', flex: 'none', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, padding: 6, lineHeight: 1, border: 'none', borderRadius: 'var(--dsw-radius-sm)', cursor: 'pointer' },
      panel: { position: 'fixed', zIndex: 1000, width: 280, boxSizing: 'border-box', padding: 6, borderRadius: 10, background: 'var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2))', border: '0.5px solid var(--dsw-alias-border-l3)', boxShadow: '0 8px 24px rgba(0,0,0,.24)', color: 'var(--dsw-alias-label-primary)', fontSize: 13 },
      item: { display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', border: 'none', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' },
      note: { padding: '6px 10px 4px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' },
      line: { padding: '6px 10px', overflowWrap: 'anywhere' },
      name: { padding: '0 10px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      bar: { height: 3, margin: '8px 10px 4px', borderRadius: 2, background: 'var(--dsw-alias-border-l4)', overflow: 'hidden' },
      fill: { height: '100%', background: 'var(--dsw-static-deepseek-500, #4d6bfe)' },
      buttons: { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '6px 10px 4px' },
      button: { height: 26, padding: '0 10px', border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 7, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer' },
      primary: { border: 'none', background: 'var(--dsw-static-deepseek-500, #4d6bfe)', color: '#fff' },
      failures: { maxHeight: 160, overflowY: 'auto', padding: '2px 10px 4px', fontSize: 12 },
      failure: { padding: '2px 0', color: 'var(--dsw-alias-label-error, #e5484d)', overflowWrap: 'anywhere' },
    }

    /** Hover background for a plain button, since inline styles have no :hover. */
    function useHover() {
      const [hover, setHover] = useState(false)
      return [hover, { onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) }]
    }

    function MenuItem({ onClick, children }) {
      const [hover, handlers] = useHover()
      return h('button', { type: 'button', style: { ...css.item, background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent' }, onClick, ...handlers }, children)
    }

    function UploadAction({ t, sessionId, absolutePath }) {
      const T = new Proxy({}, { get: (_, key) => t(key) })
      const filesWord = (n) => (n === 1 ? T.file : T.filePlural)
      const [hover, hoverHandlers] = useHover()
      // menu | checking | conflict | uploading | result; null when closed.
      const [stage, setStage] = useState(null)
      const [job, setJob] = useState(null)
      const [limit, setLimit] = useState(Infinity)
      const [position, setPosition] = useState(null)
      const anchor = useRef(null)
      const panel = useRef(null)
      const filesInput = useRef(null)
      const folderInput = useRef(null)
      const abort = useRef(null)
      const pendingConflict = useRef(null)

      useEffect(() => {
        void requestJson(LIMITS).then(r => { if (r.ok && r.body?.maxFileBytes) setLimit(r.body.maxFileBytes) }, () => undefined)
      }, [])

      // Keep the panel under the button, right-aligned and inside the window.
      useLayoutEffect(() => {
        if (stage === null) return undefined
        const place = () => {
          const rect = anchor.current?.getBoundingClientRect()
          if (rect) setPosition({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.right - 280, window.innerWidth - 288)) })
        }
        place()
        window.addEventListener('resize', place)
        return () => window.removeEventListener('resize', place)
      }, [stage])

      // A click elsewhere or Escape closes the menu and a finished result; an upload in progress stays.
      useEffect(() => {
        if (stage !== 'menu' && stage !== 'result') return undefined
        const onDown = (e) => {
          if (!panel.current?.contains(e.target) && !anchor.current?.contains(e.target)) setStage(null)
        }
        const onKey = (e) => { if (e.key === 'Escape') setStage(null) }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [stage])

      async function begin(fileList) {
        const files = [...fileList].map(file => ({ file, path: file.webkitRelativePath || file.name }))
        if (files.length === 0) {
          setJob({ uploaded: 0, failures: [], message: T.nothing })
          setStage('result')
          return
        }
        setStage('checking')
        let checked
        try {
          checked = await requestJson(CHECK, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: sessionId, paths: files.map(f => f.path) }),
          })
        } catch {
          checked = { ok: false, status: 0, body: { code: 'network' } }
        }
        if (!checked.ok) {
          setJob({ uploaded: 0, failures: [], message: checked.status === 0 ? T.network : reason(T, checked.body?.code, checked.status, limit) })
          setStage('result')
          return
        }
        const maxFileBytes = Math.min(limit, checked.body.maxFileBytes ?? Infinity)
        const blocked = new Map(checked.body.blocked.map(b => [b.path, b.code]))
        const failures = []
        const ready = []
        for (const f of files) {
          if (blocked.has(f.path)) failures.push({ path: f.path, message: reason(T, blocked.get(f.path), 409, maxFileBytes) })
          else if (f.file.size > maxFileBytes) failures.push({ path: f.path, message: fill(T.tooLarge, { max: fileSizeText(maxFileBytes) }) })
          else ready.push(f)
        }
        const existing = new Set(checked.body.existing)
        const next = { ready, failures, existing, maxFileBytes }
        if (ready.some(f => existing.has(f.path))) {
          pendingConflict.current = next
          setJob({ conflicts: ready.filter(f => existing.has(f.path)).length })
          setStage('conflict')
          return
        }
        await run(next, 'fail')
      }

      async function resolveConflict(choice) {
        const next = pendingConflict.current
        pendingConflict.current = null
        if (choice === 'cancel') {
          setStage(null)
          return
        }
        if (choice === 'skip') await run({ ...next, ready: next.ready.filter(f => !next.existing.has(f.path)) }, 'fail')
        else await run(next, choice)
      }

      async function run({ ready, failures, maxFileBytes }, conflict) {
        const controller = new AbortController()
        abort.current = controller
        const total = ready.length
        const totalBytes = ready.reduce((sum, f) => sum + f.file.size, 0)
        let sentBytes = 0
        let uploaded = 0
        const update = (current, loaded) => setJob({ done: uploaded, total, name: current, fraction: totalBytes > 0 ? (sentBytes + loaded) / totalBytes : 1 })
        setStage('uploading')
        for (const f of ready) {
          if (controller.signal.aborted) break
          update(f.path, 0)
          const query = new URLSearchParams({ session: sessionId, path: f.path, conflict })
          try {
            const result = await sendFile(`${UPLOAD}?${query}`, f.file, (loaded) => update(f.path, loaded), controller.signal)
            if (result.ok) uploaded++
            else failures.push({ path: f.path, message: reason(T, result.body?.code, result.status, maxFileBytes) })
          } catch (err) {
            if (err?.name === 'AbortError') break
            failures.push({ path: f.path, message: T.network })
          }
          sentBytes += f.file.size
        }
        abort.current = null
        const counted = { n: uploaded, files: filesWord(uploaded), failed: failures.length }
        const message = controller.signal.aborted
          ? fill(T.cancelled, counted)
          : failures.length > 0 ? fill(T.doneWithFailures, counted) : fill(T.done, counted)
        setJob({ uploaded, failures, message })
        setStage('result')
        if (failures.length === 0 && !controller.signal.aborted) {
          window.setTimeout(() => setStage(current => (current === 'result' ? null : current)), 2500)
        }
      }

      function pick(input) {
        setStage(null)
        input.current.value = ''
        input.current.click()
      }

      const busy = stage === 'checking' || stage === 'uploading'
      const body = () => {
        if (stage === 'menu') {
          return h(React.Fragment, null,
            h(MenuItem, { onClick: () => pick(filesInput) }, T.uploadFiles),
            h(MenuItem, { onClick: () => pick(folderInput) }, T.uploadFolder),
            h('div', { style: css.note }, fill(T.into, { root: absolutePath }),
              Number.isFinite(limit) ? h('div', null, fill(T.limit, { max: fileSizeText(limit) })) : null))
        }
        if (stage === 'checking') return h('div', { style: css.line }, T.checking)
        if (stage === 'conflict') {
          return h(React.Fragment, null,
            h('div', { style: css.line }, job.conflicts === 1 ? T.conflictOne : fill(T.conflict, { n: job.conflicts })),
            h('div', { style: css.buttons },
              h('button', { type: 'button', style: { ...css.button, ...css.primary }, onClick: () => void resolveConflict('rename') }, T.keepBoth),
              h('button', { type: 'button', style: css.button, onClick: () => void resolveConflict('overwrite') }, T.overwrite),
              h('button', { type: 'button', style: css.button, onClick: () => void resolveConflict('skip') }, T.skip),
              h('button', { type: 'button', style: css.button, onClick: () => void resolveConflict('cancel') }, T.cancel)))
        }
        if (stage === 'uploading') {
          return h(React.Fragment, null,
            h('div', { style: css.line }, fill(T.progress, { done: Math.min(job.done + 1, job.total), total: job.total })),
            h('div', { style: css.name, title: job.name }, job.name),
            h('div', { style: css.bar }, h('div', { style: { ...css.fill, width: `${Math.round(job.fraction * 100)}%` } })),
            h('div', { style: css.buttons }, h('button', { type: 'button', style: css.button, onClick: () => abort.current?.abort() }, T.cancel)))
        }
        return h(React.Fragment, null,
          h('div', { style: css.line }, job.message),
          job.failures.length > 0
            ? h('div', { style: css.failures }, job.failures.map(f => h('div', { key: f.path, style: css.failure }, fill(T.failureLine, f))))
            : null,
          h('div', { style: css.buttons }, h('button', { type: 'button', style: css.button, onClick: () => setStage(null) }, T.dismiss)))
      }

      return h(React.Fragment, null,
        h(Tooltip, { label: T.upload, side: 'bottom', delayMs: 500, disabled: stage !== null },
          h('button', {
            ref: anchor,
            type: 'button',
            'aria-label': T.upload,
            'aria-expanded': stage !== null,
            style: { ...css.tool, color: hover || stage !== null ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)', background: hover || stage !== null ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent' },
            onClick: () => { if (!busy && stage !== 'conflict') setStage(stage === null ? 'menu' : null) },
            ...hoverHandlers,
          }, h(IconUpload, { size: 15 }))),
        h('input', { ref: filesInput, type: 'file', multiple: true, hidden: true, onChange: (e) => void begin(e.target.files ?? []) }),
        h('input', { ref: folderInput, type: 'file', webkitdirectory: '', hidden: true, onChange: (e) => void begin(e.target.files ?? []) }),
        stage !== null && position !== null
          ? createPortal(h('div', { ref: panel, role: 'dialog', 'aria-label': T.upload, style: { ...css.panel, top: position.top, left: position.left } }, body()), document.body)
          : null)
    }

    module.exports.inject = ['slots', 'locale']
    module.exports.apply = (ctx) => {
      ctx.effect(() => ctx.locale.register(NS, COPY), 'dsh-cloud-workspace-upload: copy')
      ctx.effect(() => ctx.slots.inject('sidebar.right.tab.files.actions', () => ctx.slots.register({
        name: 'sidebar.right.tab.files.actions', id: 'dsh-cloud-upload', order: -10, locale: NS,
      }, UploadAction)), 'dsh-cloud-workspace-upload: files action')
    }
    return module.exports
  },
})
