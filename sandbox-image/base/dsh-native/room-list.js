// Native left-sidebar slot and conversation management for the Chat module.
const roomAvatars = {
  robot: '🤖', fox: '🦊', cat: '🐱', owl: '🦉', panda: '🐼', octopus: '🐙', rocket: '🚀', sparkles: '✨',
}

function RoomAvatar({ bot, group, size = 34 }) {
  const tint = roomPalette[bot?.color] ?? roomPalette[0]
  const color = group ? '#5685af' : tint
  return react.createElement('span', {
    'aria-hidden': true, 'data-room-avatar': group ? 'group' : (bot?.avatar ?? 'robot'),
    style: { width: size, height: size, flex: '0 0 auto', display: 'inline-grid', placeItems: 'center',
      fontSize: size * .56, borderRadius: 'var(--dsw-radius-sm)',
      background: `color-mix(in srgb, ${color} 24%, var(--dsw-alias-bg-base))` },
  }, group ? '👥' : roomAvatars[bot?.avatar] ?? roomAvatars.robot)
}

function createRoomNavigation() {
  const listeners = new Set()
  let state = { data: null, selected: null, dialog: null }
  const update = patch => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => state,
    show(data) { update({ data, selected: data.room?.id ?? null }) },
    select(selected) { update({ selected, dialog: null }) },
    dialog(dialog) { update({ dialog }) },
  }
}

function RoomConversationList({ t, wide, expandSidebar, nav, backToWorkspaces, onConversationSelected }) {
  const h = react.createElement
  const ui = _deepseek_ai_dsh_client_ui_primitives
  const { data, selected } = react.useSyncExternalStore(nav.subscribe, nav.getSnapshot)
  const [filter, setFilter] = react.useState('')
  const query = filter.trim().toLocaleLowerCase()
  const rows = (data?.conversations ?? []).filter(row => !query || (row.title || t('group')).toLocaleLowerCase().includes(query))
    .sort((a, b) => b.at - a.at)
  const ellipsis = { overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }
  const icon = (name, icon, onClick) => h(ui.Button, { size: 'sm', variant: 'ghost', title: name, 'aria-label': name, onClick }, icon)
  const buttonStyle = { font: 'inherit', color: 'inherit', border: 0, cursor: 'pointer', textAlign: 'start' }
  if (!wide) return h('div', { style: { display: 'grid', placeItems: 'center' } },
    icon(t('showConversations'), h(ui.IconPanelLeftOutlineRegular, { size: 17 }), expandSidebar))
  return h('section', { 'aria-label': t('conversations'), 'data-room-conversations': '',
    style: { minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', padding: '6px 10px 8px 0', gap: 8 } },
    h('div', { style: { ...roomRow, justifyContent: 'space-between', paddingInline: 6 } },
      h('strong', { style: { fontSize: 13 } }, t('conversations')),
      h(ui.Button, { size: 'sm', variant: 'ghost', onClick: backToWorkspaces }, t('workspaces'))),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, paddingInline: 3 } },
      h('input', { value: filter, onChange: e => setFilter(e.target.value), style: { ...roomField, minWidth: 0 },
        placeholder: t('findChat'), 'aria-label': t('findChat') }),
      icon(t('newConversation'), h(ui.IconNewChatOutlineRegular, { size: 19 }), () => nav.dialog({ kind: 'new' }))),
    h('div', { style: { overflowY: 'auto', minHeight: 0, display: 'grid', alignContent: 'start', gap: 3 } },
      ...rows.map(row => {
        const group = row.kind === 'group'
        const title = row.title || t('title')
        const bot = group ? null : data.bots.find(bot => bot.id === row.botId)
        const date = row.at ? new Date(row.at) : null
        const today = date?.toDateString() === new Date().toDateString()
        const time = date?.toLocaleString(undefined, today ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric' })
        return h('div', { key: row.id, 'data-room-conversation': row.kind,
          style: { display: 'flex', alignItems: 'center', gap: 1, borderRadius: 'var(--dsw-radius-md)',
            background: selected === row.id ? 'var(--dsw-alias-fill-l2, var(--dsw-alias-border-l3))' : 'transparent' } },
          h('button', { type: 'button', 'aria-current': selected === row.id ? 'true' : undefined,
            'aria-label': title, title, onClick: () => { nav.select(row.id); onConversationSelected() },
            style: { ...buttonStyle, background: 'transparent', borderRadius: 'inherit', display: 'flex', gap: 8,
              alignItems: 'center', flex: 1, minWidth: 0, padding: '8px 3px 8px 7px' } },
            h(RoomAvatar, { bot, group }),
            h('span', { style: { flex: 1, minWidth: 0, display: 'grid', gap: 3 } },
              h('span', { style: { display: 'flex', alignItems: 'baseline', gap: 4 } },
                h('strong', { style: { ...ellipsis, fontSize: 13, flex: 1 } }, title),
                time && h('time', { dateTime: date.toISOString(), style: { ...roomMuted, fontSize: 10, flexShrink: 0 } }, time)),
              h('span', { style: { ...roomMuted, ...ellipsis } }, row.running ? t('running')
                : row.preview || (group ? t('group') : t('direct'))))),
          h(ui.Button, { size: 'sm', variant: 'ghost', title: t('conversationOptions') + ' · ' + title,
            'aria-label': t('conversationOptions') + ' · ' + title, onClick: () => nav.dialog({ kind: 'options', id: row.id }) },
            h(ui.IconEllipsisOutlineRegular, { size: 14 })))
      }),
      data && !rows.length && h('div', { style: { ...roomMuted, padding: 9 } }, t(query ? 'noMatches' : 'noConversations'))))
}

function RoomBotFields({ t, name, setName, role, setRole, avatar, setAvatar }) {
  const h = react.createElement
  const ui = _deepseek_ai_dsh_client_ui_primitives
  return h(react.Fragment, null,
    h('div', { role: 'group', 'aria-label': t('avatar'), style: roomRow },
      ...Object.keys(roomAvatars).map(key => h(ui.Button, { key, size: 'sm', variant: key === avatar ? 'outline' : 'ghost',
        'aria-pressed': key === avatar, 'aria-label': t('avatar.' + key), title: t('avatar.' + key), onClick: () => setAvatar(key) },
        h(RoomAvatar, { bot: { avatar: key }, size: 29 })))),
    h('input', { value: name, onChange: e => setName(e.target.value), required: true, maxLength: 24, style: roomField,
      placeholder: t('botName'), 'aria-label': t('botName') }),
    h('textarea', { value: role, onChange: e => setRole(e.target.value), rows: 2, maxLength: 1200, style: roomField,
      placeholder: t('botRole'), 'aria-label': t('botRole') }))
}

function RoomListModal({ t, data, dialog, busy, error, nav, command }) {
  const h = react.createElement
  const ui = _deepseek_ai_dsh_client_ui_primitives
  const [name, setName] = react.useState('')
  const [role, setRole] = react.useState('')
  const [avatar, setAvatar] = react.useState('robot')
  const [members, setMembers] = react.useState([])
  const [confirm, setConfirm] = react.useState(false)
  const bots = data?.bots ?? []
  const rows = data?.conversations ?? []
  const row = rows.find(item => item.id === dialog.id)
  const button = (label, onClick, props = {}) => h(ui.Button, { variant: 'outline', disabled: busy, onClick, ...props }, label)
  const run = async (body, select) => {
    if (await command(body, select)) nav.dialog(null)
  }
  const close = () => nav.dialog(null)
  const title = dialog.kind === 'bot' ? t('addBot') : dialog.kind === 'group' ? t('newGroup')
    : dialog.kind === 'options' ? (row?.title || t('group')) : t('newConversation')
  let content
  if (dialog.kind === 'bot') {
    content = h('form', { style: roomStack, onSubmit: e => { e.preventDefault(); void run({ action: 'bot', name, role, avatar }, true) } },
      h(RoomBotFields, { t, name, setName, role, setRole, avatar, setAvatar }),
      h(ui.Button, { variant: 'primary', type: 'submit', disabled: busy || !name.trim() }, t('addBot')))
  } else if (dialog.kind === 'group') {
    content = h('form', { style: roomStack, onSubmit: e => { e.preventDefault(); void run({ action: 'create-room', title: name, members }, true) } },
      h('input', { value: name, onChange: e => setName(e.target.value), maxLength: 48, required: true,
        style: roomField, placeholder: t('groupName'), 'aria-label': t('groupName') }),
      h('strong', null, t('members')),
      h('div', { style: { ...roomStack, maxHeight: '35vh', overflowY: 'auto' } },
        ...bots.map(bot => h('label', { key: bot.id, style: roomRow },
          h('input', { type: 'checkbox', checked: members.includes(bot.id), disabled: busy || (members.length >= 4 && !members.includes(bot.id)),
            onChange: e => setMembers(e.target.checked ? [...members, bot.id] : members.filter(id => id !== bot.id)) }),
          h(RoomAvatar, { bot, size: 27 }), '@' + bot.name))),
      h(ui.Button, { variant: 'primary', type: 'submit', disabled: busy || !name.trim() }, t('newGroup')))
  } else if (dialog.kind === 'options') {
    content = row && h('div', { style: roomStack },
      confirm
        ? h(react.Fragment, null, h('p', { style: roomMuted }, t(row.kind === 'direct' ? 'deleteDirectDetail' : 'deleteGroupDetail')),
          h('div', { style: roomRow }, button(t('cancel'), () => setConfirm(false)),
            button(t('confirm'), () => run({ action: 'delete-conversation', roomId: row.id }), { disabled: busy || row.running })))
        : button(t('deleteConversation'), () => setConfirm(true), { disabled: busy || row.running }))
  } else {
    const closed = bots.filter(bot => !rows.some(row => row.kind === 'direct' && row.botId === bot.id))
    content = h('div', { style: roomStack },
      button(t('addBot'), () => nav.dialog({ kind: 'bot' })),
      button(t('newGroup'), () => nav.dialog({ kind: 'group' })),
      closed.length > 0 && h('strong', null, t('openDirect')),
      ...closed.map(bot => button('@' + bot.name, () => run({ action: 'direct', botId: bot.id }, true), { key: bot.id })))
  }
  return h(ui.Modal, { open: true, title, closeLabel: t('close'), onClose: close },
    h('div', { style: roomStack }, h(RoomFailure, { t, error }), content))
}
