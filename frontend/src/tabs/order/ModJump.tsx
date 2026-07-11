import type { ReactNode } from 'react'

/**
 * In-page jump link for a mod id: scrolls the order table to that mod's row.
 * The click handler comes from OrderTab (scrollToMod + a "hidden by filter"
 * message on miss) so every result list shares one behavior.
 */
export function ModJumpLink({
  id,
  name,
  onJump,
  children,
}: {
  id: number
  name?: string
  onJump: (id: number) => void
  children?: ReactNode
}) {
  return (
    <a
      href="#"
      className="modjump"
      title={`jump to ${name || `mod ${id}`} in the list below`}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onJump(id)
      }}
    >
      {children ?? id}
    </a>
  )
}

/**
 * Renders a freeform result line (Claude refine notes) with every mod id that
 * exists in the current install order turned into a jump link. Numbers not in
 * the order (versions, counts, unknown ids) stay plain text.
 */
export function NoteText({
  text,
  names,
  onJump,
}: {
  text: string
  names: ReadonlyMap<number, string>
  onJump: (id: number) => void
}) {
  const parts = text.split(/(-?\d+)/)
  return (
    <>
      {parts.map((p, i) => {
        if (/^-?\d+$/.test(p)) {
          const id = Number(p)
          if (names.has(id)) return <ModJumpLink key={i} id={id} name={names.get(id)} onJump={onJump} />
        }
        return p
      })}
    </>
  )
}
