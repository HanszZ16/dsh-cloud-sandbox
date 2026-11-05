// This runs inside the native WorkspaceBrowser, before it derives groups or
// search results. Do not modify the root Session store or the mounted slot.
const [roomChatIds, setRoomChatIds] = react.useState(() => new Set())
react.useEffect(() => {
  const controller = new AbortController()
  fetch(new URL('api/dshCloudRooms/session-ids', document.baseURI), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
    .then(response => response.ok ? response.json() : null)
    .then(data => { if (!controller.signal.aborted && Array.isArray(data?.sessionIds)) setRoomChatIds(new Set(data.sessionIds)) })
    .catch(() => {})
  return () => controller.abort()
}, [])
const filterRoomChats = react.useMemo(() => {
  const isRoomChat = id => id.startsWith('session-dsh-room-') || roomChatIds.has(id)
  let input, output
  return snapshot => {
    if (input === snapshot) return output
    input = snapshot
    const ids = snapshot.ids.filter(id => !isRoomChat(id))
    const hidden = Object.keys(snapshot.byId).filter(isRoomChat)
    if (!hidden.length && ids.length === snapshot.ids.length) return (output = snapshot)
    const byId = { ...snapshot.byId }
    for (const id of hidden) delete byId[id]
    return (output = { ...snapshot, ids, byId })
  }
}, [roomChatIds])
const useSessions = select => useNativeSessions(snapshot => select(filterRoomChats(snapshot)))
