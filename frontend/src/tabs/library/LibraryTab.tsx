import { useCallback, useEffect, useRef, useState } from 'react'
import { useStickyTop } from '../../hooks/useStickyTop'
import { api } from '../../api/endpoints'
import { ApiError } from '../../api/client'
import type { CollectionRef, Mod } from '../../api/types'
import { human } from '../../lib/format'
import { useDebounce } from '../../hooks/useDebounce'
import { useEvents } from '../../events/EventsProvider'
import { useRowSelection } from './useRowSelection'
import { ConfirmDialog } from '../../components/ConfirmDialog'

function SourceBadges({ collections }: { collections: CollectionRef[] }) {
  if (!collections.length) return <>manual</>
  const shown = collections.slice(0, 2)
  const rest = collections.slice(2)
  return (
    <>
      {shown.map((c) => (
        <span key={c.slug} className="badge b-same" title={c.slug}>
          {c.name || c.slug}
        </span>
      ))}{' '}
      {rest.length > 0 && (
        <span className="badge b-same" title={rest.map((c) => c.name || c.slug).join(', ')}>
          +{rest.length}
        </span>
      )}
    </>
  )
}

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e))

export function LibraryTab({ onGoToProgress }: { onGoToProgress: () => void }) {
  const [q, setQ] = useState('')
  const debouncedQ = useDebounce(q, 250)
  const [allRows, setAllRows] = useState<Mod[]>([])
  const [showDeleted, setShowDeleted] = useState(false)
  const [committed, setCommitted] = useState(false)
  const [msg, setMsg] = useState('')
  const { dl } = useEvents()

  const rows = showDeleted ? allRows : allRows.filter((r) => r.status !== 'deleted')
  const nDeleted = allRows.filter((r) => r.status === 'deleted').length
  const sel = useRowSelection(rows.map((r) => r.file_id))

  const load = useCallback(async () => {
    try {
      const [rowsData, cs] = await Promise.all([api.mods(debouncedQ.trim() || undefined), api.orderCommitState()])
      setAllRows(rowsData)
      setCommitted(cs.committed) // delete/redownload rename/remove files — unsafe while committed
    } catch (e) {
      setMsg(errText(e))
    }
  }, [debouncedQ])

  useEffect(() => {
    sel.clear()
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  // Legacy loadLibOnFinish(): refresh the library when a download job completes.
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !dl.running) void load()
    wasRunning.current = dl.running
  }, [dl.running, load])

  // Legacy setSticky(): pin the search bar right below the (wrappable) header.
  const wrapRef = useStickyTop<HTMLDivElement>()

  const ids = () => [...sel.selected]
  const n = sel.selected.size

  const doValidate = async () => {
    try {
      const r = await api.validate(ids())
      setMsg(`${r.ok.length} ok · ${r.fixed.length} size-fixed · ${r.missing.length} missing`)
    } catch (e) {
      setMsg(errText(e))
    }
    void load()
  }

  const [confirmDelete, setConfirmDelete] = useState(false)
  const doDelete = async () => {
    try {
      const r = await api.deleteFiles(ids())
      setMsg(`${r.deleted} marked deleted · ${r.files_removed} file(s) removed from disk`)
    } catch (e) {
      setMsg(errText(e))
    }
    void load()
  }

  const doRedownload = async () => {
    try {
      await api.redownload(ids())
      onGoToProgress()
    } catch (e) {
      setMsg(errText(e))
    }
  }

  return (
    <section>
      <div className="searchwrap" ref={wrapRef}>
        <input
          type="text"
          placeholder="Search name, author, category…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="toolbar" style={{ marginTop: 6 }}>
          <span className="dim">
            {rows.length} files{!showDeleted && nDeleted ? ` (${nDeleted} deleted hidden)` : ''}
          </span>
          <button className="btn ghost" disabled={!n} onClick={doValidate}>
            {n ? `Validate (${n})` : 'Validate selected'}
          </button>
          <button
            className="btn ghost"
            disabled={!n || committed}
            title={committed ? 'Install order is committed to disk — revert it (Install Order tab) first' : undefined}
            onClick={doRedownload}
          >
            {n ? `Redownload (${n})` : 'Redownload selected'}
          </button>
          <button
            className="btn ghost"
            disabled={!n || committed}
            title={committed ? 'Install order is committed to disk — revert it (Install Order tab) first' : undefined}
            style={{ color: 'var(--red)', borderColor: '#4a2226' }}
            onClick={() => setConfirmDelete(true)}
          >
            {n ? `Delete (${n})` : 'Delete selected'}
          </button>
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={`Delete ${n} file(s)?`}
            description="Removes the file(s) from disk. The library keeps the record (marked deleted), so they won't resurface as new on the next import."
            confirmLabel="Delete"
            danger
            onConfirm={() => void doDelete()}
          />
          <span style={{ width: 1, height: 22, background: 'var(--border)' }} />
          <button className="btn ghost" onClick={() => setShowDeleted((v) => !v)}>
            {showDeleted ? 'Hide deleted' : `Show deleted${nDeleted ? ` (${nDeleted})` : ''}`}
          </button>
          <span className="dim">{msg}</span>
        </div>
        {committed && (
          <div className="c-amber" style={{ marginTop: 6, fontSize: 12 }}>
            🔒 Install order is committed to disk — files are renamed with order prefixes. Delete and Redownload are
            disabled to protect the committed set; revert on the Install Order tab to re-enable them.
          </div>
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th style={{ width: 30 }}>
              <input
                type="checkbox"
                aria-label="select all"
                checked={sel.allSelected}
                onChange={(e) => sel.setAll(e.target.checked)}
              />
            </th>
            <th>Mod</th>
            <th>File</th>
            <th className="num">Version</th>
            <th className="hide-sm">Author</th>
            <th className="hide-sm">Category</th>
            <th className="hide-sm">Source</th>
            <th className="num">Size</th>
            <th className="num hide-sm">Downloaded</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.file_id} className={r.status === 'deleted' ? 'r-deleted' : ''}>
              <td>
                <input
                  type="checkbox"
                  className="libsel"
                  aria-label={`select ${r.file_name}`}
                  checked={sel.selected.has(r.file_id)}
                  onClick={(e) => sel.toggle(r.file_id, i, e.shiftKey)}
                  onChange={() => {}}
                />
              </td>
              <td>
                {r.status === 'missing' && (
                  <span className="badge" style={{ background: '#3a1214', color: 'var(--red)' }}>
                    missing{' '}
                  </span>
                )}
                {r.installed && (
                  <span className="badge" style={{ background: '#14351f', color: 'var(--green)' }}>
                    installed{' '}
                  </span>
                )}
                {r.status === 'deleted' && (
                  <span className="badge" style={{ background: '#232833', color: 'var(--dim)' }}>
                    deleted{' '}
                  </span>
                )}
                <a href={r.mod_url} target="_blank" style={{ color: 'inherit' }} rel="noreferrer">
                  {r.mod_name}
                </a>
              </td>
              <td className="dim">{r.file_name}</td>
              <td className="num">{r.file_version}</td>
              <td className="hide-sm dim">{r.author}</td>
              <td className="hide-sm dim">{r.category}</td>
              <td className="hide-sm dim">
                <SourceBadges collections={r.collections || []} />
              </td>
              <td className="num dim">{human(r.size_bytes)}</td>
              <td className="num hide-sm dim" title={r.downloaded_at}>
                {(r.downloaded_at || '').slice(0, 16)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
