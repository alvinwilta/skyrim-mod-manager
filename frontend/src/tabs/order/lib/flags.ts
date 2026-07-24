export interface ParsedFlag {
  label: string
  hint: string
  severity: 'red' | 'amber' | 'dim'
}

/**
 * Parse a mod_sort flag string into display parts (legacy flagBadge).
 * Red is reserved for things that need action (a likely duplicate install);
 * a MOVED tag (the sorter changed a mod's group) is a warning — amber.
 *
 * Shapes: DUPLICATE:<mod_id> · MOVED:<from>><to>
 */
export function parseFlag(
  flag: string,
  names: ReadonlyMap<number, string>,
  buckets: Record<string, string>,
): ParsedFlag {
  const severity: ParsedFlag['severity'] = flag.startsWith('DUPLICATE')
    ? 'red'
    : flag.startsWith('MOVED')
      ? 'amber'
      : 'dim'

  let label = flag.split(':')[0]
  let hint = flag

  const refId = flag.startsWith('DUPLICATE') && parseInt(flag.split(':')[1], 10)
  if (refId) {
    const other = names.get(refId)
    label = `DUPLICATE ↔ ${other ? other.slice(0, 30) : refId}`
    hint = `likely duplicate of ${other || 'mod'} (${refId})`
  }

  const mv = flag.startsWith('MOVED:') && flag.slice(6).match(/^(\d+|None)>(\d+)$/)
  if (mv) {
    // A MOVED flag's endpoints may be bucket ids or separator-band ids depending
    // on which reorder produced it, so map through the bucket names and fall back
    // to the raw id when it isn't a known bucket. Long labels are truncated in CSS
    // (.badge-flag, ellipsis) with the full text in the tooltip, so this can stay
    // descriptive.
    const from = buckets[mv[1]] || mv[1]
    const to = buckets[mv[2]] || mv[2]
    label = `${from} → ${to}`
    hint = `Sort/Refine moved this from ${from} to ${to}`
  }

  return { label, hint, severity }
}
