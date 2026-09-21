/** One in-flight read; hidden tabs pause and returning tabs respect the last read time. */
export function startVisiblePolling(task: () => Promise<void>, intervalMs: number, visibility: Pick<Document, "hidden" | "addEventListener" | "removeEventListener"> = document) {
  let stopped = false, running = false, lastStarted = -Infinity
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (delay: number) => {
    timer = setTimeout(() => void run(), delay)
    // Node-based render harnesses need not stay alive for browser refresh timers.
    if (typeof timer === "object") timer.unref?.()
  }
  const run = async () => {
    clearTimeout(timer)
    if (stopped || running || (intervalMs > 0 && visibility.hidden)) return
    const remaining = intervalMs - (Date.now() - lastStarted)
    if (remaining > 0) { schedule(remaining); return }
    running = true; lastStarted = Date.now()
    try { await task() } finally {
      running = false
      if (!stopped && intervalMs > 0 && !visibility.hidden) schedule(intervalMs)
    }
  }
  const changed = () => { clearTimeout(timer); if (!visibility.hidden) void run() }
  if (intervalMs > 0) visibility.addEventListener("visibilitychange", changed)
  void run()
  return () => { stopped = true; clearTimeout(timer); visibility.removeEventListener("visibilitychange", changed) }
}
