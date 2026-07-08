import type { OrderMod } from '../../../api/types'

export interface VisibleRow {
  mod: OrderMod
  /** 1-based rank in the FULL unfiltered order (backend move position). */
  pos: number
}

export interface Run {
  key: string
  bucket: number | null
  rows: VisibleRow[]
}

/**
 * Segment the rank-ordered row list into contiguous same-bucket runs. Display
 * grouping must never re-order rows — a bucket appears multiple times if
 * manual moves interleaved it — so group headers are runs, not buckets.
 */
export function segmentRuns(rows: VisibleRow[]): Run[] {
  const runs: Run[] = []
  for (const r of rows) {
    const last = runs[runs.length - 1]
    if (last && last.bucket === r.mod.bucket) {
      last.rows.push(r)
    } else {
      runs.push({ key: `${r.mod.bucket ?? 'none'}@${r.pos}`, bucket: r.mod.bucket, rows: [r] })
    }
  }
  return runs
}
