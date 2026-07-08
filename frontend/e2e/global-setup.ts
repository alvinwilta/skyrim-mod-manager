import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const tmp = path.join(here, '.tmp')

export default async function globalSetup() {
  execSync('npm run build', { cwd: path.join(repo, 'frontend'), stdio: 'inherit' })

  fs.mkdirSync(tmp, { recursive: true })
  const live = path.join(repo, 'mods.db')
  const copy = path.join(tmp, 'mods_e2e.db')
  fs.copyFileSync(live, copy)
  fs.writeFileSync(path.join(tmp, 'live_mtime'), String(fs.statSync(live).mtimeMs))

  const out = fs.openSync(path.join(tmp, 'server.log'), 'w')
  const proc = spawn(
    path.join(repo, '.venv/bin/python3'),
    ['-m', 'uvicorn', 'webapp:app', '--host', '127.0.0.1', '--port', '7799'],
    {
      cwd: repo,
      env: {
        ...process.env,
        MODMAN_DB_PATH: copy, // read at import time — subprocess isolation, never monkeypatch
        MODMAN_EXTRA_ORIGINS: 'http://127.0.0.1:7799',
      },
      stdio: ['ignore', out, out],
      detached: true,
    },
  )
  fs.writeFileSync(path.join(tmp, 'server.pid'), String(proc.pid))
  proc.unref()

  for (let i = 0; i < 75; i++) {
    try {
      const r = await fetch('http://127.0.0.1:7799/api/state')
      if (r.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 200))
  }
  throw new Error('e2e backend failed to start — see frontend/e2e/.tmp/server.log')
}
