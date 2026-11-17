window.__ModuleLoader__.load({
  id: 'dsh-cloud-website-login',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useEffect, useLayoutEffect, useRef, useState } = React
    const NS = 'dshCloudWebsiteLogin'
    const copy = {
      zh: {
        title: '安全登录', open: '打开表单', close: '收起表单', starting: '正在准备…', pending: '待授权',
        working: '正在登录…', 'signed-in': '已授权', cancelled: '已取消',
        expired: '登录请求已过期', failed: '登录未完成', busy: '登录服务正忙', unavailable: '此登录请求不可用',
        https: '请在 HTTPS 工作区里打开安全表单。', workspace: '打开 HTTPS 工作区', loading: '正在加载安全表单…',
        loadFailed: '安全表单未加载，请重试。', retry: '重试',
        vault: '密码保险库', vaultLoading: '正在打开保险库…', vaultLoadFailed: '保险库未加载，请重试。',
        vaultDisabled: '当前环境尚未启用安全登录。', vaultUnassigned: '安全登录尚未分配给你的账号。',
      },
      en: {
        title: 'Secure sign-in', open: 'Open form', close: 'Collapse form', starting: 'Preparing…', pending: 'Awaiting approval',
        working: 'Signing in…', 'signed-in': 'Authorized', cancelled: 'Cancelled',
        expired: 'Sign-in request expired', failed: 'Sign-in did not complete', busy: 'Sign-in service is busy', unavailable: 'This sign-in request is unavailable',
        https: 'Open the secure form from the HTTPS workspace.', workspace: 'Open HTTPS workspace', loading: 'Loading secure form…',
        loadFailed: 'The secure form did not load. Try again.', retry: 'Retry',
        vault: 'Vault', vaultLoading: 'Opening the Vault…', vaultLoadFailed: 'The Vault did not load. Try again.',
        vaultDisabled: 'Secure sign-in is not enabled for this deployment.', vaultUnassigned: 'Secure sign-in has not been assigned to your account.',
      },
    }

    const css = {
      card: { width: '100%', maxWidth: 500, boxSizing: 'border-box', borderRadius: 13,
        border: '1px solid var(--dsw-alias-border-l3, light-dark(#d8dce4, #464c57))', color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-layer-2, transparent)', fontSize: 13, lineHeight: 1.45, overflow: 'hidden' },
      header: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, padding: '11px 13px' },
      icon: { display: 'grid', placeItems: 'center', flex: '0 0 32px', height: 32, borderRadius: 9,
        background: 'light-dark(#e9efff, #28354f)', color: 'light-dark(#315cc0, #a7bfff)' },
      main: { flex: '1 1 130px', minWidth: 0 },
      title: { fontSize: 14, fontWeight: 650 },
      host: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, light-dark(#515b6d, #a9b1be))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      button: { flex: '0 0 auto', cursor: 'pointer', font: 'inherit', fontWeight: 600, textDecoration: 'none',
        color: 'var(--dsw-alias-label-primary, inherit)', background: 'transparent', border: '1px solid var(--dsw-alias-border-l3, light-dark(#d8dce4, #464c57))',
        borderRadius: 7, padding: '5px 9px', whiteSpace: 'nowrap' },
      badge: { padding: '2px 6px', borderRadius: 6, fontSize: 11, fontWeight: 600,
        color: 'var(--dsw-alias-label-secondary, light-dark(#515b6d, #a9b1be))', background: 'light-dark(#f0f2f6, #353a45)' },
      detail: { borderTop: '1px solid var(--dsw-alias-border-l3, light-dark(#d8dce4, #464c57))', position: 'relative' },
      message: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', minHeight: 38,
        gap: 8, padding: '7px 13px', color: 'var(--dsw-alias-label-secondary, light-dark(#515b6d, #a9b1be))' },
    }

    function Lock() {
      return h('span', { style: css.icon, 'aria-hidden': true }, h('svg', { width: 17, height: 17, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' },
      h('rect', { x: 5, y: 10, width: 14, height: 11, rx: 2 }), h('path', { d: 'M8 10V7a4 4 0 0 1 8 0v3m-4 5v2' })))
    }

    function VaultFrame({ src, t, settings = false }) {
      const iframe = useRef(null)
      const [attempt, setAttempt] = useState(0)
      const [layout, setLayout] = useState({ state: 'loading', height: 0 })
      useLayoutEffect(() => {
        const origin = new URL(src).origin
        const timeout = setTimeout(() => setLayout({ state: 'failed', height: 0 }), 8000)
        const onMessage = (event) => {
          if (event.source !== iframe.current?.contentWindow || event.origin !== origin ||
              event.data?.type !== 'dsh-website-login:layout' || !Number.isFinite(event.data.height)) return
          clearTimeout(timeout)
          const height = Math.min(720, Math.max(80, Math.ceil(event.data.height)))
          setLayout({ state: 'ready', height })
        }
        window.addEventListener('message', onMessage)
        return () => { clearTimeout(timeout); window.removeEventListener('message', onMessage) }
      }, [src, attempt])

      const ready = layout.state === 'ready'
      return h('div', { style: settings ? { position: 'relative' } : css.detail },
        layout.state !== 'failed' ? h('iframe', {
          key: attempt, ref: iframe, src, title: t(settings ? 'vault' : 'title'), sandbox: 'allow-forms allow-same-origin allow-scripts',
          referrerPolicy: 'no-referrer', 'aria-hidden': ready ? undefined : true, tabIndex: ready ? undefined : -1,
          style: { display: 'block', width: '100%', height: ready ? layout.height : 1, border: 0,
            ...(ready ? {} : { visibility: 'hidden', position: 'absolute', top: 0, left: 0 }) },
        }) : null,
        layout.state === 'loading' ? h('div', { role: 'status', style: css.message }, t(settings ? 'vaultLoading' : 'loading')) : null,
        layout.state === 'failed' ? h('div', { role: 'alert', style: css.message }, t(settings ? 'vaultLoadFailed' : 'loadFailed'),
          h('button', { type: 'button', style: css.button, onClick: () => {
            setLayout({ state: 'loading', height: 0 }); setAttempt(n => n + 1)
          } }, t('retry'))) : null)
    }

    function embeddedUrl(target) {
      target.search = '?embed=1'
      const theme = getComputedStyle(document.documentElement).colorScheme
      if (theme === 'dark' || theme === 'light') target.searchParams.set('theme', theme)
      target.hash = ''
      return target.href
    }

    function SettingsVault({ t }) {
      const [state, setState] = useState({ status: 'loading' })
      const [attempt, setAttempt] = useState(0)
      useEffect(() => {
        const abort = new AbortController()
        fetch('/api/me', { credentials: 'same-origin', cache: 'no-store', signal: abort.signal })
          .then(response => {
            if (!response.ok) throw new Error('unavailable')
            return response.json()
          }).then(data => {
            if (!abort.signal.aborted) setState(data.website_login ?? { status: 'disabled' })
          }).catch(() => { if (!abort.signal.aborted) setState({ status: 'failed' }) })
        return () => abort.abort()
      }, [attempt])

      if (state.vault_url) {
        try {
          const target = new URL(state.vault_url)
          if (target.protocol === 'https:' && target.hostname !== location.hostname && !target.username && !target.password) {
            target.pathname = '/vault'
            return h(VaultFrame, { src: embeddedUrl(target), t, settings: true })
          }
        } catch { /* Never embed an invalid URL. */ }
      }
      const stateLabel = { loading: 'vaultLoading', failed: 'vaultLoadFailed', unassigned: 'vaultUnassigned' }[state.status] ?? 'vaultDisabled'
      return h('section', { style: { padding: '12px 14px' }, 'aria-label': t('vault') },
        h('h2', { style: { margin: '0 0 8px', fontSize: 19 } }, t('vault')),
        h('div', { role: 'status', style: css.host }, t(stateLabel)),
        state.status === 'failed' ? h('button', { type: 'button', style: { ...css.button, marginTop: 8 }, onClick: () => {
          setState({ status: 'loading' }); setAttempt(n => n + 1)
        } }, t('retry')) : null)
    }

    function SignInCard({ t, callId, phase, block }) {
      const [result, setResult] = useState(null)
      const [opened, setOpened] = useState(null)
      const frameUrl = opened?.callId === callId ? opened?.url : null
      useEffect(() => {
        const mount = location.pathname.match(/^\/u\/[^/]+\//)?.[0]
        if (!mount || !callId || phase === 'preparing') return
        const controller = new AbortController()
        let timer
        const started = Date.now()
        const poll = async () => {
          let data
          try {
            const response = await fetch(`${mount}_dsh-cloud/website-login/${encodeURIComponent(callId)}`, {
              cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
            })
            data = await response.json()
          } catch { data = null }
          if (controller.signal.aborted) return
          if (data) setResult(data)
          if (phase !== 'result' && Date.now() - started < 330000 && (!data || ['pending', 'working'].includes(data.status) || Date.now() - started < 8000)) {
            timer = setTimeout(poll, 1500)
          }
        }
        void poll()
        return () => { controller.abort(); clearTimeout(timer) }
      }, [callId, phase])

      let href, secureWorkspace, host
      try { host = new URL(result?.origin).hostname } catch { /* Host unknown while preparing. */ }
      if (phase !== 'result' && result?.status === 'pending' && result.form_url) {
        try {
          const gateway = new URL(result.dsh_origin)
          const target = new URL(result.form_url)
          if (gateway.protocol === 'https:' && gateway.origin === result.dsh_origin && location.origin !== gateway.origin) {
            secureWorkspace = gateway.origin + location.pathname
          } else if (location.origin === gateway.origin && target.protocol === 'https:' && target.hostname !== location.hostname && !target.username && !target.password &&
              /^\/requests\/[A-Za-z0-9_-]+$/.test(target.pathname)) {
            href = embeddedUrl(target)
          }
        } catch { /* Never render an invalid link. */ }
      }
      let recorded
      if (phase === 'result') {
        try { recorded = JSON.parse(block?.content?.find(item => item.type === 'text')?.text ?? '').status }
        catch { recorded = 'unavailable' }
      }
      const value = recorded ?? result?.status
      const status = Object.hasOwn(copy.en, value) ? value : 'starting'
      return h('section', { 'aria-label': t('title'), style: css.card },
        h('div', { style: css.header }, h(Lock),
          h('div', { style: css.main }, h('div', { style: css.title }, t('title')),
            host ? h('div', { style: css.host, title: result.origin }, host) : null),
          h('span', { role: 'status', style: status === 'signed-in' ? { ...css.badge,
            background: 'light-dark(#e7f5ec, #244331)', color: 'light-dark(#216530, #b1e9bf)' } : css.badge }, t(status)),
          href || frameUrl ? h('button', { type: 'button', style: css.button, 'aria-expanded': Boolean(frameUrl),
            onClick: () => setOpened(frameUrl ? null : { callId, url: href }) }, t(frameUrl ? 'close' : 'open')) : null),
        secureWorkspace ? h('div', { style: { ...css.detail, ...css.message } }, t('https'),
          h('a', { style: css.button, href: secureWorkspace }, t('workspace'))) : null,
        frameUrl ? h(VaultFrame, { src: frameUrl, t }) : null)
    }

    return {
      name: 'dsh-cloud-website-login', inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, copy), 'website-login: copy')
        ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview', key: 'request_website_login', locale: NS,
        }, SignInCard)), 'website-login: sign-in card')
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'website-vault', order: 35, label: () => t('vault'), locale: NS,
        }, SettingsVault)), 'website-login: Vault in settings')
      },
    }
  },
})
