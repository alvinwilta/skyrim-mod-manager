import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const tmp = path.join(here, '.tmp')

export default async function globalTeardown() {
  try {
    const pid = Number(fs.readFileSync(path.join(tmp, 'server.pid'), 'utf8'))
    if (pid) process.kill(pid)
  } catch {
    /* already gone */
  }

  // The whole point of the throwaway server: the real db must be untouched.
  const before = Number(fs.readFileSync(path.join(tmp, 'live_mtime'), 'utf8'))
  const after = fs.statSync(path.join(repo, 'mods.db')).mtimeMs
  if (after !== before) {
    throw new Error(
      `E2E ISOLATION FAILURE: real mods.db mtime changed during the run (${before} → ${after}). ` +
        'Do not re-run until the cause is understood.',
    )
  }

  fs.rmSync(path.join(tmp, 'mods_e2e.db'), { force: true })
}
