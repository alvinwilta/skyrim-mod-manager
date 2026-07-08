import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../../api/endpoints'
import { usePoller } from '../../../hooks/usePoller'
import { useEvents } from '../../../events/EventsProvider'
import type { ConflictsResult, MissingRequirement } from '../../../api/types'
import { snapshotBuckets, diffChanged, type BucketSnapshot } from '../lib/changeDiff'
import { errText, type useOrderData } from './useOrderData'

const NOT_RUN = 'Not run yet this session.'

/**
 * All background-job machinery for the Install Order tab: heuristic sort,
 * the two Claude refine passes, collection-rule enforcement, archive scan,
 * requirements sync, and drift check — with the legacy watcher semantics
 * (poll while running, reload + change-highlight when an action finishes).
 */
export function useOrderJobs(data: ReturnType<typeof useOrderData>) {
  const events = useEvents()
  const [model, setModel] = useState('haiku')
  const [msg, setMsg] = useState('') // the shared sortmsg line
  const [heuristicLog, setHeuristicLog] = useState(NOT_RUN)
  const [bulkMsg, setBulkMsg] = useState(NOT_RUN)
  const [descMsg, setDescMsg] = useState(NOT_RUN)
  const [enforceMsg, setEnforceMsg] = useState('')
  const [enforceLog, setEnforceLog] = useState<string[]>([])
  const [enforcing, setEnforcing] = useState(false)
  const [scanMsg, setScanMsg] = useState('')
  const [scanning, setScanning] = useState(false)
  const [conflicts, setConflicts] = useState<ConflictsResult>({ pairs: [], scanned: 0, total: 0 })
  const [reqMsg, setReqMsg] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [missing, setMissing] = useState<MissingRequirement[]>([])
  const [driftMsg, setDriftMsg] = useState('')
  const [wrongById, setWrongById] = useState<ReadonlyMap<number, number | null>>(new Map())
  const [justChanged, setJustChanged] = useState<ReadonlySet<number>>(new Set())
  const snapshot = useRef<BucketSnapshot | null>(null)

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

  const loadConflicts = useCallback(async () => {
    try {
      const d = await api.conflicts()
      setConflicts(d)
      const unscanned = d.total - d.scanned
      setScanMsg(unscanned ? `${d.scanned}/${d.total} archives scanned — ${unscanned} new` : `${d.scanned}/${d.total} archives scanned`)
    } catch (e) {
      setScanMsg(errText(e))
    }
  }, [])

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
    void loadConflicts()
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
  }, [loadConflicts, loadMissing])

  // SSE says a sort is running (started elsewhere / mid-session) → enter refining.
  useEffect(() => {
    if (events.sort.running && !data.refining) data.setRefining(true)
  }, [events.sort.running, data])

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
        await finishAction()
        return false
      }
      return true
    },
    1000,
    enforcing,
  )

  // Scan watcher: 1s.
  usePoller(
    async () => {
      const s = await api.scanState()
      setScanMsg(s.phase + (s.error ? ' — ' + s.error : ''))
      if (!s.running) {
        setScanning(false)
        await loadConflicts()
        return false
      }
      return true
    },
    1000,
    scanning,
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
        setHeuristicLog(`${r.sorted} mods sorted (last run)`)
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

  const runScan = async () => {
    try {
      await api.scanConflicts()
      setScanning(true)
    } catch (e) {
      setScanMsg(errText(e))
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

  const checkDrift = useCallback(
    async (silent: boolean) => {
      try {
        const d = await api.orderCheck()
        const wrong = new Map(d.mismatches.map((m) => [m.mod_id, m.expected]))
        setWrongById(wrong)
        if (!silent) {
          setDriftMsg(
            wrong.size
              ? `${wrong.size} mod(s) in the wrong spot — highlighted red in the table below`
              : 'order matches the sorter — nothing misplaced',
          )
          await data.reload()
        }
      } catch (e) {
        setDriftMsg(errText(e))
      }
    },
    [data],
  )

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
    scanMsg,
    scanning,
    conflicts,
    reqMsg,
    syncing,
    missing,
    driftMsg,
    wrongById,
    justChanged,
    runSort,
    refineOrStop,
    runDesc,
    runEnforce,
    runScan,
    runSync,
    checkDrift,
  }
}
