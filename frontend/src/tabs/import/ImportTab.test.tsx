import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ImportTab, __resetImportCache, requestCollectionImport } from './ImportTab'
import { mockApi } from '../../test/mockApi'
import type { DiffItem } from '../../api/types'

afterEach(() => vi.unstubAllGlobals())
beforeEach(() => __resetImportCache()) // the diff cache deliberately survives remounts

const item = (over: Partial<DiffItem>): DiffItem => ({
  file_id: 1,
  mod_id: 100,
  size: 1024,
  mod_name: 'SkyUI',
  name: 'SkyUI_5_2.7z',
  version: '5.2',
  ...over,
})

const DIFF = {
  new: [item({ file_id: 1 }), item({ file_id: 2, mod_name: 'USSEP', name: 'ussep.7z' })],
  updated: [item({ file_id: 3, mod_name: 'SMIM', name: 'smim.7z', old_version: '1.0', version: '2.0' })],
  downgraded: [item({ file_id: 5, mod_name: 'Noble', name: 'noble.7z', old_version: '3.0', version: '2.5' })],
  unchanged: [item({ file_id: 4, mod_name: 'ELFX', name: 'elfx.7z' })],
}

const FETCH = {
  'POST /api/fetch-collection': {
    modlist: { fromNexus: true },
    collection: { id: 42, slug: 'h2uqa3', name: 'Lorerim' },
    count: 3,
    diff: DIFF,
  },
}

async function fetchLinks() {
  await userEvent.type(screen.getByPlaceholderText(/collections\/h2uqa3/), 'https://nexus/skyrimspecialedition/mods/1')
  await userEvent.click(screen.getByRole('button', { name: 'Fetch from Nexus' }))
  await screen.findByText('New · 2')
}

describe('ImportTab', () => {
  it('fetch → diff renders groups, new+updated pre-checked, summary counts', async () => {
    mockApi(FETCH)
    render(<ImportTab onGoToProgress={vi.fn()} />)
    await fetchLinks()

    expect(screen.getByText('New · 2')).toBeInTheDocument()
    expect(screen.getByText(/^Updated .* 1$/)).toBeInTheDocument()
    expect(screen.getByText(/^Downgrade .* 1$/)).toBeInTheDocument()
    expect(screen.getByText('Already downloaded · 1')).toBeInTheDocument()
    // 3 of 5 pre-checked (new + updated; downgrade and unchanged opt-in), 1024*3 bytes
    expect(screen.getByText('3 files · 3.0 KB')).toBeInTheDocument()
    expect(screen.getByLabelText('select elfx.7z')).not.toBeChecked()
    expect(screen.getByLabelText('select noble.7z')).not.toBeChecked()
    // updated/downgraded show old → new version
    expect(screen.getByText('1.0 →')).toBeInTheDocument()
    expect(screen.getByText('3.0 →')).toBeInTheDocument()
  })

  it('group toggle flips every box in that group only', async () => {
    mockApi(FETCH)
    render(<ImportTab onGoToProgress={vi.fn()} />)
    await fetchLinks()

    const toggles = screen.getAllByRole('button', { name: 'toggle' })
    await userEvent.click(toggles[0]) // New group: all checked → uncheck all
    expect(screen.getByLabelText('select SkyUI_5_2.7z')).not.toBeChecked()
    expect(screen.getByLabelText('select ussep.7z')).not.toBeChecked()
    expect(screen.getByLabelText('select smim.7z')).toBeChecked() // other group untouched
    expect(screen.getByText('1 files · 1.0 KB')).toBeInTheDocument()
  })

  it('fetch from Nexus wires collection id into download, then jumps to Progress', async () => {
    const go = vi.fn()
    const { calls } = mockApi({ ...FETCH, 'POST /api/download': { started: 1 } })
    render(<ImportTab onGoToProgress={go} />)
    await fetchLinks()

    await userEvent.click(screen.getByRole('button', { name: 'Download selected' }))
    await waitFor(() => expect(go).toHaveBeenCalled())
    const dl = calls.find((c) => c.path === '/api/download')
    expect(dl?.body).toMatchObject({ modlist: { fromNexus: true }, file_ids: [1, 2, 3], collection_id: 42 })
  })

  it('requestCollectionImport queues a url that auto-fetches on mount', async () => {
    const { calls } = mockApi(FETCH)
    requestCollectionImport('https://nexus/collections/lorerim')
    const { unmount } = render(<ImportTab onGoToProgress={vi.fn()} />)

    expect(await screen.findByText('New · 2')).toBeInTheDocument()
    const fetch = calls.find((c) => c.path === '/api/fetch-collection')
    expect(fetch?.body).toEqual({ url: 'https://nexus/collections/lorerim' })

    // one-shot: remounting (tab switch away and back) must not refetch
    unmount()
    render(<ImportTab onGoToProgress={vi.fn()} />)
    expect(await screen.findByText('New · 2')).toBeInTheDocument()
    expect(calls.filter((c) => c.path === '/api/fetch-collection').length).toBe(1)
  })

  it('empty url on fetch → inline hint', async () => {
    mockApi({})
    render(<ImportTab onGoToProgress={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Fetch from Nexus' }))
    expect(await screen.findByText('paste one or more Nexus links first')).toBeInTheDocument()
  })
})
