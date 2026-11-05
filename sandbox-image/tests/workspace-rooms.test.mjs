import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { test } from 'node:test'
import { nativeRunner } from '../base/plugins/workspace-rooms/index.js'
import { createRooms } from '../base/plugins/workspace-rooms/rooms.js'

async function fixture(t, run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-room-test-'))
  const path = join(dir, 'state.json')
  const projects = () => [{ id: 'project', title: 'Test project' }]
  const rooms = createRooms({ path, projects, run })
  t.after(async () => { await rooms.close(); await rm(dir, { recursive: true, force: true }) })
  const makeBot = async name => {
    const { room } = await rooms.view()
    const roomId = room?.kind === 'group' ? room.id : (await rooms.command({ action: 'create-room', title: 'Test group', members: [] })).roomId
    return (await rooms.command({ action: 'bot', roomId, name })).botId
  }
  const send = (roomId, text, requestId = randomUUID()) => rooms.command({ action: 'send', roomId, text, requestId })
  return { rooms, makeBot, send, path, projects }
}

async function settled(rooms, id) {
  for (let i = 0; i < 200; i++) {
    const { room } = await rooms.view(id)
    assert.equal(room.id, id)
    if (!room.messages.some(message => message.status === 'running')) return room
    await setTimeout(10)
  }
  assert.fail('room did not settle')
}

test('a group deduplicates dispatch, shares history, and separates bot identities', async t => {
  const calls = []
  const { rooms, makeBot, send } = await fixture(t, async args => {
    calls.push(args)
    if (!args.sessionId) await args.bindSession(randomUUID())
    return { status: 'done', text: `Evidence from ${args.bot.name}` }
  })
  const research = await makeBot('调研员')
  const review = await makeBot('Reviewer')
  const first = (await rooms.view()).room.id
  const id = randomUUID()
  await send(first, '@all Check sources', id)
  await send(first, '@all Check sources', id)
  const original = await settled(rooms, first)
  assert.deepEqual(calls.map(call => call.bot.name), ['调研员', 'reviewer'])
  assert.equal(original.messages.length, 3)
  assert.notEqual(original.sessions[research], original.sessions[review])
  const originalColors = new Map(original.messages.filter(message => message.kind === 'bot').map(message => [message.botId, message.color]))
  assert.equal(new Set(originalColors.values()).size, 2)
  await send(first, '@Reviewer 根据前面的证据复核')
  await settled(rooms, first)
  assert.equal(calls.at(-1).sessionId, original.sessions[review])
  assert.match(calls.at(-1).prompt, /Evidence from 调研员/)
  await send(first, '联系 hello@example.com')
  assert.equal(calls.length, 3)
  await rooms.command({ action: 'bot-delete', roomId: first, botId: review })
  await assert.rejects(send(first, '@reviewer 复核'), { code: 'unknown-mention' })
  const reviewReplies = (await rooms.view()).room.messages.filter(message => message.botId === review)
  assert.equal(reviewReplies.length, 2)
  assert.ok(reviewReplies.every(message => message.color === originalColors.get(review)))
  assert.ok((await rooms.sessionIds()).includes(original.sessions[review]))
  const replacement = await makeBot('Reviewer')
  assert.notEqual(replacement, review)
  await send(first, '@reviewer 继续')
  const next = await settled(rooms, first)
  assert.notEqual(next.sessions[replacement], original.sessions[review])
  assert.notEqual(next.messages.at(-1).color, originalColors.get(review))
  await assert.rejects(rooms.command({ action: 'room', title: 'Second room' }), { code: 'invalid-action' })
})

test('the room keeps one hidden sidebar session per project context without dispatching bots', async t => {
  const { path } = await fixture(t, () => assert.fail('opening the sidebar must not run a model'))
  const created = []
  const options = {
    path,
    projects: () => [{ id: 'first' }, { id: 'second' }],
    run: () => assert.fail('opening the sidebar must not run a model'),
    createSidebarSession: async project => {
      const sessionId = `session-dsh-room-sidebar-${project}`
      created.push(project)
      return sessionId
    },
  }
  const rooms = createRooms(options)
  t.after(() => rooms.close())
  await rooms.command({ action: 'create-room', title: 'Dock test', members: [] })
  const [{ room }, another] = await Promise.all([rooms.view(), rooms.view()])
  assert.equal(room.sidebarSessionId, 'session-dsh-room-sidebar-first')
  assert.equal(another.room.sidebarSessionId, room.sidebarSessionId)
  assert.deepEqual(await rooms.sessionIds(), [room.sidebarSessionId])
  await rooms.close()
  const reopened = createRooms(options)
  t.after(() => reopened.close())
  assert.equal((await reopened.view()).room.sidebarSessionId, room.sidebarSessionId)
  await reopened.command({ action: 'project', roomId: room.id, workspaceId: 'second' })
  const { room: switched } = await reopened.view()
  assert.equal(switched.sidebarSessionId, 'session-dsh-room-sidebar-second')
  assert.deepEqual(created, ['first', 'second'])
  assert.deepEqual(await reopened.sessionIds(), [room.sidebarSessionId, switched.sidebarSessionId])
})

test('starting a fresh context preserves the timeline and starts new bot sessions without replaying old room history', async t => {
  const calls = []
  const { rooms, makeBot, send } = await fixture(t, async args => {
    calls.push(args)
    await args.bindSession(randomUUID())
    return { status: 'done', text: `Result for context ${args.room.contextEpoch ?? 0}` }
  })
  const bot = await makeBot('reviewer')
  const id = (await rooms.view()).room.id
  await send(id, '@reviewer OLD_CONTEXT')
  const original = await settled(rooms, id)
  await rooms.command({ action: 'reset-context', roomId: id, expectedEpoch: 0 })
  const { room } = await rooms.view()
  assert.equal(room.contextEpoch, 1)
  assert.deepEqual(room.messages, original.messages)
  assert.deepEqual(room.members, original.members)
  assert.deepEqual(room.sessions, {})
  assert.ok((await rooms.sessionIds()).includes(original.sessions[bot]))
  await assert.rejects(rooms.command({ action: 'reset-context', roomId: id, expectedEpoch: 0 }), { code: 'context-changed' })
  await send(id, '@reviewer NEW_CONTEXT')
  const fresh = await settled(rooms, id)
  assert.equal(calls[1].sessionId, undefined)
  assert.doesNotMatch(calls[1].prompt, /OLD_CONTEXT|Result for context 0/)
  assert.match(calls[1].prompt, /NEW_CONTEXT/)
  assert.notEqual(fresh.sessions[bot], original.sessions[bot])
})

test('stop only cancels the active dispatch and recovery never redispatches interrupted work', async t => {
  const { rooms, makeBot, send, path, projects } = await fixture(t, async ({ signal }) => {
    signal.throwIfAborted()
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  await makeBot('worker')
  const roomId = (await rooms.view()).room.id
  await send(roomId, '@worker do work')
  await assert.rejects(send(roomId, '@worker duplicate work'), { code: 'room-busy' })
  await assert.rejects(rooms.command({ action: 'reset-context', roomId, expectedEpoch: 0 }), { code: 'room-busy' })
  const crashState = await readFile(path)
  await rooms.command({ action: 'stop', roomId })
  assert.equal((await settled(rooms, roomId)).messages.at(-1).status, 'stopped')

  const restoredPath = `${path}.restored`
  await writeFile(restoredPath, crashState)
  let dispatched = false
  const restored = createRooms({ path: restoredPath, projects, run: async () => { dispatched = true } })
  t.after(() => restored.close())
  const snapshot = await restored.view()
  assert.equal(snapshot.room.messages.at(-1).status, 'interrupted')
  assert.equal(snapshot.room.messages[0].text, '@worker do work')
  assert.equal(dispatched, false)
})

test('v1 migration keeps the latest room visible and all archived chats out of the workspace list', async t => {
  const { rooms, path } = await fixture(t, () => assert.fail('migration must not run a model'))
  const legacyRoom = (id, at) => ({
    id, title: id, workspaceId: 'project', members: [], sessions: { bot: `session-${id}` },
    messages: [{ id: `message-${id}`, kind: 'bot', status: 'running', text: '', at }],
  })
  await writeFile(path, JSON.stringify({ version: 1, bots: [], rooms: [legacyRoom('older', 1), legacyRoom('recent', 2)] }))
  const { room } = await rooms.view()
  assert.equal(room.id, 'recent')
  assert.equal(room.messages[0].status, 'interrupted')
  assert.deepEqual(await rooms.sessionIds(), ['session-recent', 'session-older'])
  const migrated = JSON.parse(await readFile(path))
  assert.equal(migrated.version, 3)
  assert.deepEqual(migrated.archivedRooms.map(item => item.id), ['older'])
  assert.equal(migrated.archivedRooms[0].messages[0].status, 'interrupted')
})

test('private chat and multiple groups have separate context, and deleting a conversation keeps its bot', async t => {
  const calls = []
  const { rooms, send, path, projects } = await fixture(t, async args => {
    calls.push(args)
    if (!args.sessionId) await args.bindSession(randomUUID())
    return { status: 'done', text: args.room.title }
  })
  assert.equal((await rooms.view()).room, null)
  await assert.rejects(rooms.command({ action: 'bot', name: 'reviewer', avatar: 'https://untrusted.invalid' }), { code: 'invalid-field' })
  const { botId, roomId: direct } = await rooms.command({ action: 'bot', name: 'reviewer', avatar: 'fox' })
  assert.equal((await rooms.command({ action: 'direct', botId })).roomId, direct)
  const { roomId: group } = await rooms.command({ action: 'create-room', title: 'Review project', members: [botId] })
  const { roomId: other } = await rooms.command({ action: 'create-room', title: 'Another project', members: [botId] })
  await send(group, '@reviewer GROUP_SECRET')
  const oldGroup = await settled(rooms, group)
  await send(direct, 'DIRECT_MESSAGE_WITHOUT_MENTION')
  const oldDirect = await settled(rooms, direct)
  assert.doesNotMatch(calls.at(-1).prompt, /GROUP_SECRET/)
  assert.notEqual(oldDirect.sessions[botId], oldGroup.sessions[botId])
  assert.equal((await rooms.view(other)).room.messages.length, 0)
  await rooms.command({ action: 'delete-conversation', roomId: direct })
  assert.ok((await rooms.sessionIds()).includes(oldDirect.sessions[botId]))
  const snapshot = await rooms.view()
  assert.equal(snapshot.bots[0].avatar, 'fox')
  assert.deepEqual(snapshot.conversations.map(row => row.id), [group, other])
  assert.deepEqual(snapshot.room.messages, oldGroup.messages)
  const restored = createRooms({ path, projects, run: () => assert.fail('reopening a chat must not run a model') })
  t.after(() => restored.close())
  assert.deepEqual((await restored.view()).conversations.map(row => row.id), [group, other])
  const { roomId: fresh } = await restored.command({ action: 'direct', botId })
  assert.notEqual(fresh, direct)
  assert.deepEqual((await restored.view(fresh)).room.messages, [])
  await restored.command({ action: 'delete-conversation', roomId: group })
  const remaining = await restored.view(other)
  assert.deepEqual(remaining.conversations.map(row => row.id), [other, fresh])
  assert.equal(remaining.bots[0].id, botId)
})

test('new native bot chats use the selected working directory without joining the project list', async () => {
  let bound, listener
  const sessionController = {
    async create(options) {
      assert.equal(options.cwd, '/work/project')
      assert.equal(options.workspaceId, undefined)
      assert.match(options.sessionId, /^session-dsh-room-/)
      return { sessionId: options.sessionId }
    },
    async rename() {},
    async prompt({ sessionId, requestId }) {
      assert.equal(sessionId, bound)
      const session = { id: sessionId }
      listener(session, { type: 'turn/start', data: { turn: 1 } })
      listener(session, { type: 'user/message', data: { source: { kind: 'user', rpcId: requestId } } })
      listener(session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Result' }] } } })
      listener(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    },
  }
  const run = nativeRunner({
    sessionController,
    workspaceRegistry: { get: id => id === 'project' ? { path: '/work/project' } : null },
    agents: { get: () => undefined },
    on: (_, fn) => { listener = fn; return () => { listener = undefined } },
  })
  const result = await run({ room: { workspaceId: 'project' }, bot: { name: 'researcher' },
    requestId: randomUUID(), prompt: 'Research', bindSession: async id => { bound = id }, signal: new AbortController().signal })
  assert.deepEqual(result, { status: 'done', text: 'Result' })
  assert.equal(listener, undefined)
})
