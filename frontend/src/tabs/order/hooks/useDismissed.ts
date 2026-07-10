import { useCallback, useState } from 'react'

const PREFIX = 'modman.dismissed.'

function load(section: string): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(PREFIX + section)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function save(section: string, keys: ReadonlySet<string>) {
  try {
    if (keys.size) localStorage.setItem(PREFIX + section, JSON.stringify([...keys]))
    else localStorage.removeItem(PREFIX + section)
  } catch {
    // storage unavailable — dismissals just won't survive a restart
  }
}

/**
 * Per-line dismissals for a result list, keyed by stable item identity and
 * persisted in localStorage so they survive tab switches and restarts. The
 * producing job calls clear() when it reruns, so a dismissed line stays gone
 * exactly until the next scan/refine produces fresh results.
 */
export function useDismissed(section: string) {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => load(section))
  const dismiss = useCallback(
    (k: string) =>
      setKeys((prev) => {
        const next = new Set(prev)
        next.add(k)
        save(section, next)
        return next
      }),
    [section],
  )
  const clear = useCallback(
    () =>
      setKeys((prev) => {
        if (!prev.size) return prev
        const next = new Set<string>()
        save(section, next)
        return next
      }),
    [section],
  )
  return { keys, count: keys.size, has: (k: string) => keys.has(k), dismiss, clear }
}

export type Dismissed = ReturnType<typeof useDismissed>
