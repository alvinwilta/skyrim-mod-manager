import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../../api/endpoints'
import { usePoller } from '../../../hooks/usePoller'
import { useActivity } from '../../../events/EventsProvider'
import type { MissingRequirement } from '../../../api/types'
import { snapshotBuckets, diffChanged, type BucketSnapshot } from '../lib/changeDiff'
import { useDismissed } from './useDismissed'
import { errText, type useOrderData } from './useOrderData'

const NOT_RUN = 'Not run yet this session.'

/**
 * All background-job machinery for the Install Order tab: heuristic sort,
 * the two Claude refine passes, collection-rule enforcement, requirements sync,
 * and the MO2 pull — with the legacy watcher semantics (poll while running,
 * reload + change-highlight when an action finishes).
 */
export function useOrderJobs(data: ReturnType<typeof useOrderData>) {
  const { sorting } = useActivity()
  const [model, setModel] = useState('haiku')
  const [msg, setMsg] = useState('') // the shared sortmsg line
  const [heuristicLog, setHeuristicLog] = useState(NOT_RUN)
  const [bulkMsg, setBulkMsg] = useState(NOT_RUN)
  const [descMsg, setDescMsg] = useState(NOT_RUN)
  const [enforceMsg, setEnforceMsg] = useState('')
  const [enforceLog, setEnforceLog] = useState<string[]>([])
  const [enforcing, setEnforcing] = useState(false)
  const [reqMsg, setReqMsg] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [missing, setMissing] = useState<MissingRequirement[]>([])
  const [commitMsg, setCommitMsg] = useState('')
  const [commitError, setCommitError] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [hiding, setHiding] = useState(false) // hide-installed move job in flight
  const [pulling, setPulling] = useState(false) // MO2 pull job in flight
  const [pullMsg, setPullMsg] = useState('')
  const [syncingState, setSyncingState] = useState(false) // MO2 state-only sync in flight
  const [syncStateMsg, setSyncStateMsg] = useState('')
  const [pushing, setPushing] = useState(false) // MO2 push job in flight
  const [pushMsg, setPushMsg] = useState('')
  const [justChanged, setJustChanged] = useState<ReadonlySet<number>>(new Set())
  const snapshot = useRef<BucketSnapshot | null>(null)

  // Per-line dismissals for each result list; most producing jobs clear their
  // section when they rerun, so dismissed lines stay gone until the next scan.
  // requirements is the exception: it persists across reruns, only cleared via
  // the explicit "restore dismissed" link -- a requirement you've judged safe
  // to ignore should stay ignored, not resurface every time you re-sync.
  const dismissed = {
    notes: useDismissed('notes'),
    rules: useDismissed('rules'),
    requirements: useDismissed('requirements'),
    // required-mod-level dismissals (keyed by requires_mod_id) shared by the
    // Missing Requirements and Substitutes subtabs: X'ing a mod in one hides
    // it in both. See RequirementsView / SubstitutesView.
    requirementMods: useDismissed('requirementMods'),
  }

  const takeSnapshot = () => {
    snapshot.current = snapshotBuckets(data.mods)
  }

  /** Reload the order and highlight what the finished action actually moved. */
  const finishAction = useCallback(async () => {
    const d = await data.reload()
    if (snapshot.current && d) {
      setJustChanged(diffChanged(snapshot.current, d.mods))
      snapshot.current = null
    }
  }, [data])

  const loadMissing = useCallback(async () => {
    try {
      setMissing((await api.requirementsMissing()).missing)
    } catch (e) {
      setReqMsg(errText(e))
    }
  }, [])

  // Tab-entry loads (component mounts on every Order tab entry): analysis
  // panels + last non-running refine/enforce phase messages (legacy
  // loadRefineState/loadEnforceState).
  useEffect(() => {
    void loadMissing()
    api
      .enforceState()
      .then((s) => {
        setEnforceMsg(s.phase === 'idle' ? '' : s.phase + (s.error ? ' — ' + s.error : ''))
        setEnforceLog(s.log || [])
      })
      .catch(() => {})
    api
      .sortState()
      .then((s) => {
        if (s.phase === 'idle' || s.running) return // running: the refine poller takes over
        const m = s.phase + (s.error ? ' — ' + s.error : '')
        if (s.job === 'desc') setDescMsg(m)
        else setBulkMsg(m)
      })
      .catch(() => {})
  }, [loadMissing])

  // SSE says a sort STARTED (elsewhere / mid-session) → enter refining.
  // Rising-edge only: reacting to the level re-entered refining from a stale
  // SSE frame right after the poller ended the job, looping poller-off →
  // bridge-on → poller-off (visible button flicker + wasted requests) until
  // the next frame arrived. prev starts false so a sort already running at
  // mount still triggers the first edge.
  const prevSorting = useRef(false)
  useEffect(() => {
    const rising = sorting && !prevSorting.current
    prevSorting.current = sorting
    if (rising && !data.refining) data.setRefining(true)
  }, [sorting, data.refining, data.setRefining])

  // Refine watcher: 2s, stops when the job ends, then reload + highlight.
  usePoller(
    async () => {
      const s = await api.sortState()
      const m = s.phase + (s.error ? ' — ' + s.error : '')
      setMsg(m)
      if (s.job === 'desc') setDescMsg(m)
      else setBulkMsg(m)
      if (!s.running) {
        data.setRefining(false)
        dismissed.notes.clear() // fresh refine results — dismissed notes reset
        await finishAction()
        return false
      }
      return true
    },
    2000,
    data.refining,
  )

  // Enforce watcher: 1s.
  usePoller(
    async () => {
      const s = await api.enforceState()
      setEnforceMsg(s.phase + (s.error ? ' — ' + s.error : ''))
      setEnforceLog(s.log || [])
      if (!s.running) {
        setEnforcing(false)
        dismissed.rules.clear()
        await finishAction()
        return false
      }
      return true
    },
    1000,
    enforcing,
  )

  // Requirements watcher: 1s.
  usePoller(
    async () => {
      const s = await api.requirementsState()
      setReqMsg(s.phase + (s.error ? ' — ' + s.error : ''))
      if (!s.running) {
        setSyncing(false)
        await loadMissing()
        return false
      }
      return true
    },
    1000,
    syncing,
  )

  // Commit/hide watcher: 1s. Both jobs rename/move files on disk (shared
  // backend state); blocks all reordering meanwhile. A thrown tick (route 404
  // on a stale backend, network blip) must NOT hang the overlay forever —
  // catch it, drop out, and surface the error.
  usePoller(
    async () => {
      try {
        const s = await api.orderCommitState()
        if (!s.running) {
          setCommitMsg(s.phase + (s.error ? ' — ' + s.error : ''))
          setCommitError(!!s.error)
          setCommitting(false)
          setHiding(false)
          data.setCommitted(s.committed)
          data.setHidden(s.hidden)
          await finishAction()
          return false
        }
        setCommitMsg(s.phase)
        return true
      } catch (e) {
        setCommitMsg(errText(e))
        setCommitError(true)
        setCommitting(false)
        setHiding(false)
        return false
      }
    },
    1000,
    committing || hiding,
  )

  // Pull watcher: 1s. Reads MO2's live order/state into the tool (rewrites
  // ranks), then reloads + highlights what moved.
  usePoller(
    async () => {
      const s = await api.mo2PullState()
      setPullMsg(s.phase + (s.error ? ' — ' + s.error : ''))
      if (!s.running) {
        setPulling(false)
        await finishAction()
        return false
      }
      return true
    },
    1000,
    pulling,
  )

  const runPull = async () => {
    takeSnapshot()
    setPullMsg('reading MO2…')
    try {
      await api.mo2Pull()
      setPulling(true)
    } catch (e) {
      setPullMsg(errText(e))
      snapshot.current = null
    }
  }

  // State-sync watcher: 1s. Refreshes MO2 install-state without reordering, then
  // reloads (installed flags change) + highlights any newly parked mods.
  usePoller(
    async () => {
      const s = await api.mo2SyncStateState()
      setSyncStateMsg(s.phase + (s.error ? ' — ' + s.error : ''))
      if (!s.running) {
        setSyncingState(false)
        await finishAction()
        return false
      }
      return true
    },
    1000,
    syncingState,
  )

  const runSyncState = async () => {
    takeSnapshot()
    setSyncStateMsg('reading MO2…')
    try {
      await api.mo2SyncState()
      setSyncingState(true)
    } catch (e) {
      setSyncStateMsg(errText(e))
      snapshot.current = null
    }
  }

  // Push watcher: 1s. Writes the tool's order out to MO2's modlist.txt; nothing
  // on the tool side changes, so no reload/highlight — just clear the flag.
  usePoller(
    async () => {
      const s = await api.mo2PushState()
      setPushMsg(s.phase + (s.error ? ' — ' + s.error : ''))
      if (!s.running) {
        setPushing(false)
        return false
      }
      return true
    },
    1000,
    pushing,
  )

  const runPush = async () => {
    setPushMsg('writing modlist.txt…')
    try {
      await api.mo2Push()
      setPushing(true)
    } catch (e) {
      setPushMsg(errText(e))
    }
  }

  const runCommit = async () => {
    takeSnapshot()
    setCommitError(false)
    setCommitMsg('renaming files…')
    try {
      await api.orderCommit()
      setCommitting(true)
    } catch (e) {
      setCommitMsg(errText(e))
      setCommitError(true)
      snapshot.current = null
    }
  }

  const runUncommit = async () => {
    takeSnapshot()
    setCommitError(false)
    setCommitMsg('restoring names…')
    try {
      await api.orderUncommit()
      setCommitting(true)
    } catch (e) {
      setCommitMsg(errText(e))
      setCommitError(true)
      snapshot.current = null
    }
  }

  const runHideInstalled = async (enabled: boolean) => {
    setCommitError(false)
    setCommitMsg(enabled ? 'moving installed archives…' : 'moving archives back…')
    try {
      await api.orderHideInstalled(enabled)
      setHiding(true)
    } catch (e) {
      setCommitMsg(errText(e))
      setCommitError(true)
    }
  }

  const runSort = async (llm: boolean) => {
    takeSnapshot()
    setMsg('sorting…')
    if (llm) setBulkMsg('sorting…')
    try {
      const r = await api.sort(llm, model)
      if (llm) {
        data.setRefining(true) // the refine poller unlocks + reloads when done
      } else {
        setMsg('')
        setHeuristicLog(
          `${r.sorted} mods sorted into bands${r.pins ? `, ${r.pins} cross-band conflict pin(s)` : ''} (last run)`,
        )
        await finishAction()
      }
    } catch (e) {
      const m = errText(e)
      setMsg(m)
      if (llm) setBulkMsg(m)
      snapshot.current = null
    }
  }

  const refineOrStop = async () => {
    if (!data.refining) return runSort(true)
    try {
      await api.sortStop()
      setMsg('stopping…')
      setBulkMsg('stopping…')
    } catch (e) {
      setMsg(errText(e))
      setBulkMsg(errText(e))
    }
  }

  const runDesc = async () => {
    takeSnapshot()
    setMsg('checking uncertain mods…')
    setDescMsg('checking uncertain mods…')
    try {
      await api.sortDesc(model)
      data.setRefining(true)
    } catch (e) {
      setMsg(errText(e))
      setDescMsg(errText(e))
      snapshot.current = null
    }
  }

  const runEnforce = async () => {
    takeSnapshot()
    try {
      await api.enforceOrder()
      setEnforcing(true)
    } catch (e) {
      setEnforceMsg(errText(e))
      snapshot.current = null
    }
  }

  const runSync = async () => {
    try {
      await api.syncRequirements()
      setSyncing(true)
    } catch (e) {
      setReqMsg(errText(e))
    }
  }

  const clearJustChanged = useCallback(() => setJustChanged(new Set()), [])

  return {
    model,
    setModel,
    msg,
    setMsg,
    heuristicLog,
    bulkMsg,
    descMsg,
    enforceMsg,
    enforceLog,
    enforcing,
    reqMsg,
    syncing,
    missing,
    commitMsg,
    commitError,
    committing,
    hiding,
    pulling,
    pullMsg,
    runPull,
    syncingState,
    syncStateMsg,
    runSyncState,
    pushing,
    pushMsg,
    runPush,
    justChanged,
    runSort,
    refineOrStop,
    runDesc,
    runEnforce,
    runSync,
    runCommit,
    runUncommit,
    runHideInstalled,
    clearJustChanged,
    dismissed,
  }
}
