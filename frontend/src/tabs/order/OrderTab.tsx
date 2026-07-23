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
import { resolveMove } from './lib/moveIntent'
import { type VisibleRow } from './lib/runs'
import { OrderRow } from './OrderRow'
import { OrderToolbar } from './OrderToolbar'
import type { Separator } from '../../api/types'
import { HighlightBar } from './HighlightBar'
import { ALL_HIGHLIGHTS_ON, CLEARABLE_FLAG_KIND, flagCategory, type HighlightKey } from './lib/highlights'
import { SelectionToolbar } from './SelectionToolbar'
import { Subtabs } from './subtabs/Subtabs'
import { ConflictsView, conflictKey } from './subtabs/ConflictsView'
import { RequirementsView, requirementKey } from './subtabs/RequirementsView'
import { DriftView, type DriftEntry } from './subtabs/DriftView'
import { Mo2View, mo2Key } from './subtabs/Mo2View'
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
const SEP_ROW_H = 46

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
  const [hl, setHl] = useState(ALL_HIGHLIGHTS_ON)
  const [showLocked, setShowLocked] = useState(true)
  const [dragId, setDragId] = useState<number | null>(null)
  const [confirmCommit, setConfirmCommit] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const mo2WrongIds = useMemo(
    () =>
      new Set(
        jobs.mo2.out_of_order
          .filter((e) => !jobs.dismissed.mo2.keys.has(mo2Key('out', e)))
          .map((e) => e.mod_id)
          .filter((x): x is number => x != null),
      ),
    [jobs.mo2, jobs.dismissed.mo2.keys],
  )

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
  const [assigning, setAssigning] = useState(false)
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

  const toggleBand = (id: number) => {
    setCollapsedBands((prev) => {
      const next = new Set(prev)
      const willCollapse = !next.has(id)
      willCollapse ? next.add(id) : next.delete(id)
      void api.collapseSeparator(id, willCollapse).catch(() => {})
      return next
    })
  }

  const assignBands = async () => {
    setAssigning(true)
    try {
      const r = await api.assignSeparators()
      jobs.setMsg(`assigned ${r.assigned} mod(s) to separator bands`)
      loadSeparators()
      await data.reload()
    } catch (e) {
      jobs.setMsg(errText(e))
    } finally {
      setAssigning(false)
    }
  }

  // Organise into bands once per mount, after any pull settles — so the order
  // is always band-grouped (contiguous dividers) without a manual click.
  // assign+rerank is idempotent and preserves manual within/cross-band moves,
  // so running it on tab entry just re-enforces the invariant. Skipped while
  // committed (frozen) or a pull is still in flight.
  const autoAssignedRef = useRef(false)
  useEffect(() => {
    if (autoAssignedRef.current || jobs.pulling || assigning || data.committed) return
    if (data.mods.length === 0) return
    autoAssignedRef.current = true
    void assignBands()
    // assignBands is stable enough for this one-shot guard; deps intentionally minimal
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.mods, jobs.pulling, assigning, data.committed])

  // Resolve the drift check's {mod_id → expected bucket} map against the
  // order cache so the panel can list the drifted mods by name/position.
  const driftEntries: DriftEntry[] = useMemo(
    () =>
      data.mods.flatMap((m, i) =>
        jobs.wrongById.has(m.mod_id)
          ? [
              {
                pos: i + 1,
                mod_id: m.mod_id,
                mod_name: m.mod_name,
                bucket: m.bucket,
                expected: jobs.wrongById.get(m.mod_id) ?? null,
              },
            ]
          : [],
      ),
    [data.mods, jobs.wrongById],
  )

  // × on a chip: drift is session state (just reset the check result); the
  // rest are stored mod_sort flags — strip them in the db, then reload.
  const clearHl = async (key: HighlightKey) => {
    const kind = CLEARABLE_FLAG_KIND[key]
    if (!kind) {
      jobs.clearDrift()
      return
    }
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
  // Hiding locked rows is just another filter: positions stay global (i+1 over
  // the full list), so a move onto a visible row still lands at that mod's real
  // rank — locked rows keep their place relative to the moved block.
  const visibleAll: VisibleRow[] = useMemo(
    () =>
      data.mods
        .map((mod, i) => ({ mod, pos: i + 1 }))
        .filter((r) => matchesFilter(r.mod, cat, grp, q) && (showLocked || !r.mod.locked)),
    [data.mods, cat, grp, q, showLocked],
  )

  const lockedCount = useMemo(() => data.mods.filter((m) => m.locked).length, [data.mods])

  // How many rows each highlight would tag right now — shown on the chips so
  // an empty pass reads as (0) instead of a chip that does nothing.
  const hlCounts = useMemo(() => {
    const c: Record<HighlightKey, number> = { conflict: 0, duplicate: 0, moved: 0, uncertain: 0, drift: 0 }
    for (const mod of data.mods) {
      const cats = new Set<HighlightKey>()
      for (const f of mod.flags || []) {
        const k = flagCategory(f)
        if (k) cats.add(k)
      }
      if (jobs.justChanged.has(mod.mod_id)) cats.add('moved')
      for (const k of cats) c[k]++
    }
    c.drift = jobs.wrongById.size
    return c
  }, [data.mods, jobs.justChanged, jobs.wrongById])
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

  // Combined render list: separator dividers interleaved with the (band-grouped)
  // mod rows — one draggable order, MO2-style. A divider is emitted at each band
  // boundary; a collapsed band keeps its divider but drops its mod rows.
  const combined = useMemo(() => {
    const out: ({ kind: 'sep'; sepId: number } | { kind: 'mod'; row: VisibleRow })[] = []
    let prev: number | null | undefined
    for (const row of visible) {
      const sid = row.mod.separator_id
      if (sid != null && sid !== prev) out.push({ kind: 'sep', sepId: sid })
      prev = sid
      if (sid != null && collapsedBands.has(sid)) continue // band collapsed: hide its mods
      out.push({ kind: 'mod', row })
    }
    return out
  }, [visible, collapsedBands])

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

  // Stable reference: SortableContext re-derives its internal `items` off this
  // array's identity, not its contents — an inline `.map()` here would hand it
  // a new array (and force that recompute) on every OrderTab re-render for any
  // unrelated reason (job polling, a message update) while a drag is in flight.
  const visibleIds = useMemo(
    () => combined.flatMap((it) => (it.kind === 'mod' ? [it.row.mod.mod_id] : [])),
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
    // async measure pass: separator dividers are a FIXED 46px (see .band-divider
    // in css), mod rows a fixed single-line ~35.5px. A single flat estimate made
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
    data.reorderLocal(ids, position)
    try {
      const r = await api.orderMove(ids, position, separatorId)
      jobs.setMsg(`moved ${ids.length > 1 ? ids.length + ' mods ' : ''}to #${r.position}`)
      if (jobs.wrongById.size) await jobs.checkDrift(true) // keep drift highlights fresh
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
    const intent = resolveMove(Number(e.active.id), Number(e.over.id), sel.selected, data.mods)
    if (!intent) return
    // dropping onto a mod joins that mod's band — this is how a drag across a
    // divider re-bands the moved mod(s).
    const overMod = data.mods.find((m) => m.mod_id === Number(e.over!.id))
    void doMove(intent.ids, intent.position, overMod?.separator_id ?? null)
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

      <div className="toolgroup">
        <div className="toolgroup-h">
          <span className="toolgroup-label">Ordering</span>
          <span className="dim" style={{ fontSize: 12 }}>
            Places mods into STEP groups and orders them — heuristic first, Claude refine + collection rules on top.
            These actually move mods.
          </span>
        </div>
        <OrderToolbar
          model={jobs.model}
          onModel={jobs.setModel}
          refining={data.refining}
          enforcing={jobs.enforcing}
          committed={data.committed}
          onSort={() => void jobs.runSort(false)}
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
              {active === 'heuristic' && <div className="dim">{jobs.heuristicLog}</div>}
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
      </div>

      <div className="toolgroup" style={{ marginTop: 10 }}>
        <div className="toolgroup-h">
          <span className="toolgroup-label">MO2 sync</span>
          <span className="dim" style={{ fontSize: 12 }}>
            Import MO2's live install order + enabled/disabled state as the starting point. Auto-runs once on
            first load; re-run after changing mods in MO2. Rewrites this list's order — MO2 is never modified.
          </span>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <button
            className="btn ghost"
            disabled={jobs.pulling || frozen}
            title="Read the active MO2 profile's modlist.txt + installed folders and set this list's order + install-state to match. Read-only for MO2."
            onClick={() => void jobs.runPull()}
          >
            {jobs.pulling ? 'Pulling…' : 'Pull from MO2'}
          </button>
          {jobs.pullMsg && (
            <span className="dim" style={{ fontSize: 12 }}>
              {jobs.pullMsg}
            </span>
          )}
        </div>
      </div>

      <div className="toolgroup" style={{ marginTop: 10 }}>
        <div className="toolgroup-h">
          <span className="toolgroup-label">Grouping</span>
          <span className="dim" style={{ fontSize: 12 }}>
            Separator bands (STEP-style) appear as collapsible dividers inline in the order below. Organise groups
            mods by their Nexus category band; drag a mod under a different divider to re-band it.
          </span>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <button
            className="btn ghost"
            disabled={assigning || frozen}
            title="Assign each mod to its separator band (from its Nexus category) and group the order by band. Unmapped/uncategorised mods land in NEW & UNSORTED."
            onClick={() => void assignBands()}
          >
            {assigning ? 'Organising…' : 'Organise into bands'}
          </button>
          <button
            className="btn ghost"
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
      </div>

      <div className="toolgroup" style={{ marginTop: 10 }}>
        <div className="toolgroup-h">
          <span className="toolgroup-label">Analysis</span>
          <span className="dim" style={{ fontSize: 12 }}>
            Real (not guessed) data pulled in from archives/Nexus, plus checking the order itself — all read-only,
            never moves a mod by itself.
          </span>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <button
            className="btn ghost"
            disabled={jobs.scanning}
            title="Lists every downloaded archive's actual file paths (via 7z) and finds real overlaps between mods — not a guess"
            onClick={() => void jobs.runScan()}
          >
            Scan archives
          </button>
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
            disabled={data.refining}
            title="Flags mods whose current group disagrees with where the last Sort/Refine placed them — i.e. a manual drag or move drifted them out of the sorter's group. Each flag names the group the sorter expected."
            onClick={() => void jobs.checkDrift(false)}
          >
            Check for drift
          </button>
          <button
            className="btn ghost"
            disabled={!data.committed || data.refining}
            title={
              data.committed
                ? "Compares your install list against what MO2 actually has installed and enabled on disk (modlist.txt order). Flags mods out of order, installed-but-not-listed, and listed-but-not-installed."
                : 'Commit the install order to disk first — only then does MO2 see this order to compare against.'
            }
            onClick={() => void jobs.checkMo2()}
          >
            Check vs MO2 order
          </button>
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
              id: 'conflicts',
              label: 'Conflicts',
              count:
                jobs.conflicts.pairs.filter((p) => !p.expected && !jobs.dismissed.conflicts.keys.has(conflictKey(p)))
                  .length || undefined,
            },
            {
              id: 'requirements',
              label: 'Requirements',
              count: jobs.missing.filter((m) => !jobs.dismissed.requirements.keys.has(requirementKey(m))).length || undefined,
            },
            { id: 'drift', label: 'Check for drift', count: jobs.wrongById.size || undefined },
            {
              id: 'mo2',
              label: 'vs MO2',
              count:
                jobs.mo2.out_of_order.filter((e) => !jobs.dismissed.mo2.keys.has(mo2Key('out', e))).length || undefined,
            },
          ]}
        >
          {(active) => (
            <>
              {active === 'conflicts' && (
                <ConflictsView
                  msg={jobs.scanMsg}
                  pairs={jobs.conflicts.pairs}
                  d={jobs.dismissed.conflicts}
                  onJump={jumpToMod}
                />
              )}
              {active === 'requirements' && (
                <RequirementsView
                  msg={jobs.reqMsg}
                  missing={jobs.missing}
                  d={jobs.dismissed.requirements}
                  onJump={jumpToMod}
                />
              )}
              {active === 'drift' && (
                <DriftView msg={jobs.driftMsg} entries={driftEntries} buckets={data.buckets} onJump={jumpToMod} />
              )}
              {active === 'mo2' && <Mo2View msg={jobs.mo2Msg} mo2={jobs.mo2} d={jobs.dismissed.mo2} />}
            </>
          )}
        </Subtabs>
      </div>

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
        buckets={data.buckets}
        mods={data.mods}
        selected={sel.selected}
        disabled={frozen}
        onLock={(locked) => void doLock([...sel.selected], locked)}
        // bulk moves (Top/Bottom/Move/group) are one-shot: the rows land at
        // their target, so keeping them selected only invites an accidental
        // second move — clear right away (the optimistic reorder already ran)
        onMoveTo={(p) => {
          void doMove([...sel.selected], p)
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
                <div role="columnheader">#</div>
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
                      ref={rowVirtualizer.measureElement}
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
                    const isCol = collapsedBands.has(item.sepId)
                    return wrap(
                      <button
                        className={`band-divider${sep?.special_kind ? ` band-${sep.special_kind}` : ''}`}
                        onClick={() => toggleBand(item.sepId)}
                        title="click to collapse/expand this band"
                      >
                        <span className="band-caret">{isCol ? '▸' : '▾'}</span>
                        <span className="band-name">{sep?.name ?? item.sepId}</span>
                        <span className="band-count">{sep?.mod_count ?? ''}</span>
                      </button>,
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
                      wrongExpected={
                        hl.drift && jobs.wrongById.has(r.mod.mod_id) ? jobs.wrongById.get(r.mod.mod_id) : undefined
                      }
                      mo2Wrong={data.committed && mo2WrongIds.has(r.mod.mod_id)}
                      justChanged={jobs.justChanged.has(r.mod.mod_id)}
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
