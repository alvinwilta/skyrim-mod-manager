import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NoteText } from './ModJump'

const names = new Map<number, string>([
  [50307, 'Alternate Perspective'],
  [96865, 'Voiced Addon'],
  [-42, 'Local Mod'],
])

describe('NoteText', () => {
  it('links only ids present in the order; other numbers stay plain text', async () => {
    const onJump = vi.fn()
    render(
      <NoteText
        text="50307 (Alternate Perspective) vs 96865 (Voiced Addon): addon wins, v1.2 needs 99999"
        names={names}
        onJump={onJump}
      />,
    )
    expect(screen.getByRole('link', { name: '50307' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '96865' })).toBeInTheDocument()
    // 1, 2 (version) and 99999 (not in order) are not links
    expect(screen.queryByRole('link', { name: '99999' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(2)

    await userEvent.click(screen.getByRole('link', { name: '96865' }))
    expect(onJump).toHaveBeenCalledWith(96865)
  })

  it('handles negative ids of locally-adopted mods', () => {
    render(<NoteText text="DUPLICATE: -42 duplicates 50307" names={names} onJump={() => {}} />)
    expect(screen.getByRole('link', { name: '-42' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '50307' })).toBeInTheDocument()
  })
})
