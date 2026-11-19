import { setTimeout as delay } from 'node:timers/promises'

export const name = 'website-login'
export const inject = ['tools', 'systemPrompt']

const namespace = '/_dsh-cloud/website-login'
const output = { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const COOLDOWN_MS = 30 * 1000
const COOLDOWN_STATUSES = new Set(['cancelled'])

function targetKey(siteId, loginUrl) {
  if (siteId) return `site:${siteId}`
  try {
    return `origin:${new URL(loginUrl).origin}`
  } catch {
    return null
  }
}

export function apply(ctx) {
  const root = process.env.DSH_CLOUD_WEBSITE_LOGIN_CALLBACK
  const token = process.env.DEEPSEEK_API_KEY
  if (!root || !token?.startsWith('dshgw-')) return
  const blockedTargets = new Map()

  async function gateway(path, method, signal, body) {
    const timeout = AbortSignal.timeout(8000)
    const response = await fetch(root + namespace + path, {
      method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (response.ok) return response.json()
    return response.status === 400 ? { status: 'failed', reason: 'invalid-public-https-login-url' }
      : { status: response.status === 429 ? 'busy' : 'unavailable' }
  }

  ctx.effect(() => {
    const list = ctx.tools.register({
      name: 'website_login_sites',
      description: 'List optional site aliases. When supports_login_url is true, use the exact public HTTPS login URL for a site without an alias. Never ask for passwords in chat.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output,
      async execute(_args, exec) {
        try { return await gateway('/sites', 'GET', exec.signal) }
        catch { return { status: 'unavailable' } }
      },
    })
    const request = ctx.tools.register({
      name: 'request_website_login',
      description: 'PRIMARY LOGIN TOOL: Pop up the Secure Sign-in Card (backed by the user Password Vault) to fill credentials directly into the sandbox browser. Supports single-page forms, multi-step forms (Gmail), and nested iframes/tab-switching (QQ Mail). Always call this tool FIRST whenever any website needs login—do NOT ask the user to type passwords in Remote browser themselves. Pass the HTTPS login_url (or a configured site_id).',
      parameters: {
        type: 'object', properties: {
          login_url: { type: 'string', description: 'Exact public HTTPS login page URL (e.g. https://wx.mail.qq.com/ or https://accounts.google.com/).' },
          site_id: { type: 'string', description: 'An optional configured site ID from website_login_sites, instead of login_url.' },
        }, additionalProperties: false,
      },
      output,
      async execute({ site_id, login_url }, exec) {
        const byId = /^[a-z0-9][a-z0-9-]{0,63}$/.test(site_id ?? '') && login_url === undefined
        const byUrl = site_id === undefined && typeof login_url === 'string' && login_url.length <= 2048 && login_url.startsWith('https://')
        const key = byId ? targetKey(site_id, null) : byUrl ? targetKey(null, login_url) : null
        if ((!byId && !byUrl) || !key || !/^[\w-]{1,128}$/.test(exec.callId ?? '')) {
          return { status: 'unavailable' }
        }
        const blocked = blockedTargets.get(key)
        if (blocked && blocked.until > Date.now()) {
          return { status: 'unavailable', reason: blocked.reason }
        }
        const path = `/requests/${encodeURIComponent(exec.callId)}`
        let pending = true
        try {
          let result = await gateway(byId ? `${path}/${encodeURIComponent(site_id)}` : path, 'POST', exec.signal, byUrl ? { login_url } : undefined)
          const deadline = Date.now() + 305000
          while (['pending', 'working'].includes(result.status) && Date.now() < deadline) {
            await delay(1500, undefined, { signal: exec.signal })
            result = await gateway(path, 'GET', exec.signal)
          }
          pending = ['pending', 'working', 'unavailable'].includes(result.status)
          const finalStatus = ['pending', 'working'].includes(result.status) ? 'expired' : result.status
          if (COOLDOWN_STATUSES.has(finalStatus)) {
            blockedTargets.set(key, { until: Date.now() + COOLDOWN_MS, reason: typeof result.reason === 'string' ? result.reason : finalStatus })
          }
          return { status: finalStatus,
            ...(typeof result.reason === 'string' ? { reason: result.reason } : {}) }
        } catch {
          return { status: exec.signal?.aborted ? 'cancelled' : 'unavailable' }
        } finally {
          if (pending) await gateway(path, 'DELETE').catch(() => undefined)
        }
      },
    })
    return () => { request(); list() }
  }, 'website-login: tools')

  ctx.systemPrompt.section({
    name: 'tool:website-login', order: 100, interpolate: false,
    text: () => [
      'MANDATORY WEBSITE LOGIN & VAULT WORKFLOW:',
      '1. Always operate the sandbox browser (mcp__browser__*) autonomously in the background first. Do NOT tell the user to open Remote browser and log in manually.',
      '2. Whenever a website needs sign-in (including QQ Mail, Gmail, nested iframes, or multi-step forms), you MUST immediately call `request_website_login` with the HTTPS `login_url` (or `site_id`). This opens the Secure Sign-in Card and uses the user Password Vault so saved credentials are automatically injected into your sandbox browser.',
      '3. Never claim that iframes or multi-step forms are unsupported by `request_website_login`—the sandbox browser hub handles iframe penetration and tab switching automatically.',
      '4. If `request_website_login` returns `reason: "needs-takeover"`, the username and password have ALREADY been filled into the sandbox browser, and a secondary challenge (slider CAPTCHA, SMS OTP, or QR confirmation) appeared: first ask the user in chat if they have an SMS/OTP code you can enter, or tell them to complete just the verification step in the automatically opened Remote browser.',
      '5. Never ask for or accept plaintext passwords in chat. Only stop retrying within the same turn if the user explicitly declined (`cancelled`).',
    ].join('\n'),
  })
}
