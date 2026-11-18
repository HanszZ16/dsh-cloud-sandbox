import { setTimeout as delay } from 'node:timers/promises'

export const name = 'website-login'
export const inject = ['tools', 'systemPrompt']

const namespace = '/_dsh-cloud/website-login'
const output = { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const COOLDOWN_MS = 10 * 60 * 1000
const COOLDOWN_STATUSES = new Set(['cancelled', 'failed'])

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
      description: 'Ask the workspace owner to sign in using the secure card. Supports traditional single-page same-origin password POST forms only (no OAuth, QR code, multi-step login, CAPTCHA, or 2FA). Supply a configured site_id from website_login_sites, or an exact public HTTPS login_url when explicitly asked to sign in. Never request passwords, codes or cookies in chat, and never retry after failed/cancelled/unavailable; instead ask the user to sign in manually in the Remote browser.',
      parameters: {
        type: 'object', properties: {
          login_url: { type: 'string', description: 'Exact public HTTPS login page, when there is no configured ID.' },
          site_id: { type: 'string', description: 'An optional configured site ID, instead of login_url.' },
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
    name: 'tool:website-login', order: 2360, interpolate: false,
    text: () => 'When a website needs a password, first check website_login_sites for a configured site_id, or call request_website_login with the exact public HTTPS login URL. Do not enter or ask for passwords through chat, browser tools, ask_user_question, or tool arguments. Never claim sign-in succeeded unless the tool reports signed-in. If it returns reason "needs-takeover", credentials were entered in the workspace browser and Remote browser was opened for the user to complete CAPTCHA/QR/2FA—ask the user for an OTP or to finish verification there. If declined, failed, or unavailable, do not retry for that site.',
  })
}
