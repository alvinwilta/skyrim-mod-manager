import { get, post } from './client'
import type {
  BrowseResult,
  Collection,
  CollectionMods,
  CommitState,
  ConfigData,
  ConflictsResult,
  DeleteResult,
  DiffResult,
  FetchCollectionResult,
  InstallOrder,
  JobState,
  MissingRequirement,
  Mo2Check,
  Mod,
  OrderCheck,
  SortPrompt,
  ValidateResult,
} from './types'

// One named function per backend route; grows phase by phase.
export const api = {
  mods: (q?: string) => get<Mod[]>(`/api/mods${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  validate: (fileIds: number[]) => post<ValidateResult>('/api/validate', { file_ids: fileIds }),
  deleteFiles: (fileIds: number[]) => post<DeleteResult>('/api/delete', { file_ids: fileIds }),
  deleteMods: (modIds: number[]) => post<DeleteResult>('/api/delete', { mod_ids: modIds }),
  purgeFiles: (fileIds: number[]) => post<{ purged: number; files_removed: number }>('/api/purge', { file_ids: fileIds }),
  redownload: (fileIds: number[]) => post<{ started: number; batches: number }>('/api/redownload', { file_ids: fileIds }),
  cancelDownload: (fileIds: number[]) => post<{ cancelled: number }>('/api/cancel', { file_ids: fileIds }),
  cancelAllDownloads: () => post<{ cancelled: number }>('/api/cancel', { all: true }),
  fetchCollection: (url: string) => post<FetchCollectionResult>('/api/fetch-collection', { url }),
  diff: (modlist: unknown) => post<DiffResult>('/api/diff', modlist),
  download: (modlist: unknown, fileIds: number[], collectionId: number | null) =>
    post<{ started: number; batches: number }>('/api/download', { modlist, file_ids: fileIds, collection_id: collectionId }),
  collections: () => get<{ collections: Collection[] }>('/api/collections'),
  collectionMods: (id: number) => get<CollectionMods>(`/api/collections/${id}/mods`),
  setCollectionEnabled: (id: number, enabled: boolean) =>
    post<{ id: number; enabled: boolean }>(`/api/collections/${id}/enabled`, { enabled }),
  collectionRemovable: (id: number) =>
    get<{ removable: number; shared: number }>(`/api/collections/${id}/removable`),
  removeCollectionMods: (id: number) =>
    post<{ deleted: number; files_removed: number; shared_kept: number }>(`/api/collections/${id}/remove-mods`, {}),
  installOrder: () => get<InstallOrder>('/api/installorder'),
  sortState: () => get<JobState>('/api/sort-state'),
  orderMove: (modIds: number[], position: number) =>
    post<{ moved: number[]; position: number }>('/api/order/move', { mod_ids: modIds, position }),
  orderLock: (modIds: number[], locked: boolean) =>
    post<{ mod_ids: number[]; locked: boolean }>('/api/order/lock', { mod_ids: modIds, locked }),
  orderClearFlags: (kinds: string[]) =>
    post<{ cleared: number; kinds: string[] }>('/api/order/clear-flags', { kinds }),
  orderCheck: () => get<OrderCheck>('/api/order/check'),
  orderMo2Check: () => get<Mo2Check>('/api/order/mo2-check'),
  orderCommit: () => post<{ started: boolean }>('/api/order/commit'),
  orderUncommit: () => post<{ started: boolean }>('/api/order/uncommit'),
  orderHideInstalled: (enabled: boolean) => post<{ started: boolean }>('/api/order/hide-installed', { enabled }),
  orderCommitState: () => get<CommitState>('/api/order/commit-state'),
  importLocal: () => post<{ started: boolean }>('/api/import-local'),
  importLocalState: () => get<JobState>('/api/import-local-state'),
  mo2Pull: () => post<{ started: boolean }>('/api/mo2-pull'),
  mo2PullState: () =>
    get<JobState & { matched: number; adopted: number; removed: number; skipped: number }>('/api/mo2-pull-state'),
  sort: (llm: boolean, model: string) => post<{ sorted: number; llm: boolean }>('/api/sort', { llm, model }),
  sortDesc: (model: string) => post<{ started: boolean }>('/api/sort-desc', { model }),
  sortStop: () => post<{ stopped: boolean }>('/api/sort-stop'),
  sortPrompt: () => get<SortPrompt>('/api/sort-prompt'),
  saveSortPrompt: (prompt: string) => post<{ saved: boolean }>('/api/sort-prompt', { prompt }),
  enforceOrder: () => post<{ started: boolean }>('/api/enforce-order'),
  enforceState: () => get<JobState>('/api/enforce-state'),
  scanConflicts: () => post<{ started: boolean }>('/api/scan-conflicts'),
  scanState: () => get<JobState>('/api/scan-state'),
  conflicts: () => get<ConflictsResult>('/api/conflicts'),
  syncRequirements: () => post<{ started: boolean }>('/api/sync-requirements'),
  requirementsState: () => get<JobState>('/api/requirements-state'),
  requirementsMissing: () => get<{ missing: MissingRequirement[] }>('/api/requirements-missing'),
  config: () => get<ConfigData>('/api/config'),
  saveConfig: (values: Record<string, string>) =>
    post<{ saved: boolean; restart_required: boolean; stored: Record<string, string> }>('/api/config', values),
  browse: (path?: string) => get<BrowseResult>(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
}
