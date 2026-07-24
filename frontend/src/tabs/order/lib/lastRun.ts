/**
 * Persisted "last run" timestamps for the Order tab's jobs, so a section shows
 * when it was last run instead of "not run yet this session" (which is lost on
 * every reload). Stored in localStorage — this is a single-user local tool.
 */
const PREFIX = 'modman.lastRun.'

export type LastRunKey = 'sort' | 'refineBulk' | 'refineDesc' | 'enforce' | 'requirements'
const KEYS: LastRunKey[] = ['sort', 'refineBulk', 'refineDesc', 'enforce', 'requirements']

export type LastRuns = Partial<Record<LastRunKey, string>>

export function loadLastRuns(): LastRuns {
  const out: LastRuns = {}
  for (const k of KEYS) {
    try {
      const v = localStorage.getItem(PREFIX + k)
      if (v) out[k] = v
    } catch {
      /* storage unavailable */
    }
  }
  return out
}

export function saveLastRun(k: LastRunKey, iso: string) {
  try {
    localStorage.setItem(PREFIX + k, iso)
  } catch {
    /* storage unavailable — just won't persist */
  }
}

/** "Last run: 24/07/2026 14:03 (2h ago)" or "Never run". */
export function formatLastRun(iso?: string): string {
  if (!iso) return 'Never run'
  const d = new Date(iso)
  const t = d.getTime()
  if (!Number.isFinite(t)) return 'Never run'
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  const rel =
    s < 60
      ? 'just now'
      : s < 3600
        ? `${Math.floor(s / 60)}m ago`
        : s < 86400
          ? `${Math.floor(s / 3600)}h ago`
          : `${Math.floor(s / 86400)}d ago`
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
  return `Last run: ${stamp} (${rel})`
}
