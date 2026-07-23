import { describe, expect, it } from 'vitest'
import { snapshotBuckets, diffChanged } from './changeDiff'
import type { OrderMod } from '../../../api/types'

const m = (mod_id: number, bucket: number | null): OrderMod => ({
  mod_id,
  mod_name: `mod${mod_id}`,
  mod_url: '',
  category: null,
  bucket,
  locked: false,
  installed: false,
  mo2_state: null,
  file_type: null,
  flags: [],
})

describe('changeDiff', () => {
  it('flags only mods whose bucket changed since the snapshot', () => {
    const before = snapshotBuckets([m(1, 3), m(2, 3), m(3, null)])
    const after = [m(1, 3), m(2, 5), m(3, 1)]
    expect([...diffChanged(before, after)].sort()).toEqual([2, 3])
  })

  it('mods new since the snapshot count as changed (undefined !== bucket)', () => {
    const before = snapshotBuckets([m(1, 3)])
    expect([...diffChanged(before, [m(1, 3), m(9, 2)])]).toEqual([9])
  })

  it('no changes → empty set', () => {
    const mods = [m(1, 3), m(2, null)]
    expect(diffChanged(snapshotBuckets(mods), mods).size).toBe(0)
  })
})
