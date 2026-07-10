/**
 * Row highlights in the load order come from the scan/analysis passes, one
 * per tag kind. Each is a pure display toggle over data already fetched — the
 * WRONG SPOT / MOVED / CONFLICT / DUPLICATE / UNCERTAIN tags and their row
 * tints — so flipping one never re-runs a scan, and turning all of them off
 * leaves the table free of any highlighting.
 */
export type HighlightKey = 'conflict' | 'duplicate' | 'moved' | 'uncertain' | 'drift'

export type Highlights = Record<HighlightKey, boolean>

export const ALL_HIGHLIGHTS_ON: Highlights = {
  conflict: true,
  duplicate: true,
  moved: true,
  uncertain: true,
  drift: true,
}

/** Which toggle governs a given mod_sort flag (WRONG SPOT is synthesized by the
 *  drift check). null = an unknown flag, always shown so nothing silently hides. */
export function flagCategory(flag: string): HighlightKey | null {
  if (flag.startsWith('CONFLICT')) return 'conflict'
  if (flag.startsWith('DUPLICATE')) return 'duplicate'
  if (flag.startsWith('MOVED')) return 'moved'
  if (flag.startsWith('UNCERTAIN')) return 'uncertain'
  if (flag.startsWith('WRONG SPOT')) return 'drift'
  return null
}

/** db flag prefix each highlight clears via /api/order/clear-flags.
 *  drift is null: WRONG SPOT is computed by the drift check, not stored —
 *  clearing it just resets the session's check result. */
export const CLEARABLE_FLAG_KIND: Record<HighlightKey, string | null> = {
  conflict: 'CONFLICT',
  duplicate: 'DUPLICATE',
  moved: 'MOVED',
  uncertain: 'UNCERTAIN',
  drift: null,
}

/** Chip metadata for the highlight bar — colors mirror the badge/row tints. */
export const HIGHLIGHT_CHIPS: { key: HighlightKey; label: string; color: string; bg: string; title: string }[] = [
  { key: 'conflict', label: 'Conflicts', color: 'var(--amber)', bg: '#3a2b12', title: 'CONFLICT tags from Refine with Claude — mods that share files' },
  { key: 'duplicate', label: 'Duplicates', color: 'var(--red)', bg: '#3a1214', title: 'DUPLICATE tags from Refine with Claude — likely the same mod twice' },
  { key: 'moved', label: 'Moved', color: 'var(--amber)', bg: '#241d0f', title: "MOVED tags + amber row tint — Claude/sort changed a mod's group" },
  { key: 'uncertain', label: 'Uncertain', color: 'var(--dim)', bg: '#232833', title: "UNCERTAIN tags — the sorter wasn't confident about the group" },
  { key: 'drift', label: 'Wrong spot', color: 'var(--red)', bg: '#2a1215', title: 'WRONG SPOT tags + red row tint from Check for drift — a manual move drifted a mod out of the sorter group' },
]
