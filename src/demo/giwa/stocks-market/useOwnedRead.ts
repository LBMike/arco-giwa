import { useEffect, useState } from "react"
export type ReadState<T> = { phase: "loading" } | { phase: "error" } | { phase: "ready"; value: T }
/** Render fence plus cancellation; even transports ignoring abort cannot publish an old key. */
export function useOwnedRead<T>(key: string, load: (signal: AbortSignal) => Promise<T>): ReadState<T> {
  const [result, setResult] = useState<{ key: string; load: typeof load; state: ReadState<T> } | null>(null)
  useEffect(() => {
    const controller = new AbortController(); let live = true
    setResult({ key, load, state: { phase: "loading" } })
    void load(controller.signal).then(value => { if (live && !controller.signal.aborted) setResult({ key, load, state: { phase: "ready", value } }) }, () => { if (live && !controller.signal.aborted) setResult({ key, load, state: { phase: "error" } }) })
    return () => { live = false; controller.abort() }
  }, [key, load])
  return result?.key === key && result.load === load ? result.state : { phase: "loading" }
}
