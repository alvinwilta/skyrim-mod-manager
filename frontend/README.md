# Skyrim Mod Manager — Frontend

Vite + React 19 + TypeScript UI for the mod manager. Talks to the FastAPI
backend (`../webapp.py`) over `/api`. See the repo root `README.md` and
`CLAUDE.md` for the full system.

## Layout

```
src/
  api/          endpoints, client, shared types
  components/   TabNav, ConfirmDialog, EventsProvider
  hooks/        usePoller, useSSE, useDebounce, useStickyTop
  tabs/         Library / Order / Collections / Import / Progress / Guide
  test/         vitest setup + mock API
public/         favicon.svg, icons.svg
e2e/            Playwright specs + global setup/teardown
```

## Scripts

```bash
npm run dev      # Vite dev server on :5173, proxies /api -> :7788 (strips Origin)
npm run build    # tsc -b + vite build -> dist/ (served by backend at :7788)
npm run check    # tsc + vitest + build — run before committing
npm run test     # vitest unit/component tests only
npm run e2e      # Playwright; spawns its own backend on :7799 with a DB copy
npm run lint     # oxlint
```

## How it runs

- **Dev**: `npm run dev` (`:5173`) for hot-reload UI. It has no backend of its
  own — it proxies `/api` to the real backend on `:7788`, which must be running.
- **Prod / real use**: `npm run build`, then the backend serves `dist/` at
  `:7788`. No dist → backend returns 503 with a build hint.

VS Code launch configs (`.vscode/launch.json`) wrap both; the backend config
rebuilds `dist/` via the `build-frontend` task before launch.
