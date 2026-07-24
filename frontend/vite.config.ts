import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Read ENVIRONMENT from the repo-root .env (same toggle the Python backend uses)
// so ONE switch drives both sides: dev -> proxy to the dev backend :7799, live
// -> :7788. MODMAN_BACKEND env still overrides for ad-hoc targets.
function repoEnvironment(): string {
  try {
    for (const line of readFileSync(resolve(__dirname, '..', '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*ENVIRONMENT\s*=\s*(.*)$/)
      if (m) return m[1].trim().replace(/^["']|["']$/g, '').toLowerCase()
    }
  } catch {
    /* no .env -> live */
  }
  return ''
}

const isDev = repoEnvironment() === 'dev'
const backend = process.env.MODMAN_BACKEND ?? (isDev ? 'http://127.0.0.1:7799' : 'http://127.0.0.1:7788')

// The backend rejects any request whose Origin header isn't in its static
// allowlist (CSRF guard in webapp.py), but explicitly passes requests with
// no Origin at all (the curl/CLI path). Strip the browser's Origin before
// the proxy copies req.headers into the outgoing request — works against
// any backend target (7788 or a 7799 throwaway) without loosening the
// backend. (http-proxy's `headers` option and a proxyReq setHeader both
// fail to override the already-copied header.)
const stripOrigin: Plugin = {
  name: 'modman-strip-origin',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url?.startsWith('/api')) delete req.headers.origin
      next()
    })
  },
}

export default defineConfig({
  plugins: [react(), stripOrigin],
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    proxy: {
      // Covers /api/events (SSE) too — http-proxy streams responses.
      '/api': {
        target: backend,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['e2e/**', 'node_modules/**'], // e2e/*.spec.ts belongs to Playwright
    // dnd-kit's CJS build would otherwise load a second React copy under
    // vitest → "Invalid hook call"; inlining makes it share the ESM React.
    server: { deps: { inline: [/@dnd-kit/] } },
  },
})
