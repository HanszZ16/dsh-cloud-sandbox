import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// `pnpm dev` serves the UI with hot reload and forwards gateway routes to a
// running gateway (GATEWAY_DEV_TARGET, default http://127.0.0.1:8000).
const target = process.env.GATEWAY_DEV_TARGET ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': target,
      '/u': { target, ws: true },
    },
  },
})
