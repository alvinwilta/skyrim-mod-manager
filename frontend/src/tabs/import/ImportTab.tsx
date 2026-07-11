import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { api } from '../../api/endpoints'
import { ApiError } from '../../api/client'
import type { DiffItem, DiffResult, FetchCollectionResult } from '../../api/types'
import { human } from '../../lib/format'
import { useRowSelection } from '../library/useRowSelection'

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e))

interface Group {
  title: string
  badgeCls: string
  rowCls?: string
  items: DiffItem[]
}

function toGroups(d: DiffResult): Group[] {
  return [
    { title: 'New', badgeCls: 'b-new', rowCls: 'r-new', items: d.new },
    { title: 'Updated — replaces your older file', badgeCls: 'b-upd', rowCls: 'r-upd', items: d.updated },
    { title: 'Downgrade — older than your file', badgeCls: 'b-down', rowCls: 'r-down', items: d.downgraded ?? [] },
    { title: 'Already downloaded', badgeCls: 'b-same', items: d.unchanged },
  ]
}

const DEFAULT_PLACEHOLDER = '{"data":{"collectionRevision":{"modFiles":[…]}}}'

// Module-level cache (same pattern as PromptEditor): tabs unmount on switch,
// and downloading auto-jumps to Progress — without this a fetched collection
// diff was gone, so downloading a subset then coming back for the rest meant
// re-fetching everything.
const cache: {
  url: string
  diff: DiffResult | null
  modlist: unknown
  collection: FetchCollectionResult['collection']
  placeholder: string
  selected: number[] | null
} = { url: '', diff: null, modlist: null, collection: null, placeholder: DEFAULT_PLACEHOLDER, selected: null }

/** Test hook — reset the module cache between tests. */
export const __resetImportCache = () => {
  cache.url = ''
  cache.diff = null
  cache.modlist = null
  cache.collection = null
  cache.placeholder = DEFAULT_PLACEHOLDER
  cache.selected = null
}

export function ImportTab({ onGoToProgress }: { onGoToProgress: () => void }) {
  const [url, setUrl] = useState(cache.url)
  const [jsonText, setJsonText] = useState('')
  const [jsonPlaceholder, setJsonPlaceholder] = useState(cache.placeholder)
  const [err, setErr] = useState('')
  const [fetching, setFetching] = useState(false)
  const [diff, setDiff] = useState<DiffResult | null>(cache.diff)
  const [modlist, setModlist] = useState<unknown>(cache.modlist)
  const [collection, setCollection] = useState<FetchCollectionResult['collection']>(cache.collection)

  const groups = useMemo(() => (diff ? toGroups(diff) : []), [diff])
  const allItems = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const sel = useRowSelection(allItems.map((i) => i.file_id))

  // restore the cached selection once on remount (before any user click)
  useEffect(() => {
    if (cache.selected) sel.replace(cache.selected)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // keep the cached selection current so a remount restores exactly it
  useEffect(() => {
    cache.selected = diff ? [...sel.selected] : null
  }, [sel.selected, diff])

  const showDiff = (d: DiffResult) => {
    setDiff(d)
    cache.diff = d
    // new + updated default-checked; downgrades and unchanged opt-in
    const ids = [...d.new, ...d.updated].map((i) => i.file_id)
    sel.replace(ids)
    cache.selected = ids
  }

  const doFetch = async () => {
    setErr('')
    const u = url.trim()
    if (!u) {
      setErr('paste a collection url first')
      return
    }
    setFetching(true)
    try {
      const d = await api.fetchCollection(u)
      setModlist(d.modlist)
      setCollection(d.collection)
      setJsonText('')
      setJsonPlaceholder(`fetched ${d.count} files from ${u}`)
      cache.modlist = d.modlist
      cache.collection = d.collection
      cache.placeholder = `fetched ${d.count} files from ${u}`
      showDiff(d.diff)
    } catch (e) {
      setErr(errText(e))
    } finally {
      setFetching(false)
    }
  }

  const doDiff = async () => {
    setErr('')
    let payload: unknown
    try {
      payload = JSON.parse(jsonText)
    } catch {
      setErr('invalid JSON')
      return
    }
    try {
      const d = await api.diff(payload)
      setModlist(payload)
      setCollection(null) // pasted/uploaded JSON has no known collection identity
      cache.modlist = payload
      cache.collection = null
      showDiff(d)
    } catch (e) {
      setErr(errText(e))
    }
  }

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) setJsonText(await f.text())
  }

  const doDownload = async () => {
    try {
      await api.download(modlist, [...sel.selected], collection?.id ?? null)
      onGoToProgress()
    } catch (e) {
      setErr(errText(e))
    }
  }

  const toggleGroup = (g: Group) => {
    const ids = g.items.map((i) => i.file_id)
    const anyUnchecked = ids.some((id) => !sel.selected.has(id))
    const next = new Set(sel.selected)
    for (const id of ids) {
      if (anyUnchecked) next.add(id)
      else next.delete(id)
    }
    sel.replace(next)
  }

  const selBytes = allItems.reduce((a, i) => a + (sel.selected.has(i.file_id) ? i.size : 0), 0)

  // running index across groups so shift-range spans group boundaries (legacy
  // rangeSelect was bound to the whole #diffout container)
  let flatIndex = -1

  return (
    <section>
      <p className="dim" style={{ marginBottom: 8 }}>
        Paste a collection URL or a single mod page URL to fetch straight from Nexus — or paste/upload a{' '}
        <code>modlist.json</code> below. Either way it is diffed against the local database; only new and updated
        files are selected by default. Downloading an updated (or downgraded) file replaces the older archive it
        supersedes.
      </p>
      <div className="toolbar" style={{ margin: '0 0 12px' }}>
        <input
          type="text"
          placeholder="…/collections/h2uqa3/mods or …/skyrimspecialedition/mods/32117"
          style={{ flex: 1, minWidth: 260 }}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            cache.url = e.target.value
          }}
        />
        <button className="btn" disabled={fetching} onClick={doFetch}>
          {fetching ? 'Fetching…' : 'Fetch from Nexus'}
        </button>
      </div>
      <textarea placeholder={jsonPlaceholder} value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
      <div className="toolbar">
        <input type="file" accept=".json" style={{ width: 'auto' }} onChange={onFile} aria-label="modlist file" />
        <button className="btn ghost" onClick={doDiff}>
          Diff against DB
        </button>
        <span className="c-red">{err}</span>
      </div>
      <div>
        {groups.map(
          (g) =>
            g.items.length > 0 && (
              <div className="grp" key={g.title}>
                <h2>
                  <span className={`badge ${g.badgeCls}`}>
                    {g.title} · {g.items.length}
                  </span>
                  <button
                    className="btn ghost"
                    style={{ padding: '2px 10px', fontSize: 12 }}
                    onClick={() => toggleGroup(g)}
                  >
                    toggle
                  </button>
                </h2>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 30 }}></th>
                      <th>Mod — File</th>
                      <th className="num">Version</th>
                      <th className="num">Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map((i) => {
                      flatIndex++
                      const idx = flatIndex
                      return (
                        <tr key={i.file_id} className={g.rowCls || ''}>
                          <td style={{ width: 30 }}>
                            <input
                              type="checkbox"
                              aria-label={`select ${i.name}`}
                              checked={sel.selected.has(i.file_id)}
                              onClick={(e) => sel.toggle(i.file_id, idx, e.shiftKey)}
                              onChange={() => {}}
                            />
                          </td>
                          <td>
                            {i.mod_name} <span className="dim">— {i.name}</span>
                          </td>
                          <td className="num">
                            {i.old_version && <span className="dim">{i.old_version} → </span>}
                            {i.version}
                          </td>
                          <td className="num dim">{human(i.size)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ),
        )}
      </div>
      {diff && (
        <div className="toolbar">
          <button className="btn" disabled={!sel.selected.size} onClick={doDownload}>
            Download selected
          </button>
          <span className="dim">
            {sel.selected.size} files · {human(selBytes)}
          </span>
        </div>
      )}
    </section>
  )
}
