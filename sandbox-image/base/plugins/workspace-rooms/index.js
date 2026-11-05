import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRooms, RoomError } from './rooms.js'

export const name = 'workspace-rooms'
export const inject = ['connection', 'sessionController', 'agents', 'workspaceRegistry']

const ROUTE = '/api/dshCloudRooms'
const MAX_BODY_BYTES = 24 * 1024
const TURN_TIMEOUT_MS = 180_000

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  } })
}

async function readCommand(request) {
  // Require a non-simple browser request; a form from another origin cannot issue commands.
  const site = request.headers.get('sec-fetch-site')
  if (request.headers.get('x-dsh-cloud-rooms') !== '1' || (site && site !== 'same-origin' && site !== 'none')) {
    throw new RoomError(403, 'invalid-origin')
  }
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new RoomError(415, 'invalid-content-type')
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of request.body ?? []) {
    bytes += chunk.byteLength
    if (bytes > MAX_BODY_BYTES) throw new RoomError(413, 'request-too-large')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new RoomError(400, 'invalid-json') }
}

const rpcId = (message) => message?.source?.kind === 'user' ? message.source.rpcId : undefined

/** Track only the native turn that admitted this room's prompt, even when the user opens the bot chat. */
export function watchTurn(ctx, sessionId, requestId, updatePreview) {
  const { promise, resolve } = Promise.withResolvers()
  let turn, ownedTurn, finished = false
  let text = ''
  const ownsActiveTurn = () => !finished && ownedTurn !== undefined && turn === ownedTurn
  const unsubscribe = ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId || finished) return
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.type === 'user/message' && rpcId(event.data) === requestId) ownedTurn = turn
    if (ownedTurn === undefined || turn !== ownedTurn) return
    if (event.type === 'assistant/message' && event.data.turn === ownedTurn) {
      const parts = event.data.message.content
      if (!parts.some(part => part.type === 'tool-call')) {
        text = parts.filter(part => part.type === 'text').map(part => part.text).join('').trim()
      }
    }
    if (event.type === 'turn/end' && event.data.turn === ownedTurn) {
      finished = true
      const reason = event.data.reason.kind
      const status = reason === 'completed' && text ? 'done'
        : reason === 'max-tokens' && text ? 'partial'
        : reason === 'aborted' ? 'stopped' : 'failed'
      resolve({ status, text: status === 'done' || status === 'partial' ? text : '' })
    }
  })
  let attempt, preview = ''
  const unsubscribeStream = updatePreview && ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (agent.session.id !== sessionId || !ownsActiveTurn()) return
    if (frame.type === 'start' && frame.turn === ownedTurn) {
      attempt = frame.attemptId
      preview = ''
      updatePreview('')
    } else if (frame.type === 'chunk' && frame.attemptId === attempt && frame.chunk.type === 'text-delta') {
      preview = (preview + frame.chunk.text).slice(0, 12_000)
      updatePreview(preview)
    }
  }, { global: true })
  return { promise, ownsActiveTurn, dispose() { unsubscribe(); unsubscribeStream?.() } }
}

export function nativeRunner(ctx, timeoutMs = TURN_TIMEOUT_MS) {
  const controller = ctx.sessionController
  return async ({ room, bot, sessionId, bindSession, prompt, requestId, signal, updatePreview }) => {
    signal.throwIfAborted()
    if (!sessionId) {
      const workspace = ctx.workspaceRegistry.get(room.workspaceId)
      if (!workspace) throw new RoomError(400, 'project-required')
      // Keep the real working directory but leave the native chat out of the project's membership.
      const created = await controller.create({ cwd: workspace.path, sessionId: `session-dsh-room-${randomUUID()}` })
      sessionId = created.sessionId
      await bindSession(sessionId)
      // The ordinary chat is available for files, approvals, and detailed tool output.
      try { await controller.rename({ sessionId, title: room.kind === 'direct' ? `@${bot.name}` : `${room.title || '协作房间'} · @${bot.name}` }) }
      catch { /* the title does not affect routing */ }
    }
    signal.throwIfAborted()
    const agentBefore = ctx.agents.get(sessionId)
    if (agentBefore?.status === 'running' || agentBefore?.inbox.nextTurn.length) return { status: 'session-busy', text: '' }
    const timed = AbortSignal.timeout(timeoutMs)
    const deadline = AbortSignal.any([signal, timed])
    const watch = watchTurn(ctx, sessionId, requestId, updatePreview)
    let interrupted
    const aborted = new Promise(resolve => {
      interrupted = () => resolve({ status: signal.aborted ? 'stopped' : 'timed-out', text: '' })
      deadline.addEventListener('abort', interrupted, { once: true })
    })
    try {
      await controller.prompt({ sessionId, requestId, mode: 'followup', content: [{ type: 'text', text: prompt }] }, deadline)
      const agent = ctx.agents.get(sessionId)
      const result = await Promise.race([
        watch.promise,
        aborted,
        agent?.whenIdle().then(() => ({ status: 'failed', text: '' })) ?? Promise.resolve({ status: 'failed', text: '' }),
      ])
      if (result.status === 'stopped' || result.status === 'timed-out') {
        if (watch.ownsActiveTurn()) controller.cancel({ sessionId })
        else {
          const queued = agent?.inbox.nextTurn.find(message => rpcId(message) === requestId)
          if (queued) await controller.updateQueue({ sessionId, itemId: queued.id, action: { kind: 'remove' } })
        }
      }
      return result
    } finally {
      deadline.removeEventListener('abort', interrupted)
      watch.dispose()
    }
  }
}

export function apply(ctx, config = {}) {
  const rooms = createRooms({
    path: config.stateFile ?? join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'workspace-rooms', 'state.json'),
    projects: () => ctx.workspaceRegistry.list().map(({ id, title }) => ({ id, title })),
    run: nativeRunner(ctx),
    async createSidebarSession(workspaceId) {
      const { path: cwd } = ctx.workspaceRegistry.get(workspaceId)
      const { sessionId } = await ctx.sessionController.create({ cwd, sessionId: `session-dsh-room-sidebar-${randomUUID()}` })
      return sessionId
    },
    warn: (error, operation = 'bot turn') => ctx.logger.warn('room %s failed: %s', operation, String(error?.code ?? error?.name ?? 'unknown')),
  })

  async function serve(request, handler) {
    try { return json(await handler(request)) }
    catch (error) {
      if (error instanceof RoomError) return json({ code: error.code, detail: error.detail }, error.status)
      ctx.logger.warn('room route failed: %s', String(error?.code ?? error?.name ?? 'unknown'))
      return json({ code: 'unavailable' }, 500)
    }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE, methods: ['GET'], requestBody: 'buffered',
    fetch: request => serve(request, () => rooms.view(new URL(request.url).searchParams.get('conversationId'))),
  }), 'workspace-rooms: read rooms')
  ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE}/session-ids`, methods: ['GET'], requestBody: 'buffered',
    fetch: request => serve(request, async () => ({ sessionIds: await rooms.sessionIds() })),
  }), 'workspace-rooms: session ownership')
  ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE}/command`, methods: ['POST'], requestBody: 'streaming',
    fetch: request => serve(request, async req => rooms.command(await readCommand(req))),
  }), 'workspace-rooms: room commands')
  ctx.effect(() => () => rooms.close(), 'workspace-rooms: stop dispatch')
}
