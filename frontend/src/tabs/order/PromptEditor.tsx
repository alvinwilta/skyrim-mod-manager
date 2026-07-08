import { useEffect, useState } from 'react'
import { api } from '../../api/endpoints'
import { errText } from './hooks/useOrderData'

// Module-level cache: unsaved edits must survive tab switches (the legacy
// promptLoaded guard). A remount reads the cache instead of refetching.
const cache = { prompt: '', default: '', loaded: false }

/** Test hook — reset the module cache between tests. */
export const __resetPromptCache = () => {
  cache.prompt = ''
  cache.default = ''
  cache.loaded = false
}

export function PromptEditor() {
  const [prompt, setPrompt] = useState(cache.prompt)
  const [msg, setMsg] = useState('')
  const [loaded, setLoaded] = useState(cache.loaded)

  useEffect(() => {
    if (cache.loaded) return // don't clobber unsaved edits on tab re-entry
    api
      .sortPrompt()
      .then((d) => {
        cache.prompt = d.prompt
        cache.default = d.default
        cache.loaded = true
        setPrompt(d.prompt)
        setLoaded(true)
      })
      .catch((e) => setMsg(errText(e)))
  }, [])

  const update = (v: string) => {
    cache.prompt = v
    setPrompt(v)
  }

  const save = async () => {
    try {
      await api.saveSortPrompt(prompt)
      setMsg('saved')
    } catch (e) {
      setMsg(errText(e))
    }
  }

  const reset = async () => {
    update(cache.default)
    try {
      await api.saveSortPrompt('') // empty string = reset to default on the backend
      setMsg('reset to default')
    } catch (e) {
      setMsg(errText(e))
    }
  }

  return (
    <details style={{ marginTop: 10 }}>
      <summary className="dim" style={{ cursor: 'pointer' }}>
        Claude prompt (editable — <code>{'{{BUCKETS}}'}</code> and <code>{'{{MODS}}'}</code> are filled in per run)
      </summary>
      <textarea
        style={{ height: 220, marginTop: 8 }}
        aria-label="claude prompt"
        value={prompt}
        disabled={!loaded}
        onChange={(e) => update(e.target.value)}
      />
      <div className="toolbar" style={{ marginTop: 6 }}>
        <button className="btn ghost" onClick={save}>
          Save prompt
        </button>
        <button className="btn ghost" onClick={reset}>
          Reset to default
        </button>
        <span className="dim">{msg}</span>
      </div>
    </details>
  )
}
