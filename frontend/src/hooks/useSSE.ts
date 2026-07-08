import { useEffect, useRef, useState } from 'react'

/**
 * EventSource subscription with auto-reconnect (2s after error, matching the
 * legacy UI). Safe under StrictMode double-mount: cleanup closes the source
 * and cancels any pending reconnect.
 */
export function useSSE<T>(url: string, onMessage: (data: T) => void, reconnectMs = 2000): { connected: boolean } {
  const [connected, setConnected] = useState(false)
  const handler = useRef(onMessage)
  handler.current = onMessage

  useEffect(() => {
    let es: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let disposed = false

    const connect = () => {
      es = new EventSource(url)
      es.onopen = () => setConnected(true)
      es.onmessage = (ev) => {
        try {
          handler.current(JSON.parse(ev.data) as T)
        } catch {
          // malformed frame — ignore
        }
      }
      es.onerror = () => {
        setConnected(false)
        es?.close()
        if (!disposed) timer = setTimeout(connect, reconnectMs)
      }
    }
    connect()

    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      es?.close()
      setConnected(false)
    }
  }, [url, reconnectMs])

  return { connected }
}
