/** Pulse duration must outlast the CSS animation (0.8s × 3 iterations). */
const FLASH_MS = 2600

/** Pending un-flash timers, so re-clicking a row restarts its pulse cleanly. */
const flashTimers = new WeakMap<Element, number>()

function flash(el: HTMLElement) {
  window.clearTimeout(flashTimers.get(el))
  // drop + reflow + re-add so the animation restarts on repeated clicks
  el.classList.remove('row-flash')
  void el.offsetWidth
  el.classList.add('row-flash')
  flashTimers.set(
    el,
    window.setTimeout(() => el.classList.remove('row-flash'), FLASH_MS),
  )
}

/**
 * Scroll the order-table row for a mod into view and flash it. Centered
 * (`block: 'center'`) so the row lands with comfortable context above and
 * below instead of hugging the viewport edge. Returns false when the row
 * isn't rendered — i.e. hidden by the current category/group/locked filter.
 */
export function scrollToMod(modId: number): boolean {
  const el = document.querySelector(`tr.ordrow[data-mid="${modId}"]`)
  if (!(el instanceof HTMLElement)) return false
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  // The smooth scroll takes time — flashing now would finish before the row
  // is even on screen. Pulse once the row actually enters the viewport (the
  // observer fires immediately if it's already visible).
  if (typeof IntersectionObserver === 'undefined') {
    flash(el) // jsdom / very old browsers
    return true
  }
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      io.disconnect()
      flash(el)
    },
    { threshold: 0.5 },
  )
  io.observe(el)
  // safety net: never leave a dangling observer if the scroll gets interrupted
  window.setTimeout(() => io.disconnect(), 5000)
  return true
}
