/*
 * Workspace account entries, injected by the gateway into every dsh Web page.
 *
 * dsh's own sidebar "More" menu gains, at its top, the signed-in user, account
 * settings (a panel showing /account in an iframe, without leaving the
 * workspace) and the admin console for administrators, and at its bottom, sign
 * out (the workspace is saved first, with progress). The entries are clones of
 * dsh's own menu items, so they match its look. dsh's DeepSeek account item is
 * relabelled "DeepSeek Sign in" so it is not mistaken for the workspace account. It also watches the workspace: when it goes to sleep or restarts
 * while the page is open, a cover explains that and offers to resume, instead of
 * leaving dsh's connection errors on screen.
 *
 * Everything renders in a shadow root so dsh's styles and these do not interact;
 * colors come from dsh's design tokens, which inherit into the shadow tree.
 */
(() => {
  if (window.top !== window || document.getElementById('dsh-cloud-overlay')) return

  const SAVE_STEPS = [
    ['queued', '准备保存', 0, 5, 0.5],
    ['stop', '保存对话和设置', 5, 35, 1.5],
    ['archive', '保存文件', 35, 65, 1],
    ['save', '同步工作空间', 65, 85, 0.5],
    ['destroy', '即将完成', 85, 98, 0.5],
  ]
  const WATCH_INTERVAL_MS = 10000

  const host = document.createElement('div')
  host.id = 'dsh-cloud-overlay'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
<style>
  :host { all: initial; }
  [hidden] { display: none !important; }
  * { box-sizing: border-box; font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif); }
  .surface {
    background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #0f1115);
    box-shadow: var(--dsw-elevation-prominent, 0 8px 28px rgba(0, 0, 0, 0.16));
  }
  .layer { position: fixed; inset: 0; z-index: 2147483001; display: flex; align-items: center; justify-content: center; padding: 16px; }
  .mask { position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.32)); }
  .dialog { position: relative; width: 100%; max-width: 420px; padding: 22px 24px 20px; border-radius: var(--dsw-radius-panel, 28px); }
  .panel {
    position: relative; display: flex; flex-direction: column; width: 100%; max-width: 600px;
    height: min(760px, calc(100vh - 32px)); overflow: hidden; border-radius: var(--dsw-radius-panel, 28px);
  }
  .panel-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 0 24px; }
  .panel iframe { flex: 1; width: 100%; border: none; background: transparent; }
  .close { width: 32px; height: 32px; border: none; border-radius: 50%; background: transparent; color: inherit; cursor: pointer; font-size: 18px; }
  .close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05)); }
  h2 { margin: 0; font-size: 16px; font-weight: 500; }
  p { margin: 10px 0 0; font-size: 14px; line-height: 22px; }
  .muted { color: var(--dsw-alias-label-tertiary, #8b8d91); font-size: 13px; }
  .error { color: var(--dsw-alias-state-error-primary, #e5484d); font-size: 13px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  .btn { height: 36px; padding: 0 14px; border: none; border-radius: 12px; font-size: 14px; cursor: pointer; background: transparent; color: inherit; }
  .btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05)); }
  .btn.primary { color: #fff; background: var(--dsw-static-deepseek-500, #4d6bfe); }
  .btn.primary:hover { background: var(--dsw-static-deepseek-450, #5686fe); }
  .progress { margin-top: 16px; }
  .progress-label { font-size: 13px; color: var(--dsw-alias-label-secondary, #555); margin-bottom: 10px; }
  .track { height: 3px; border-radius: 2px; overflow: hidden; background: var(--dsw-alias-bg-skeleton, rgba(0, 0, 0, 0.08)); }
  .fill { height: 100%; width: 0; border-radius: 2px; transition: width 0.3s ease; background: var(--dsw-static-deepseek-500, #4d6bfe); }
  .cover {
    position: fixed; inset: 0; z-index: 2147483002; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; padding: 24px; text-align: center; background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #0f1115);
  }
  .cover .logo { color: var(--dsw-static-deepseek-500, #4d6bfe); margin-bottom: 12px; }
  .cover .logo.breathe { animation: breathe 2.4s ease-in-out infinite; }
  @keyframes breathe { 50% { opacity: 0.55; transform: scale(0.96); } }
  .cover .title { font-size: 17px; font-weight: 500; }
  .cover .btn { margin-top: 14px; }
</style>
<div class="layer account-layer" hidden>
  <div class="mask"></div>
  <div class="panel surface">
    <div class="panel-head"><h2>账号设置</h2><button class="close" title="关闭">✕</button></div>
    <iframe title="账号设置"></iframe>
  </div>
</div>
<div class="layer exit-layer" hidden>
  <div class="mask"></div>
  <div class="dialog surface">
    <h2>退出登录</h2>
    <div class="exit-body">
      <p>退出前会保存你的工作空间，下次登录时一切会回到现在的样子。</p>
      <p class="muted">正在进行的任务会被中断。</p>
      <p class="error" hidden></p>
      <div class="actions"><button class="btn cancel">取消</button><button class="btn primary confirm">退出登录</button></div>
    </div>
    <div class="progress" hidden>
      <div class="progress-label"></div>
      <div class="track"><div class="fill"></div></div>
    </div>
  </div>
</div>
<div class="cover" hidden>
  <svg class="logo" width="48" height="36" viewBox="0 0 23.16 17.04" aria-hidden="true"><path fill="currentColor" d="M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736Z"/></svg>
  <div class="title cover-title"></div>
  <div class="muted cover-sub"></div>
  <button class="btn primary cover-action" hidden></button>
</div>`

  const $ = (selector) => root.querySelector(selector)
  const accountLayer = $('.account-layer')
  const exitLayer = $('.exit-layer')
  const cover = $('.cover')
  const errorLine = $('.error')
  let exiting = false

  // Entries in dsh's sidebar "More" menu
  let me = null
  fetch('/api/me', { credentials: 'same-origin' })
    .then((response) => (response.ok ? response.json() : null))
    .then((value) => {
      me = value
    })
    .catch(() => undefined)
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    accountLayer.hidden = true
    if (!exiting) exitLayer.hidden = true
  })

  // dsh's DeepSeek account item, by its label in either locale.
  const DEEPSEEK_LABELS = {
    'Sign in': 'DeepSeek Sign in',
    'Sign out': 'DeepSeek Sign out',
    'Log in': 'DeepSeek Sign in',
    'Log out': 'DeepSeek Sign out',
    登录: '登录 DeepSeek 账号',
    退出登录: '退出 DeepSeek 账号',
    退出: '退出 DeepSeek 账号',
  }
  const ICONS = {
    account:
      '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M4 20a8 8 0 0 1 16 0"/>',
    admin: '<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
    signOut: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4"/><path d="M6 12h10"/>',
  }

  /** The trigger of the sidebar More menu: dsh marks it with its account state. */
  const moreTrigger = () => document.querySelector('button[aria-haspopup="menu"][data-signed-out][aria-expanded="true"]')

  function labelOf(item) {
    const spans = item.querySelectorAll('span')
    return spans.length > 1 ? spans[1] : item
  }

  function entry(template, icon, label, onSelect) {
    const wrapper = template.cloneNode(true)
    wrapper.dataset.dshCloud = 'entry'
    const item = wrapper.querySelector('[role="menuitem"]') || wrapper
    const iconBox = item.querySelector('span')
    const size = iconBox?.querySelector('svg')?.getAttribute('width') || '16'
    if (iconBox) {
      iconBox.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>`
    }
    labelOf(item).textContent = label
    item.querySelectorAll('span').forEach((span, index) => {
      if (index > 1) span.textContent = ''
    })
    item.removeAttribute('aria-disabled')
    item.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      moreTrigger()?.click()
      onSelect()
    })
    return wrapper
  }

  function separator() {
    const line = document.createElement('div')
    line.dataset.dshCloud = 'entry'
    line.setAttribute('role', 'separator')
    line.style.cssText = 'height:0.5px;margin:4px 8px;background:var(--dsw-alias-border-l3, rgba(0,0,0,0.12))'
    return line
  }

  function header() {
    const row = document.createElement('div')
    row.dataset.dshCloud = 'entry'
    row.style.cssText =
      'display:flex;align-items:center;gap:10px;padding:8px 10px 6px;min-width:200px;color:var(--dsw-alias-label-primary)'
    const name = me ? me.display_name || me.username : ''
    const avatar = document.createElement('span')
    avatar.textContent = name.slice(0, 1).toUpperCase()
    avatar.style.cssText =
      'display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;border-radius:50%;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-skeleton)'
    const text = document.createElement('div')
    text.style.cssText = 'display:flex;flex-direction:column;min-width:0;line-height:18px'
    const strong = document.createElement('span')
    strong.textContent = name
    strong.style.cssText = 'font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    const small = document.createElement('span')
    small.textContent = me ? me.username : ''
    small.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-tertiary)'
    text.append(strong, small)
    row.append(avatar, text)
    return row
  }

  function extendMoreMenu(menu) {
    if (!moreTrigger() || menu.querySelector('[data-dsh-cloud]')) return
    const items = [...menu.querySelectorAll('[role="menuitem"]')]
    if (!items.length) return
    for (const item of items) {
      const label = labelOf(item)
      const renamed = DEEPSEEK_LABELS[label.textContent.trim()]
      if (renamed) label.textContent = renamed
    }
    const template = items[0].parentElement !== menu && items[0].parentElement.children.length === 1 ? items[0].parentElement : items[0]
    const list = template.parentElement
    const first = list.firstChild
    const top = [header(), entry(template, ICONS.account, '账号设置', openAccount)]
    if (me && me.role === 'admin') {
      top.push(
        entry(template, ICONS.admin, '管理后台', () => {
          window.location.href = '/admin'
        }),
      )
    }
    top.push(separator())
    for (const node of top) list.insertBefore(node, first)
    list.append(separator(), entry(template, ICONS.signOut, '退出登录', openSignOut))
  }

  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue
        const menu = node.matches('[role="menu"]') ? node : node.querySelector('[role="menu"]')
        if (menu) extendMoreMenu(menu)
      }
    }
  }).observe(document.body || document.documentElement, { childList: true, subtree: true })

  // Account settings, without leaving the workspace
  function openAccount() {
    $('iframe').src = '/account'
    accountLayer.hidden = false
  }
  const closeAccount = () => {
    accountLayer.hidden = true
    $('iframe').src = 'about:blank'
  }
  $('.close').addEventListener('click', closeAccount)
  accountLayer.querySelector('.mask').addEventListener('click', closeAccount)

  // Sign out: save the workspace with progress, then end the session
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
      const error = new Error(message)
      error.status = response.status
      throw error
    }
    return response.json()
  }

  function openSignOut() {
    errorLine.hidden = true
    exitLayer.hidden = false
  }
  $('.cancel').addEventListener('click', () => {
    exitLayer.hidden = true
  })
  exitLayer.querySelector('.mask').addEventListener('click', () => {
    if (!exiting) exitLayer.hidden = true
  })

  let shown = { info: null, at: 0 }
  function renderProgress() {
    const info = shown.info
    if (!info || info.status !== 'releasing') return
    const step = SAVE_STEPS.find((s) => s[0] === info.phase) || SAVE_STEPS[0]
    const [, label, from, to, expected] = step
    const elapsed = (info.phase_elapsed_s || 0) + (performance.now() - shown.at) / 1000
    $('.progress-label').textContent = label
    $('.fill').style.width = `${from + (to - from) * (1 - Math.exp(-elapsed / expected))}%`
  }

  $('.confirm').addEventListener('click', async () => {
    exiting = true
    $('.exit-body').hidden = true
    $('.progress').hidden = false
    $('.progress-label').textContent = '正在保存你的工作空间'
    const ticker = window.setInterval(renderProgress, 120)
    try {
      let info = await api('POST', '/api/me/sandbox/release')
      shown = { info, at: performance.now() }
      while (info.status === 'releasing' || info.status === 'starting') {
        await new Promise((resolve) => window.setTimeout(resolve, 600))
        info = await api('GET', '/api/me/sandbox')
        shown = { info, at: performance.now() }
      }
      window.clearInterval(ticker)
      $('.progress-label').textContent = '已保存'
      $('.fill').style.width = '100%'
      await api('POST', '/api/auth/logout')
      window.location.href = '/login'
    } catch (error) {
      window.clearInterval(ticker)
      exiting = false
      errorLine.textContent = `退出失败：${error.message}`
      errorLine.hidden = false
      $('.exit-body').hidden = false
      $('.progress').hidden = true
    }
  })

  // Watch the workspace while the page is open
  function showCover(title, sub, action, onAction, breathe) {
    $('.cover-title').textContent = title
    $('.cover-sub').textContent = sub
    $('.cover .logo').classList.toggle('breathe', Boolean(breathe))
    const button = $('.cover-action')
    button.hidden = !action
    button.textContent = action || ''
    button.onclick = onAction || null
    accountLayer.hidden = true
    cover.hidden = false
  }

  let wasUpdating = false
  async function watch() {
    if (exiting || document.visibilityState !== 'visible') return
    let info
    try {
      info = await api('GET', '/api/me/sandbox')
    } catch (error) {
      if (error.status === 401) {
        showCover('登录已失效', '请重新登录以继续使用你的工作空间。', '重新登录', () => {
          window.location.href = '/login'
        })
      }
      return
    }
    if (exiting) return
    if (info.status === 'running') {
      // Back from a restart: reload so dsh reconnects to the new instance.
      if (wasUpdating) window.location.href = '/'
      return
    }
    if (info.status === 'starting' || info.status === 'releasing') {
      wasUpdating = true
      showCover('正在更新你的工作空间', '马上就好，完成后会自动回到这里。', '', null, true)
      return
    }
    showCover('工作空间已休眠', '你的文件、对话和设置都已保存。', '恢复工作空间', () => {
      window.location.href = '/'
    })
  }
  window.setInterval(() => {
    watch()
  }, WATCH_INTERVAL_MS)
  document.addEventListener('visibilitychange', () => {
    watch()
  })
  // While updating, check more often so the page comes back promptly.
  window.setInterval(() => {
    if (wasUpdating) watch()
  }, 1500)

  const mount = () => document.body.appendChild(host)
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount)
})()
