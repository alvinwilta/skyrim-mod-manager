import { get, post } from './client'
import type {
  Collection,
  CollectionMods,
  ConflictsResult,
  DeleteResult,
  DiffResult,
  FetchCollectionResult,
  InstallOrder,
  JobState,
  MissingRequirement,
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
  redownload: (fileIds: number[]) => post<{ started: number }>('/api/redownload', { file_ids: fileIds }),
  fetchCollection: (url: string) => post<FetchCollectionResult>('/api/fetch-collection', { url }),
  diff: (modlist: unknown) => post<DiffResult>('/api/diff', modlist),
  download: (modlist: unknown, fileIds: number[], collectionId: number | null) =>
    post<{ started: number }>('/api/download', { modlist, file_ids: fileIds, collection_id: collectionId }),
  collections: () => get<{ collections: Collection[] }>('/api/collections'),
  collectionMods: (id: number) => get<CollectionMods>(`/api/collections/${id}/mods`),
  setCollectionEnabled: (id: number, enabled: boolean) =>
    post<{ id: number; enabled: boolean }>(`/api/collections/${id}/enabled`, { enabled }),
  installOrder: () => get<InstallOrder>('/api/installorder'),
  sortState: () => get<JobState>('/api/sort-state'),
  orderMove: (modIds: number[], position: number) =>
    post<{ moved: number[]; position: number }>('/api/order/move', { mod_ids: modIds, position }),
  orderLock: (modIds: number[], locked: boolean) =>
    post<{ mod_ids: number[]; locked: boolean }>('/api/order/lock', { mod_ids: modIds, locked }),
  orderCheck: () => get<OrderCheck>('/api/order/check'),
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
}
