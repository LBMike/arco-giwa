// A number that rolls to each new value instead of jumping, like a counter: the Savings deposit / withdraw screen rolls
// the savings token balance up (or down) to what it will be after the transfer as the amount changes.

import { useEffect, useRef, useState } from "react"

const ROLL_MS = 900

/** Fast at first, settling gently into the new figure. */
export function easeOutCubic(progress: number): number {
  const t = Math.min(1, Math.max(0, progress))
  return 1 - Math.pow(1 - t, 3)
}

/** The figure `elapsed` ms into a roll from `from` to `to` that lasts `duration` ms; exactly `to` once it is over. */
export function rollingValue(from: number, to: number, elapsed: number, duration: number): number {
  if (duration <= 0 || elapsed >= duration) return to
  return from + (to - from) * easeOutCubic(elapsed / duration)
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/**
 * `target`, rolled into: each new target is reached from whatever is showing (mid-roll too), easing out over
 * `duration` ms. The first value, a value after null, and every value under reduced motion show at once.
 */
export function useRollingNumber(target: number | null, duration = ROLL_MS): number | null {
  const [shown, setShown] = useState(target)
  const shownRef = useRef(target)
  useEffect(() => {
    const current = shownRef.current
    if (target === null || current === null || current === target || prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
      shownRef.current = target
      setShown(target)
      return
    }
    const from = current
    const to = target
    const start = performance.now()
    let frame = requestAnimationFrame(function roll(now: number) {
      const value = rollingValue(from, to, now - start, duration)
      shownRef.current = value
      setShown(value)
      if (value !== to) frame = requestAnimationFrame(roll)
    })
    return () => cancelAnimationFrame(frame)
  }, [target, duration])
  return shown
}
