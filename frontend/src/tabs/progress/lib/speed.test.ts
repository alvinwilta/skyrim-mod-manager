import { describe, expect, it } from 'vitest'
import { computeStats, formatEta, isLinkPhase, updateSpeed } from './speed'
import type { DlFile } from '../../../api/types'

const f = (over: Partial<DlFile>): DlFile => ({ name: 'a', size: 100, got: 0, status: 'pending', ...over })

describe('updateSpeed', () => {
  it('seeds the first sample without computing a speed', () => {
    const r = updateSpeed(0, null, 1000, 500)
    expect(r.speed).toBe(0)
    expect(r.prev).toEqual({ t: 1000, b: 500 })
  })

  it('ignores samples closer than 0.2s', () => {
    const r = updateSpeed(10, { t: 1000, b: 0 }, 1100, 999)
    expect(r).toEqual({ speed: 10, prev: { t: 1000, b: 0 } })
  })

  it('seeds unsmoothed, then blends 0.7/0.3', () => {
    // first real sample: 1000 bytes over 1s → 1000 B/s, no smoothing
    const a = updateSpeed(0, { t: 0, b: 0 }, 1000, 1000)
    expect(a.speed).toBe(1000)
    // second: 2000 bytes over 1s → 0.7*1000 + 0.3*2000 = 1300
    const b = updateSpeed(a.speed, a.prev, 2000, 3000)
    expect(b.speed).toBeCloseTo(1300)
  })

  it('clamps negative deltas (restart) to zero', () => {
    const r = updateSpeed(1000, { t: 0, b: 5000 }, 1000, 0)
    expect(r.speed).toBeCloseTo(700)
  })
})

describe('formatEta', () => {
  it('formats HH:MM:SS', () => {
    expect(formatEta(1024, 1024 * 90)).toBe('00:01:30')
  })
  it('dashes when speed too low or nothing remains', () => {
    expect(formatEta(0, 5000)).toBe('—')
    expect(formatEta(1, 5000)).toBe('—')
    expect(formatEta(1024, 0)).toBe('—')
  })
})

describe('computeStats', () => {
  it('counts done/failed and byte totals like the legacy render()', () => {
    const stats = computeStats([
      f({ name: 'a', status: 'done', size: 100, got: 100 }),
      f({ name: 'b', status: 'failed', size: 50, got: 10 }),
      f({ name: 'c', status: 'downloading', size: 200, got: 80 }),
      f({ name: 'd', status: 'skipped', size: 0, got: 30 }),
    ])
    expect(stats.done).toBe(1)
    expect(stats.fail).toBe(1)
    expect(stats.total).toBe(4)
    expect(stats.finished).toBe(2)
    // done contributes its size; failed contributes nothing; downloading its got;
    // size-0 skipped falls back to got (legacy `f.size || f.got`)
    expect(stats.gotBytes).toBe(100 + 80 + 30)
    expect(stats.totalBytes).toBe(350)
  })

  it('linksDone counts files past the url-generation stage', () => {
    const stats = computeStats([
      f({ name: 'a', status: 'pending' }),
      f({ name: 'b', status: 'url' }),
      f({ name: 'c', status: 'queued' }),
      f({ name: 'd', status: 'done' }),
    ])
    expect(stats.linksDone).toBe(2)
  })
})

describe('isLinkPhase', () => {
  it('matches "generating" phases case-insensitively', () => {
    expect(isLinkPhase('Generating download links')).toBe(true)
    expect(isLinkPhase('downloading')).toBe(false)
  })
})
