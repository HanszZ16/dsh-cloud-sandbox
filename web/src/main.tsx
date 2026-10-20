import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import './theme/base.css'
import './theme/brand-font.css'
import './theme/design-platform.css'
import './theme/elevation.css'
import './styles.css'
import { App } from './App.tsx'
import { syncColorScheme } from './theme.ts'

syncColorScheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
