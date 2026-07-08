import { useMemo, useState } from 'react'
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
import { SelectionToolbar } from './SelectionToolbar'
import { Subtabs } from './subtabs/Subtabs'
import { ConflictsView } from './subtabs/ConflictsView'
import { RequirementsView } from './subtabs/RequirementsView'

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
  const [dragId, setDragId] = useState<number | null>(null)

  // Rank positions are absolute over the full list; filters only hide rows.
  const visible: VisibleRow[] = useMemo(
    () =>
      data.mods
        .map((mod, i) => ({ mod, pos: i + 1 }))
        .filter((r) => matchesFilter(r.mod, cat, grp)),
    [data.mods, cat, grp],
  )
  const sel = useRowSelection(visible.map((r) => r.mod.mod_id))

  const visibleIndex = useMemo(() => new Map(visible.map((r, i) => [r.mod.mod_id, i])), [visible])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const doMove = async (ids: number[], position: number) => {
    if (data.refining) return
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

      <OrderToolbar
        model={jobs.model}
        onModel={jobs.setModel}
        refining={data.refining}
        enforcing={jobs.enforcing}
        onSort={() => void jobs.runSort(false)}
        onRefine={() => void jobs.refineOrStop()}
        onRefineUncertain={() => void jobs.runDesc()}
        onEnforce={() => void jobs.runEnforce()}
        msg={jobs.msg}
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
        </div>
        <Subtabs
          tabs={[
            { id: 'conflicts', label: 'Conflicts', count: jobs.conflicts.pairs.filter((p) => !p.expected).length || undefined },
            { id: 'requirements', label: 'Requirements', count: jobs.missing.length || undefined },
            { id: 'drift', label: 'Check for drift', count: jobs.wrongById.size || undefined },
          ]}
        >
          {(active) => (
            <>
              {active === 'conflicts' && <ConflictsView msg={jobs.scanMsg} pairs={jobs.conflicts.pairs} />}
              {active === 'requirements' && <RequirementsView msg={jobs.reqMsg} missing={jobs.missing} />}
              {active === 'drift' && <div className="dim">{jobs.driftMsg}</div>}
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

      <SelectionToolbar
        count={sel.selected.size}
        buckets={data.buckets}
        mods={data.mods}
        disabled={data.refining}
        onLock={(locked) => void doLock([...sel.selected], locked)}
        onMoveTo={(p) => void doMove([...sel.selected], p)}
        onClear={sel.clear}
      />

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
                    selected={sel.selected.has(r.mod.mod_id)}
                    wrongExpected={jobs.wrongById.has(r.mod.mod_id) ? jobs.wrongById.get(r.mod.mod_id) : undefined}
                    justChanged={jobs.justChanged.has(r.mod.mod_id)}
                    disabled={data.refining}
                    onRowClick={(e) => onRowClick(r.mod.mod_id, e)}
                    onToggleLock={() => void doLock([r.mod.mod_id], !r.mod.locked)}
                    onMoveTo={(p) => void doMove([r.mod.mod_id], p)}
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
    </section>
  )
}
