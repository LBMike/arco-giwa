// Pure helpers for the Portfolio page's product views (All Portfolio / Savings / Funds / Stocks) and its Net Worth
// change. No React or I/O, so they run under `npm run test:frontend`.
import type { GiwaPriceHistory } from "./api"
import { vaultConfigOf } from "./catalog"
import type { RawPoint } from "./detail-charts"
import type { GiwaCatalogItem } from "./types"

export const PORTFOLIO_VIEWS = [
  { id: "all", label: "All Portfolio" },
  { id: "savings", label: "Savings" },
  { id: "funds", label: "Funds" },
  { id: "stocks", label: "Stocks" },
] as const
export type PortfolioView = (typeof PORTFOLIO_VIEWS)[number]["id"]
export type PortfolioCategory = Exclude<PortfolioView, "all">
export const PORTFOLIO_CATEGORIES: readonly PortfolioCategory[] = ["savings", "funds", "stocks"]
export const CATEGORY_LABEL: Readonly<Record<PortfolioCategory, string>> = { savings: "Savings", funds: "Funds", stocks: "Stocks" }

/** Savings vaults are the ones the Savings page opens (kind "saving"); every other GIWA product is a Fund. */
export function productPortfolioCategory(product: Pick<GiwaCatalogItem, "vaultConfig">): "savings" | "funds" {
  return vaultConfigOf(product).kind === "saving" ? "savings" : "funds"
}

export type AllocationSlice = {
  category: PortfolioCategory
  /** Current value of the holdings that have a price. */
  usd: number
  count: number
  /** Percent of the valued total, or null while nothing is valued. */
  share: number | null
  /** False when one of the holdings has no current price, so `usd` leaves it out. */
  complete: boolean
}

/** Current value per product line, in Savings, Funds, Stocks order. */
export function allocationOf(rows: readonly { category: PortfolioCategory; usd: number | null }[]): AllocationSlice[] {
  const total = rows.reduce((sum, row) => sum + (row.usd ?? 0), 0)
  return PORTFOLIO_CATEGORIES.map((category) => {
    const own = rows.filter((row) => row.category === category)
    const usd = own.reduce((sum, row) => sum + (row.usd ?? 0), 0)
    return { category, usd, count: own.length, share: total > 0 ? (usd / total) * 100 : null, complete: own.every((row) => row.usd != null) }
  })
}

export type ValueChange = { amount: number; pct: number | null }

/** Change across the visible points: last − first, and that as a percent of the first. */
export function valueChange(points: readonly RawPoint[]): ValueChange | null {
  if (points.length < 2) return null
  const first = points[0].value
  const last = points[points.length - 1].value
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null
  return { amount: last - first, pct: first > 0 ? ((last - first) / first) * 100 : null }
}

export type ChangeLabel = { text: string; dir: "up" | "down" | "flat" }

/** "+$12.34 (+0.52%)" or "-$3.21 (-0.14%)"; a change under half a cent is flat: "$0.00 (0.00%)". */
export function formatValueChange(change: ValueChange): ChangeLabel {
  const cents = Math.round(change.amount * 100)
  const dir = cents > 0 ? "up" : cents < 0 ? "down" : "flat"
  const amount = `${cents > 0 ? "+" : cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (change.pct == null || !Number.isFinite(change.pct)) return { text: amount, dir }
  const basis = Math.round(change.pct * 100)
  const pct = `${basis > 0 ? "+" : basis < 0 ? "-" : ""}${(Math.abs(basis) / 100).toFixed(2)}%`
  return { text: `${amount} (${dir === "flat" ? "0.00%" : pct})`, dir }
}

/** The earliest price point across the held vaults' histories, or null when none has one. */
export function historyStart(histories: readonly (GiwaPriceHistory | undefined)[]): number | null {
  let start: number | null = null
  for (const history of histories) {
    for (const point of history?.points ?? []) if (start === null || point.t < start) start = point.t
  }
  return start
}

/**
 * A vault's price history with its current USD price appended at `now`, so the Net Worth line ends at today's
 * valuation. Only a vault that already has history gets the point: one without history stays out of the line.
 */
export function withCurrentPrice(
  history: GiwaPriceHistory | undefined,
  current: { navUsd: number | null; navBase: number | null },
  now: number | null,
): GiwaPriceHistory | undefined {
  if (!history || history.points.length === 0 || now === null || current.navUsd == null || !(current.navUsd > 0)) return history
  const latest = history.points.reduce((a, b) => (b.t > a.t ? b : a))
  if (latest.t >= now) return history
  return { ...history, points: [...history.points, { t: now, navBase: current.navBase ?? latest.navBase, navUsd: current.navUsd }] }
}

export type DailyClose = { t: number; close: number }

/**
 * A stock holding's price line for the Net Worth chart, in the vault history shape: daily closes from `from` on (the
 * last close before `from` is carried to `from`, so the stock is priced where the Savings and Funds line starts), then
 * the current price at `now`. Without closes the line is empty and the stock stays out of the chart.
 */
export function stockPriceHistory(
  id: string,
  closes: readonly DailyClose[],
  options: { from: number | null; price: number | null; now: number | null },
): GiwaPriceHistory {
  const sorted = closes.filter((c) => Number.isFinite(c.t) && Number.isFinite(c.close) && c.close > 0).sort((a, b) => a.t - b.t)
  let points = sorted
  if (options.from !== null) {
    const from = options.from
    const before = sorted.filter((c) => c.t < from)
    const after = sorted.filter((c) => c.t >= from)
    const carried = before.length && after[0]?.t !== from ? [{ t: from, close: before[before.length - 1].close }] : []
    points = [...carried, ...after]
  }
  const price = options.price
  const now = options.now
  if (points.length && price !== null && price > 0 && now !== null && points[points.length - 1].t < now) points = [...points, { t: now, close: price }]
  return { productId: id, apy: null, points: points.map((c) => ({ t: c.t, navBase: c.close, navUsd: c.close })) }
}
