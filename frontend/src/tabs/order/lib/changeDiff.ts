import type { OrderMod } from '../../../api/types'

export type BucketSnapshot = ReadonlyMap<number, number | null>

/** Snapshot bucket-per-mod right before a sort/refine/enforce action starts. */
export const snapshotBuckets = (mods: OrderMod[]): BucketSnapshot => new Map(mods.map((m) => [m.mod_id, m.bucket]))

/**
 * Which mods did the action actually move? Diffed against the fresh order once
 * it finishes; each new action's diff replaces the previous one's so only the
 * most recent step stays highlighted (legacy diffChanged()).
 */
export const diffChanged = (before: BucketSnapshot, mods: OrderMod[]): ReadonlySet<number> =>
  new Set(mods.filter((m) => before.get(m.mod_id) !== m.bucket).map((m) => m.mod_id))
