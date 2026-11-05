// Compiled into @deepseek-ai/dsh-client-ui-chat. Native chat owns rendering,
// workspace navigation, link handling and component styling.
const DSH_ROOM_PANEL = 'dsh-cloud-workspace-rooms'
const DSH_ROOM_LOCALE = 'dshCloudWorkspaceRooms'
const DSH_ROOM_COPY = {
  zh: {
    title: '协作房间', members: '成员', manage: '房间成员与设置', close: '关闭',
    conversations: '对话', workspaces: '工作区', findChat: '搜索对话', showConversations: '展开对话列表',
    newConversation: '新建对话', newGroup: '新建群聊', groupName: '群聊名称', openDirect: '重新开启私聊',
    group: '群聊', direct: '私聊', noMatches: '没有匹配的对话', noConversations: '还没有对话',
    conversationOptions: '会话选项', deleteConversation: '删除会话', directSettings: '私聊设置',
    deleteDirectDetail: '删除对话列表中的这条私聊及其聊天记录。Bot 仍可用于群聊或开启空白私聊。DSH 执行记录保留。',
    deleteGroupDetail: '删除这个群聊及其聊天记录。Bot、私聊、项目文件和 DSH 执行记录保留。',
    welcome: '从左侧选择对话，或用「＋」添加机器人、创建群聊。',
    privatePlaceholder: '输入消息', leave: '移出群聊',
    avatar: '选择头像', 'avatar.robot': '机器人头像', 'avatar.fox': '狐狸头像', 'avatar.cat': '猫咪头像', 'avatar.owl': '猫头鹰头像',
    'avatar.panda': '熊猫头像', 'avatar.octopus': '章鱼头像', 'avatar.rocket': '火箭头像', 'avatar.sparkles': '星星头像',
    'error.group-limit': '群聊数量已达上限。', 'error.workspace-busy': '已有 4 位机器人在处理任务，请稍后再试。',
    addBot: '添加机器人', botName: '机器人名字', botRole: '职责（选填）', join: '加入房间',
    project: '工作项目', chooseProject: '选择项目', noProject: '请先在 DSH 工作区创建项目。',
    remove: '删除 Bot', confirm: '确认删除', cancel: '取消', preserve: '机器人会从所有群聊移除，私聊会删除，群聊消息保留。',
    resetContext: '开启新上下文', confirmReset: '确认开启',
    resetDetail: '旧消息会留在房间里。下一次点名时，机器人会用新的会话，旧房间消息不再进入提示词。',
    contextDivider: '新上下文从这里开始', 'error.context-changed': '房间上下文已更新，请重新确认。',
    openChat: '查看执行会话', mention: '点名机器人', everyone: '所有机器人',
    placeholder: '输入消息，输入 @ 点名机器人', send: '发送', stop: '停止本轮',
    empty: '发送消息开始协作。输入 @ 可以选机器人。', loading: '正在打开协作房间…',
    retry: '重试', running: '正在处理…', failed: '未能完成，可打开独立会话查看。',
    partial: '回复达到输出上限。', stopped: '已停止', 'timed-out': '已超时',
    interrupted: '工作空间重启，轮次已中断。', 'session-busy': '机器人的独立会话正在运行。',
    'error.unknown-mention': '房间里没有这个机器人', 'error.no-members': '请先添加机器人。',
    'error.room-busy': '请等机器人完成，或先停止这一轮。', 'error.invalid-field': '请检查名称和输入长度。',
    'error.name-taken': '这个名字已被使用', 'error.project-required': '请先在房间设置里选择一个工作项目。',
    'error.member-limit': '房间最多 4 位机器人。', 'error.bot-limit': '机器人数量已达上限。',
    'error.generic': '暂时无法完成操作，请重试。',
  },
  en: {
    title: 'Collaboration room', members: 'Members', manage: 'Room members and settings', close: 'Close',
    conversations: 'Conversations', workspaces: 'Workspaces', findChat: 'Search conversations', showConversations: 'Expand conversation list',
    newConversation: 'New conversation', newGroup: 'New group chat', groupName: 'Group name', openDirect: 'Reopen a direct chat',
    group: 'Group chat', direct: 'Direct chat', noMatches: 'No matching conversations', noConversations: 'No conversations yet',
    conversationOptions: 'Conversation options', deleteConversation: 'Delete conversation', directSettings: 'Direct chat settings',
    deleteDirectDetail: 'Delete this direct chat and its messages from Conversations. You can reopen a fresh chat with this bot. DSH run records stay.',
    deleteGroupDetail: 'Delete this group and its messages. Bots, direct chats, project files and DSH run records stay.',
    welcome: 'Choose a conversation, or use + to add a bot or create a group.',
    privatePlaceholder: 'Type a message', leave: 'Remove from group',
    avatar: 'Choose an avatar', 'avatar.robot': 'Robot avatar', 'avatar.fox': 'Fox avatar', 'avatar.cat': 'Cat avatar', 'avatar.owl': 'Owl avatar',
    'avatar.panda': 'Panda avatar', 'avatar.octopus': 'Octopus avatar', 'avatar.rocket': 'Rocket avatar', 'avatar.sparkles': 'Star avatar',
    'error.group-limit': 'The group limit has been reached.', 'error.workspace-busy': 'Four bots are working. Try again when one finishes.',
    addBot: 'Add a bot', botName: 'Bot name', botRole: 'Role (optional)', join: 'Join room',
    project: 'Project', chooseProject: 'Choose a project', noProject: 'Create a project in DSH first.',
    remove: 'Delete bot', confirm: 'Confirm deletion', cancel: 'Cancel', preserve: 'The bot leaves all groups and its direct chat is deleted. Group messages stay.',
    resetContext: 'Start fresh context', confirmReset: 'Confirm new context',
    resetDetail: 'Earlier messages stay in the room. The next mention starts a fresh bot session without sending old room messages.',
    contextDivider: 'Fresh context starts here', 'error.context-changed': 'The room context changed. Confirm again.',
    openChat: 'View execution session', mention: 'Mention a bot', everyone: 'All bots',
    placeholder: 'Message the room, or type @ to mention a bot', send: 'Send', stop: 'Stop turn',
    empty: 'Send a message to start collaborating. Type @ to select a bot.', loading: 'Opening the collaboration room…',
    retry: 'Retry', running: 'Working…', failed: 'Did not finish. Open the individual chat for details.',
    partial: 'The reply reached the output limit.', stopped: 'Stopped', 'timed-out': 'Timed out',
    interrupted: 'Interrupted when the workspace restarted.', 'session-busy': 'The individual chat is already running.',
    'error.unknown-mention': 'This bot is not in the room', 'error.no-members': 'Add a bot first.',
    'error.room-busy': 'Wait for the bots or stop the current turn.', 'error.invalid-field': 'Check the name or length of your input.',
    'error.name-taken': 'That name is already in use', 'error.project-required': 'Choose a project in room settings first.',
    'error.member-limit': 'The room can have up to 4 bots.', 'error.bot-limit': 'The bot limit has been reached.',
    'error.generic': 'The operation could not finish. Try again.',
  },
}
const roomEndpoint = suffix => new URL('api/dshCloudRooms' + suffix, document.baseURI)

async function dshRoomApi(body, signal, conversationId) {
  const url = roomEndpoint(body ? '/command' : '')
  if (!body && conversationId) url.searchParams.set('conversationId', conversationId)
  const response = await fetch(url, {
    credentials: 'same-origin', cache: 'no-store', signal,
    ...(body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-cloud-rooms': '1' }, body: JSON.stringify(body) } : {}),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || (!body && !Array.isArray(data.conversations)) || (body && !('roomId' in data || 'botId' in data))) {
    throw { code: data.code ?? 'generic', detail: data.detail }
  }
  return data
}

function roomRequestId() {
  if (crypto.randomUUID) return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  return [...bytes].map((byte, i) => ([4, 6, 8, 10].includes(i) ? '-' : '') + byte.toString(16).padStart(2, '0')).join('')
}

const roomMuted = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }
const roomPalette = ['#287ee0', '#159667', '#9a54d6', '#c36b17', '#cc4675', '#168b9b',
  '#858b26', '#515ed1', '#c35538', '#557b39', '#9a5f9b', '#746354']
const roomStack = { display: 'grid', gap: 8 }
const roomRow = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const roomField = { width: '100%', boxSizing: 'border-box', padding: '7px 9px', background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-sm)', font: 'inherit' }

function RoomFailure({ error, t }) {
  if (!error) return null
  const key = 'error.' + error.code
  const detail = ['unknown-mention', 'name-taken'].includes(error.code) && error.detail ? ': @' + error.detail : ''
  return react.createElement('div', { role: 'alert', className: ChatView_module_css_default.openError },
    t(Object.hasOwn(DSH_ROOM_COPY.en, key) ? key : 'error.generic') + detail)
}

function RoomSettings({ t, data, busy, running, error, command, openChat, onClose }) {
  const h = react.createElement
  const ui = _deepseek_ai_dsh_client_ui_primitives
  const [name, setName] = react.useState('')
  const [role, setRole] = react.useState('')
  const [avatar, setAvatar] = react.useState('robot')
  const [deleting, setDeleting] = react.useState(null)
  const [resetEpoch, setResetEpoch] = react.useState(null)
  const { room, bots, projects } = data
  const epoch = room.contextEpoch ?? 0
  const hasContext = Object.keys(room.sessions).length > 0 || room.messages.some(message => (message.epoch ?? 0) === epoch)
  const currentProject = projects.some(project => project.id === room.workspaceId) ? room.workspaceId : ''
  const disabled = busy || running
  const button = (label, props) => h(ui.Button, { variant: 'outline', ...props }, label)
  const direct = room.kind === 'direct'
  return h(ui.Modal, { open: true, title: t(direct ? 'directSettings' : 'manage'), closeLabel: t('close'), onClose },
    h('div', { style: { ...roomStack, gap: 16 } },
      h(RoomFailure, { t, error }),
      h('label', { style: roomStack }, t('project'),
        h('select', { value: currentProject, disabled: disabled || !projects.length, style: roomField, onChange: e => {
          if (e.target.value) void command({ action: 'project', roomId: room.id, workspaceId: e.target.value })
        } }, !currentProject && h('option', { value: '' }, t(projects.length ? 'chooseProject' : 'noProject')),
        ...projects.map(project => h('option', { value: project.id, key: project.id }, project.title)))),
      h('div', { style: roomStack },
        resetEpoch === epoch
          ? h(react.Fragment, null, h('div', { style: roomMuted }, t('resetDetail')),
            h('div', { style: roomRow }, button(t('cancel'), { onClick: () => setResetEpoch(null) }),
              button(t('confirmReset'), { disabled, onClick: async () => {
                if (await command({ action: 'reset-context', roomId: room.id, expectedEpoch: resetEpoch })) {
                  setResetEpoch(null)
                  onClose()
                }
              } })))
          : h('div', { style: roomRow }, button(t('resetContext'), { disabled: disabled || !hasContext, onClick: () => setResetEpoch(epoch) }))),
      h('div', { style: roomStack },
        !direct && h('strong', null, t('members') + ' · ' + room.members.length),
        ...bots.filter(bot => !direct || bot.id === room.botId).map(bot => {
          const joined = room.members.includes(bot.id)
          return h('div', { key: bot.id, style: roomStack },
            h('div', { style: roomRow },
              h(RoomAvatar, { bot, size: 28 }),
              h('div', { style: { flex: 1, minWidth: 90, overflowWrap: 'anywhere' } },
                h('strong', null, '@' + bot.name), bot.role && h('div', { style: roomMuted }, bot.role)),
              !direct && !joined && button(t('join'), { disabled, onClick: () => command({ action: 'member', roomId: room.id, botId: bot.id, join: true }) }),
              joined && room.sessions[bot.id] && button(t('openChat'), { 'aria-label': t('openChat') + ' @' + bot.name,
                onClick: () => { onClose(); openChat(room.sessions[bot.id]) } }),
              !direct && joined && button(t('leave'), { disabled, onClick: () => command({ action: 'member', roomId: room.id, botId: bot.id, join: false }) }),
              direct && button(t('remove'), { disabled, 'aria-label': t('remove') + ' @' + bot.name, onClick: () => setDeleting(bot.id) })),
            deleting === bot.id && h('div', { style: roomStack },
              h('div', { style: roomMuted }, t('preserve')),
              h('div', { style: roomRow }, button(t('cancel'), { onClick: () => setDeleting(null) }),
                button(t('confirm'), { disabled, onClick: async () => {
                  if (await command({ action: 'bot-delete', roomId: room.id, botId: bot.id })) { setDeleting(null); onClose() }
                } }))))
        })),
      !direct && h('form', { style: roomStack, onSubmit: async e => {
        e.preventDefault()
        if (await command({ action: 'bot', roomId: room.id, name, role, avatar })) { setName(''); setRole(''); setAvatar('robot') }
      } },
      h(RoomBotFields, { t, name, setName, role, setRole, avatar, setAvatar }),
      h(ui.Button, { variant: 'primary', type: 'submit', disabled: disabled || !name.trim() || room.members.length >= 4 }, t('addBot')))))
}

function RoomTranscript({ t, nativeText, room, bots, openFile, openExternalLink }) {
  const h = react.createElement
  const ui = _deepseek_ai_dsh_client_ui_primitives
  const css = ChatView_module_css_default
  const scroller = react.useRef(null)
  const following = react.useRef(true)
  const epoch = room.contextEpoch ?? 0
  const change = epoch + ':' + room.messages.map(message => message.id + ':' + message.status + ':' + message.text.length).join(',')
  const divider = h('div', { key: 'room-context-divider', 'data-room-context-divider': '',
    style: { ...roomMuted, textAlign: 'center', paddingBlock: 8, borderBlockStart: '1px solid var(--dsw-alias-border-l3)' } },
    t('contextDivider'))
  const firstCurrent = room.messages.findIndex(message => (message.epoch ?? 0) === epoch)
  react.useLayoutEffect(() => {
    if (following.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [change])
  return h('div', { className: css.frame, style: { flex: 1, minHeight: 0 } },
    h('div', { className: css.root },
      h('div', { className: css.scroll, ref: scroller, onScroll: event => {
        const el = event.currentTarget
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72
      } },
      h('div', { className: css.column, 'data-chat-flow': '', role: 'log', 'aria-live': 'polite' },
        !room.messages.length && h('div', { className: css.hint }, t(room.kind === 'direct' ? 'privatePlaceholder' : 'empty')),
        ...room.messages.flatMap((message, index) => {
          const rows = index === firstCurrent && firstCurrent > 0 ? [divider] : []
          if (message.kind === 'user') {
            return [...rows, h('div', { className: MessageItem_module_css_default.userRow, key: message.id },
              h('div', { className: MessageItem_module_css_default.userStack },
                h(ui.UserMessageBubble, { 'data-message-bubble': '', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, message.text)))]
          }
          const streaming = message.status === 'running'
          const nativeId = (message.epoch ?? 0) === epoch ? room.sessions[message.botId] : undefined
          const tint = roomPalette[message.color] ?? roomPalette[0]
          const bot = bots.find(bot => message.botId ? bot.id === message.botId : bot.name === message.speaker)
          return [...rows, h('article', { className: css.flowItem, key: message.id, 'aria-label': '@' + message.speaker },
            h('div', { style: { ...roomRow, ...roomMuted, marginBottom: 5 } },
              h(RoomAvatar, { bot: bot ?? { color: message.color, avatar: message.avatar }, size: 26 }), h('strong', null, '@' + message.speaker)),
            h('div', { 'data-room-bot-bubble': '', style: {
              width: 'fit-content', maxWidth: '100%', boxSizing: 'border-box', padding: '9px 13px',
              overflowWrap: 'anywhere', borderRadius: 'var(--dsw-radius-lg)',
              backgroundColor: `color-mix(in srgb, ${tint} 14%, var(--dsw-alias-bg-base))`,
            } },
              message.text && h(ui.MarkdownDelegateProvider, {
                openFile: nativeId ? (path, options) => openFile(nativeId, path, options) : undefined,
                openExternalLink,
                getTriggerProps: () => ({}),
              }, h(AssistantMarkdown, { blocks: [{ kind: 'text', text: message.text }], streaming, t: nativeText })),
              message.status !== 'done' && h('div', { style: roomMuted, role: streaming ? 'status' : undefined }, t(message.status))))]
        }),
        epoch > 0 && firstCurrent < 0 && divider))))
}

function DshRoomPanel({ t, nativeText, Frame, Composer, SidebarExpand, mountSidebar, openChat, openFile, openExternalLink, nav }) {
  const h = react.createElement
  const ui = _deepseek_ai_dsh_client_ui_primitives
  const { data, selected, dialog } = react.useSyncExternalStore(nav.subscribe, nav.getSnapshot)
  const [error, setError] = react.useState(null)
  const [busy, setBusy] = react.useState(false)
  const [settings, setSettings] = react.useState(null)
  const writing = react.useRef(false)
  const activeRead = react.useRef(null)
  const streaming = react.useRef(false)
  const pending = react.useRef(null)
  const load = react.useCallback(async (report = true) => {
    activeRead.current?.abort()
    const request = new AbortController()
    const selection = nav.getSnapshot().selected
    activeRead.current = request
    try {
      const next = await dshRoomApi(undefined, request.signal, selection)
      if (!request.signal.aborted && nav.getSnapshot().selected === selection) {
        streaming.current = next.room?.messages.some(message => message.status === 'running')
        nav.show(next)
      }
    } catch (failure) {
      if (!request.signal.aborted && report) setError(failure)
    }
  }, [nav])
  react.useEffect(() => {
    if (!writing.current) void load()
  }, [load, selected])
  react.useEffect(() => {
    let idleTicks = 0
    const timer = setInterval(() => {
      if (!writing.current && document.visibilityState === 'visible' && (streaming.current || ++idleTicks % 4 === 0)) void load(false)
    }, 650)
    return () => { clearInterval(timer); activeRead.current?.abort() }
  }, [load])
  async function command(body, select = false) {
    if (writing.current) return false
    writing.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await dshRoomApi(body)
      if (select && result.roomId) nav.select(result.roomId)
      await load()
      return result
    } catch (failure) {
      setError(failure)
      return false
    } finally {
      writing.current = false
      setBusy(false)
    }
  }
  const room = data?.room?.id === selected ? data.room : null
  const sidebarId = room?.sidebarSessionId
  react.useLayoutEffect(() => sidebarId ? mountSidebar(sidebarId) : undefined, [mountSidebar, sidebarId])
  const members = room ? data.bots.filter(bot => room.members.includes(bot.id)) : []
  const project = data?.projects.find(item => item.id === room?.workspaceId)
  const running = room?.messages.some(message => message.status === 'running')
  const direct = room?.kind === 'direct'
  const showSettings = !!room && settings === room.id && !dialog
  const settingsLabel = t(direct ? 'directSettings' : 'manage')
  react.useEffect(() => { setError(null); setSettings(null) }, [selected, dialog?.kind, dialog?.id])
  async function send(text) {
    if (pending.current?.text !== text || pending.current?.roomId !== room.id) pending.current = { text, roomId: room.id, id: roomRequestId() }
    if (!await command({ action: 'send', roomId: room.id, requestId: pending.current.id, text })) return false
    pending.current = null
    return true
  }
  return h(Frame, {
    title: room ? room.title || t('title') : t('conversations'),
    titleIcon: room && h(RoomAvatar, { bot: direct ? members[0] : null, group: !direct, size: 31 }),
    detail: room ? (direct ? t('direct') : t('members') + ' · ' + (members.length + 1)) + (project ? '  ·  ' + project.title : '')
      : !data || selected ? t('loading') : '',
    headerAction: room && h(ui.Button, { variant: 'ghost', 'aria-label': settingsLabel, title: settingsLabel, onClick: () => { setError(null); setSettings(room.id) } },
      h(ui.IconEllipsisOutlineRegular, { size: 18 })),
    headerCorner: room && h(SidebarExpand),
    composer: room && h(Composer, { key: room.id, t, direct, members: direct ? [] : members, running, busy,
      onSend: send, onStop: () => command({ action: 'stop', roomId: room.id }) }),
  },
    !showSettings && !dialog && h(RoomFailure, { t, error }),
    room ? h(RoomTranscript, { key: room.id, t, nativeText, room, bots: data.bots, openFile, openExternalLink })
      : error ? h(ui.Button, { variant: 'outline', onClick: () => { setError(null); void load() } }, t('retry'))
      : data && !selected && h('div', { style: { margin: 'auto', padding: 24, textAlign: 'center', ...roomMuted } },
        t('welcome'), h('div', { style: { marginTop: 12 } }, h(ui.Button, { variant: 'outline', onClick: () => nav.dialog({ kind: 'new' }) }, t('newConversation')))),
    showSettings && h(RoomSettings, { t, data, running, busy, error, command, openChat, onClose: () => { setSettings(null); setError(null) } }),
    dialog && h(RoomListModal, { key: dialog.kind + ':' + (dialog.id ?? ''), t, data, dialog, busy, error, nav, command }))
}

function registerDshRoomPanel(ctx, nativeText) {
  const ui = _deepseek_ai_dsh_client_ui_primitives
  const { DshRoomFrame, DshRoomComposer } = require('@deepseek-ai/dsh-client-ui-conversation')
  ctx.effect(() => ctx.locale.register(DSH_ROOM_LOCALE, DSH_ROOM_COPY), 'ui-chat: room strings')
  const t = ctx.locale.bind(DSH_ROOM_LOCALE)
  const nav = createRoomNavigation()
  ctx.effect(() => {
    const lifetime = new AbortController()
    const registrations = []
    // Respect the existing host-plugin assignment without shipping a browser plugin.
    fetch(roomEndpoint('/session-ids'), { credentials: 'same-origin', cache: 'no-store', signal: lifetime.signal })
      .then(response => {
        if (!response.ok || lifetime.signal.aborted) return
        registrations.push(ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: DSH_ROOM_PANEL, locale: DSH_ROOM_LOCALE,
          inject: () => ({
            nativeText, Frame: DshRoomFrame, Composer: DshRoomComposer, nav,
            SidebarExpand: ctx.sidebarRight.RoomExpandButton,
            mountSidebar: ctx.sidebarRight.mountRoomSidebar,
            openChat: id => ctx.uiWorkspace.openSession(id),
            openFile: (id, path, options) => {
              const cwd = ctx.sessions.list.getSnapshot().byId[id]?.cwd
              const url = fileAddressFor(id, cwd, resolveWorkspacePath(cwd, path))
              ctx.sidebarRight.openResource(url, options?.line === undefined ? undefined : { params: { line: options.line } })
            },
            openExternalLink: url => {
              if (ctx.get('sidebarRightTabs')?.get('browser')) ctx.sidebarRight.openTab('browser', { params: { url } })
              else window.open(url, '_blank', 'noopener,noreferrer')
            },
          }),
        }, DshRoomPanel)))
        registrations.push(ctx.slots.inject('sidebar.conversations', () => ctx.slots.register({
          name: 'sidebar.conversations', locale: DSH_ROOM_LOCALE,
          inject: () => ({ nav }),
        }, RoomConversationList)))
        registrations.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: DSH_ROOM_PANEL, locale: DSH_ROOM_LOCALE, order: 15, label: () => t('conversations'),
        }, ({ size }) => react.createElement(ui.IconNewChatOutlineRegular, { size }))))
      }).catch(error => { if (!lifetime.signal.aborted) console.warn('DSH room panel:', error) })
    return () => {
      lifetime.abort()
      for (const unregister of registrations.reverse()) unregister()
    }
  }, 'ui-chat: native collaboration room')
}
