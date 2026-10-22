// The sArcoUSD APY chart's lead-in: a month of rates rising from SEED_FROM to SEED_TO, drawn where the account has no
// paid rate yet. sArcoUSD's first distributions start on 2026-10-23; until a month of them has built up, the chart
// would otherwise show a line at 0% (or a single point) beside the APY shown above it.
//
// The lead-in ends where the paid rate begins: at the first snapshot with a rate above 0, or now while there is none.
// Snapshots before that point (0%) are left out; every snapshot from it on is drawn as read. The lead-in is anchored
// to that point, so once it exists the drawn values stop moving, and the lead-in leaves the 30-day chart a month
// later. Turn it off with SAVINGS_APY_SEED.enabled.
//
// Display only: the Savings page's APY chart and sparkline. The Portfolio and the API read the real history.

import type { GiwaPriceHistory, GiwaPriceHistoryPoint } from "./api"

export type SavingsApySeed = Readonly<{
  enabled: boolean
  /** How many days the lead-in covers. */
  days: number
  /** APY in percent at the start of the lead-in. */
  from: number
  /** APY in percent where the paid rate begins. */
  to: number
}>

// to: the distributor's 4.5% APR cap compounded daily, the rate the account shows.
export const SAVINGS_APY_SEED: SavingsApySeed = { enabled: true, days: 30, from: 3.8, to: 4.6 }

const DAY = 86_400

/** A small fixed wobble per day (in percent), so the line reads like daily rates rather than a ruler. */
function wobble(day: number): number {
  const x = Math.sin(day * 12.9898) * 43_758.5453
  return (x - Math.floor(x) - 0.5) * 0.08
}

/**
 * The history the Savings APY chart draws for sArcoUSD: the seeded month up to where the paid rate begins, then the
 * snapshots as read. Undefined (no history read yet) stays undefined. `now` is in unix seconds.
 */
export function withSeededApy(history: GiwaPriceHistory | undefined, now: number, seed: SavingsApySeed = SAVINGS_APY_SEED): GiwaPriceHistory | undefined {
  if (!history || !seed.enabled) return history
  const points = [...history.points].sort((a, b) => a.t - b.t)
  const firstPaid = points.find((point) => typeof point.apy === "number" && point.apy > 0) ?? null
  const end = firstPaid?.t ?? now
  const start = end - seed.days * DAY
  const price = firstPaid?.navBase ?? points[points.length - 1]?.navBase ?? 1

  const seeded: GiwaPriceHistoryPoint[] = []
  for (let day = 0; day <= seed.days; day += 1) {
    const t = start + day * DAY
    // Rising from `from` to `to`; the first and last days are exact.
    const trend = seed.from + ((seed.to - seed.from) * day) / seed.days
    const apy = day === 0 || day === seed.days ? trend : trend + wobble(day)
    seeded.push({ t, navBase: price, navUsd: price, apy: Math.round(apy * 100) / 100 })
  }
  // While nothing has been paid the month ends now, on the last seeded day; once something has, the snapshots take
  // over from the first paid one (the seeded last day would sit on the same second, so it gives way).
  const real = firstPaid === null ? [] : withoutKeeperGaps(points.filter((point) => point.t >= firstPaid.t))
  return { ...history, points: [...(firstPaid === null ? seeded : seeded.slice(0, -1)), ...real] }
}

const paid = (point: GiwaPriceHistoryPoint | undefined) => typeof point?.apy === "number" && point.apy > 0

/**
 * Leaves out a lone 0% snapshot between two paid ones: the minutes between one distribution finishing its day and the
 * keeper sending the next (it checks every few minutes), not a stop in the yield.
 */
function withoutKeeperGaps(points: readonly GiwaPriceHistoryPoint[]): GiwaPriceHistoryPoint[] {
  return points.filter((point, i) => paid(point) || !(paid(points[i - 1]) && paid(points[i + 1])))
}
