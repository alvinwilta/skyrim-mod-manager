import { useEffect, useRef } from 'react'

/**
 * Poll `tick` every `intervalMs` while `enabled`, mirroring the legacy watcher
 * loops (watchRefine/watchScan/...): an in-flight tick suppresses the next
 * interval instead of stacking requests, and `tick` returning false stops the
 * loop until `enabled` cycles. Runs one immediate tick on enable.
 */
export function usePoller(tick: () => Promise<boolean>, intervalMs: number, enabled: boolean): void {
  const tickRef = useRef(tick)
  tickRef.current = tick

  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let inFlight = false

    const run = async () => {
      if (inFlight || stopped) return
      inFlight = true
      try {
        if (!(await tickRef.current())) {
          stopped = true
          clearInterval(id)
        }
      } catch {
        // a failed tick shouldn't kill the loop
      } finally {
        inFlight = false
      }
    }

    const id = setInterval(run, intervalMs)
    void run()

    return () => {
      stopped = true
      clearInterval(id)
    }
  }, [intervalMs, enabled])
}
