/*
 * Workspace browser, client face: a right-Sidebar tab type that shows the
 * workspace's Chromium live and forwards the user's mouse, keyboard, and text.
 *
 * Written directly in dsh's client bundle format (the closure factory that
 * dsh's tsdown preset emits): `require` resolves platform modules such as React
 * from dsh's module table, so this file needs no build step. It uses dsh's
 * right-Sidebar contract (`sidebarRightTabs.register`, the keyed
 * `sidebar.right.pane.tab` slot), which is pre-stable: re-check after
 * upgrading dsh.
 *
 * The live view connects to /u/<user>/_dsh-cloud/browser on the page's own
 * origin; the gateway forwards it to the sandbox's browser hub for the
 * signed-in owner only. See the hub (browser-hub/hub.mjs) for the protocol.
 * Each dsh page also keeps a watch-only connection there and opens this tab
 * when the agent starts operating the browser.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cloud-workspace-browser',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState, useCallback } = React

    const ID = 'dsh-cloud-workspace-browser'
    const KIND = 'workspace-browser'
    const ZH = (document.documentElement.lang || navigator.language || '').toLowerCase().startsWith('zh')
    const T = ZH
      ? {
          title: '工作空间浏览器', guide: '工作空间浏览器',
          description: '实时查看并接管 Agent 正在操作的浏览器',
          address: '输入网址后回车', starting: '正在启动浏览器…', connecting: '正在连接…',
          reconnecting: '连接已断开，正在重连…', agent: 'Agent 正在操作', you: '你可以直接点击和输入',
          unavailable: '这个工作空间还没有浏览器。请退出登录后重新登录，让工作空间用新版本重新启动。',
          unauthorized: '登录已失效，请刷新页面重新登录。',
          back: '后退', forward: '前进', reload: '刷新', newTab: '新标签页', closeTab: '关闭标签页',
          ok: '确定', cancel: '取消', untitled: '新标签页',
        }
      : {
          title: 'Workspace browser', guide: 'Workspace browser',
          description: 'Watch and take over the browser the agent is operating',
          address: 'Enter a URL', starting: 'Starting the browser…', connecting: 'Connecting…',
          reconnecting: 'Disconnected, reconnecting…', agent: 'Agent is operating', you: 'Click and type to take over',
          unavailable: 'This workspace has no browser yet. Sign out and back in so it restarts on the current version.',
          unauthorized: 'Your sign-in has expired. Reload the page to sign in again.',
          back: 'Back', forward: 'Forward', reload: 'Reload', newTab: 'New tab', closeTab: 'Close tab',
          ok: 'OK', cancel: 'Cancel', untitled: 'New tab',
        }

    // Keys forwarded as key presses; everything else arrives as text through the input box.
    const KEY_CODES = {
      Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34,
      ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45,
    }
    const modifiersOf = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
    const BUTTONS = ['left', 'middle', 'right']

    /** The live-view socket URL for the workspace this page belongs to; `watch` asks for agent events only. */
    function socketUrl(watch) {
      const mount = window.location.pathname.match(/^\/u\/[^/]+\//)
      const base = mount ? mount[0] : '/'
      const url = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${base}_dsh-cloud/browser`
      return watch ? `${url}?watch=1` : url
    }
    // Gateway close codes: the workspace has no browser hub (4404), or the session is not the owner's (4401).
    const NO_BROWSER = 4404
    const NOT_SIGNED_IN = 4401

    function Icon({ size = 16, className, d }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', className, 'aria-hidden': true,
      }, ...[].concat(d).map((path, i) => h('path', { key: i, d: path })))
    }
    const BrowserGlyph = (props) => h(Icon, {
      ...props,
      d: ['M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M3 9h18', 'M6.5 6.5h.01', 'M9 6.5h.01', 'm10 13 2 2 4-4'],
    })

    const css = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', fontSize: 13 },
      toolbar: { display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', borderBottom: '0.5px solid var(--dsw-alias-border-l4)' },
      button: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, border: 'none', borderRadius: 8, background: 'transparent', color: 'inherit', cursor: 'pointer' },
      address: { flex: 1, minWidth: 0, height: 28, padding: '0 10px', border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', color: 'inherit', font: 'inherit', outline: 'none' },
      tabs: { display: 'flex', gap: 4, padding: '4px 8px', overflowX: 'auto', borderBottom: '0.5px solid var(--dsw-alias-border-l4)' },
      tab: { display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 180, height: 24, padding: '0 4px 0 10px', borderRadius: 6, border: 'none', cursor: 'pointer', color: 'inherit', font: 'inherit', fontSize: 12, flex: 'none' },
      status: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
      stage: { position: 'relative', flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: 'var(--dsw-alias-bg-base)' },
      frame: { maxWidth: '100%', maxHeight: '100%', userSelect: 'none', cursor: 'default', outline: 'none', boxShadow: '0 0 0 0.5px var(--dsw-alias-border-l3)' },
      sink: { position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0, border: 0, padding: 0, resize: 'none' },
      placeholder: { color: 'var(--dsw-alias-label-tertiary)' },
      dialog: { position: 'absolute', left: 12, right: 12, top: 12, padding: 12, borderRadius: 12, background: 'var(--dsw-alias-bg-layer-2)', boxShadow: '0 6px 24px rgba(0,0,0,0.18)' },
    }

    function WorkspaceBrowser() {
      const [frame, setFrame] = useState(null)
      const [tabs, setTabs] = useState({ tabs: [], canGoBack: false, canGoForward: false })
      const [agent, setAgent] = useState(false)
      const [state, setState] = useState('connecting')
      const [address, setAddress] = useState('')
      const [editing, setEditing] = useState(false)
      const [dialog, setDialog] = useState(null)
      const [promptText, setPromptText] = useState('')
      const socket = useRef(null)
      const image = useRef(null)
      const sink = useRef(null)
      const size = useRef({ width: 1280, height: 800 })
      const composing = useRef(false)
      const pendingMove = useRef(null)

      const send = useCallback((message) => {
        const ws = socket.current
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
      }, [])

      useEffect(() => {
        let closed = false
        let retry = 0
        let timer = 0
        const connect = () => {
          const ws = new WebSocket(socketUrl())
          socket.current = ws
          ws.onopen = () => {
            retry = 0
          }
          ws.onmessage = (event) => {
            const message = JSON.parse(event.data)
            switch (message.type) {
              case 'frame':
                size.current = { width: message.width, height: message.height }
                setFrame(`data:image/jpeg;base64,${message.data}`)
                setState('ready')
                return
              case 'tabs':
                setTabs(message)
                return
              case 'agent':
                setAgent(Boolean(message.active))
                return
              case 'status':
                setState(message.state === 'error' ? 'error' : message.state === 'starting' ? 'starting' : 'ready')
                return
              case 'dialog':
                setDialog(message)
                setPromptText(message.defaultPrompt ?? '')
                return
              case 'dialog-closed':
                setDialog(null)
                return
              default:
            }
          }
          ws.onclose = (event) => {
            if (closed) return
            if (event.code === NO_BROWSER || event.code === NOT_SIGNED_IN) {
              setState(event.code === NO_BROWSER ? 'unavailable' : 'unauthorized')
              timer = window.setTimeout(connect, 15000)
              return
            }
            setState('reconnecting')
            retry = Math.min(retry + 1, 6)
            timer = window.setTimeout(connect, 500 * 2 ** retry)
          }
        }
        connect()
        return () => {
          closed = true
          window.clearTimeout(timer)
          socket.current?.close()
        }
      }, [])

      const active = tabs.tabs.find((tab) => tab.active)
      useEffect(() => {
        if (!editing) setAddress(active?.url === 'about:blank' ? '' : (active?.url ?? ''))
      }, [active?.url, editing])

      const point = (e) => {
        const rect = image.current.getBoundingClientRect()
        return {
          x: ((e.clientX - rect.left) * size.current.width) / rect.width,
          y: ((e.clientY - rect.top) * size.current.height) / rect.height,
          modifiers: modifiersOf(e),
        }
      }
      const onMouseDown = (e) => {
        e.preventDefault()
        sink.current?.focus({ preventScroll: true })
        send({ type: 'mouse', event: 'down', button: BUTTONS[e.button] ?? 'left', clickCount: e.detail || 1, ...point(e) })
      }
      const onMouseUp = (e) => {
        send({ type: 'mouse', event: 'up', button: BUTTONS[e.button] ?? 'left', clickCount: e.detail || 1, ...point(e) })
      }
      const onMouseMove = (e) => {
        // One move per animation frame keeps the socket quiet while dragging.
        const first = pendingMove.current === null
        pendingMove.current = { type: 'mouse', event: 'move', buttons: e.buttons, button: e.buttons & 1 ? 'left' : 'none', ...point(e) }
        if (first) {
          requestAnimationFrame(() => {
            send(pendingMove.current)
            pendingMove.current = null
          })
        }
      }
      useEffect(() => {
        const element = image.current
        if (!element) return
        // React's onWheel is passive; the page must not scroll the sidebar instead.
        const onWheel = (e) => {
          e.preventDefault()
          send({ type: 'mouse', event: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY, ...point(e) })
        }
        element.addEventListener('wheel', onWheel, { passive: false })
        return () => element.removeEventListener('wheel', onWheel)
      }, [frame !== null, send])

      const onKeyDown = (e) => {
        if (composing.current || e.isComposing) return
        const keyCode = KEY_CODES[e.key]
        const shortcut = (e.ctrlKey || e.metaKey) && !['v', 'V'].includes(e.key)
        if (keyCode !== undefined || shortcut) {
          e.preventDefault()
          send({ type: 'key', event: 'down', key: e.key, code: e.code, keyCode: keyCode ?? e.key.toUpperCase().charCodeAt(0), modifiers: modifiersOf(e) })
        }
      }
      const onKeyUp = (e) => {
        if (composing.current || e.isComposing) return
        const keyCode = KEY_CODES[e.key]
        if (keyCode !== undefined || e.ctrlKey || e.metaKey) {
          send({ type: 'key', event: 'up', key: e.key, code: e.code, keyCode: keyCode ?? e.key.toUpperCase().charCodeAt(0), modifiers: modifiersOf(e) })
        }
      }
      // Typed characters, pasted text, and IME output all arrive as text.
      const flushText = () => {
        const box = sink.current
        if (box && box.value) {
          send({ type: 'text', text: box.value })
          box.value = ''
        }
      }

      const go = (e) => {
        e.preventDefault()
        send({ type: 'navigate', url: address })
        setEditing(false)
        e.currentTarget.querySelector('input')?.blur()
      }

      const button = (title, d, onClick, disabled) => h('button', {
        type: 'button', title, 'aria-label': title, onClick, disabled,
        style: { ...css.button, opacity: disabled ? 0.35 : 1, cursor: disabled ? 'default' : 'pointer' },
      }, h(Icon, { d }))

      const placeholder = {
        reconnecting: T.reconnecting, starting: T.starting, unavailable: T.unavailable, unauthorized: T.unauthorized,
      }[state] ?? T.connecting

      return h('div', { style: css.root },
        h('form', { style: css.toolbar, onSubmit: go },
          button(T.back, 'M15 18l-6-6 6-6', () => send({ type: 'back' }), !tabs.canGoBack),
          button(T.forward, 'M9 18l6-6-6-6', () => send({ type: 'forward' }), !tabs.canGoForward),
          button(T.reload, ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'], () => send({ type: 'reload' })),
          h('input', {
            style: css.address, value: address, placeholder: T.address, spellCheck: false,
            onChange: (e) => setAddress(e.target.value), onFocus: () => setEditing(true), onBlur: () => setEditing(false),
          }),
          button(T.newTab, ['M12 5v14', 'M5 12h14'], () => send({ type: 'new-tab' })),
        ),
        tabs.tabs.length > 1 ? h('div', { style: css.tabs },
          tabs.tabs.map((tab) => h('div', {
            key: tab.id, role: 'button', tabIndex: 0, title: tab.url,
            onClick: () => send({ type: 'activate', id: tab.id }),
            style: { ...css.tab, background: tab.active ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent' },
          },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, tab.title || T.untitled),
          h('button', {
            type: 'button', title: T.closeTab, 'aria-label': T.closeTab,
            style: { ...css.button, width: 18, height: 18 },
            onClick: (e) => {
              e.stopPropagation()
              send({ type: 'close-tab', id: tab.id })
            },
          }, h(Icon, { size: 12, d: ['M18 6 6 18', 'm6 6 12 12'] }))))) : null,
        h('div', { style: css.status },
          h('span', {
            style: {
              width: 7, height: 7, borderRadius: '50%',
              background: agent ? 'var(--dsw-static-deepseek-500, #4d6bfe)' : 'var(--dsw-alias-state-success-primary, #2ba471)',
              boxShadow: agent ? '0 0 0 3px color-mix(in srgb, var(--dsw-static-deepseek-500, #4d6bfe) 25%, transparent)' : 'none',
            },
          }),
          h('span', { style: { color: agent ? 'var(--dsw-alias-label-primary)' : undefined } }, agent ? T.agent : T.you),
        ),
        h('div', { style: css.stage },
          frame === null || state !== 'ready'
            ? h('span', { style: { ...css.placeholder, maxWidth: 360, padding: 16, textAlign: 'center' } }, frame === null || state === 'unavailable' || state === 'unauthorized' ? placeholder : null)
            : null,
          frame !== null ? h('img', {
            ref: image, src: frame, alt: '', draggable: false,
            style: { ...css.frame, display: ['reconnecting', 'unavailable', 'unauthorized'].includes(state) ? 'none' : 'block' },
            onMouseDown, onMouseUp, onMouseMove, onContextMenu: (e) => e.preventDefault(),
          }) : null,
          h('textarea', {
            ref: sink, style: css.sink, 'aria-label': T.title, autoComplete: 'off', spellCheck: false,
            onKeyDown, onKeyUp,
            onCompositionStart: () => {
              composing.current = true
            },
            onCompositionEnd: () => {
              composing.current = false
              flushText()
            },
            onInput: () => {
              if (!composing.current) flushText()
            },
          }),
          dialog ? h('div', { style: css.dialog },
            h('div', { style: { marginBottom: 8, whiteSpace: 'pre-wrap' } }, dialog.message),
            dialog.dialogType === 'prompt' ? h('input', {
              style: { ...css.address, width: '100%', marginBottom: 8 }, value: promptText,
              onChange: (e) => setPromptText(e.target.value),
            }) : null,
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 6 } },
              dialog.dialogType !== 'alert' ? h('button', {
                type: 'button', style: { ...css.button, width: 'auto', padding: '0 12px' },
                onClick: () => send({ type: 'dialog', accept: false }),
              }, T.cancel) : null,
              h('button', {
                type: 'button',
                style: { ...css.button, width: 'auto', padding: '0 12px', background: 'var(--dsw-static-deepseek-500, #4d6bfe)', color: '#fff' },
                onClick: () => send({ type: 'dialog', accept: true, promptText }),
              }, T.ok),
            )) : null,
        ),
      )
    }

    module.exports.inject = ['slots', 'sidebarRight', 'sidebarRightTabs']
    module.exports.apply = (ctx) => {
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        priority: 'extension',
        title: () => T.title,
        guide: [{ id: 'open', order: 31, title: () => T.guide, description: () => T.description, icon: BrowserGlyph }],
      }), 'dsh-cloud-workspace-browser: type')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: ID,
      }, WorkspaceBrowser)), 'dsh-cloud-workspace-browser: body')
      ctx.effect(() => watchAgent(() => {
        try {
          // Opens the tab in the current session, or brings an open one forward.
          ctx.sidebarRight.openTab(KIND)
        } catch (err) {
          // No session is selected (e.g. the welcome page): nothing to open the tab in.
          console.debug('dsh-cloud-workspace-browser: not opening the live view', err)
        }
      }), 'dsh-cloud-workspace-browser: follow agent')
    }

    /** Call `onStart` each time the agent starts operating the browser; returns the disposer. */
    function watchAgent(onStart) {
      let stopped = false
      let socket = null
      let timer = 0
      let retry = 0
      let active = false
      const connect = () => {
        socket = new WebSocket(socketUrl(true))
        socket.onopen = () => {
          retry = 0
        }
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data)
          if (message.type !== 'agent') return
          if (message.active && !active) onStart()
          active = Boolean(message.active)
        }
        socket.onclose = (event) => {
          if (stopped) return
          active = false
          // Without a browser hub (or a valid session), check back rarely.
          const delay = event.code === NO_BROWSER || event.code === NOT_SIGNED_IN ? 60000 : 1000 * 2 ** Math.min(++retry, 5)
          timer = window.setTimeout(connect, delay)
        }
      }
      connect()
      return () => {
        stopped = true
        window.clearTimeout(timer)
        socket?.close()
      }
    }
    return module.exports
  },
})
