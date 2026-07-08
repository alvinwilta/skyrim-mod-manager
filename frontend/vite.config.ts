import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Dev backend. Point at a throwaway server (safe-live-test pattern) with:
//   MODMAN_BACKEND=http://127.0.0.1:7799 npm run dev
const backend = process.env.MODMAN_BACKEND ?? 'http://127.0.0.1:7788'

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
