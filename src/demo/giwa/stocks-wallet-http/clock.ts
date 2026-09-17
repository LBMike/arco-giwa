import { fail } from "./errors"

/**
 * A wall clock for `WalletPorts.now`, this adapter and the submission gate that never runs behind a monotonic
 * lower bound.
 *
 * The bound is anchored at the latest reading whose wall time was ahead of it, a forward correction or ordinary
 * progress. Later readings return at least that anchor plus the monotonic time elapsed since it, so a wall clock
 * that stalls or is stepped back never makes time run slower than it really passed after the last observation.
 * Forward corrections are followed and remembered.
 *
 * Guarantees and limits:
 * - Readings never decrease.
 * - A non-finite wall or monotonic reading, or a monotonic reading below the previous one, makes this clock
 *   return NaN from then on. Every lifetime check against NaN fails, so nothing gains lifetime or permission after
 *   an abnormal reading. Recovery means creating a new clock (and a new controller).
 * - A mistaken forward jump makes leases look expired until real time catches up. It never extends one.
 * - A device clock that is wrong and never corrected cannot be fixed here; the controller also bounds each
 *   execution policy by monotonic time on its own.
 */
export function createExecutionClock(options: { now?: () => number; monotonicNow?: () => number } = {}): () => number {
  const wall = options.now ?? Date.now
  const monotonic = options.monotonicNow ?? (() => performance.now())
  let anchorWall = wall()
  let anchorMonotonic = monotonic()
  let lastMonotonic = anchorMonotonic
  let broken = false
  if (!Number.isFinite(anchorWall) || !Number.isFinite(anchorMonotonic)) fail("INVALID_CONTEXT", "CLOCK")
  return () => {
    if (broken) return Number.NaN
    const currentWall = wall()
    const currentMonotonic = monotonic()
    if (!Number.isFinite(currentWall) || !Number.isFinite(currentMonotonic) || currentMonotonic < lastMonotonic) {
      broken = true
      return Number.NaN
    }
    lastMonotonic = currentMonotonic
    const floor = anchorWall + Math.floor(currentMonotonic - anchorMonotonic)
    if (currentWall > floor) {
      // Forward correction (or normal progress): remember it, and keep counting from here.
      anchorWall = currentWall
      anchorMonotonic = currentMonotonic
      return currentWall
    }
    return floor
  }
}
