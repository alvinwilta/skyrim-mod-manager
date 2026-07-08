import type { Mo2Check, Mo2Entry } from '../../../api/types'

function List({ title, color, bg, entries, suffix }: { title: string; color: string; bg: string; entries: Mo2Entry[]; suffix: string }) {
  if (entries.length === 0) return null
  return (
    <div className="grp">
      <h2>
        <span className="badge" style={{ background: bg, color }}>
          {title} · {entries.length}
        </span>
      </h2>
      <ul style={{ margin: '6px 0 0 20px' }} className="dim">
        {entries.slice(0, 30).map((e, i) => (
          <li key={i}>
            {e.mod_name}
            {e.mod_id == null ? ' (not a Nexus mod / no modid)' : ''} {suffix}
          </li>
        ))}
        {entries.length > 30 && <li>...and {entries.length - 30} more</li>}
      </ul>
    </div>
  )
}

/** Results of comparing the app's install list against MO2's real enabled order. */
export function Mo2View({ msg, mo2 }: { msg: string; mo2: Mo2Check }) {
  return (
    <div>
      <div className="dim">{msg}</div>
      <List
        title="Out of order"
        color="var(--red)"
        bg="#3a1214"
        entries={mo2.out_of_order}
        suffix="— sits in a different relative position than MO2 has it installed"
      />
      <List
        title="Installed in MO2, not in list"
        color="var(--amber)"
        bg="#3a2b12"
        entries={mo2.in_mo2_not_list}
        suffix="— enabled in MO2 but absent from your list"
      />
      <List
        title="In list, not installed in MO2"
        color="var(--amber)"
        bg="#3a2b12"
        entries={mo2.in_list_not_mo2}
        suffix="— in your list but not enabled/installed in MO2 yet"
      />
    </div>
  )
}
