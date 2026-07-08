export interface ParsedFlag {
  label: string
  hint: string
  severity: 'red' | 'amber' | 'dim'
}

/**
 * Parse a mod_sort flag string into display parts (legacy flagBadge).
 * Red is reserved for things that actually need action: a likely duplicate
 * install, or a manual move that drifted from the sorter's opinion. A plain
 * ordering CONFLICT (two mods that share/overwrite files) is a warning — amber.
 *
 * Shapes: CONFLICT:<mod_id> · DUPLICATE:<mod_id> · MOVED:<from>><to> · WRONG SPOT
 */
export function parseFlag(
  flag: string,
  names: ReadonlyMap<number, string>,
  buckets: Record<string, string>,
): ParsedFlag {
  const severity: ParsedFlag['severity'] =
    flag.startsWith('DUPLICATE') || flag === 'WRONG SPOT'
      ? 'red'
      : flag.startsWith('CONFLICT') || flag.startsWith('MOVED')
        ? 'amber'
        : 'dim'

  let label = flag.split(':')[0]
  let hint = flag

  const refId = (flag.startsWith('CONFLICT') || flag.startsWith('DUPLICATE')) && parseInt(flag.split(':')[1], 10)
  if (refId) {
    const other = names.get(refId)
    const verb = flag.startsWith('DUPLICATE') ? 'DUPLICATE' : 'CONFLICT'
    label = `${verb} ↔ ${other ? other.slice(0, 30) : refId}`
    hint = `${verb === 'DUPLICATE' ? 'likely duplicate of' : 'conflicts with'} ${other || 'mod'} (${refId})`
  }

  const mv = flag.startsWith('MOVED:') && flag.slice(6).match(/^(\d+|None)>(\d+)$/)
  if (mv) {
    const from = buckets[mv[1]]
    const to = buckets[mv[2]]
    label = `MOVED ${from || mv[1]} → ${to || mv[2]}`
    hint = `Claude moved this from ${mv[1]} · ${from || 'unsorted'} to ${mv[2]} · ${to || '?'}`
  }

  return { label, hint, severity }
}
