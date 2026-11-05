// Compiled into DSH's native right sidebar. A room has its own dock Session
// while the selected workspace Conversation and its dock remain untouched.
const DSH_ROOM_SIDEBAR_PANEL = 'dsh-cloud-workspace-rooms'

function createRoomSidebar(ctx, controller, t) {
  const owner = _deepseek_ai_dsh_client_store.createSnapshotStore(undefined)
  const seat = _deepseek_ai_dsh_client_store.createSnapshotStore(undefined)
  const active = () => ctx.layout.panelInfo.getSnapshot().activePanelId === DSH_ROOM_SIDEBAR_PANEL
  let pendingBrowser
  let attachment

  function sync() {
    const sessionId = active() ? owner.getSnapshot() : undefined
    const store = sessionId && controller.adopted.get(sessionId)?.store
    const previous = seat.getSnapshot()
    if (store ? previous?.store !== store : previous !== undefined) {
      seat.set(store ? { sessionId, store } : undefined)
    }
    if (!active()) pendingBrowser = undefined
    if (pendingBrowser && store && controller.mounted.getSnapshot() === sessionId) {
      const kind = pendingBrowser
      pendingBrowser = undefined
      controller.openTab(kind)
    }
  }

  controller.mountRoomSidebar = sessionId => {
    const lease = attachment = {}
    owner.set(sessionId)
    return () => {
      if (attachment !== lease) return
      attachment = undefined
      owner.set(undefined)
    }
  }

  // The existing browser watcher reports starts and stops. Queue a start that
  // arrives before React has adopted the room's native dock store.
  controller.followRoomBrowser = (kind, operating) => {
    if (!active()) return false
    pendingBrowser = operating ? kind : undefined
    sync()
    return true
  }

  const shortcuts = ctx.shortcuts.catalog
  function useShortcuts(select) {
    return select(react.useSyncExternalStore(shortcuts.subscribe, shortcuts.getSnapshot))
  }
  function RoomExpandSeat({ sessionId, store }) {
    const useStore = select => select(react.useSyncExternalStore(store.subscribe, store.getSnapshot))
    return react.createElement(ExpandButton, { sessionId, useStore, actions: store.actions, t, useShortcuts })
  }
  controller.RoomExpandButton = function RoomExpandButton() {
    const ready = react.useSyncExternalStore(seat.subscribe, seat.getSnapshot)
    return ready ? react.createElement(RoomExpandSeat, ready) : null
  }
  return { owner, sync }
}
