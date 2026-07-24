import type { ConflictRelations } from '../../../api/types'

/**
 * MO2-style overwrite detail for the currently-selected mod(s), shown in the
 * Sort subtab: what each selected mod OVERWRITES (its loose files win, green) and
 * what it's OVERWRITTEN BY (those files win over it, red). Each entry names the
 * other mod + how many file paths overlap, and jumps to it on click. Direction
 * comes from the install order (lower in the list = higher priority = overwrites).
 */
export function ConflictDetail({
  selected,
  relations,
  names,
  onJump,
}: {
  selected: number[]
  relations: ConflictRelations
  names: ReadonlyMap<number, string>
  onJump: (modId: number) => void
}) {
  if (!selected.length)
    return <div className="dim">Select a mod to see what it overwrites and what overwrites it.</div>

  const withRel = selected.filter((id) => relations[String(id)])
  if (!withRel.length)
    return (
      <div className="dim">
        The selected mod{selected.length > 1 ? 's have' : ' has'} no file conflicts — run Sort first if you
        haven't (it scans archives), or nothing overlaps.
      </div>
    )

  const line = (
    edges: { mod_id: number; mod_name: string; files: number }[],
    cls: string,
    verb: string,
  ) =>
    edges.length > 0 && (
      <div className="cd-line">
        <span className={`cd-verb ${cls}`}>{verb}</span>
        {edges.map((e) => (
          <button key={e.mod_id} className="cd-mod" title={`${e.files} shared file(s) — jump`} onClick={() => onJump(e.mod_id)}>
            {e.mod_name} <span className="dim">({e.files})</span>
          </button>
        ))}
      </div>
    )

  return (
    <div className="cd-wrap">
      {withRel.map((id) => {
        const rel = relations[String(id)]
        return (
          <div key={id} className="cd-mod-block">
            <div className="cd-title">{names.get(id) ?? id}</div>
            {line(rel.overwrites, 'c-over', 'overwrites')}
            {line(rel.overwritten_by, 'c-under', 'overwritten by')}
          </div>
        )
      })}
    </div>
  )
}
