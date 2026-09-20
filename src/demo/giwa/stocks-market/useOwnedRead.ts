import { useEffect, useState } from "react"
import { startVisiblePolling } from "./polling"
export type ReadState<T> = { phase: "loading" } | { phase: "error" } | { phase: "ready"; value: T }
/** Render fence plus cancellation; even transports ignoring abort cannot publish an old key. */
export function useOwnedRead<T>(key: string, load: (signal: AbortSignal) => Promise<T>, refreshMs = 0): ReadState<T> {
  const [result, setResult] = useState<{ key: string; load: typeof load; state: ReadState<T> } | null>(null)
  useEffect(() => {
    const controller = new AbortController(); let live = true
    setResult({ key, load, state: { phase: "loading" } })
    const stop = startVisiblePolling(() => load(controller.signal).then(value => { if (live && !controller.signal.aborted) setResult({ key, load, state: { phase: "ready", value } }) }, () => { if (live && !controller.signal.aborted) setResult({ key, load, state: { phase: "error" } }) }), refreshMs)
    return () => { live = false; stop(); controller.abort() }
  }, [key, load, refreshMs])
  return result?.key === key && result.load === load ? result.state : { phase: "loading" }
}
