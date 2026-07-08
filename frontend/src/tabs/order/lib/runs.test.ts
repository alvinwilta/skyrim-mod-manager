import { describe, expect, it } from 'vitest'
import { segmentRuns, type VisibleRow } from './runs'
import type { OrderMod } from '../../../api/types'

const m = (mod_id: number, bucket: number | null): OrderMod => ({
  mod_id,
  mod_name: `mod${mod_id}`,
  mod_url: '',
  category: null,
  bucket,
  locked: false,
  installed: false,
  file_type: null,
  flags: [],
})
const rows = (specs: [number, number | null][]): VisibleRow[] =>
  specs.map(([id, b], i) => ({ mod: m(id, b), pos: i + 1 }))

describe('segmentRuns', () => {
  it('groups contiguous same-bucket rows', () => {
    const r = segmentRuns(rows([[1, 3], [2, 3], [3, 5]]))
    expect(r.map((x) => [x.bucket, x.rows.length])).toEqual([
      [3, 2],
      [5, 1],
    ])
  })

  it('an interleaved bucket produces separate runs — display never re-orders', () => {
    const r = segmentRuns(rows([[1, 3], [2, 5], [3, 3]]))
    expect(r.map((x) => x.bucket)).toEqual([3, 5, 3])
    expect(r[0].key).not.toBe(r[2].key)
  })

  it('null buckets form their own runs', () => {
    const r = segmentRuns(rows([[1, null], [2, null], [3, 1]]))
    expect(r.map((x) => [x.bucket, x.rows.length])).toEqual([
      [null, 2],
      [1, 1],
    ])
  })

  it('empty input → no runs', () => {
    expect(segmentRuns([])).toEqual([])
  })
})
