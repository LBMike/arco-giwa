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

/* ── Crypto Native and Gold savings vaults (aBTC, aXRP, ArcoGOLD) ────────────────────────────────────────────────────
 * Their rates are set figures (the market's published `apy`: server/src/registry/apy.ts), and their price feeds are
 * posted by hand now and then, so there is no rate history to draw. The APY chart shows a month of daily rates that
 * move inside the vault's band and arrive at the rate shown above the chart.
 *
 * Each day's rate depends only on the calendar day and the vault, so a day keeps its value from one visit to the
 * next; the last days lean toward today's rate so the line ends on it. Display only, like the sArcoUSD lead-in: the
 * Portfolio and the API read the real history, and the vault's price does not rise at these rates. Testnet; turn a
 * vault off by removing it from SAVINGS_VAULT_APY_BANDS.
 */
export type SavingsApyBand = Readonly<{ low: number; high: number }>

/** The band a vault's drawn rates stay inside, in percent, by product id. */
export const SAVINGS_VAULT_APY_BANDS: Readonly<Record<string, SavingsApyBand>> = {
  abtc: { low: 2, high: 3.5 },
  axrp: { low: 3, high: 5 },
  arcogold: { low: 2.5, high: 3.8 },
}

const BAND_DAYS = 30
/** Over the last days the line leans toward today's rate, so it arrives there without a jump. */
const LEAN_DAYS = 8

/** 0..1, slow waves over the calendar day; `phase` sets the vault's own line. */
function drift(day: number, phase: number): number {
  const wave = Math.sin(day / 4.7 + phase) * 0.5 + Math.sin(day / 11.3 + phase * 1.7) * 0.35 + Math.sin(day / 2.1 + phase * 2.9) * 0.15
  return (wave + 1) / 2
}

/** A number from the product id, so each vault draws its own line. */
function phaseOf(productId: string): number {
  let sum = 0
  for (const char of productId) sum = (sum * 31 + char.charCodeAt(0)) % 997
  return sum / 97
}

/**
 * The history the Savings APY chart draws for a banded vault: BAND_DAYS daily rates inside its band, ending now on
 * `apyNow` (the rate the page shows). Any other vault, or one with no rate to show, keeps its history as read.
 * `now` is in unix seconds.
 */
export function withBandedApy(
  history: GiwaPriceHistory | undefined,
  productId: string,
  apyNow: number | null,
  now: number,
  bands: Readonly<Record<string, SavingsApyBand>> = SAVINGS_VAULT_APY_BANDS,
): GiwaPriceHistory | undefined {
  const band = bands[productId.toLowerCase()]
  if (!band || apyNow === null || !Number.isFinite(apyNow)) return history
  const price = history?.points[history.points.length - 1]?.navBase ?? 1
  const phase = phaseOf(productId.toLowerCase())
  const today = Math.floor(now / DAY)
  // The drawn rates keep a little clear of the band's edges.
  const pad = (band.high - band.low) * 0.08
  const points: GiwaPriceHistoryPoint[] = []
  for (let back = BAND_DAYS; back >= 0; back -= 1) {
    const day = today - back
    const drawn = band.low + pad + drift(day, phase) * (band.high - band.low - 2 * pad) + wobble(day)
    // back 0 is now, on today's rate exactly; the days before lean toward it.
    const lean = back >= LEAN_DAYS ? 0 : 1 - back / LEAN_DAYS
    const apy = Math.min(band.high, Math.max(band.low, drawn + (apyNow - drawn) * lean))
    points.push({ t: back === 0 ? now : day * DAY, navBase: price, navUsd: price, apy: back === 0 ? apyNow : Math.round(apy * 100) / 100 })
  }
  return { productId: history?.productId ?? productId, apy: history?.apy ?? apyNow, points }
}
