import { groupHue } from './lib/groupHue'

export type Buckets = Record<string, string>

/** Golden-angle-hued group badge, stable per bucket id (legacy groupBadge).
 *  Full "n · name" label; where the column is narrow (order table) the pill
 *  truncates with ellipsis in CSS and the full text stays in this tooltip. */
export function GroupBadge({ bucket, buckets }: { bucket: number | null; buckets: Buckets }) {
  if (bucket == null) return <span className="badge b-same" title="Unsorted">? · Unsorted</span>
  const hue = groupHue(bucket)
  const name = buckets[bucket] || '?'
  return (
    <span
      className="badge"
      style={{ background: `hsl(${hue} 45% 22%)`, color: `hsl(${hue} 65% 72%)` }}
      title={`${bucket} · ${name}`}
    >
      {bucket} · {name}
    </span>
  )
}
