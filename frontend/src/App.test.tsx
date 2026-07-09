import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import App from './App'
import { FakeEventSource } from './test/FakeEventSource'
import { mockApi } from './test/mockApi'

let uninstall: () => void
beforeEach(() => {
  uninstall = FakeEventSource.install()
  mockApi({ 'GET /api/mods': [] }) // default Library tab loads on mount
})
afterEach(() => {
  uninstall()
  vi.unstubAllGlobals()
})

describe('App shell', () => {
  it('renders all six tabs and switches on click', async () => {
    render(<App />)
    for (const label of ['Library', 'Install Order', 'Collections', 'Import', 'Progress', 'Guide']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }

    await userEvent.click(screen.getByRole('button', { name: 'Guide' }))
    expect(screen.getByRole('button', { name: 'Guide' })).toHaveClass('on')
    expect(screen.getByRole('button', { name: 'Library' })).not.toHaveClass('on')
  })

  it('renders the Guide tab content', async () => {
    render(<App />)
    await userEvent.click(screen.getByRole('button', { name: 'Guide' }))
    expect(screen.getByRole('heading', { name: 'Install Order' })).toBeInTheDocument()
    expect(screen.getAllByText(/Sort \(heuristic\)/).length).toBeGreaterThan(0)
    expect(screen.getByText(/BSA-only/)).toBeInTheDocument()
  })
})
