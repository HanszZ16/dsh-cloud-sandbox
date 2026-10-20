/**
 * Workspace browser hub: one Chromium per workspace, shared by the agent and the user.
 *
 * - Chromium starts on first use (headless, remote debugging on 127.0.0.1:CDP_PORT)
 *   with its profile under the user's home, so logins survive sleep.
 * - Agent endpoint, 127.0.0.1:AGENT_PORT: a pass-through Chrome DevTools Protocol
 *   proxy for the Playwright MCP server (`playwright-mcp --cdp-endpoint http://127.0.0.1:9223`).
 *   Passing through here lets viewers see when the agent is operating.
 * - Viewer endpoint, HUB_HOST:HUB_PORT: a WebSocket that the gateway forwards for the
 *   signed-in user only. It speaks a small JSON protocol instead of raw CDP:
 *     server → viewer  {type:"frame", data, width, height}   JPEG of the active tab
 *                      {type:"tabs", tabs:[{id,title,url,active}], canGoBack, canGoForward}
 *                      {type:"agent", active}                  agent sent CDP traffic recently
 *                      {type:"dialog", dialogType, message, defaultPrompt} | {type:"dialog-closed"}
 *                      {type:"status", state, message?}        "starting" | "ready" | "error"
 *     viewer → server  {type:"mouse", event, x, y, button, clickCount, deltaX, deltaY, modifiers}
 *                      {type:"key", event:"down"|"up", key, code, keyCode, modifiers}
 *                      {type:"text", text}                     typed or pasted text, IME output
 *                      {type:"navigate", url} | {type:"back"} | {type:"forward"} | {type:"reload"}
 *                      {type:"activate", id} | {type:"new-tab"} | {type:"close-tab", id}
 *                      {type:"dialog", accept, promptText}
 *   Coordinates are page CSS pixels of the frame the viewer last received.
 *   A connection with ?watch=1 only receives {type:"agent"} events: it neither
 *   starts Chromium nor receives frames. dsh pages keep one open to bring the
 *   live view forward when the agent starts operating the browser.
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'

const HUB_HOST = process.env.HUB_HOST ?? '127.0.0.1'
const HUB_PORT = Number(process.env.HUB_PORT ?? 3081)
const CDP_PORT = Number(process.env.CDP_PORT ?? 9222)
const AGENT_PORT = Number(process.env.AGENT_PORT ?? 9223)
const CHROMIUM = process.env.CHROMIUM ?? '/usr/bin/chromium'
const PROFILE_DIR = process.env.BROWSER_PROFILE_DIR ?? join(process.env.HOME ?? '/home/agent', '.config/dsh-workspace-browser')
const WIDTH = 1280
const HEIGHT = 800
const AGENT_IDLE_MS = 3000

const log = (...args) => console.log('dsh-cloud browser:', ...args)

// Chromium lifecycle

let chrome = null
let starting = null

async function cdpJson(path) {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`)
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  return response.json()
}

function ensureChrome() {
  if (chrome) return Promise.resolve()
  starting ??= launch().finally(() => {
    starting = null
  })
  return starting
}

async function launch() {
  // A profile saved from a stopped container still holds the old host's locks.
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    rmSync(join(PROFILE_DIR, name), { force: true })
  }
  log('starting Chromium')
  const child = spawn(CHROMIUM, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${PROFILE_DIR}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // Containers get a 64 MB /dev/shm, too small for Chromium's renderers.
    '--disable-dev-shm-usage',
    '--lang=zh-CN',
    'about:blank',
  ], { stdio: 'ignore' })
  child.on('exit', (code, signal) => {
    log(`Chromium exited (${signal ?? code})`)
    if (chrome === child) chrome = null
    viewer.chromeExited()
  })
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chromium exited during startup (${child.exitCode})`)
    try {
      await cdpJson('/json/version')
      chrome = child
      log('Chromium ready')
      return
    } catch {
      // Not listening yet.
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  child.kill('SIGKILL')
  throw new Error('Chromium did not start within 30s')
}

/** A flat CDP connection to the browser target, with sessions multiplexed by sessionId. */
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve)
      this.ws.once('error', reject)
    })
    this.ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) waiter?.reject(new Error(message.error.message))
        else waiter?.resolve(message.result)
      } else {
        for (const listener of this.listeners) listener(message)
      }
    })
    this.ws.on('close', () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('CDP connection closed'))
      this.pending.clear()
    })
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  close() {
    this.ws.close()
  }
}

// Viewer side: one shared controller for every connected viewer

const viewer = {
  sockets: new Set(),
  cdp: null,
  pages: new Map(), // targetId -> {id, title, url}
  activeId: null,
  sessionId: null,
  history: { canGoBack: false, canGoForward: false },
  agentActive: false,
  connecting: null,

  broadcast(message) {
    const text = JSON.stringify(message)
    for (const socket of this.sockets) if (socket.readyState === WebSocket.OPEN) socket.send(text)
  },

  sendTabs() {
    this.broadcast({
      type: 'tabs',
      tabs: [...this.pages.values()].map((page) => ({ ...page, active: page.id === this.activeId })),
      ...this.history,
    })
  },

  async add(socket) {
    this.sockets.add(socket)
    socket.on('close', () => {
      this.sockets.delete(socket)
      if (this.sockets.size === 0) this.disconnect()
    })
    socket.on('message', (raw) => {
      let message
      try {
        message = JSON.parse(raw.toString())
      } catch {
        // Ignore malformed viewer input.
        return
      }
      this.handle(message).catch((err) => log('viewer command failed:', message.type, err.message))
    })
    socket.send(JSON.stringify({ type: 'agent', active: this.agentActive }))
    try {
      await this.connect()
      socket.send(JSON.stringify({ type: 'status', state: 'ready' }))
      this.sendTabs()
    } catch (err) {
      socket.send(JSON.stringify({ type: 'status', state: 'error', message: err.message }))
    }
  },

  connect() {
    if (this.cdp) return Promise.resolve()
    this.connecting ??= this.open().finally(() => {
      this.connecting = null
    })
    return this.connecting
  },

  async open() {
    this.broadcast({ type: 'status', state: 'starting' })
    await ensureChrome()
    const { webSocketDebuggerUrl } = await cdpJson('/json/version')
    const cdp = new Cdp(webSocketDebuggerUrl)
    await cdp.opened
    this.cdp = cdp
    cdp.listeners.add((message) => this.onEvent(message))
    cdp.ws.on('close', () => {
      if (this.cdp === cdp) this.reset()
    })
    await cdp.send('Target.setDiscoverTargets', { discover: true })
    const { targetInfos } = await cdp.send('Target.getTargets')
    for (const info of targetInfos) if (info.type === 'page') this.pages.set(info.targetId, pageOf(info))
    if (this.pages.size === 0) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
      this.pages.set(targetId, { id: targetId, title: '', url: 'about:blank' })
    }
    await this.activate([...this.pages.keys()].at(-1))
  },

  reset() {
    this.cdp = null
    this.pages.clear()
    this.activeId = null
    this.sessionId = null
  },

  disconnect() {
    this.cdp?.close()
    this.reset()
  },

  chromeExited() {
    this.disconnect()
    this.broadcast({ type: 'status', state: 'error', message: '浏览器已退出，重新打开面板会自动启动' })
  },

  async activate(targetId) {
    if (!targetId || !this.cdp) return
    const cdp = this.cdp
    if (this.sessionId) {
      const old = this.sessionId
      this.sessionId = null
      await cdp.send('Page.stopScreencast', {}, old).catch(() => undefined)
      await cdp.send('Target.detachFromTarget', { sessionId: old }).catch(() => undefined)
    }
    this.activeId = targetId
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    this.sessionId = sessionId
    await cdp.send('Target.activateTarget', { targetId }).catch(() => undefined)
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: WIDTH, maxHeight: HEIGHT }, sessionId)
    await this.refreshHistory()
    this.sendTabs()
  },

  async refreshHistory() {
    if (!this.sessionId) return
    const { currentIndex, entries } = await this.cdp.send('Page.getNavigationHistory', {}, this.sessionId)
    this.history = { canGoBack: currentIndex > 0, canGoForward: currentIndex < entries.length - 1 }
  },

  onEvent({ method, params, sessionId }) {
    switch (method) {
      case 'Page.screencastFrame':
        if (sessionId !== this.sessionId) return
        this.cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => undefined)
        this.broadcast({
          type: 'frame', data: params.data,
          width: params.metadata.deviceWidth, height: params.metadata.deviceHeight,
        })
        return
      case 'Target.targetCreated':
        if (params.targetInfo.type !== 'page') return
        this.pages.set(params.targetInfo.targetId, pageOf(params.targetInfo))
        // Follow a tab the agent (or a page) just opened.
        this.activate(params.targetInfo.targetId).catch((err) => log('follow new tab failed:', err.message))
        return
      case 'Target.targetInfoChanged':
        if (!this.pages.has(params.targetInfo.targetId)) return
        this.pages.set(params.targetInfo.targetId, pageOf(params.targetInfo))
        if (params.targetInfo.targetId === this.activeId) {
          this.refreshHistory().catch(() => undefined).then(() => this.sendTabs())
        } else {
          this.sendTabs()
        }
        return
      case 'Target.targetDestroyed':
        if (!this.pages.delete(params.targetId)) return
        if (params.targetId === this.activeId) {
          this.sessionId = null
          this.activeId = null
          const next = [...this.pages.keys()].at(-1)
          if (next) this.activate(next).catch(() => undefined)
          else this.newTab().catch(() => undefined)
        }
        this.sendTabs()
        return
      case 'Page.javascriptDialogOpening':
        if (sessionId === this.sessionId) {
          this.broadcast({ type: 'dialog', dialogType: params.type, message: params.message, defaultPrompt: params.defaultPrompt })
        }
        return
      case 'Page.javascriptDialogClosed':
        if (sessionId === this.sessionId) this.broadcast({ type: 'dialog-closed' })
        return
      default:
    }
  },

  async newTab() {
    await this.cdp.send('Target.createTarget', { url: 'about:blank' })
  },

  async handle(message) {
    await this.connect()
    const { cdp, sessionId } = this
    const page = (method, params) => cdp.send(method, params, sessionId)
    switch (message.type) {
      case 'mouse': {
        if (!sessionId) return
        const base = { x: message.x, y: message.y, modifiers: message.modifiers ?? 0 }
        if (message.event === 'wheel') {
          await page('Input.dispatchMouseEvent', { ...base, type: 'mouseWheel', deltaX: message.deltaX ?? 0, deltaY: message.deltaY ?? 0 })
        } else {
          await page('Input.dispatchMouseEvent', {
            ...base,
            type: { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' }[message.event],
            button: message.button ?? 'none',
            buttons: message.event === 'move' ? (message.buttons ?? 0) : undefined,
            clickCount: message.clickCount ?? (message.event === 'move' ? 0 : 1),
          })
        }
        return
      }
      case 'key': {
        if (!sessionId) return
        const params = {
          type: message.event === 'down' ? 'rawKeyDown' : 'keyUp',
          key: message.key, code: message.code,
          windowsVirtualKeyCode: message.keyCode, nativeVirtualKeyCode: message.keyCode,
          modifiers: message.modifiers ?? 0,
        }
        await page('Input.dispatchKeyEvent', params)
        // Enter produces a character as well as a key press.
        if (message.event === 'down' && message.key === 'Enter') {
          await page('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter', modifiers: params.modifiers })
        }
        return
      }
      case 'text':
        if (sessionId && message.text) await page('Input.insertText', { text: String(message.text) })
        return
      case 'navigate': {
        if (!sessionId) return
        const url = normalizeUrl(String(message.url ?? ''))
        if (url) await page('Page.navigate', { url })
        return
      }
      case 'back':
      case 'forward': {
        if (!sessionId) return
        const { currentIndex, entries } = await page('Page.getNavigationHistory')
        const entry = entries[currentIndex + (message.type === 'back' ? -1 : 1)]
        if (entry) await page('Page.navigateToHistoryEntry', { entryId: entry.id })
        return
      }
      case 'reload':
        if (sessionId) await page('Page.reload')
        return
      case 'activate':
        if (this.pages.has(message.id)) await this.activate(message.id)
        return
      case 'new-tab':
        await this.newTab()
        return
      case 'close-tab':
        if (this.pages.has(message.id)) await cdp.send('Target.closeTarget', { targetId: message.id })
        return
      case 'dialog':
        if (sessionId) {
          await page('Page.handleJavaScriptDialog', { accept: Boolean(message.accept), promptText: message.promptText ?? '' })
        }
        return
      default:
    }
  },
}

function pageOf(info) {
  return { id: info.targetId, title: info.title, url: info.url }
}

/** An http(s) URL from address-bar input; a bare host becomes https. */
function normalizeUrl(input) {
  const text = input.trim()
  if (!text) return null
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.href === 'about:blank' ? url.href : null
  } catch {
    // Not a URL.
    return null
  }
}

// Agent endpoint: a pass-through CDP proxy that notes activity

const watchers = new Set()
let agentTimer = null

function announceAgent(active) {
  viewer.agentActive = active
  viewer.broadcast({ type: 'agent', active })
  const text = JSON.stringify({ type: 'agent', active })
  for (const socket of watchers) if (socket.readyState === WebSocket.OPEN) socket.send(text)
}

function agentActivity() {
  if (!viewer.agentActive) announceAgent(true)
  clearTimeout(agentTimer)
  agentTimer = setTimeout(() => announceAgent(false), AGENT_IDLE_MS)
}

const agentServer = http.createServer(async (request, response) => {
  try {
    await ensureChrome()
    const upstream = await fetch(`http://127.0.0.1:${CDP_PORT}${request.url}`, { method: request.method })
    const body = (await upstream.text()).replaceAll(`127.0.0.1:${CDP_PORT}`, `127.0.0.1:${AGENT_PORT}`)
    response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    response.end(body)
  } catch (err) {
    response.writeHead(502, { 'content-type': 'text/plain' })
    response.end(`workspace browser unavailable: ${err.message}`)
  }
})
const agentSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
agentServer.on('upgrade', async (request, socket, head) => {
  try {
    await ensureChrome()
  } catch {
    // Chromium could not start; refuse the upgrade.
    socket.destroy()
    return
  }
  const upstream = new WebSocket(`ws://127.0.0.1:${CDP_PORT}${request.url}`, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
  upstream.once('error', () => socket.destroy())
  upstream.once('open', () => {
    agentSockets.handleUpgrade(request, socket, head, (client) => {
      client.on('message', (data, isBinary) => {
        agentActivity()
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
      })
      upstream.on('message', (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
      })
      client.on('close', () => upstream.close())
      upstream.on('close', () => client.close())
    })
  })
})
agentServer.listen(AGENT_PORT, '127.0.0.1', () => log(`agent endpoint http://127.0.0.1:${AGENT_PORT}`))

// Viewer endpoint (forwarded by the gateway)

const viewerServer = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end('dsh-cloud workspace browser hub\n')
})
const viewerSockets = new WebSocketServer({ server: viewerServer, perMessageDeflate: false })
viewerSockets.on('connection', (socket, request) => {
  if (new URL(request.url ?? '/', 'http://hub').searchParams.get('watch') === '1') {
    watchers.add(socket)
    socket.on('close', () => watchers.delete(socket))
    socket.send(JSON.stringify({ type: 'agent', active: viewer.agentActive }))
    return
  }
  viewer.add(socket)
})
viewerServer.listen(HUB_PORT, HUB_HOST, () => log(`viewer endpoint ws://${HUB_HOST}:${HUB_PORT}`))

// On container stop, let Chromium flush its profile (cookies, storage) before exiting.
const stop = () => {
  const child = chrome
  if (!child) process.exit(0)
  child.once('exit', () => process.exit(0))
  child.kill('SIGTERM')
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
