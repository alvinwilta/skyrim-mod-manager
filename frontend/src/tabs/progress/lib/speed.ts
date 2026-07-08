import type { DlFile } from '../../../api/types'

/**
 * Exponentially-smoothed transfer speed, ported from the legacy render():
 * only re-sample when >0.2s elapsed; first sample seeds unsmoothed.
 * Returns the new {speed, prev} sampling state.
 */
export interface SpeedSample {
  t: number
  b: number
}

export function updateSpeed(
  speed: number,
  prev: SpeedSample | null,
  nowMs: number,
  gotBytes: number,
): { speed: number; prev: SpeedSample } {
  if (!prev) return { speed, prev: { t: nowMs, b: gotBytes } }
  const dt = (nowMs - prev.t) / 1000
  if (dt <= 0.2) return { speed, prev }
  const inst = Math.max(0, (gotBytes - prev.b) / dt)
  return {
    speed: speed ? speed * 0.7 + inst * 0.3 : inst,
    prev: { t: nowMs, b: gotBytes },
  }
}

/** "HH:MM:SS" ETA, or "—" when speed/remaining don't support an estimate. */
export function formatEta(speed: number, remainingBytes: number): string {
  if (speed <= 1 || remainingBytes <= 0) return '—'
  return new Date((1000 * remainingBytes) / speed).toISOString().substring(11, 19)
}

export interface DlStats {
  done: number
  fail: number
  gotBytes: number
  totalBytes: number
  total: number
  finished: number
  linksDone: number
}

/** Aggregate per-file counters, ported from the legacy render() loop. */
export function computeStats(files: DlFile[]): DlStats {
  let done = 0
  let fail = 0
  let gotBytes = 0
  let totalBytes = 0
  for (const f of files) {
    totalBytes += f.size
    if (f.status === 'done') {
      done++
      gotBytes += f.size
    } else if (f.status === 'failed') {
      fail++
    } else {
      gotBytes += Math.min(f.got, f.size || f.got)
    }
  }
  return {
    done,
    fail,
    gotBytes,
    totalBytes,
    total: files.length,
    finished: done + fail,
    linksDone: files.filter((f) => f.status !== 'pending' && f.status !== 'url').length,
  }
}

/** The "generating links" phase progresses by links done, not files finished. */
export const isLinkPhase = (phase: string) => /generating/i.test(phase)
