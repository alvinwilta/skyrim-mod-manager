import type { Mo2Check, Mo2Entry } from '../../../api/types'
import type { Dismissed } from '../hooks/useDismissed'
import { DismissX, RestoreDismissed } from '../Dismiss'

export const mo2Key = (section: string, e: Mo2Entry) => `${section}:${e.mod_id ?? e.mod_name}`

function List({
  section,
  title,
  color,
  bg,
  entries,
  suffix,
  d,
}: {
  section: string
  title: string
  color: string
  bg: string
  entries: Mo2Entry[]
  suffix: string
  d: Dismissed
}) {
  const shown = entries.filter((e) => !d.has(mo2Key(section, e)))
  if (shown.length === 0) return null
  return (
    <div className="grp">
      <h2>
        <span className="badge" style={{ background: bg, color }}>
          {title} · {shown.length}
        </span>
      </h2>
      <ul className="dim dismiss-list">
        {shown.slice(0, 30).map((e, i) => (
          <li key={i}>
            <DismissX onDismiss={() => d.dismiss(mo2Key(section, e))} />
            {e.mod_name}
            {e.mod_id == null ? ' (not a Nexus mod / no modid)' : ''} {suffix}
          </li>
        ))}
        {shown.length > 30 && <li>...and {shown.length - 30} more</li>}
      </ul>
    </div>
  )
}

/** Results of comparing the app's install list against MO2's real enabled order. */
export function Mo2View({ msg, mo2, d }: { msg: string; mo2: Mo2Check; d: Dismissed }) {
  return (
    <div>
      <div className="dim">
        {msg} <RestoreDismissed d={d} />
      </div>
      <List
        section="out"
        title="Out of order"
        color="var(--red)"
        bg="#3a1214"
        entries={mo2.out_of_order}
        suffix="— sits in a different relative position than MO2 has it installed"
        d={d}
      />
      <List
        section="in_mo2"
        title="Installed in MO2, not in list"
        color="var(--amber)"
        bg="#3a2b12"
        entries={mo2.in_mo2_not_list}
        suffix="— enabled in MO2 but absent from your list"
        d={d}
      />
      <List
        section="in_list"
        title="In list, not installed in MO2"
        color="var(--amber)"
        bg="#3a2b12"
        entries={mo2.in_list_not_mo2}
        suffix="— in your list but not enabled/installed in MO2 yet"
        d={d}
      />
    </div>
  )
}
