// Pure, unit-testable series + range helpers for the vault-detail Performance card.
// No React/I/O so they run under `npm run test:frontend`. Points carry a numeric unix
// `ts` so the range selector can filter before the chart formats the axis label.
import type { GiwaPriceHistory } from "./api"
import type { GiwaChartPoint } from "./PortfolioChart"
import { impliedApyPercent } from "./price-policy"

const SECONDS_PER_DAY = 86_400
const SECONDS_PER_YEAR = 365 * SECONDS_PER_DAY

// APY-series guards. Annualizing a tiny inter-post gap explodes (a 0.1% move over 17 min
// → astronomical), so ignore intervals shorter than this, and clamp any residual outlier
// to a sane display bound. Keeps the curve consistent with the last-interval headline.
const MIN_APY_PERIOD_DAYS = 0.25
const APY_CLAMP_PERCENT = 1000

export type RawPoint = { ts: number; value: number }
export type ChartRange = "7D" | "30D" | "90D" | "1Y" | "All"

export function tsLabel(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

function sortedPosts(history: GiwaPriceHistory | undefined) {
  return (history?.points ?? []).filter((point) => point.navBase != null).slice().sort((a, b) => a.t - b.t)
}

// Legacy Performance series (the 6 built-ins): real navUsd history at >=3 indexed points,
// else a 30-day APY-implied "projected" curve anchored at the current navUsd.
export function buildProductSeries(
  history: GiwaPriceHistory | undefined,
  currentNavUsd: number | null,
  apy: number | null,
  now: number,
): { points: RawPoint[]; projected: boolean } {
  const real = (history?.points ?? [])
    .filter((point) => point.navUsd != null)
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((point) => ({ ts: point.t, value: round4(point.navUsd as number) }))
  if (real.length >= 3) return { points: real, projected: false }
  if (currentNavUsd == null || currentNavUsd <= 0 || apy == null || apy <= 0) return { points: real, projected: false }

  const days = 30
  const points: RawPoint[] = []
  for (let i = days; i >= 0; i -= 1) {
    const ts = now - i * SECONDS_PER_DAY
    const yearsBack = (i * SECONDS_PER_DAY) / SECONDS_PER_YEAR
    points.push({ ts, value: round4(currentNavUsd / Math.pow(1 + apy / 100, yearsBack)) })
  }
  return { points, projected: true }
}

// Registered-vault Performance: the real posted share price (navBase) over time. <2 posts
// renders the chart's empty state.
export function buildRegisteredPriceSeries(
  history: GiwaPriceHistory | undefined,
): { points: RawPoint[]; projected: boolean } {
  const points = sortedPosts(history).map((point) => ({ ts: point.t, value: round4(point.navBase) }))
  return { points: points.length >= 2 ? points : [], projected: false }
}

// APY history: implied APY per interval, skipping short gaps (unstable annualization) and
// clamping outliers. The last kept interval matches the market's last-pair impliedApy that
// the list/stat/headline show.
export function buildApySeries(history: GiwaPriceHistory | undefined): RawPoint[] {
  const posts = sortedPosts(history)
  const series: RawPoint[] = []
  for (let i = 1; i < posts.length; i += 1) {
    const prev = posts[i - 1]
    const point = posts[i]
    const periodDays = (point.t - prev.t) / SECONDS_PER_DAY
    if (periodDays < MIN_APY_PERIOD_DAYS) continue
    const apy = impliedApyPercent({ basePrice: prev.navBase, newPrice: point.navBase, periodDays })
    if (apy == null) continue
    const clamped = Math.max(-APY_CLAMP_PERCENT, Math.min(APY_CLAMP_PERCENT, apy))
    series.push({ ts: point.t, value: round4(clamped) })
  }
  return series
}

const RANGE_DAYS: Record<Exclude<ChartRange, "All">, number> = { "7D": 7, "30D": 30, "90D": 90, "1Y": 365 }

export function filterByRange(points: RawPoint[], range: ChartRange, now: number): RawPoint[] {
  if (range === "All" || points.length === 0) return points
  const cutoff = now - RANGE_DAYS[range] * SECONDS_PER_DAY
  return points.filter((point) => point.ts >= cutoff)
}

// Default range: 30D, or All when the data spans less than 30 days (like legacy).
export function defaultRange(points: RawPoint[]): ChartRange {
  if (points.length < 2) return "All"
  const spanDays = (points[points.length - 1].ts - points[0].ts) / SECONDS_PER_DAY
  return spanDays >= 30 ? "30D" : "All"
}

export function toChartPoints(points: RawPoint[]): GiwaChartPoint[] {
  return points.map((point) => ({ t: tsLabel(point.ts), value: point.value }))
}

// Price return over the visible range (relative %, first → last).
export function priceReturnPct(points: RawPoint[]): number | null {
  if (points.length < 2 || !(points[0].value > 0)) return null
  return (points[points.length - 1].value / points[0].value - 1) * 100
}

// APY change over the visible range (absolute percentage points, first → last).
export function apyChangePct(points: RawPoint[]): number | null {
  if (points.length < 2) return null
  return round4(points[points.length - 1].value - points[0].value)
}
