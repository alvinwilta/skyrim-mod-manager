// Hand-written mirrors of webapp.py's raw-dict responses (no Pydantic on the
// backend, so no codegen). Each tab's phase fills in its own types after
// reading the corresponding handler — keep these in sync with webapp.py.

export interface CollectionRef {
  slug: string
  name?: string
}

/** GET /api/mods row */
export interface Mod {
  file_id: number
  mod_id: number
  mod_name: string
  mod_url: string
  file_name: string
  filename: string
  file_version: string
  author: string
  category: string
  size_bytes: number
  downloaded_at: string
  status: 'ok' | 'missing' | 'deleted'
  installed: boolean
  collections: CollectionRef[]
}

/** POST /api/validate */
export interface ValidateResult {
  ok: number[]
  fixed: number[]
  missing: number[]
}

/** POST /api/delete */
export interface DeleteResult {
  deleted: number
  files_removed: number
}

/** One row of a POST /api/diff group */
export interface DiffItem {
  file_id: number
  mod_id: number
  size: number
  mod_name: string
  name: string
  version: string
  old_version?: string
  /** the library file this one supersedes — downloading replaces it */
  old_file_id?: number
}

/** POST /api/diff */
export interface DiffResult {
  new: DiffItem[]
  updated: DiffItem[]
  downgraded: DiffItem[]
  unchanged: DiffItem[]
}

/** GET /api/installorder mod row */
export interface OrderMod {
  mod_id: number
  mod_name: string
  mod_url: string
  category: string | null
  bucket: number | null
  locked: boolean
  installed: boolean
  /** MO2 live state from the last pull: 'enabled' | 'disabled' | 'removed' | null */
  mo2_state: string | null
  /** provenance: 'mo2' = adopted from an MO2-only install (no managed archive), else null */
  source: string | null
  file_type: string | null
  flags: string[]
}

/** GET /api/installorder */
export interface InstallOrder {
  buckets: Record<string, string>
  mods: OrderMod[]
  notes: string[]
  /** true when files are renamed on disk with install-order prefixes */
  committed: boolean
  /** true when installed archives are moved into downloads/installed/ */
  hidden: boolean
}

/** GET /api/order/commit-state — JobState plus the persisted committed/hidden flags */
export interface CommitState extends JobState {
  committed: boolean
  hidden: boolean
}

/** GET /api/order/check */
export interface OrderCheck {
  mismatches: { mod_id: number; expected: number | null }[]
}

/** an entry in an /api/order/mo2-check list (mod_id is null for unmatched MO2 folders) */
export interface Mo2Entry {
  mod_id: number | null
  mod_name: string
}

/** GET /api/order/mo2-check — app install list vs MO2's real enabled install order */
export interface Mo2Check {
  out_of_order: Mo2Entry[]
  in_mo2_not_list: Mo2Entry[]
  in_list_not_mo2: Mo2Entry[]
}

/** GET /api/sort-prompt */
export interface SortPrompt {
  prompt: string
  default: string
}

/** GET /api/conflicts */
export interface ConflictPair {
  a: { mod_id: number; mod_name: string }
  b: { mod_id: number; mod_name: string }
  paths: string[]
  expected: boolean
}
export interface ConflictsResult {
  pairs: ConflictPair[]
  scanned: number
  total: number
}

/** GET /api/requirements-missing item */
export interface MissingRequirement {
  mod_id: number
  mod_name: string
  requires_url: string
  requires_mod_id: number
  notes: string | null
}

/** GET /api/collections item */
export interface Collection {
  id: number
  slug: string
  name: string
  url: string
  enabled: boolean
  mod_count: number
  downloaded_count: number
  rule_count: number
}

/** GET /api/collections/{id}/mods */
export interface CollectionMods {
  mods: {
    mod_name: string
    mod_url: string
    bucket: number | null
    locked: boolean
    downloaded: boolean
  }[]
  buckets: Record<string, string>
}

/** POST /api/fetch-collection */
export interface FetchCollectionResult {
  modlist: unknown
  collection: { id: number; slug: string; name: string } | null
  count: number
  diff: DiffResult
  skipped: string[]
}

/** Shared shape of the four background-job state endpoints
 *  (/api/sort-state, /api/scan-state, /api/requirements-state, /api/enforce-state) */
export interface JobState {
  running: boolean
  phase: string
  error: string | null
  log?: string[]
  job?: string
}

// 'expired': signed CDN url outlived its ~4h window mid-batch — the backend
// regenerates the link next round and resumes; transient, not a failure
// 'cancelled': user cancelled the file — partial cleaned from disk, finished
// files never affected
export type DlFileStatus =
  | 'pending'
  | 'url'
  | 'queued'
  | 'downloading'
  | 'done'
  | 'skipped'
  | 'failed'
  | 'expired'
  | 'cancelled'

/** One entry of engine.state.files */
export interface DlFile {
  name: string
  size: number
  got: number
  status: DlFileStatus
  /** identity block written by the backend; file_id drives per-file cancel */
  meta?: { file_id: number; mod_id: number; mod_name: string; file_name: string }
}

/** GET /api/state / the `dl` half of the SSE frame (engine.state) */
export interface DlState {
  phase: string
  files: DlFile[]
  error: string | null
  running: boolean
  /** download batches running in parallel (downloads started mid-job join as new batches) */
  batches?: number
}

/** SSE /api/events frame */
export interface EventsFrame {
  dl: DlState
  sort: JobState
}

/** GET /api/config */
export interface ConfigData {
  /** overrides the user explicitly stored (may be a subset of keys) */
  stored: Record<string, string>
  /** resolved values actually in effect (DB > .env > env > default) */
  effective: Record<string, string | number>
  /** provenance per key: 'db' | 'env' | 'default' */
  sources: Record<string, string>
  /** every editable config key, in display order */
  keys: string[]
  /** keys whose value must be an existing directory */
  dir_keys: string[]
}

/** GET /api/browse — one directory level for the folder picker */
export interface BrowseResult {
  path: string
  parent: string
  dirs: string[]
}
