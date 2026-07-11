import { ModJumpLink } from '../ModJump'

/** One drifted mod, resolved by OrderTab from the check result + order cache. */
export interface DriftEntry {
  pos: number
  mod_id: number
  mod_name: string
  bucket: number | null
  expected: number | null
}

export function DriftView({
  msg,
  entries,
  buckets,
  onJump,
}: {
  msg: string
  entries: DriftEntry[]
  buckets: Record<string, string>
  onJump: (id: number) => void
}) {
  const name = (b: number | null) => (b != null && buckets[String(b)]) || 'Unsorted'
  return (
    <div>
      <div className="dim">{msg}</div>
      {entries.length > 0 && (
        <div className="grp">
          <h2>
            <span className="badge" style={{ background: '#3a1214', color: 'var(--red)' }}>
              Drifted mods · {entries.length}
            </span>
          </h2>
          <ul className="dim">
            {entries.map((e) => (
              <li key={e.mod_id}>
                #{e.pos} <span style={{ color: 'var(--text)' }}>{e.mod_name}</span> (
                <ModJumpLink id={e.mod_id} name={e.mod_name} onJump={onJump} />) — now in “{name(e.bucket)}”, sorter
                expected “{name(e.expected)}”
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
