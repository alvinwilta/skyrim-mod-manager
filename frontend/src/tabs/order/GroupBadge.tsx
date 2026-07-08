import { groupHue } from './lib/groupHue'

export type Buckets = Record<string, string>

/** Golden-angle-hued group badge, stable per bucket id (legacy groupBadge). */
export function GroupBadge({ bucket, buckets }: { bucket: number | null; buckets: Buckets }) {
  if (bucket == null) return <span className="badge b-same">? · Unsorted</span>
  const hue = groupHue(bucket)
  return (
    <span className="badge" style={{ background: `hsl(${hue} 45% 22%)`, color: `hsl(${hue} 65% 72%)` }}>
      {bucket} · {buckets[bucket] || '?'}
    </span>
  )
}
