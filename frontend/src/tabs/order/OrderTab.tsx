import { useMemo, useRef, useState } from 'react'
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
import { api } from '../../api/endpoints'
import { useRowSelection } from '../library/useRowSelection'
import { useOrderData, matchesFilter, errText } from './hooks/useOrderData'
import { useOrderJobs } from './hooks/useOrderJobs'
import { resolveMove } from './lib/moveIntent'
import { type VisibleRow } from './lib/runs'
import { OrderRow } from './OrderRow'
import { OrderToolbar } from './OrderToolbar'
import { HighlightBar } from './HighlightBar'
import { ALL_HIGHLIGHTS_ON, CLEARABLE_FLAG_KIND, flagCategory, type HighlightKey } from './lib/highlights'
import { SelectionToolbar } from './SelectionToolbar'
import { Subtabs } from './subtabs/Subtabs'
import { ConflictsView } from './subtabs/ConflictsView'
import { RequirementsView } from './subtabs/RequirementsView'
import { Mo2View } from './subtabs/Mo2View'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { LoadingOverlay } from '../../components/LoadingOverlay'

function NotesList({ notes }: { notes: string[] }) {
  const dupes = notes.filter((x) => x.toUpperCase().startsWith('DUPLICATE:'))
  const rest = notes.filter((x) => !x.toUpperCase().startsWith('DUPLICATE:'))
  return (
    <>
      {dupes.length > 0 && (
        <div className="grp">
          <h2>
            <span className="badge" style={{ background: '#3a1214', color: 'var(--red)' }}>
              Possible duplicate mods · {dupes.length}
            </span>
          </h2>
          <ul style={{ margin: '6px 0 0 20px' }} className="dim">
            {dupes.map((x, i) => (
              <li key={i}>{x.replace(/^duplicate:\s*/i, '')}</li>
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
          <ul style={{ margin: '6px 0 0 20px' }} className="dim">
            {rest.map((x, i) => (
              <li key={i}>{x}</li>
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
  const [hl, setHl] = useState(ALL_HIGHLIGHTS_ON)
  const [showLocked, setShowLocked] = useState(true)
  const [dragId, setDragId] = useState<number | null>(null)
  const [confirmCommit, setConfirmCommit] = useState(false)

  const mo2WrongIds = useMemo(
    () => new Set(jobs.mo2.out_of_order.map((e) => e.mod_id).filter((x): x is number => x != null)),
    [jobs.mo2],
  )

  const toggleHl = (key: HighlightKey) => setHl((h) => ({ ...h, [key]: !h[key] }))

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
  const visible: VisibleRow[] = useMemo(
    () =>
      data.mods
        .map((mod, i) => ({ mod, pos: i + 1 }))
        .filter((r) => matchesFilter(r.mod, cat, grp) && (showLocked || !r.mod.locked)),
    [data.mods, cat, grp, showLocked],
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
  const sel = useRowSelection(visible.map((r) => r.mod.mod_id))

  const visibleIndex = useMemo(() => new Map(visible.map((r, i) => [r.mod.mod_id, i])), [visible])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const doMove = async (ids: number[], position: number) => {
    if (frozen) return
    try {
      const r = await api.orderMove(ids, position)
      jobs.setMsg(`moved ${ids.length > 1 ? ids.length + ' mods ' : ''}to #${r.position}`)
      if (jobs.wrongById.size) await jobs.checkDrift(true) // keep drift highlights fresh
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
    const idx = visibleIndex.get(mid) ?? 0
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
    if (intent) void doMove(intent.ids, intent.position)
  }

  const blockDrag = dragId !== null && sel.selected.has(dragId) && sel.selected.size > 1
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
            { id: 'bulk', label: 'Refine with Claude', count: data.notes.length || undefined },
            { id: 'desc', label: 'Refine uncertain' },
            { id: 'rules', label: 'Collection rules' },
          ]}
        >
          {(active) => (
            <>
              {active === 'heuristic' && <div className="dim">{jobs.heuristicLog}</div>}
              {active === 'bulk' && (
                <div>
                  <div className="dim">{jobs.bulkMsg}</div>
                  <NotesList notes={data.notes} />
                </div>
              )}
              {active === 'desc' && <div className="dim">{jobs.descMsg}</div>}
              {active === 'rules' && (
                <div>
                  <div className="dim">{jobs.enforceMsg}</div>
                  {jobs.enforceLog.length > 0 && (
                    <ul style={{ margin: '6px 0 0 20px' }} className="dim">
                      {jobs.enforceLog.map((e, i) => (
                        <li key={i}>{e}</li>
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
            { id: 'conflicts', label: 'Conflicts', count: jobs.conflicts.pairs.filter((p) => !p.expected).length || undefined },
            { id: 'requirements', label: 'Requirements', count: jobs.missing.length || undefined },
            { id: 'drift', label: 'Check for drift', count: jobs.wrongById.size || undefined },
            { id: 'mo2', label: 'vs MO2', count: jobs.mo2.out_of_order.length || undefined },
          ]}
        >
          {(active) => (
            <>
              {active === 'conflicts' && <ConflictsView msg={jobs.scanMsg} pairs={jobs.conflicts.pairs} />}
              {active === 'requirements' && <RequirementsView msg={jobs.reqMsg} missing={jobs.missing} />}
              {active === 'drift' && <div className="dim">{jobs.driftMsg}</div>}
              {active === 'mo2' && <Mo2View msg={jobs.mo2Msg} mo2={jobs.mo2} />}
            </>
          )}
        </Subtabs>
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
        onMoveTo={(p) => void doMove([...sel.selected], p)}
        onClear={sel.clear}
      />

      {jobs.msg && (
        <div className="dim" style={{ marginTop: 8 }}>
          {jobs.msg}
        </div>
      )}

      {visible.length ? (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <SortableContext items={visible.map((r) => r.mod.mod_id)} strategy={verticalListSortingStrategy}>
            <div
              onClick={(e) => {
                // click on empty space (not a row / interactive el) clears selection
                if (!(e.target as Element).closest('tr.ordrow, button, a, input, select')) sel.clear()
              }}
            >
            <table>
              <thead>
                <tr>
                  <th style={{ width: 30 }}></th>
                  <th style={{ width: 70 }}>#</th>
                  <th>Mod</th>
                  <th className="num">Mod ID</th>
                  <th className="hide-sm">Category</th>
                  <th className="num">Group</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <OrderRow
                    key={r.mod.mod_id}
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
                  />
                ))}
              </tbody>
            </table>
            </div>
          </SortableContext>
          <DragOverlay>
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
