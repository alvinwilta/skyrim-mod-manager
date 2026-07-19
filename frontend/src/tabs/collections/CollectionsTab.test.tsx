import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CollectionsTab } from './CollectionsTab'
import { mockApi } from '../../test/mockApi'
import type { Collection } from '../../api/types'

afterEach(() => vi.unstubAllGlobals())

const coll = (over: Partial<Collection>): Collection => ({
  id: 1,
  slug: 'lorerim',
  name: 'Lorerim',
  url: 'https://nexus/collections/lorerim',
  enabled: true,
  mod_count: 10,
  downloaded_count: 4,
  rule_count: 3,
  ...over,
})

describe('CollectionsTab', () => {
  it('renders cards with counts; empty state otherwise', async () => {
    mockApi({ 'GET /api/collections': { collections: [coll({})] } })
    render(<CollectionsTab onImportMods={vi.fn()} />)
    expect(await screen.findByText('Lorerim')).toBeInTheDocument()
    expect(screen.getByText('4/10 downloaded · 3 order rule(s)')).toBeInTheDocument()
  })

  it('enable checkbox posts and reverts on error', async () => {
    const { calls } = mockApi({
      'GET /api/collections': { collections: [coll({})] },
      'POST /api/collections/1/enabled': { __status: 500, error: 'db locked' },
    })
    render(<CollectionsTab onImportMods={vi.fn()} />)
    const cb = await screen.findByLabelText('enable Lorerim')
    await userEvent.click(cb)
    expect(calls.find((c) => c.path === '/api/collections/1/enabled')?.body).toEqual({ enabled: false })
    await waitFor(() => expect(cb).toBeChecked()) // reverted
    expect(await screen.findByText('db locked')).toBeInTheDocument()
  })

  it('Remove mods previews, confirms, posts, and refreshes', async () => {
    const { calls } = mockApi({
      'GET /api/collections': { collections: [coll({})] },
      'GET /api/collections/1/removable': { removable: 5, shared: 2 },
      'POST /api/collections/1/remove-mods': { deleted: 5, files_removed: 5, shared_kept: 2 },
    })
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    )
    render(<CollectionsTab onImportMods={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove mods' }))

    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/collections/1/remove-mods')).toBeTruthy(),
    )
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Remove 5 archive(s)'))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('2 mod(s) shared'))
    // refreshed the list afterwards
    expect(calls.filter((c) => c.path === '/api/collections').length).toBe(2)
  })

  it('Remove mods with nothing exclusive shows hint, no confirm, no post', async () => {
    const { calls } = mockApi({
      'GET /api/collections': { collections: [coll({})] },
      'GET /api/collections/1/removable': { removable: 0, shared: 7 },
    })
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    )
    render(<CollectionsTab onImportMods={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove mods' }))

    expect(await screen.findByText(/all 7 downloaded mods are shared/)).toBeInTheDocument()
    expect(window.confirm).not.toHaveBeenCalled()
    expect(calls.find((c) => c.path === '/api/collections/1/remove-mods')).toBeFalsy()
  })

  it('Import mods hands the collection url to the callback', async () => {
    mockApi({ 'GET /api/collections': { collections: [coll({})] } })
    const onImport = vi.fn()
    render(<CollectionsTab onImportMods={onImport} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Import mods' }))
    expect(onImport).toHaveBeenCalledWith('https://nexus/collections/lorerim')
  })

  it('expanding lazy-loads mods exactly once', async () => {
    const { calls } = mockApi({
      'GET /api/collections': { collections: [coll({})] },
      'GET /api/collections/1/mods': {
        mods: [
          { mod_name: 'SkyUI', mod_url: 'https://n/skyui', bucket: 3, locked: true, downloaded: true },
          { mod_name: 'ELFX', mod_url: 'https://n/elfx', bucket: null, locked: false, downloaded: false },
        ],
        buckets: { '3': 'Interface' },
      },
    })
    render(<CollectionsTab onImportMods={vi.fn()} />)
    const title = await screen.findByText('Lorerim')

    await userEvent.click(title) // expand
    expect(await screen.findByText('SkyUI')).toBeInTheDocument()
    expect(screen.getByText('3 · Interface')).toBeInTheDocument()
    expect(screen.getByText('? · Unsorted')).toBeInTheDocument()
    expect(screen.getByText('(not downloaded)')).toBeInTheDocument()

    await userEvent.click(title) // collapse
    expect(screen.queryByText('SkyUI')).not.toBeInTheDocument()
    await userEvent.click(title) // re-expand: no refetch
    expect(await screen.findByText('SkyUI')).toBeInTheDocument()
    expect(calls.filter((c) => c.path === '/api/collections/1/mods').length).toBe(1)
  })
})
