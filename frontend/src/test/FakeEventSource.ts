/** Minimal EventSource stand-in for tests (jsdom has none). */
export class FakeEventSource {
  static instances: FakeEventSource[] = []

  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  close() {
    this.closed = true
  }

  emitOpen() {
    this.onopen?.()
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }

  emitError() {
    this.onerror?.()
  }

  static reset() {
    FakeEventSource.instances = []
  }

  static get last(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1]
  }

  /** Install as the global EventSource; returns an uninstall fn. */
  static install(): () => void {
    const prev = (globalThis as Record<string, unknown>).EventSource
    ;(globalThis as Record<string, unknown>).EventSource = FakeEventSource
    FakeEventSource.reset()
    return () => {
      ;(globalThis as Record<string, unknown>).EventSource = prev
    }
  }
}
