/*
 * dsh-cloud control button, injected by the gateway into every dsh Web page.
 *
 * A small button in the bottom-right corner opens a menu with "back to portal"
 * and "save and exit". Exit saves and releases the sandbox through the gateway
 * API with a progress bar, then signs out. It lives in a shadow root so dsh's
 * styles and its own do not interact; colors come from dsh's design tokens,
 * which inherit into the shadow tree.
 */
(() => {
  if (window.top !== window || document.getElementById('dsh-cloud-overlay')) return

  const STEPS = {
    starting: [
      ['queued', '排队中', 0, 5, 0.5],
      ['prepare', '读取你的数据', 5, 15, 0.5],
      ['create', '创建云电脑', 15, 30, 1],
      ['restore', '恢复文件和会话', 30, 45, 1],
      ['boot', '启动 DeepSeek Harness', 45, 98, 5],
    ],
    releasing: [
      ['queued', '排队中', 0, 5, 0.5],
      ['stop', '停止 DeepSeek Harness 并写盘', 5, 35, 1.5],
      ['archive', '打包文件和会话', 35, 65, 1],
      ['save', '保存数据', 65, 85, 0.5],
      ['destroy', '释放云电脑', 85, 98, 0.5],
    ],
  }

  const host = document.createElement('div')
  host.id = 'dsh-cloud-overlay'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
<style>
  :host { all: initial; }
  [hidden] { display: none !important; }
  * { box-sizing: border-box; font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif); }
  .fab {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
    display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px;
    border: none; border-radius: 17px; cursor: pointer; font-size: 13px; color: #fff;
    background: var(--dsw-static-deepseek-500, #4d6bfe);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  }
  .fab:hover { background: var(--dsw-static-deepseek-450, #5686fe); }
  .menu {
    position: fixed; right: 16px; bottom: 58px; z-index: 2147483000; width: 220px; padding: 6px;
    border-radius: var(--dsw-radius-md, 12px);
    background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #0f1115);
    box-shadow: var(--dsw-elevation-prominent, 0 8px 28px rgba(0, 0, 0, 0.16));
    border: 0.5px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  }
  .menu[hidden], .layer[hidden] { display: none; }
  .who { padding: 8px 10px 6px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8b8d91); }
  .item {
    display: block; width: 100%; padding: 9px 10px; border: none; border-radius: 8px; text-align: left;
    background: transparent; color: inherit; font-size: 14px; cursor: pointer; text-decoration: none;
  }
  .item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05)); }
  .item small { display: block; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8b8d91); }
  .item.exit { color: var(--dsw-alias-state-error-primary, #e5484d); }
  .layer { position: fixed; inset: 0; z-index: 2147483001; display: flex; align-items: center; justify-content: center; padding: 16px; }
  .mask { position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.32)); }
  .dialog {
    position: relative; width: 100%; max-width: 440px; padding: 22px 24px 20px;
    border-radius: var(--dsw-radius-panel, 28px);
    background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #0f1115);
    box-shadow: var(--dsw-elevation-prominent, 0 12px 40px rgba(0, 0, 0, 0.2));
  }
  h2 { margin: 0 0 10px; font-size: 16px; font-weight: 500; }
  p { margin: 0 0 6px; font-size: 14px; line-height: 22px; }
  .muted { color: var(--dsw-alias-label-tertiary, #8b8d91); font-size: 13px; }
  .error { color: var(--dsw-alias-state-error-primary, #e5484d); font-size: 13px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  .btn { height: 36px; padding: 0 14px; border: none; border-radius: 12px; font-size: 14px; cursor: pointer; background: transparent; color: inherit; }
  .btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05)); }
  .btn.primary { color: #fff; background: var(--dsw-static-deepseek-500, #4d6bfe); }
  .btn.primary:hover { background: var(--dsw-static-deepseek-450, #5686fe); }
  .progress { margin-top: 6px; }
  .progress-head { display: flex; justify-content: space-between; font-size: 13px; color: var(--dsw-alias-label-secondary, #555); margin-bottom: 8px; }
  .track { height: 8px; border-radius: 4px; overflow: hidden; background: var(--dsw-alias-bg-skeleton, rgba(0, 0, 0, 0.08)); }
  .fill { height: 100%; width: 0; border-radius: 4px; transition: width 0.3s ease;
    background: linear-gradient(90deg, var(--dsw-static-deepseek-500, #4d6bfe), var(--dsw-static-deepseek-400, #7aaaff)); }
</style>
<button class="fab" part="fab" title="云电脑">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/></svg>
  云电脑
</button>
<div class="menu" hidden>
  <div class="who"></div>
  <a class="item" href="/">返回门户<small>云电脑继续运行</small></a>
  <button class="item exit">保存并退出<small>保存数据，释放云电脑，退出登录</small></button>
</div>
<div class="layer" hidden>
  <div class="mask"></div>
  <div class="dialog">
    <h2>保存并退出</h2>
    <div class="body">
      <p>会先保存你的文件、会话、记忆和插件设置，再释放云电脑，然后退出登录。</p>
      <p class="muted">正在运行的任务会被中断。下次登录启动云电脑后，一切会恢复原样。</p>
      <p class="error" hidden></p>
    </div>
    <div class="progress" hidden>
      <div class="progress-head"><span class="label"></span><span class="pct"></span></div>
      <div class="track"><div class="fill"></div></div>
    </div>
    <div class="actions">
      <button class="btn cancel">取消</button>
      <button class="btn primary confirm">保存并退出</button>
    </div>
  </div>
</div>`

  const $ = (selector) => root.querySelector(selector)
  const fab = $('.fab')
  const menu = $('.menu')
  const layer = $('.layer')
  const errorLine = $('.error')

  fab.addEventListener('click', (event) => {
    event.stopPropagation()
    menu.hidden = !menu.hidden
  })
  document.addEventListener('click', () => {
    menu.hidden = true
  })
  menu.addEventListener('click', (event) => event.stopPropagation())
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') menu.hidden = true
  })

  fetch('/api/me', { credentials: 'same-origin' })
    .then((response) => (response.ok ? response.json() : null))
    .then((me) => {
      if (me) $('.who').textContent = `${me.display_name || me.username} · ${me.username}`
    })
    .catch(() => undefined)

  $('.item.exit').addEventListener('click', () => {
    menu.hidden = true
    errorLine.hidden = true
    layer.hidden = false
  })
  $('.cancel').addEventListener('click', () => {
    layer.hidden = true
  })
  $('.mask').addEventListener('click', () => {
    if (!busy) layer.hidden = true
  })

  let busy = false
  let shown = { info: null, at: 0 }

  function render() {
    const info = shown.info
    const steps = info && STEPS[info.status]
    if (!steps) return
    const step = steps.find((s) => s[0] === info.phase) || steps[0]
    const [, label, from, to, expected] = step
    const elapsed = (info.phase_elapsed_s || 0) + (performance.now() - shown.at) / 1000
    const percent = from + (to - from) * (1 - Math.exp(-elapsed / expected))
    $('.label').textContent = label
    $('.pct').textContent = `${Math.round(percent)}%`
    $('.fill').style.width = `${percent}%`
  }

  async function api(method, path) {
    const response = await fetch(path, { method, credentials: 'same-origin' })
    if (!response.ok) {
      let message = `请求失败（${response.status}）`
      try {
        const data = await response.json()
        if (typeof data.detail === 'string') message = data.detail
      } catch {
        // Not JSON: keep the status message.
      }
      throw new Error(message)
    }
    return response.json()
  }

  $('.confirm').addEventListener('click', async () => {
    busy = true
    $('.body').hidden = true
    $('.actions').hidden = true
    $('.progress').hidden = false
    const ticker = window.setInterval(render, 120)
    try {
      let info = await api('POST', '/api/me/sandbox/release')
      shown = { info, at: performance.now() }
      while (info.status === 'releasing' || info.status === 'starting') {
        await new Promise((resolve) => window.setTimeout(resolve, 600))
        info = await api('GET', '/api/me/sandbox')
        shown = { info, at: performance.now() }
      }
      $('.label').textContent = '已保存，正在退出'
      $('.pct').textContent = '100%'
      $('.fill').style.width = '100%'
      await api('POST', '/api/auth/logout')
      window.location.href = '/login'
    } catch (error) {
      window.clearInterval(ticker)
      busy = false
      errorLine.textContent = `退出失败：${error.message}`
      errorLine.hidden = false
      $('.body').hidden = false
      $('.actions').hidden = false
      $('.progress').hidden = true
    }
  })

  const mount = () => document.body.appendChild(host)
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount)
})()
