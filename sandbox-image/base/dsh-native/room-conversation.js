// Compiled into @deepseek-ai/dsh-client-ui-conversation's native client factory.
// The room uses the normal editor, composer card and conversation chrome.
function DshRoomFrame({ title, titleIcon, detail, headerAction, headerCorner, children, composer }) {
  const h = react.createElement
  const css = ConversationRoot_module_css_default
  return h('div', { className: css.root, 'data-phase': 'active', 'data-dsh-room': '' },
    h('header', { className: css.header },
      h('div', { className: css.titleRow },
        h('div', { className: css.titleCluster },
          h('div', { className: css.crumbs },
            titleIcon,
            h('h1', { className: css.crumb + ' ' + css.crumbCurrent,
              style: { margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1 } }, title),
            h('span', { style: { marginInlineStart: 8, color: 'var(--dsw-alias-label-secondary)', fontSize: 12,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, detail))),
        h('div', { className: css.headerUtilities }, headerAction,
          h('div', { className: css.headerCorner, 'data-conversation-header-corner': '' }, headerCorner)))),
    h('div', { className: css.body, 'data-conversation-content': '', 'data-conversation-region': 'chat',
      style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
      children,
      composer && h('div', { className: css.composerSeat, 'data-composer-seat': '', 'data-conversation-region': 'composer',
        style: { position: 'relative', inset: 'auto', flex: 'none' } }, composer)))
}

function DshRoomComposer({ t, direct, members, running, busy, onSend, onStop }) {
  const h = react.createElement
  const css = InputBar_module_css_default
  const primitives = _deepseek_ai_dsh_client_ui_primitives
  const [draft, setDraft] = react.useState('')
  const [mention, setMention] = react.useState(null)
  const [selected, setSelected] = react.useState(0)
  const scrollRef = react.useRef(null)
  const submitting = react.useRef(false)
  const state = react.useRef(null)
  state.current = { members }
  const runtime = react.useMemo(() => {
    const lexicon = new Map()
    const model = new DraftEditorRuntime({
      onUpdate() {
        model.refreshProjection()
        const { clipboardText, caret } = model.projection
        setDraft(clipboardText)
        const match = caret === null ? null : /(^|[^\p{L}\p{N}_.@])@([\p{L}\p{N}_-]*)$/u.exec(clipboardText.slice(0, caret))
        setMention(match && state.current.members.length ? { start: caret - match[2].length - 1, end: caret, query: match[2] } : null)
      },
      quoteLabels: () => ({ remove: '' }),
      openReference: () => false,
      lexicon: () => lexicon,
      resolveLexicon: () => undefined,
    })
    return model
  }, [])
  react.useLayoutEffect(() => runtime.register(), [runtime])
  react.useEffect(() => setSelected(0), [mention?.query])
  const choices = mention ? [{ id: 'all', name: 'all' }, ...members].filter(bot => bot.name.startsWith(mention.query.toLowerCase())) : []
  const pick = (name) => {
    if (!mention) return
    runtime.replaceText({ start: mention.start, end: mention.end }, '@' + name + ' ')
    runtime.editor.focus()
    setMention(null)
  }
  const send = async () => {
    if (submitting.current || busy || running || !draft.trim() || draft.length > 4000) return
    submitting.current = true
    setMention(null)
    try {
      if (await onSend(draft)) runtime.setDraft('')
    } finally {
      submitting.current = false
      runtime.editor.focus()
    }
  }
  const action = running ? t('stop') : t('send')
  const placeholder = t(direct ? 'privatePlaceholder' : 'placeholder')
  const icon = running
    ? h('rect', { x: 3, y: 3, width: 10, height: 10, rx: 3, fill: 'currentColor' })
    : h('path', { d: 'M8 2 2 8l1.5 1.5 3.5-3.6V15h2V5.9l3.5 3.6L14 8z', fill: 'currentColor' })
  return h('div', { className: css.root },
    h('div', { className: css.card, 'data-composer-card': true, onKeyDownCapture: event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229 || event.target !== runtime.editor.getRootElement()) return
      if (event.key === 'Escape' && mention) { event.preventDefault(); setMention(null); return }
      if (choices.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault()
        setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length)
        return
      }
      if (event.key !== 'Enter' || event.shiftKey) return
      event.preventDefault()
      event.stopPropagation()
      if (choices.length && !choices.some(bot => bot.name === mention.query.toLowerCase())) pick(choices[selected % choices.length].name)
      else void send()
    } },
    choices.length > 0 && h('div', { className: css.accessory, 'aria-label': t('mention'),
      style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
      ...choices.map((bot, i) => h(primitives.Button, { key: bot.id, variant: i === selected ? 'outline' : 'ghost',
        onMouseDown: e => e.preventDefault(), onClick: () => pick(bot.name) }, bot.name === 'all' ? '@all · ' + t('everyone') : '@' + bot.name))),
    h(DraftEditor, { classNames: css, editor: runtime.editor, scrollRef, editable: !busy, editorDisabled: busy,
      phase: busy ? 'sending' : 'plain', placeholderText: placeholder, ariaLabel: placeholder, showPlaceholder: draft === '' }),
    h('div', { className: css.row },
      h('div', { className: css.tools },
        !direct && h('button', { type: 'button', className: css.add, title: t('mention'), 'aria-label': t('mention'),
          disabled: busy || !members.length, onMouseDown: e => e.preventDefault(), onClick: () => {
            const pos = runtime.projection.caret ?? draft.length
            runtime.replaceText({ start: pos, end: pos }, (pos && !/\s$/.test(draft.slice(0, pos)) ? ' ' : '') + '@')
            runtime.editor.focus()
          } }, '@')),
      h('div', { className: css.trailing },
        h('button', { type: 'button', className: css.primary, 'aria-label': action, title: action, onMouseDown: e => e.preventDefault(),
          disabled: busy || (!running && (!draft.trim() || draft.length > 4000)), onClick: running ? onStop : send },
          h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true }, icon))))))
}
