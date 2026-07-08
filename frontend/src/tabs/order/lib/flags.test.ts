import { describe, expect, it } from 'vitest'
import { parseFlag } from './flags'

const names = new Map([
  [42, 'Unofficial Skyrim Special Edition Patch With A Very Long Name Indeed'],
  [7, 'SkyUI'],
])
const buckets = { '3': 'Interface', '5': 'Foundation' }

describe('parseFlag', () => {
  it('CONFLICT:<id> — amber, target name truncated to 30 chars', () => {
    const f = parseFlag('CONFLICT:42', names, buckets)
    expect(f.severity).toBe('amber')
    expect(f.label).toBe(`CONFLICT ↔ ${'Unofficial Skyrim Special Edition Patch With A Very Long Name Indeed'.slice(0, 30)}`)
    expect(f.hint).toContain('conflicts with')
    expect(f.hint).toContain('(42)')
  })

  it('DUPLICATE:<id> — red', () => {
    const f = parseFlag('DUPLICATE:7', names, buckets)
    expect(f.severity).toBe('red')
    expect(f.label).toBe('DUPLICATE ↔ SkyUI')
    expect(f.hint).toBe('likely duplicate of SkyUI (7)')
  })

  it('unknown ref id falls back to the raw id', () => {
    const f = parseFlag('CONFLICT:999', names, buckets)
    expect(f.label).toBe('CONFLICT ↔ 999')
  })

  it('MOVED:<from>><to> — amber with bucket names', () => {
    const f = parseFlag('MOVED:3>5', names, buckets)
    expect(f.severity).toBe('amber')
    expect(f.label).toBe('MOVED Interface → Foundation')
    expect(f.hint).toBe('Claude moved this from 3 · Interface to 5 · Foundation')
  })

  it('MOVED:None><to> — unsorted source', () => {
    const f = parseFlag('MOVED:None>5', names, buckets)
    expect(f.label).toBe('MOVED None → Foundation')
    expect(f.hint).toContain('None · unsorted')
  })

  it('WRONG SPOT — red', () => {
    expect(parseFlag('WRONG SPOT', names, buckets)).toEqual({
      label: 'WRONG SPOT',
      hint: 'WRONG SPOT',
      severity: 'red',
    })
  })

  it('unknown flags — dim passthrough', () => {
    expect(parseFlag('UNCERTAIN', names, buckets).severity).toBe('dim')
  })
})
