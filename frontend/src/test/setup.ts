import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Without vitest `globals: true`, RTL can't self-register its cleanup hook.
afterEach(() => {
  cleanup()
  // App persists the active tab to localStorage; jsdom keeps it across tests in
  // the same file, so clear it to keep each test on a fresh (library) session.
  // Guarded: bare `localStorage` can resolve to Node's experimental global,
  // which throws when unconfigured — go through window (jsdom's real impl).
  try {
    window.localStorage.clear()
  } catch {
    /* no window/localStorage in this env */
  }
})

// jsdom has no ResizeObserver (sticky search bar uses it).
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub
}
