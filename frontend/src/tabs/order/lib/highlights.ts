/**
 * Row highlights in the load order come from the refine passes, one per tag
 * kind. Each is a pure display toggle over data already fetched — the MOVED /
 * DUPLICATE / UNCERTAIN tags and their row tints — so flipping one never re-runs
 * a job, and turning all of them off leaves the table free of any highlighting.
 */
export type HighlightKey = 'duplicate' | 'moved' | 'uncertain'

export type Highlights = Record<HighlightKey, boolean>

export const ALL_HIGHLIGHTS_ON: Highlights = {
  duplicate: true,
  moved: true,
  uncertain: true,
}

/**
 * Initial state for the order table. The ACTIONABLE tags stay on (duplicates);
 * the INFORMATIONAL ones start OFF so every row isn't drowned in badges. `moved`
 * in particular is transient sort-audit noise ("Sort changed this mod's group")
 * that stacks a long badge on every touched row; `uncertain` is a soft hint. The
 * user opts into either via its highlight chip.
 */
export const DEFAULT_HIGHLIGHTS: Highlights = {
  duplicate: true,
  moved: false,
  uncertain: false,
}

/** Which toggle governs a given mod_sort flag. null = an unknown flag, always
 *  shown so nothing silently hides. */
export function flagCategory(flag: string): HighlightKey | null {
  if (flag.startsWith('DUPLICATE')) return 'duplicate'
  if (flag.startsWith('MOVED')) return 'moved'
  if (flag.startsWith('UNCERTAIN')) return 'uncertain'
  return null
}

/** db flag prefix each highlight clears via /api/order/clear-flags. */
export const CLEARABLE_FLAG_KIND: Record<HighlightKey, string | null> = {
  duplicate: 'DUPLICATE',
  moved: 'MOVED',
  uncertain: 'UNCERTAIN',
}

/** Chip metadata for the highlight bar — colors mirror the badge/row tints. */
export const HIGHLIGHT_CHIPS: { key: HighlightKey; label: string; color: string; bg: string; title: string }[] = [
  { key: 'duplicate', label: 'Duplicates', color: 'var(--red)', bg: '#3a1214', title: 'DUPLICATE tags from Refine with Claude — likely the same mod twice' },
  { key: 'moved', label: 'Moved', color: 'var(--amber)', bg: '#241d0f', title: "MOVED tags + amber row tint — Claude/sort changed a mod's group" },
  { key: 'uncertain', label: 'Uncertain', color: 'var(--dim)', bg: '#232833', title: "UNCERTAIN tags — the sorter wasn't confident about the group" },
]
