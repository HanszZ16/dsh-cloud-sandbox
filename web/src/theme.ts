/** Storage key the dsh page overlay (public/dsh-cloud-overlay.js) writes dsh's theme source to. */
const THEME_KEY = 'dsh-cloud.theme'

/** dsh's theme source as last published by the overlay; `system` until dsh has been opened. */
function themeSource(): string {
  try {
    return localStorage.getItem(THEME_KEY) ?? 'system'
  } catch {
    // Storage is unavailable (blocked site data); follow the OS scheme.
    return 'system'
  }
}

/**
 * Applies the theme chosen in dsh the way dsh Web marks its dark theme on <body>:
 * light or dark as chosen there, otherwise the OS color scheme. Follows later
 * changes from dsh (another tab, or the dsh page hosting this one in an iframe)
 * and from the OS.
 */
export function syncColorScheme(): void {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const apply = () => {
    const source = themeSource()
    const dark = source === 'dark' || (source !== 'light' && query.matches)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    if (dark) document.body.setAttribute('data-ds-dark-theme', '')
    else document.body.removeAttribute('data-ds-dark-theme')
  }
  apply()
  query.addEventListener('change', apply)
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_KEY) apply()
  })
  if (navigator.userAgent.includes('Mac')) document.documentElement.dataset.platform = 'darwin'
}
