import { parseFlag } from './lib/flags'

const STYLE = {
  red: { background: '#3a1214', color: 'var(--red)' },
  amber: { background: '#3a2b12', color: 'var(--amber)' },
  dim: { background: '#232833', color: 'var(--dim)' },
} as const

export function FlagBadge({
  flag,
  names,
  buckets,
}: {
  flag: string
  names: ReadonlyMap<number, string>
  buckets: Record<string, string>
}) {
  const { label, hint, severity } = parseFlag(flag, names, buckets)
  // trailing space: badges are nowrap spans, and JSX .map() emits no whitespace
  // between siblings — without it a long badge run is one unbreakable line
  return (
    <>
      <span className="badge" style={STYLE[severity]} title={hint}>
        {label}
      </span>{' '}
    </>
  )
}
