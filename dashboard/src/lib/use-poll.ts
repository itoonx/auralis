// Stale-guarded polling: refetch whenever deps change; a response only lands if it's still the newest
// request, so switching project/run mid-flight can't leave another project's data on screen. Errors
// surface instead of being swallowed; the last good data is kept so a blip doesn't blank the page.
// Dep changes abort the in-flight fetch (the fetcher receives an AbortSignal), and every request also
// carries an 8s timeout inside api.ts — a hung oracle can no longer wedge a panel forever.
// Pass fetcher = null to disable (e.g. before the project resolves).
import { useEffect, useRef, useState } from "react"

export interface PollState<T> {
  data: T | null
  error: string | null
  /** Epoch ms of the last successful response — 0 until one lands. Drives the stale badge. */
  atMs: number
}

export function usePoll<T>(fetcher: ((signal: AbortSignal) => Promise<T>) | null, deps: unknown[]): PollState<T> {
  const [state, setState] = useState<PollState<T>>({ data: null, error: null, atMs: 0 })
  const req = useRef(0)
  useEffect(() => {
    if (!fetcher) return
    const id = ++req.current
    const ctrl = new AbortController()
    fetcher(ctrl.signal)
      .then((data) => { if (id === req.current) setState({ data, error: null, atMs: Date.now() }) })
      // Aborted requests never get here as the newest id (cleanup bumps it first), so an abort on
      // project-switch can't masquerade as an oracle error.
      .catch((e) => { if (id === req.current) setState((s) => ({ ...s, error: (e as Error).message })) })
    return () => { req.current++; ctrl.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}
