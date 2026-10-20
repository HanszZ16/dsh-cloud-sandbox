/** Follows the OS color scheme the way dsh Web marks its dark theme on <body>. */
export function syncColorScheme(): void {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const apply = () => {
    if (query.matches) document.body.setAttribute('data-ds-dark-theme', '')
    else document.body.removeAttribute('data-ds-dark-theme')
  }
  apply()
  query.addEventListener('change', apply)
  if (navigator.userAgent.includes('Mac')) document.documentElement.dataset.platform = 'darwin'
}
