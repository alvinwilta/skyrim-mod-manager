import { useEffect, useState } from 'react'
import { api } from '../../api/endpoints'
import { ApiError } from '../../api/client'
import type { Collection, CollectionMods } from '../../api/types'
import { GroupBadge } from '../order/GroupBadge'

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e))

function CollectionCard({
  c,
  onImportMods,
  onChanged,
}: {
  c: Collection
  onImportMods: (url: string) => void
  onChanged: () => void
}) {
  const [enabled, setEnabled] = useState(c.enabled)
  const [expanded, setExpanded] = useState(false)
  const [mods, setMods] = useState<CollectionMods | null>(null)
  const [removing, setRemoving] = useState(false)
  const [err, setErr] = useState('')

  const toggleEnabled = async (on: boolean) => {
    setEnabled(on) // optimistic; revert on failure
    try {
      await api.setCollectionEnabled(c.id, on)
    } catch (e) {
      setEnabled(!on)
      setErr(errText(e))
    }
  }

  const removeMods = async () => {
    setErr('')
    setRemoving(true)
    try {
      const p = await api.collectionRemovable(c.id)
      if (!p.removable) {
        setErr(p.shared ? `nothing exclusive to remove — all ${p.shared} downloaded mods are shared` : 'nothing to remove')
        return
      }
      const kept = p.shared ? ` ${p.shared} mod(s) shared with other collections are kept.` : ''
      if (
        !window.confirm(
          `Remove ${p.removable} archive(s) of "${c.name || c.slug}" from disk and the install order?${kept}\n` +
            'Soft-delete: re-importing the collection offers them again.',
        )
      )
        return
      await api.removeCollectionMods(c.id)
      setEnabled(false)
      setMods(null) // downloaded flags stale now — refetch on next expand
      onChanged()
    } catch (e) {
      setErr(errText(e))
    } finally {
      setRemoving(false)
    }
  }

  const toggleExpand = async () => {
    setExpanded((v) => !v)
    if (!mods) {
      try {
        setMods(await api.collectionMods(c.id)) // lazy, fetched once
      } catch (e) {
        setErr(errText(e))
      }
    }
  }

  return (
    <div className="grp">
      <h2>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 14 }}>
          <input
            type="checkbox"
            aria-label={`enable ${c.name || c.slug}`}
            checked={enabled}
            onChange={(e) => toggleEnabled(e.target.checked)}
          />
        </label>
        <span style={{ cursor: 'pointer', fontSize: 14 }} onClick={toggleExpand}>
          {c.name || c.slug}
        </span>
        <span className="dim" style={{ fontSize: 12 }}>
          {c.downloaded_count}/{c.mod_count} downloaded · {c.rule_count} order rule(s)
        </span>
        <button
          className="btn ghost"
          style={{ padding: '2px 10px', fontSize: 12 }}
          title="Fetch this collection in the Import tab and diff it against the library"
          onClick={() => onImportMods(c.url)}
        >
          Import mods
        </button>
        <button
          className="btn ghost"
          style={{ padding: '2px 10px', fontSize: 12 }}
          title="Soft-delete this collection's downloaded mods (mods shared with another collection are kept)"
          disabled={removing}
          onClick={removeMods}
        >
          {removing ? 'Removing…' : 'Remove mods'}
        </button>
        <a
          className="btn ghost"
          href={c.url}
          target="_blank"
          rel="noreferrer"
          style={{ padding: '2px 10px', fontSize: 12, textDecoration: 'none' }}
        >
          View on Nexus ↗
        </a>
        {err && <span className="c-red">{err}</span>}
      </h2>
      {expanded && (
        <div>
          {!mods ? (
            <p className="dim">loading…</p>
          ) : mods.mods.length ? (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 50 }}>#</th>
                  <th>Mod</th>
                  <th className="num">Group</th>
                </tr>
              </thead>
              <tbody>
                {mods.mods.map((m, i) => (
                  <tr key={`${m.mod_url}-${i}`} className={m.downloaded ? '' : 'dim'}>
                    <td className="num dim">{i + 1}</td>
                    <td>
                      {m.locked ? '🔒 ' : ''}
                      <a href={m.mod_url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
                        {m.mod_name}
                      </a>
                      {!m.downloaded && (
                        <span className="dim" style={{ fontSize: 11 }}>
                          {' '}
                          (not downloaded)
                        </span>
                      )}
                    </td>
                    <td className="num">
                      <GroupBadge bucket={m.bucket} buckets={mods.buckets} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="dim">This collection has no mods.</p>
          )}
        </div>
      )}
    </div>
  )
}

export function CollectionsTab({ onImportMods }: { onImportMods: (url: string) => void }) {
  const [collections, setCollections] = useState<Collection[] | null>(null)
  const [err, setErr] = useState('')

  const refresh = () => {
    api
      .collections()
      .then((d) => setCollections(d.collections))
      .catch((e) => setErr(errText(e)))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refresh, [])

  return (
    <section>
      <p className="dim" style={{ marginBottom: 8 }}>
        Collections you've imported and which of their mods are in your library, in their current real install order.
        Disable a collection to exclude its curated ordering rules from "Apply collection order rules" (Install Order
        tab) without losing its data.
      </p>
      {err && <p className="c-red">{err}</p>}
      {collections &&
        (collections.length ? (
          collections.map((c) => <CollectionCard key={c.id} c={c} onImportMods={onImportMods} onChanged={refresh} />)
        ) : (
          <p className="dim">No collections imported yet — fetch one from the Import tab.</p>
        ))}
    </section>
  )
}
