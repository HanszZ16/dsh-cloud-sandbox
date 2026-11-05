import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const directory = process.argv[2]
if (!directory) throw new Error('Usage: node apply.mjs /path/to/@deepseek-ai/dsh')
const require = createRequire(resolve(directory, 'package.json'))
const snippet = name => readFileSync(new URL(name, import.meta.url), 'utf8').trim()
const marker = '// dsh-cloud: native room integration (alpha.3)'
const expected = {
  'ui-chat': 'b7e645f2461231e8ece31381f026db2df72d058e425eaef19265f215c823d84e',
  'ui-conversation': '9a37949cc76603ea3a965ce4d0d6ca65885de4a9808345c38748e595ac396378',
  'ui-sidebar': '07cead30e20b91bf36b0b94d2574f4d7e672a4efbbfab7670376aeb00d89968b',
  'ui-sidebar-right': '45868a5ae021b850f6ee6451b6d1168d3c72ddea81b3073b6cfbbebaf23c5257',
  'ui-workspace': 'bb31f7870381f737b2cb45db4c7911a08a4949856bc86b648a10d3e85a3e9f89',
}

function replaceOnce(text, before, after) {
  const index = text.indexOf(before)
  if (index < 0 || text.indexOf(before, index + before.length) >= 0) throw new Error('Native DSH patch anchor missing or ambiguous: ' + before.trim())
  return text.slice(0, index) + after + text.slice(index + before.length)
}
const addBefore = (text, anchor, source) => replaceOnce(text, anchor, marker + '\n' + source + '\n' + anchor)
const patches = {
  'ui-conversation': text => addBefore(text, '\t\texports.Config = Config;', snippet('room-conversation.js') +
    '\nexports.DshRoomFrame = DshRoomFrame;\nexports.DshRoomComposer = DshRoomComposer;'),
  'ui-chat': text => {
    text = addBefore(text, '\t\tfunction apply(ctx) {', snippet('room-list.js') + '\n' + snippet('room-chat.js'))
    const anchor = '\t\t\tconst chatStore = createChatStore();'
    return replaceOnce(text, anchor, anchor + '\n\t\t\tregisterDshRoomPanel(ctx, t);')
  },
  'ui-sidebar': text => {
    const panelId = '"dsh-cloud-workspace-rooms"'
    const currentPanel = '\t\t\tconst activePanelId = usePanelInfo((info) => info.activePanelId);'
    text = replaceOnce(text, currentPanel, currentPanel + `
			const selectSidebarPanel = id => {
				selectPanel(id);
				if (id === ${panelId} && (collapsed || drawer)) toggleSidebar();
			};`)
    text = replaceOnce(text, '\t\t\t\t\t\t\tselectPanel,\n\t\t\t\t\t\t\ttrackEntryClick,',
      '\t\t\t\t\t\t\tselectPanel: selectSidebarPanel,\n\t\t\t\t\t\t\ttrackEntryClick,')
    text = replaceOnce(text, 'if (panel !== void 0) selectPanel(panel.id);',
      'if (panel !== void 0) selectSidebarPanel(panel.id);')
    const anchorRender = 'children: renderSlot("sidebar.workspaces", {'
    text = replaceOnce(text, anchorRender, 'children: activePanelId === "dsh-cloud-workspace-rooms" ? renderSlot("sidebar.conversations", {\n' +
      '  wide, backToWorkspaces: () => selectPanel(null), expandSidebar: () => { if (collapsed) toggleSidebar(); },\n' +
      '  onConversationSelected: () => { if (drawer && !collapsed) toggleSidebar(); }\n' +
      '}) : ' + anchorRender.slice('children: '.length))
    const anchor = '\t\t\t\t\t"sidebar.workspaces": {'
    return addBefore(text, anchor, '\t\t\t\t\t"sidebar.conversations": { kind: "single", scope: "root" },')
  },
  'ui-sidebar-right': text => {
    text = addBefore(text, '\t\tfunction apply(ctx) {', snippet('room-sidebar.js'))
    const visible = '\t\t\tconst visible = usePanelInfo((info) => info.activePanelId === null);'
    text = replaceOnce(text, visible, '\t\t\tconst visible = usePanelInfo((info) => info.activePanelId === null || info.activePanelId === DSH_ROOM_SIDEBAR_PANEL);')
    const oldSelection = `\t\t\tctx.effect(() => {
				const current = ctx.uiSession.adapter.current;
				const sync = () => {
					views.select(current.getSnapshot().key);
				};
				const unsubscribe = current.subscribe(sync);
				sync();
				return () => {
					unsubscribe();
					views.dispose();
				};
			}, "ui-sidebar-right: retained Session views");`
    text = replaceOnce(text, oldSelection + '\n', '')
    const oldVisibility = `\t\t\tctx.effect(() => {
				const sync = () => {
					const selected = views.source.getSnapshot().find((view) => view.selected);
					show(layout.panelInfo.getSnapshot().activePanelId === null ? selected?.sessionId : void 0);
				};
				const unsubscribeViews = views.source.subscribe(sync);
				const unsubscribePanel = layout.panelInfo.subscribe(sync);
				sync();
				return () => {
					unsubscribeViews();
					unsubscribePanel();
					show(void 0);
				};
			}, "ui-sidebar-right: on-screen Session");`
    text = replaceOnce(text, oldVisibility, `\t\t\tconst roomSidebar = createRoomSidebar(ctx, controller, t);
			ctx.effect(() => {
				const current = ctx.uiSession.adapter.current;
				const sync = () => {
					const panel = layout.panelInfo.getSnapshot().activePanelId;
					const room = panel === DSH_ROOM_SIDEBAR_PANEL;
					const id = room ? roomSidebar.owner.getSnapshot() : current.getSnapshot().key;
					views.select(id);
					show(panel === null || room ? id : void 0);
					queueMicrotask(roomSidebar.sync);
				};
				const disposers = [current, layout.panelInfo, roomSidebar.owner].map(source => source.subscribe(sync));
				sync();
				return () => {
					for (const dispose of disposers) dispose();
					show(void 0);
					views.dispose();
				};
			}, "ui-sidebar-right: on-screen Session");`)
    const adopt = '\t\t\t\t\t\t\tadoptions.set(sessionId, adopt(sessionId, instance));'
    return replaceOnce(text, adopt, adopt + '\n\t\t\t\t\t\t\tif (sessionId === roomSidebar.owner.getSnapshot()) queueMicrotask(roomSidebar.sync);')
  },
  'ui-workspace': text => {
    const anchor = '\t\t\tconst list = useSessions((state) => state);'
    // Only WorkspaceBrowser reads the projected list. All other consumers keep
    // the real session identity, including DSH navigation and tool approvals.
    text = replaceOnce(text, '\t\tfunction WorkspaceBrowser({ wide, usePanelInfo, expandSidebar, useSessions,',
      '\t\tfunction WorkspaceBrowser({ wide, usePanelInfo, expandSidebar, useSessions: useNativeSessions,')
    const signature = text.indexOf('function WorkspaceBrowser({')
    const relative = text.indexOf(anchor, signature)
    if (relative < 0 || relative - signature > 2300) throw new Error('WorkspaceBrowser list anchor moved')
    text = text.slice(0, relative) + snippet('room-workspace.js') + '\n' + text.slice(relative)
    return marker + '\n' + text
  },
}

const pending = []
for (const [name, transform] of Object.entries(patches)) {
  const path = require.resolve('@deepseek-ai/dsh-client-' + name + '/client')
  const source = readFileSync(path, 'utf8')
  if (source.includes(marker)) throw new Error('Use a clean installation to apply the native patch: ' + path)
  if (createHash('sha256').update(source).digest('hex') !== expected[name]) throw new Error('Unsupported DSH client build: ' + path)
  pending.push([path, transform(source)])
}
for (const [path, content] of pending) writeFileSync(path, content)
console.log('Patched native DSH Chat, Conversation, Sidebar, Right Sidebar and Workspace modules.')
