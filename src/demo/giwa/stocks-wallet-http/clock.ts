import { fail } from "./errors"

/**
 * A wall clock for `WalletPorts.now` and this adapter that never runs behind the monotonic time elapsed since
 * it was created, while still following forward corrections.
 *
 * The wallet controller compares the execution policy, session and evidence lifetimes with `ports.now()`.
 * With a plain `Date.now`, a wall clock stepped back during a check (for less than that check's own elapsed
 * time) would make an already expired policy look valid again at wallet dispatch. With this clock it cannot.
 * It does not correct a device clock that was already wrong when the clock was created.
 */
export function createExecutionClock(options: { now?: () => number; monotonicNow?: () => number } = {}): () => number {
  const wall = options.now ?? Date.now
  const monotonic = options.monotonicNow ?? (() => performance.now())
  const anchorWall = wall()
  const anchorMonotonic = monotonic()
  if (!Number.isFinite(anchorWall) || !Number.isFinite(anchorMonotonic)) fail("INVALID_CONTEXT", "CLOCK")
  return () => {
    const current = wall()
    const elapsed = monotonic() - anchorMonotonic
    // An unusable reading fails closed: every lifetime check against NaN is false.
    if (!Number.isFinite(current) || !Number.isFinite(elapsed)) return Number.NaN
    return Math.max(current, anchorWall + Math.max(0, Math.floor(elapsed)))
  }
}
