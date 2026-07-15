import { useCallback, useEffect, useRef, useState } from 'react'
import { useStickyTop } from '../../hooks/useStickyTop'
import { api } from '../../api/endpoints'
import { ApiError } from '../../api/client'
import type { CollectionRef, Mod } from '../../api/types'
import { human } from '../../lib/format'
import { useDebounce } from '../../hooks/useDebounce'
import { usePoller } from '../../hooks/usePoller'
import { useActivity } from '../../events/EventsProvider'
import { useRowSelection } from './useRowSelection'
import { ConfirmDialog } from '../../components/ConfirmDialog'

function SourceBadges({ collections }: { collections: CollectionRef[] }) {
  if (!collections.length) return <>manual</>
  const shown = collections.slice(0, 2)
  const rest = collections.slice(2)
  return (
    // flex-wrap: two long badge names side by side otherwise force a ~350px
    // min column width, pushing the whole table past the centered 1200px main
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
      {shown.map((c) => (
        <span key={c.slug} className="badge b-same" title={c.slug}>
          {c.name || c.slug}
        </span>
      ))}
      {rest.length > 0 && (
        <span className="badge b-same" title={rest.map((c) => c.name || c.slug).join(', ')}>
          +{rest.length}
        </span>
      )}
    </span>
  )
}

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e))

function SortTh({
  label,
  dir,
  numeric,
  hideSm,
  onClick,
}: {
  label: string
  dir: 'asc' | 'desc' | null
  numeric?: boolean
  hideSm?: boolean
  onClick: () => void
}) {
  const cls = [numeric && 'num', hideSm && 'hide-sm'].filter(Boolean).join(' ') || undefined
  return (
    <th className={cls}>
      {label}{' '}
      <button
        className="btn ghost"
        style={{ padding: '0 4px', fontSize: 11, lineHeight: 1 }}
        aria-label={
          dir === 'asc' ? `${label}: sorted ascending, click for descending`
          : dir === 'desc' ? `${label}: sorted descending, click to clear`
          : `sort by ${label}`
        }
        onClick={onClick}
      >
        {dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '⇅'}
      </button>
    </th>
  )
}

export function LibraryTab({ onGoToProgress }: { onGoToProgress: () => void }) {
  const [q, setQ] = useState('')
  const debouncedQ = useDebounce(q, 250)
  const [allRows, setAllRows] = useState<Mod[]>([])
  const [showDeleted, setShowDeleted] = useState(false)
  const [hideInstalled, setHideInstalled] = useState(false)
  const [committed, setCommitted] = useState(false)
  const [msg, setMsg] = useState('')
  const [sort, setSort] = useState<{ key: keyof Mod; dir: 'asc' | 'desc' } | null>(null)
  const { downloading } = useActivity()

  // cycle: unsorted -> desc -> asc -> unsorted; clicking a different column starts it fresh at desc
  const toggleSort = (key: keyof Mod) =>
    setSort((prev) => (!prev || prev.key !== key ? { key, dir: 'desc' } : prev.dir === 'desc' ? { key, dir: 'asc' } : null))

  // "Show deleted" is an exclusive view: on = ONLY soft-deleted rows, off = only live rows.
  let rows = allRows.filter((r) => (showDeleted ? r.status === 'deleted' : r.status !== 'deleted'))
  if (hideInstalled) rows = rows.filter((r) => !r.installed)
  if (sort) {
    const { key, dir } = sort
    rows = [...rows].sort((a, b) => {
      const [av, bv] = [a[key], b[key]]
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
      return dir === 'asc' ? cmp : -cmp
    })
  }
  const nDeleted = allRows.filter((r) => r.status === 'deleted').length
  const nInstalled = allRows.filter((r) => r.installed).length
  const sel = useRowSelection(rows.map((r) => r.file_id))

  // stale-response guard: rapid query changes can resolve out of order — only
  // the newest load() may write state, or a slow old response overwrites a
  // newer one (empty search box showing filtered results)
  const loadSeq = useRef(0)
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const [rowsData, cs] = await Promise.all([api.mods(debouncedQ.trim() || undefined), api.orderCommitState()])
      if (seq !== loadSeq.current) return
      setAllRows(rowsData)
      setCommitted(cs.committed) // delete/redownload rename/remove files — unsafe while committed
    } catch (e) {
      if (seq !== loadSeq.current) return
      setMsg(errText(e))
    }
  }, [debouncedQ])

  useEffect(() => {
    sel.clear()
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  // "Show deleted" swaps the visible row set: a selection carried across the
  // toggle would silently keep targeting rows that are no longer shown —
  // worst case, live rows purged from the deleted-only view.
  useEffect(() => {
    sel.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDeleted, hideInstalled])

  // Legacy loadLibOnFinish(): refresh the library when a download job completes.
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !downloading) void load()
    wasRunning.current = downloading
  }, [downloading, load])

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
      // In the deleted-only view, "Delete" permanently purges the record from
      // the DB instead of soft-deleting an already-deleted row again.
      if (showDeleted) {
        const r = await api.purgeFiles(ids())
        setMsg(`${r.purged} record(s) purged · ${r.files_removed} file(s) removed from disk`)
      } else {
        const r = await api.deleteFiles(ids())
        setMsg(`${r.deleted} marked deleted · ${r.files_removed} file(s) removed from disk`)
      }
    } catch (e) {
      setMsg(errText(e))
    }
    sel.clear()
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

  // Adopt archives sitting in the downloads dir that aren't in the DB yet
  // (downloaded straight through MO2 or from other sites). Background job +
  // poller, since the Nexus metadata fetch is network-bound.
  const [importing, setImporting] = useState(false)
  const doImport = async () => {
    setMsg('scanning downloads for new files…')
    try {
      await api.importLocal()
      setImporting(true)
    } catch (e) {
      setMsg(errText(e))
    }
  }
  usePoller(
    async () => {
      try {
        const s = await api.importLocalState()
        setMsg(s.phase + (s.error ? ' — ' + s.error : ''))
        if (!s.running) {
          setImporting(false)
          await load()
          return false
        }
        return true
      } catch (e) {
        setMsg(errText(e))
        setImporting(false)
        return false
      }
    },
    1000,
    importing,
  )

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
            {showDeleted
              ? n
                ? `Purge (${n})`
                : 'Purge selected'
              : n
                ? `Delete (${n})`
                : 'Delete selected'}
          </button>
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={showDeleted ? `Permanently purge ${n} record(s)?` : `Delete ${n} file(s)?`}
            description={
              showDeleted
                ? "Permanently removes the record from the database (and the file from disk if any remains). This can't be undone; the mod will resurface as new on the next import."
                : "Removes the file(s) from disk. The library keeps the record (marked deleted), so they won't resurface as new on the next import."
            }
            confirmLabel={showDeleted ? 'Purge' : 'Delete'}
            danger
            onConfirm={() => void doDelete()}
          />
          <span style={{ width: 1, height: 22, background: 'var(--border)' }} />
          <button className="btn ghost" onClick={() => setShowDeleted((v) => !v)}>
            {showDeleted ? 'Hide deleted' : 'Show deleted'}
          </button>
          <button className="btn ghost" onClick={() => setHideInstalled((v) => !v)}>
            {hideInstalled ? 'Show installed' : 'Hide installed'}
          </button>
          <button
            className="btn ghost"
            disabled={importing || committed}
            title={
              committed
                ? 'Install order is committed to disk — revert it (Install Order tab) first'
                : 'Add archives already in the downloads folder (downloaded via MO2 or other sites) to the library'
            }
            onClick={doImport}
          >
            {importing ? 'Importing…' : 'Import from disk'}
          </button>
        </div>
        <div style={{ color: 'var(--text)', fontSize: 12, marginTop: 6 }}>
          {rows.length} {showDeleted ? 'deleted files' : 'files'}
          {!showDeleted && nDeleted ? ` (${nDeleted} deleted hidden)` : ''}
          {!showDeleted && hideInstalled && nInstalled ? ` (${nInstalled} installed hidden)` : ''}
        </div>
        <span className="dim">{msg}</span>
        {committed && (
          <div className="c-amber" style={{ marginTop: 6, fontSize: 12 }}>
            🔒 Install order is committed to disk — files are renamed with order prefixes. Delete and Redownload are
            disabled to protect the committed set; revert on the Install Order tab to re-enable them.
          </div>
        )}
      </div>
      <div className="tablewrap">
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
            <SortTh label="Mod" dir={sort?.key === 'mod_name' ? sort.dir : null} onClick={() => toggleSort('mod_name')} />
            <SortTh
              label="Mod ID"
              numeric
              dir={sort?.key === 'mod_id' ? sort.dir : null}
              onClick={() => toggleSort('mod_id')}
            />
            <SortTh label="File" dir={sort?.key === 'file_name' ? sort.dir : null} onClick={() => toggleSort('file_name')} />
            <th className="num">Version</th>
            <SortTh
              label="Author"
              hideSm
              dir={sort?.key === 'author' ? sort.dir : null}
              onClick={() => toggleSort('author')}
            />
            <SortTh
              label="Category"
              hideSm
              dir={sort?.key === 'category' ? sort.dir : null}
              onClick={() => toggleSort('category')}
            />
            <th className="hide-sm">Source</th>
            <SortTh
              label="Size"
              numeric
              dir={sort?.key === 'size_bytes' ? sort.dir : null}
              onClick={() => toggleSort('size_bytes')}
            />
            <SortTh
              label="Downloaded"
              numeric
              hideSm
              dir={sort?.key === 'downloaded_at' ? sort.dir : null}
              onClick={() => toggleSort('downloaded_at')}
            />
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
                {r.mod_url ? (
                  <a href={r.mod_url} target="_blank" style={{ color: 'inherit' }} rel="noreferrer">
                    {r.mod_name}
                  </a>
                ) : (
                  // non-Nexus adopted mods have no page; href="" would open a
                  // duplicate copy of this app
                  r.mod_name
                )}
              </td>
              <td className="num dim">{r.mod_id}</td>
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
      </div>
    </section>
  )
}
