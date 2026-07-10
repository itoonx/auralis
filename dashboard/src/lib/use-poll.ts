// Stale-guarded polling: refetch whenever deps change; a response only lands if it's still the newest
// request, so switching project/run mid-flight can't leave another project's data on screen (which used
// to stick forever while paused). Errors surface instead of being swallowed; the last good data is kept
// so a blip doesn't blank the page. Pass fetcher = null to disable (e.g. before the project resolves).
import { useEffect, useRef, useState } from "react"

export function usePoll<T>(fetcher: (() => Promise<T>) | null, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; at: string }>({ data: null, error: null, at: "" })
  const req = useRef(0)
  useEffect(() => {
    if (!fetcher) return
    const id = ++req.current
    fetcher()
      .then((data) => { if (id === req.current) setState({ data, error: null, at: new Date().toLocaleTimeString() }) })
      .catch((e) => { if (id === req.current) setState((s) => ({ ...s, error: (e as Error).message })) })
    // Bumping on cleanup invalidates the in-flight request on dep change, unmount, and StrictMode re-runs.
    return () => { req.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}
