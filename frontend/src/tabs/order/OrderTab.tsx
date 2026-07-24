import { useCallback, useEffect, useMemo, useRef, useState, type Key, type ReactNode } from 'react'
import { useStickyTop } from '../../hooks/useStickyTop'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { api } from '../../api/endpoints'
import { useRowSelection } from '../library/useRowSelection'
import { useOrderData, matchesFilter, errText } from './hooks/useOrderData'
import { useOrderJobs } from './hooks/useOrderJobs'
import { resolveDrop, type DropCell } from './lib/moveIntent'
import { type VisibleRow } from './lib/runs'
import { OrderRow } from './OrderRow'
import { BandDivider } from './BandDivider'
import { OrderToolbar } from './OrderToolbar'
import type { ConflictRelations, OrderMod, Separator } from '../../api/types'
import { HighlightBar } from './HighlightBar'
import { DEFAULT_HIGHLIGHTS, CLEARABLE_FLAG_KIND, flagCategory, type HighlightKey } from './lib/highlights'
import { SelectionToolbar } from './SelectionToolbar'
import { Subtabs } from './subtabs/Subtabs'
import { ResizablePanel } from './ResizablePanel'
import { RequirementsView, requirementKey } from './subtabs/RequirementsView'
import { SubstitutesView } from './subtabs/SubstitutesView'
import { ConflictDetail } from './subtabs/ConflictDetail'
import { NoteText } from './ModJump'
import { scrollToMod } from './lib/scrollToMod'
import { DismissX, RestoreDismissed } from './Dismiss'
import type { Dismissed } from './hooks/useDismissed'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { LoadingOverlay } from '../../components/LoadingOverlay'

// Fixed row heights (px) — MUST match .ordrow / .band-divider in index.css so
// the virtualizer's positions are exact and don't depend on the async measure
// pass (which is what let stacked dividers overlap).
const MOD_ROW_H = 36
// Separators MUST match MOD_ROW_H: dnd-kit's verticalListSortingStrategy shifts
// every item past the drop point by the ACTIVE item's height (uniform-height
// assumption). A taller divider (was 46) shifted by a dragged 36px row left a
// 10px overlap mid-drag ("divider locked to row height"). Equal heights = exact.
const SEP_ROW_H = MOD_ROW_H

// Native-scrollbar overview marks: colour per flag kind (mirrors the badge/chip
// tints); the ORDER is severity — first match wins when a mod has several flags.
const SCROLL_MARK_COLOR: Record<HighlightKey, string> = {
  duplicate: '#d9534f',
  moved: '#c8934a',
  uncertain: '#8a93a3',
}
const SCROLL_MARK_ORDER: HighlightKey[] = ['duplicate', 'moved', 'uncertain']

// Scrollbar colours for the select-to-tint overlay (selection + its winners/losers).
const TINT_MARK = { sel: '#4a90e2', green: '#57d267', red: '#ff5148', orange: '#e6a52e' } as const

function NotesList({
  notes,
  d,
  names,
  onJump,
}: {
  notes: string[]
  d: Dismissed
  names: ReadonlyMap<number, string>
  onJump: (id: number) => void
}) {
  const shown = notes.filter((x) => !d.has(x))
  const dupes = shown.filter((x) => x.toUpperCase().startsWith('DUPLICATE:'))
  const rest = shown.filter((x) => !x.toUpperCase().startsWith('DUPLICATE:'))
  return (
    <>
      {dupes.length > 0 && (
        <div className="grp">
          <h2>
            <span className="badge" style={{ background: '#3a1214', color: 'var(--red)' }}>
              Possible duplicate mods · {dupes.length}
            </span>
          </h2>
          <ul className="dim dismiss-list">
            {dupes.map((x, i) => (
              <li key={i}>
                <DismissX onDismiss={() => d.dismiss(x)} />
                <NoteText text={x.replace(/^duplicate:\s*/i, '')} names={names} onJump={onJump} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {rest.length > 0 && (
        <div className="grp">
          <h2>
            <span className="badge" style={{ background: '#3a2b12', color: 'var(--amber)' }}>
              Conflict notes · {rest.length}
            </span>
          </h2>
          <ul className="dim dismiss-list">
            {rest.map((x, i) => (
              <li key={i}>
                <DismissX onDismiss={() => d.dismiss(x)} />
                <NoteText text={x} names={names} onJump={onJump} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

export function OrderTab() {
  const data = useOrderData()
  const jobs = useOrderJobs(data)
  const [cat, setCat] = useState('')
  const [grp, setGrp] = useState('')
  const [q, setQ] = useState('')
  const searchWrapRef = useStickyTop<HTMLDivElement>()
  const [hl, setHl] = useState(DEFAULT_HIGHLIGHTS)
  const [showLocked, setShowLocked] = useState(true)
  const [dragId, setDragId] = useState<number | null>(null)
  const [confirmCommit, setConfirmCommit] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmPull, setConfirmPull] = useState(false)
  const [confirmPush, setConfirmPush] = useState(false)
  const [subCount, setSubCount] = useState(0)

  const toggleHl = (key: HighlightKey) => setHl((h) => ({ ...h, [key]: !h[key] }))

  const setMsg = jobs.setMsg

  // Auto-pull MO2's order once, on first ever load (no mod carries an mo2_state
  // yet) — the seed. Never re-fires afterwards (a pull stamps every ok mod), so
  // it can't clobber tool-side reordering on later reloads. Skipped while the
  // order is committed to disk (reordering is frozen then).
  const autoPulledRef = useRef(false)
  useEffect(() => {
    if (autoPulledRef.current || data.committed || jobs.pulling) return
    if (data.mods.length === 0 || data.mods.some((m) => m.mo2_state != null)) return
    autoPulledRef.current = true
    void jobs.runPull()
  }, [data.mods, data.committed, jobs])

  // Separator bands: dividers live INLINE in the single draggable order.
  const [separators, setSeparators] = useState<Separator[]>([])
  const [collapsedBands, setCollapsedBands] = useState<Set<number>>(new Set())
  const loadSeparators = useCallback(() => {
    api
      .separators()
      .then((r) => {
        setSeparators(r.separators)
        setCollapsedBands(new Set(r.separators.filter((s) => s.collapsed).map((s) => s.id)))
      })
      .catch(() => {})
  }, [])
  useEffect(loadSeparators, [loadSeparators])

  const sepById = useMemo(() => new Map(separators.map((s) => [s.id, s])), [separators])

  // MO2-style directed overwrite relations (who overwrites whom), from real file
  // overlaps + current order. Loaded on mount and refreshed after every Sort
  // (Sort scans archives + regenerates ranks, both of which change the answer).
  const [relations, setRelations] = useState<ConflictRelations>({})
  const loadRelations = useCallback(() => {
    api
      .conflictRelations()
      .then((r) => setRelations(r.relations))
      .catch(() => {})
  }, [])
  useEffect(loadRelations, [loadRelations])

  const toggleBand = (id: number) => {
    setCollapsedBands((prev) => {
      const next = new Set(prev)
      const willCollapse = !next.has(id)
      willCollapse ? next.add(id) : next.delete(id)
      void api.collapseSeparator(id, willCollapse).catch(() => {})
      return next
    })
  }

  // Sort (the engine) assigns every mod its band + order; refresh the band
  // counts shown on the dividers after it runs.
  const runSortAndRefresh = () =>
    void jobs.runSort(false).then(() => {
      loadSeparators()
      loadRelations()
    })

  // × on a chip: strip the stored mod_sort flags in the db, then reload.
  const clearHl = async (key: HighlightKey) => {
    const kind = CLEARABLE_FLAG_KIND[key]
    if (!kind) return
    try {
      const r = await api.orderClearFlags([kind])
      jobs.setMsg(`cleared ${kind} tags from ${r.cleared} mod(s)`)
      if (key === 'moved') jobs.clearJustChanged()
      await data.reload()
    } catch (e) {
      jobs.setMsg(errText(e))
    }
  }

  // Committed = files renamed on disk with install-order prefixes. Freezes every
  // reordering surface (like refining does) so nothing renumbers under the
  // committed files; the commit/revert toggle + filters + analysis stay live.
  const frozen = data.refining || data.committed

  // Rank positions are absolute over the full list; filters only hide rows.
  // The ordered, filtered row list — the SINGLE source the whole tab derives
  // pos, selection indices and the divider list from. It is built by GROUPING
  // mods into their separator band (band id ascending; unassigned last), NOT by
  // trusting the raw rank order to already be band-contiguous. This is the
  // invariant that makes duplicate/overlapping dividers structurally impossible:
  // every band is one contiguous run here by construction, so a stale rank (mid
  // optimistic move, or a backend that regressed) can never split a band into
  // two divider runs. `pos` is the 1-based index in THIS grouped order, which
  // also equals the backend's band-grouped rank (order_store.move keeps them in
  // sync), so a move position computed here lands correctly on the server.
  const NO_BAND = Number.MAX_SAFE_INTEGER
  const visibleAll: VisibleRow[] = useMemo(() => {
    const filtered = data.mods.filter((m) => matchesFilter(m, cat, grp, q) && (showLocked || !m.locked))
    const byBand = new Map<number, OrderMod[]>()
    for (const m of filtered) {
      const b = m.separator_id ?? NO_BAND
      const arr = byBand.get(b)
      if (arr) arr.push(m)
      else byBand.set(b, [m])
    }
    const seq = [...byBand.keys()].sort((a, b) => a - b).flatMap((b) => byBand.get(b)!)
    return seq.map((mod, i) => ({ mod, pos: i + 1 }))
  }, [data.mods, cat, grp, q, showLocked])

  const lockedCount = useMemo(() => data.mods.filter((m) => m.locked).length, [data.mods])
  const allLocked = data.mods.length > 0 && lockedCount === data.mods.length

  // How many rows each highlight would tag right now — shown on the chips so
  // an empty pass reads as (0) instead of a chip that does nothing.
  const hlCounts = useMemo(() => {
    const c: Record<HighlightKey, number> = { duplicate: 0, moved: 0, uncertain: 0 }
    for (const mod of data.mods) {
      const cats = new Set<HighlightKey>()
      for (const f of mod.flags || []) {
        const k = flagCategory(f)
        if (k) cats.add(k)
      }
      if (jobs.justChanged.has(mod.mod_id)) cats.add('moved')
      for (const k of cats) c[k]++
    }
    return c
  }, [data.mods, jobs.justChanged])
  const sel = useRowSelection(visibleAll.map((r) => r.mod.mod_id))

  // While a selected row is being dragged, the REST of the selection leaves
  // the list (it travels in the drag overlay as "N mods"). With those rows
  // still rendered, dnd-kit's drop preview shifts neighbors as if only ONE
  // row were moving, so the block landed 2+ rows below where it was dropped.
  const blockDrag = dragId !== null && sel.selected.has(dragId) && sel.selected.size > 1
  const visible: VisibleRow[] = useMemo(
    () =>
      blockDrag ? visibleAll.filter((r) => r.mod.mod_id === dragId || !sel.selected.has(r.mod.mod_id)) : visibleAll,
    [visibleAll, blockDrag, dragId, sel.selected],
  )

  // Combined render list: one divider per band, followed by that band's mod
  // rows — one draggable order, MO2-style. Built by GROUPING (band id ascending;
  // unassigned last), so exactly one divider can ever exist per band regardless
  // of the input row order — the duplicate/overlapping-divider class of bug is
  // impossible here by construction. A collapsed band keeps its divider but
  // drops its rows. `visible` may hide some rows mid-drag (blockDrag), which
  // only shrinks a band's run, never splits it.
  const combined = useMemo(() => {
    const byBand = new Map<number, VisibleRow[]>()
    for (const row of visible) {
      const b = row.mod.separator_id ?? NO_BAND
      const arr = byBand.get(b)
      if (arr) arr.push(row)
      else byBand.set(b, [row])
    }
    const out: ({ kind: 'sep'; sepId: number } | { kind: 'mod'; row: VisibleRow })[] = []
    for (const b of [...byBand.keys()].sort((x, y) => x - y)) {
      const hasBand = b !== NO_BAND
      if (hasBand) out.push({ kind: 'sep', sepId: b })
      if (hasBand && collapsedBands.has(b)) continue // collapsed: divider only
      for (const row of byBand.get(b)!) out.push({ kind: 'mod', row })
    }
    return out
  }, [visible, collapsedBands, NO_BAND])

  // mod_id → index in `combined` (interleaved with dividers) — for the
  // virtualizer's scrollToIndex when jumping to a mod.
  const combinedIndex = useMemo(() => {
    const m = new Map<number, number>()
    combined.forEach((it, i) => it.kind === 'mod' && m.set(it.row.mod.mod_id, i))
    return m
  }, [combined])

  // mod_id → index in `visibleAll` (mods only) — this is the index space the
  // selection hook's shift-range uses, so it MUST exclude dividers.
  const selIndex = useMemo(() => new Map(visibleAll.map((r, i) => [r.mod.mod_id, i])), [visibleAll])

  // Overview markers painted onto the native scrollbar (Chromium only — see the
  // ::-webkit-scrollbar-track gradient in css). One per flagged mod, at its
  // fraction down the combined list; kind decides colour. Respects the highlight
  // toggles (moved/uncertain default off), so the scrollbar only marks kinds the
  // user has turned on. Highest-severity kind wins when a mod has several.
  const scrollMarks = useMemo(() => {
    const n = combined.length
    const out: { frac: number; color: string }[] = []
    combined.forEach((it, i) => {
      if (it.kind !== 'mod') return
      const mod = it.row.mod
      const kinds = new Set<HighlightKey>()
      for (const f of mod.flags || []) {
        const c = flagCategory(f)
        if (c && hl[c]) kinds.add(c)
      }
      const kind = SCROLL_MARK_ORDER.find((k) => kinds.has(k))
      if (kind) out.push({ frac: n > 1 ? i / (n - 1) : 0, color: SCROLL_MARK_COLOR[kind] })
    })
    return out
  }, [combined, hl])

  // Select-to-tint: when mods are selected, tint the rows they conflict with by
  // who WINS. green = that mod OVERWRITES the selection (winner), red = it's
  // OVERWRITTEN BY the selection (loser), orange = both. Empty when nothing is
  // selected (tint only on select); the selection itself keeps its own r-sel
  // highlight.
  const conflictTint = useMemo(() => {
    const m = new Map<number, 'green' | 'red' | 'orange'>()
    if (!sel.selected.size) return m
    const green = new Set<number>() // mods that overwrite the selection (win)
    const red = new Set<number>() // mods the selection overwrites (lose)
    for (const sid of sel.selected) {
      const rel = relations[String(sid)]
      if (!rel) continue
      for (const e of rel.overwritten_by) green.add(e.mod_id) // they win over the selection
      for (const e of rel.overwrites) red.add(e.mod_id) // the selection wins over them
    }
    for (const id of green) m.set(id, red.has(id) ? 'orange' : 'green')
    for (const id of red) if (!m.has(id)) m.set(id, 'red')
    return m
  }, [relations, sel.selected])

  // Scrollbar marks. With nothing selected: the flag marks (conflict/duplicate/
  // moved/uncertain/drift). While mods ARE selected: swap to ONLY the select-to-
  // tint highlights — the selected rows (blue) and their green (overwrites the
  // selection) / red (overwritten by it) / orange conflict rows — so the
  // scrollbar shows just what you selected, not every flagged mod.
  const paintMarks = useMemo(() => {
    if (!sel.selected.size) return scrollMarks
    const n = combined.length
    // `w` = width MULTIPLIER over one row's proportional height (computed in
    // paint); overlay marks are a touch thicker than the thin flag marks so the
    // green/red/blue read clearly, but still track a single row's position.
    const overlay: { frac: number; color: string; w: number }[] = []
    combined.forEach((it, i) => {
      if (it.kind !== 'mod') return
      const id = it.row.mod.mod_id
      const frac = n > 1 ? i / (n - 1) : 0
      if (sel.selected.has(id)) overlay.push({ frac, color: TINT_MARK.sel, w: 1.8 })
      else {
        const t = conflictTint.get(id)
        if (t) overlay.push({ frac, color: TINT_MARK[t], w: 1.8 })
      }
    })
    return overlay
  }, [scrollMarks, combined, sel.selected, conflictTint])

  // Build the ::-webkit-scrollbar-track background gradient from the marks and
  // stamp it on :root as --sb-marks. The list is window-scrolled, so map each
  // mark's list fraction to its DOCUMENT position (list offset + fraction·list
  // height) over the full scrollHeight — that's what the native track spans.
  // Recompute when the marks or layout (row count → total size, viewport) change.
  useEffect(() => {
    const root = document.documentElement
    const paint = () => {
      const listEl = listRef.current
      const docH = root.scrollHeight
      if (!listEl || !docH || !paintMarks.length) {
        root.style.removeProperty('--sb-marks')
        return
      }
      const listTop = listEl.getBoundingClientRect().top + window.scrollY
      const listH = listEl.offsetHeight || 1
      // one row's half-height as a % of the whole document = proportional mark
      // size, floored so a single row still shows a visible sliver on the track
      const rowHalf = Math.max(0.1, ((MOD_ROW_H / 2) / docH) * 100)
      const seg: string[] = []
      for (const m of paintMarks) {
        const f = Math.min(100, Math.max(0, ((listTop + m.frac * listH) / docH) * 100))
        const hw = rowHalf * ('w' in m ? (m as { w: number }).w : 1)
        const a = Math.max(0, f - hw)
        const b = Math.min(100, f + hw)
        seg.push(`transparent ${a}%`, `${m.color} ${a}%`, `${m.color} ${b}%`, `transparent ${b}%`)
      }
      root.style.setProperty('--sb-marks', `linear-gradient(to bottom, ${seg.join(', ')})`)
    }
    paint()
    window.addEventListener('resize', paint)
    return () => {
      window.removeEventListener('resize', paint)
      root.style.removeProperty('--sb-marks')
    }
  }, [paintMarks])

  // Stable reference: SortableContext re-derives its internal `items` off this
  // array's identity, not its contents — an inline `.map()` here would hand it
  // a new array (and force that recompute) on every OrderTab re-render for any
  // unrelated reason (job polling, a message update) while a drag is in flight.
  // Sortable ids in render order — dividers INCLUDED (`sep-<id>`) so they take
  // part in dnd-kit's reflow (see BandDivider). Mixing string + number ids is
  // fine (dnd-kit's UniqueIdentifier). Mods keep their numeric mod_id so the
  // OrderRow useSortable ids match.
  const visibleIds = useMemo<(string | number)[]>(
    () => combined.map((it) => (it.kind === 'sep' ? `sep-${it.sepId}` : it.row.mod.mod_id)),
    [combined],
  )

  // Same order as `combined`, shaped for resolveDrop (id + band + modId).
  const dropCells = useMemo<DropCell[]>(
    () =>
      combined.map((it) =>
        it.kind === 'sep'
          ? { id: `sep-${it.sepId}`, band: it.sepId, modId: null }
          : { id: it.row.mod.mod_id, band: it.row.mod.separator_id ?? null, modId: it.row.mod.mod_id },
      ),
    [combined],
  )

  // Real row count runs into the hundreds — mounting every row keeps every one
  // of them subscribed to dnd-kit's SortableContext, which re-renders every
  // subscriber on each row the pointer crosses while dragging (React Context
  // has no per-consumer filtering). Only mounting rows near the viewport is
  // what actually bounds that cost. useWindowVirtualizer (not an inner
  // overflow div) keeps the page scrolling exactly as before — no new inner
  // scrollbar — and happens to be what dnd-kit's own auto-scroll already
  // targets by default (window/document) when it finds no scrollable ancestor.
  const listRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useWindowVirtualizer({
    count: combined.length,
    // Per-item height so positions are deterministic and don't rely on the
    // async measure pass: separator dividers and mod rows are both a FIXED 36px
    // (see .band-divider in css / MOD_ROW_H). A single flat estimate made
    // stacked dividers overlap (each ~10px taller than the estimate) until — or
    // unless — ResizeObserver corrected them.
    estimateSize: (i) => (combined[i]?.kind === 'sep' ? SEP_ROW_H : MOD_ROW_H),
    overscan: 15,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  })

  // Shared by every result list (refine notes, conflicts, requirements,
  // drift): scroll to the named mod's row; if a filter hides it, say so
  // instead of silently doing nothing. Virtualized rows outside the current
  // window aren't mounted yet, so scrollToIndex first, then poll a few
  // frames for the row to land in the DOM before flashing it — scrollToMod
  // itself is a harmless no-op re-scroll once the row is already in view.
  const jumpToMod = useCallback(
    (id: number) => {
      const idx = combinedIndex.get(id)
      if (idx === undefined) {
        setMsg(`mod ${id} is hidden by the current filter — clear filters to jump to it`)
        return
      }
      rowVirtualizer.scrollToIndex(idx, { align: 'center' })
      let tries = 0
      const tick = () => {
        if (scrollToMod(id) || ++tries > 20) return
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
    [combinedIndex, rowVirtualizer, setMsg],
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const doMove = async (ids: number[], position: number, separatorId?: number | null) => {
    if (frozen) return
    // Reorder the local cache first so the table's row order already matches
    // the drop target when dnd-kit resets the dragged row's transform — the
    // await below would otherwise leave the array stale for a network
    // round-trip, and the row visibly snaps back to its old spot first.
    data.reorderLocal(ids, position, separatorId)
    try {
      const r = await api.orderMove(ids, position, separatorId)
      jobs.setMsg(`moved ${ids.length > 1 ? ids.length + ' mods ' : ''}to #${r.position}`)
      await data.reload()
    } catch (e) {
      jobs.setMsg(errText(e))
      await data.reload() // undo the optimistic reorder — the move never landed
    }
  }

  // Same soft-delete as the Library tab, but keyed by mod: the backend
  // expands each mod_id to all its live files, removes them from disk and
  // marks the rows deleted, so the mod drops off the order on reload.
  const doDelete = async () => {
    const ids = [...sel.selected]
    try {
      const r = await api.deleteMods(ids)
      jobs.setMsg(`${r.deleted} marked deleted · ${r.files_removed} file(s) removed from disk`)
      sel.clear()
      await data.reload()
    } catch (e) {
      jobs.setMsg(errText(e))
    }
  }

  const doLock = async (ids: number[], locked: boolean) => {
    if (frozen) return
    try {
      await api.orderLock(ids, locked)
      await data.reload()
    } catch (e) {
      jobs.setMsg(errText(e))
    }
  }

  // Row click = checkbox toggle (accumulates); shift = range. Click outside
  // any row clears. Selection only shrinks on a row re-click or outside-click.
  const onRowClick = (mid: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const idx = selIndex.get(mid) ?? 0
    sel.toggle(mid, idx, e.shiftKey)
  }

  // Stable per-row handlers (identity never changes): with hundreds of rows,
  // fresh inline arrows per render defeated the row memo, so every poller
  // message or selection click re-rendered the whole table. The ref always
  // points at the latest closures; the wrappers are created once.
  const live = useRef({ doMove, doLock, onRowClick })
  live.current = { doMove, doLock, onRowClick }
  const rowHandlers = useMemo(
    () => ({
      click: (mid: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) =>
        live.current.onRowClick(mid, e),
      lock: (mid: number, locked: boolean) => void live.current.doLock([mid], !locked),
      moveTo: (mid: number, p: number) => void live.current.doMove([mid], p),
    }),
    [],
  )

  const onDragStart = (e: DragStartEvent) => setDragId(Number(e.active.id))
  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null)
    if (!e.over) return
    // active is always a mod (dividers aren't draggable); over may be a mod OR a
    // `sep-<id>` divider. resolveDrop works in the combined space and derives the
    // destination band from the divider above the block's new spot.
    const r = resolveDrop(dropCells, Number(e.active.id), e.over.id, sel.selected)
    if (!r) return
    void doMove(r.ids, r.position, r.separatorId)
  }

  const dragName = dragId !== null ? data.names.get(dragId) : ''

  const groupIds = Object.keys(data.buckets)
    .map(Number)
    .sort((a, b) => a - b)

  return (
    <section>
      <p className="dim" style={{ marginBottom: 8 }}>
        Loose MO2 left-panel install order (bottom overwrites above). Drag the ≡ handle to reorder — dragging a
        selected row moves the whole selection. Click rows to toggle them into the selection, shift ranges, click
        empty space to clear. Click a position number to type an exact position.
      </p>

      {data.error && <p className="c-red">{data.error}</p>}

      <ResizablePanel storageKey="ordering" className="toolgroup" initial={260} min={140}>
        <div className="toolgroup-h">
          <span className="toolgroup-label">Ordering</span>
          <span className="dim" style={{ fontSize: 12 }}>
            Sort generates the whole order: every mod into its separator band, family-clustered, real cross-band
            conflicts auto-pinned. Claude refine + collection rules layer on top. These actually move mods.
          </span>
        </div>
        <OrderToolbar
          model={jobs.model}
          onModel={jobs.setModel}
          refining={data.refining}
          enforcing={jobs.enforcing}
          committed={data.committed}
          onSort={runSortAndRefresh}
          onRefine={() => void jobs.refineOrStop()}
          onRefineUncertain={() => void jobs.runDesc()}
          onEnforce={() => void jobs.runEnforce()}
        />

        <Subtabs
          tabs={[
            { id: 'heuristic', label: 'Sort' },
            {
              id: 'bulk',
              label: 'Refine with Claude',
              count: data.notes.filter((n) => !jobs.dismissed.notes.keys.has(n)).length || undefined,
            },
            { id: 'desc', label: 'Refine uncertain' },
            { id: 'rules', label: 'Collection rules' },
          ]}
        >
          {(active) => (
            <>
              {active === 'heuristic' && (
                <div>
                  <div className="dim">{jobs.heuristicLog}</div>
                  <ConflictDetail
                    selected={[...sel.selected]}
                    relations={relations}
                    names={data.names}
                    onJump={jumpToMod}
                  />
                </div>
              )}
              {active === 'bulk' && (
                <div>
                  <div className="dim">
                    {jobs.bulkMsg} <RestoreDismissed d={jobs.dismissed.notes} />
                  </div>
                  <NotesList notes={data.notes} d={jobs.dismissed.notes} names={data.names} onJump={jumpToMod} />
                </div>
              )}
              {active === 'desc' && <div className="dim">{jobs.descMsg}</div>}
              {active === 'rules' && (
                <div>
                  <div className="dim">
                    {jobs.enforceMsg} <RestoreDismissed d={jobs.dismissed.rules} />
                  </div>
                  {jobs.enforceLog.length > 0 && (
                    <ul className="dim dismiss-list">
                      {jobs.enforceLog
                        .filter((e) => !jobs.dismissed.rules.keys.has(e))
                        .map((e, i) => (
                          <li key={i}>
                            <DismissX onDismiss={() => jobs.dismissed.rules.dismiss(e)} />
                            {e}
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </Subtabs>
      </ResizablePanel>

      <ResizablePanel storageKey="tools" className="toolgroup" style={{ marginTop: 10 }} initial={300} min={140}>
        <div className="toolgroup-h">
          <span className="toolgroup-label">Tools</span>
          <span className="dim" style={{ fontSize: 12 }}>
            Pull MO2's live order as the starting point or push this order back to MO2; flag missing Nexus
            requirements (read-only); hide already-installed archives or commit the order to disk (both rename/move
            files).
          </span>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <button
            className="btn ghost"
            disabled={jobs.syncing}
            title="Checks each mod's own real Nexus requirements — not a guess — and flags any that aren't in your library"
            onClick={() => void jobs.runSync()}
          >
            Sync requirements
          </button>
          <button
            className="btn ghost"
            disabled={jobs.pulling || jobs.pushing || frozen}
            title="Read the active MO2 profile's modlist.txt + installed folders and set this list's order + install-state to match. Auto-runs once on first load; re-run after changing mods in MO2. Read-only for MO2."
            onClick={() => setConfirmPull(true)}
          >
            {jobs.pulling ? 'Pulling…' : 'Pull from MO2'}
          </button>
          <button
            className="btn ghost"
            disabled={jobs.pushing || jobs.pulling || frozen}
            title="Write this list's order back out to the active MO2 profile's modlist.txt. Reorders the mods MO2 has to match the tool; separators, tool outputs and DLC/CC lines stay put; a timestamped backup is taken first. Close MO2 before pushing."
            onClick={() => setConfirmPush(true)}
          >
            {jobs.pushing ? 'Pushing…' : 'Push to MO2'}
          </button>
          {(jobs.pullMsg || jobs.pushMsg) && (
            <span className="dim" style={{ fontSize: 12 }}>
              {jobs.pushing || jobs.pushMsg ? jobs.pushMsg : jobs.pullMsg}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <label
            className="switch-label"
            title="Move archives already installed in MO2 (per their .meta) into downloads/installed/ so MO2's Downloads tab only shows what's left to install. Toggle off to move them back. Names (and any install-order prefix) are untouched."
          >
            <input
              type="checkbox"
              className="switch"
              checked={data.hidden}
              disabled={jobs.committing || jobs.hiding}
              onChange={(e) => void jobs.runHideInstalled(e.target.checked)}
            />
            Hide installed mods
          </label>
          <button
            className={`btn${data.committed ? '' : ' ghost'}`}
            style={data.committed ? { background: '#7f1d1d' } : undefined}
            // refining: ranks are being rewritten — committing now would
            // freeze a mid-refine order onto the filenames (backend also 409s)
            disabled={jobs.committing || data.refining}
            title={
              data.committed
                ? 'Files are renamed on disk with install-order prefixes and reordering is frozen. Click to rename them back to their original names.'
                : 'Physically rename every downloaded archive on disk with a zero-padded install-order prefix (0001__…) so they sort in install order for MO2. Freezes reordering and blocks downloads until reverted.'
            }
            onClick={() => setConfirmCommit(true)}
          >
            {data.committed ? '🔒 Committed to disk — click to revert' : 'Commit order to disk'}
          </button>
        </div>
        {jobs.commitMsg && (
          <div className={jobs.commitError ? 'c-red' : 'dim'} style={{ marginTop: 8 }}>
            {jobs.commitError ? `Commit failed — ${jobs.commitMsg}` : jobs.commitMsg}
          </div>
        )}
        <Subtabs
          tabs={[
            {
              id: 'requirements',
              label: 'Missing Requirements',
              count:
                jobs.missing.filter(
                  (m) =>
                    !jobs.dismissed.requirements.keys.has(requirementKey(m)) &&
                    !jobs.dismissed.requirementMods.keys.has(String(m.requires_mod_id)),
                ).length || undefined,
            },
            { id: 'substitutes', label: 'Substitutes', count: subCount || undefined },
          ]}
        >
          {(active) => (
            <>
              {active === 'requirements' && (
                <RequirementsView
                  msg={jobs.reqMsg}
                  missing={jobs.missing}
                  d={jobs.dismissed.requirements}
                  ridD={jobs.dismissed.requirementMods}
                  onJump={jumpToMod}
                />
              )}
              {active === 'substitutes' && (
                <SubstitutesView
                  pairD={jobs.dismissed.requirements}
                  ridD={jobs.dismissed.requirementMods}
                  onCountChange={setSubCount}
                />
              )}
            </>
          )}
        </Subtabs>
      </ResizablePanel>

      <div className="searchwrap" ref={searchWrapRef} style={{ margin: '12px 0 0' }}>
        <input
          type="text"
          placeholder="Search mod name or id…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="toolbar" style={{ marginTop: 12 }}>
        <span className="dim" style={{ fontSize: 12 }}>
          Filter:
        </span>
        <select aria-label="filter category" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All categories</option>
          {data.categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select aria-label="filter group" value={grp} onChange={(e) => setGrp(e.target.value)}>
          <option value="">All groups</option>
          <option value="none">? · Unsorted</option>
          {groupIds.map((g) => (
            <option key={g} value={g}>
              {g} · {data.buckets[g] || '?'}
            </option>
          ))}
        </select>
        {visible.length < data.mods.length && (
          <span className="dim">
            ({visible.length} of {data.mods.length} shown)
          </span>
        )}
        <button
          className="btn ghost"
          style={{ marginLeft: 'auto' }}
          disabled={!separators.length}
          title="Collapse every band"
          onClick={() => setCollapsedBands(new Set(separators.map((s) => s.id)))}
        >
          Collapse all
        </button>
        <button
          className="btn ghost"
          disabled={!collapsedBands.size}
          title="Expand every band"
          onClick={() => setCollapsedBands(new Set())}
        >
          Expand all
        </button>
      </div>

      <HighlightBar
        hl={hl}
        counts={hlCounts}
        onToggle={toggleHl}
        onClear={(k) => void clearHl(k)}
        showLocked={showLocked}
        onToggleLocked={() => setShowLocked((v) => !v)}
        lockedCount={lockedCount}
      />

      <SelectionToolbar
        count={sel.selected.size}
        separators={separators}
        buckets={data.buckets}
        mods={data.mods}
        selected={sel.selected}
        disabled={frozen}
        onLock={(locked) => void doLock([...sel.selected], locked)}
        // bulk moves (Move / Change group / Change separator) are one-shot: the
        // rows land at their target, so keeping them selected only invites an
        // accidental second move — clear right away (the optimistic reorder ran)
        onMoveTo={(p) => {
          void doMove([...sel.selected], p)
          sel.clear()
        }}
        // Change separator: drop the selection at the END of the chosen band. A
        // position past the list clamps to its tail, and move()'s band regroup
        // then slots them into that band. Refresh separators so the new band's
        // count reflects the move.
        onMoveToSeparator={(sepId) => {
          void doMove([...sel.selected], data.mods.length + 1, sepId).then(loadSeparators)
          sel.clear()
        }}
        onDelete={() => setConfirmDelete(true)}
        onClear={sel.clear}
      />

      {jobs.msg && (
        <div className="dim" style={{ marginTop: 8 }}>
          {jobs.msg}
        </div>
      )}

      {visible.length ? (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
            <div className="ordwrap">
            <div
              role="table"
              className="ordtable"
              onClick={(e) => {
                // click on empty space (not a row / interactive el) clears selection
                if (!(e.target as Element).closest('.ordrow, .band-divider, button, a, input, select')) sel.clear()
              }}
            >
              <div className="ordtable-head" role="row">
                <div role="columnheader"></div>
                <div className="poshead" role="columnheader">
                  <button
                    className={`lockbtn${allLocked ? ' on' : ''}`}
                    disabled={frozen || !data.mods.length}
                    title={allLocked ? 'all pinned — click to unpin every mod' : 'pin every mod at its current position'}
                    onClick={() =>
                      void doLock(
                        data.mods.map((mm) => mm.mod_id),
                        !allLocked,
                      )
                    }
                  >
                    {allLocked ? '🔒' : '🔓'}
                  </button>
                  <span>Order</span>
                </div>
                <div role="columnheader">Mod</div>
                <div className="num" role="columnheader">Mod ID</div>
                <div className="hide-sm" role="columnheader">Category</div>
                <div className="num" role="columnheader">Group</div>
              </div>
              <div ref={listRef} style={{ position: 'relative', height: rowVirtualizer.getTotalSize() }}>
                {rowVirtualizer.getVirtualItems().map((vRow) => {
                  const item = combined[vRow.index]
                  if (!item) return null
                  const wrap = (children: ReactNode, key: Key) => (
                    <div
                      key={key}
                      data-index={vRow.index}
                      // NO measureElement ref: row/divider heights are fixed and
                      // already exact via estimateSize (SEP_ROW_H/MOD_ROW_H match
                      // the CSS). Attaching the async measure pass here is what let
                      // a lagging re-measure stack a row over a divider mid-scroll.
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${vRow.start - rowVirtualizer.options.scrollMargin}px)`,
                      }}
                    >
                      {children}
                    </div>
                  )
                  if (item.kind === 'sep') {
                    const sep = sepById.get(item.sepId)
                    return wrap(
                      <BandDivider
                        sepId={item.sepId}
                        name={sep?.name}
                        specialKind={sep?.special_kind}
                        collapsed={collapsedBands.has(item.sepId)}
                        count={sep?.mod_count}
                        onToggle={toggleBand}
                      />,
                      `sep-${item.sepId}`,
                    )
                  }
                  const r = item.row
                  return wrap(
                    <OrderRow
                      mod={r.mod}
                      pos={r.pos}
                      names={data.names}
                      buckets={data.buckets}
                      hl={hl}
                      selected={sel.selected.has(r.mod.mod_id)}
                      justChanged={jobs.justChanged.has(r.mod.mod_id)}
                      overwritesCount={relations[String(r.mod.mod_id)]?.overwrites.length ?? 0}
                      overwrittenCount={relations[String(r.mod.mod_id)]?.overwritten_by.length ?? 0}
                      conflictTint={conflictTint.get(r.mod.mod_id)}
                      disabled={frozen}
                      onRowClick={rowHandlers.click}
                      onToggleLock={rowHandlers.lock}
                      onMoveTo={rowHandlers.moveTo}
                    />,
                    r.mod.mod_id,
                  )
                })}
              </div>
            </div>
            </div>
          </SortableContext>
          {/* dropAnimation=null: the row already reflects its final position
              (reorderLocal ran synchronously in onDragEnd/doMove) by the time
              this unmounts, so animating the overlay back to a DOM position
              would just be motion for its own sake. */}
          <DragOverlay dropAnimation={null}>
            {dragId !== null && (
              <div className="dragoverlay">{blockDrag ? `${sel.selected.size} mods` : dragName}</div>
            )}
          </DragOverlay>
        </DndContext>
      ) : (
        <p className="dim" style={{ marginTop: 14 }}>
          {data.mods.length ? 'No mods match the filter.' : 'Library empty.'}
        </p>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${sel.selected.size} mod(s)?`}
        description="Removes every downloaded file of the selected mod(s) from disk. The library keeps the records (marked deleted), so they won't resurface as new on the next import."
        confirmLabel="Delete"
        danger
        onConfirm={() => void doDelete()}
      />

      <ConfirmDialog
        open={confirmPull}
        onOpenChange={setConfirmPull}
        title="Pull install order from MO2?"
        description="Reads the active MO2 profile and overwrites this list's order + install-state to match MO2's. Any reordering you've done here that you haven't pushed back will be replaced. Read-only for MO2 — nothing on MO2's side changes."
        confirmLabel="Pull"
        onConfirm={() => void jobs.runPull()}
      />

      <ConfirmDialog
        open={confirmPush}
        onOpenChange={setConfirmPush}
        title="Push install order to MO2?"
        description="Rewrites the active MO2 profile's modlist.txt so its mods sit in this list's order. Separators, tool outputs and DLC/CC lines are preserved; a timestamped backup is taken first. Close Mod Organizer before pushing — it overwrites modlist.txt when it exits."
        confirmLabel="Push"
        danger
        onConfirm={() => void jobs.runPush()}
      />

      <ConfirmDialog
        open={confirmCommit}
        onOpenChange={setConfirmCommit}
        title={data.committed ? 'Revert install order on disk?' : 'Commit install order to disk?'}
        description={
          data.committed
            ? 'Renames every archive back to its original filename and unfreezes reordering. Downloads are re-enabled afterward.'
            : 'Physically renames every downloaded archive (and its MO2 .meta) to add a zero-padded install-order prefix, e.g. 0001__ModName. Reordering is frozen and downloads are blocked until you revert. MO2 tracks downloads by name, so this will rename them in MO2 too.'
        }
        confirmLabel={data.committed ? 'Revert' : 'Commit'}
        danger
        onConfirm={() => (data.committed ? void jobs.runUncommit() : void jobs.runCommit())}
      />

      {(jobs.committing || jobs.hiding) && (
        <LoadingOverlay
          message={
            jobs.hiding
              ? data.hidden
                ? 'Moving archives back…'
                : 'Moving installed archives…'
              : data.committed
                ? 'Restoring original filenames…'
                : 'Renaming files on disk…'
          }
          detail="Do not close this tab until it finishes."
        />
      )}
    </section>
  )
}
