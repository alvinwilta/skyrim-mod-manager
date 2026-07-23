import { useEffect, useState } from 'react'
import { api } from '../../api/endpoints'
import { ApiError } from '../../api/client'
import type { ConfigData } from '../../api/types'
import { FolderPicker } from './FolderPicker'

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e))

// Per-key presentation. The backend owns the key list + order; this only adds a
// human label + one-line help. A key missing here still renders (label = key).
const FIELDS: Record<string, { label: string; help: string }> = {
  mo2_base_dir: {
    label: 'MO2 base directory',
    help: 'Portable instance root — downloads/mods/profiles derive from this unless overridden below.',
  },
  downloads_dir: { label: 'Downloads dir (override)', help: 'Leave blank to use <base>/downloads.' },
  mods_dir: { label: 'Mods dir (override)', help: 'Leave blank to use <base>/mods.' },
  profiles_dir: { label: 'Profiles dir (override)', help: 'Leave blank to use <base>/profiles.' },
  mo2_ini: { label: 'ModOrganizer.ini path (override)', help: 'Leave blank to use <base>/MO2/ModOrganizer.ini.' },
  cdp_port: { label: 'Chromium CDP port', help: 'Debug port for the dedicated link-gen browser (default 9223).' },
  nexus_api_key: { label: 'Nexus API key', help: 'Free-tier key — only needed for collection ordering rules.' },
}

export function ConfigTab() {
  const [data, setData] = useState<ConfigData | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedNote, setSavedNote] = useState(false)
  const [picking, setPicking] = useState<string | null>(null)

  const load = () => {
    setError('')
    api
      .config()
      .then((d) => {
        setData(d)
        // seed the form from stored overrides only — placeholders show the
        // effective (resolved) value so a blank field means "use the default".
        const seed: Record<string, string> = {}
        for (const k of d.keys) seed[k] = d.stored[k] ?? ''
        setForm(seed)
      })
      .catch((e) => setError(errText(e)))
  }

  useEffect(load, [])

  const dirty = data ? data.keys.some((k) => (form[k] ?? '') !== (data.stored[k] ?? '')) : false

  const save = () => {
    setSaving(true)
    setError('')
    setSavedNote(false)
    api
      .saveConfig(form)
      .then((r) => {
        setSavedNote(r.restart_required)
        load()
      })
      .catch((e) => setError(errText(e)))
      .finally(() => setSaving(false))
  }

  if (!data) {
    return (
      <section className="config-tab">
        {error ? <p className="config-error">{error}</p> : <p className="dim">Loading…</p>}
      </section>
    )
  }

  return (
    <section className="config-tab">
      <h2>Configuration</h2>
      <p className="dim">
        Paths and settings the app uses to reach your MO2 instance. Stored in <code>mods.db</code>; these override{' '}
        <code>.env</code> and environment variables. <strong>Changes apply on restart.</strong>
      </p>

      {error && <p className="config-error">{error}</p>}
      {savedNote && (
        <p className="config-ok">Saved. Restart the app for path changes to take effect.</p>
      )}

      <div className="config-fields">
        {data.keys.map((k) => {
          const meta = FIELDS[k] ?? { label: k, help: '' }
          const effective = data.effective[k]
          const isDir = data.dir_keys.includes(k)
          const fromEnv = data.sources[k] === 'env'
          return (
            <label key={k} className="config-field">
              <span className="config-label">
                {meta.label}
                {fromEnv ? (
                  <span className="config-tag ok">loaded from env</span>
                ) : (
                  isDir && <span className="config-tag warn">dir must exist</span>
                )}
              </span>
              <span className="config-input">
                <input
                  type="text"
                  value={form[k] ?? ''}
                  placeholder={effective != null && effective !== '' ? String(effective) : '(unset)'}
                  onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                  spellCheck={false}
                />
                {isDir && (
                  <button type="button" className="btn ghost" onClick={() => setPicking(k)}>
                    Browse…
                  </button>
                )}
              </span>
              {meta.help && <span className="config-help">{meta.help}</span>}
            </label>
          )
        })}
      </div>

      <div className="config-actions">
        <button className="btn" onClick={save} disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="btn ghost" onClick={load} disabled={saving || !dirty}>
          Reset
        </button>
      </div>

      {picking && (
        <FolderPicker
          title={FIELDS[picking]?.label ?? picking}
          start={form[picking] || String(data.effective[picking] ?? '')}
          onPick={(path) => {
            setForm((f) => ({ ...f, [picking]: path }))
            setPicking(null)
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </section>
  )
}
