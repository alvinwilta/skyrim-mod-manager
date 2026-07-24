import { describe, expect, it } from 'vitest'
import { parseFlag } from './flags'

const names = new Map([
  [42, 'Unofficial Skyrim Special Edition Patch With A Very Long Name Indeed'],
  [7, 'SkyUI'],
])
const buckets = { '3': 'Interface', '5': 'Foundation' }

describe('parseFlag', () => {
  it('DUPLICATE:<id> — red, target name truncated to 30 chars', () => {
    const f = parseFlag('DUPLICATE:42', names, buckets)
    expect(f.severity).toBe('red')
    expect(f.label).toBe(`DUPLICATE ↔ ${'Unofficial Skyrim Special Edition Patch With A Very Long Name Indeed'.slice(0, 30)}`)
    expect(f.hint).toContain('likely duplicate of')
    expect(f.hint).toContain('(42)')
  })

  it('DUPLICATE:<id> — red', () => {
    const f = parseFlag('DUPLICATE:7', names, buckets)
    expect(f.severity).toBe('red')
    expect(f.label).toBe('DUPLICATE ↔ SkyUI')
    expect(f.hint).toBe('likely duplicate of SkyUI (7)')
  })

  it('unknown ref id falls back to the raw id', () => {
    const f = parseFlag('DUPLICATE:999', names, buckets)
    expect(f.label).toBe('DUPLICATE ↔ 999')
  })

  it('MOVED:<from>><to> — full label (truncated in CSS), detail in the hint', () => {
    const f = parseFlag('MOVED:3>5', names, buckets)
    expect(f.severity).toBe('amber')
    expect(f.label).toBe('Interface → Foundation')
    expect(f.hint).toBe('Sort/Refine moved this from Interface to Foundation')
  })

  it('MOVED:None><to> — unknown source id falls back to the raw id', () => {
    const f = parseFlag('MOVED:None>5', names, buckets)
    expect(f.label).toBe('None → Foundation')
    expect(f.hint).toBe('Sort/Refine moved this from None to Foundation')
  })

  it('unknown flags — dim passthrough', () => {
    expect(parseFlag('UNCERTAIN', names, buckets).severity).toBe('dim')
  })
})
