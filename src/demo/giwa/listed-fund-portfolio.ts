import type { BreakdownRow } from "../data/acapix-detail"
import { formatAsOf, type FundBreakdown, type ListedFund } from "./listed-funds"

/** One breakdown as Portfolio rows; a partial list gets its calculated remainder so the donut is not normalized to 100%. */
export function breakdownRows(view: FundBreakdown | undefined): BreakdownRow[] {
  if (!view) return []
  const rows: BreakdownRow[] = view.rows.map((row) => ({ label: row.label, value: null, pct: row.percent }))
  if (view.partial) {
    // Basis points keep the remainder exact.
    const listed = rows.reduce((sum, row) => sum + Math.round(row.pct * 100), 0)
    const remainder = 10_000 - listed
    if (remainder > 0) rows.push({ label: "Remaining weight (calculated)", value: null, pct: remainder / 100 })
  }
  return rows
}

/** Portfolio card data for a listed fund, or null when no breakdown is published. */
export function listedFundPortfolio(fund: ListedFund) {
  const { snapshot, industry, exposure } = fund.portfolio
  const views = [snapshot, industry, exposure].filter((view): view is FundBreakdown => Boolean(view))
  if (views.length === 0) return null
  const dates = views.map((view) => view.asOf).sort()
  const latest = dates[dates.length - 1]
  return {
    card: {
      updatedAt: formatAsOf(latest),
      note: views.map((view) => `${view.title}: ${view.scope}, ${view.sourceLabel}, ${formatAsOf(view.asOf)}.`).join(" "),
      total: null,
      snapshot: breakdownRows(snapshot),
      industry: breakdownRows(industry),
      exposure: breakdownRows(exposure),
    },
    enabledViews: { snapshot: Boolean(snapshot), industry: Boolean(industry), exposure: Boolean(exposure) },
    exposureHeading: exposure?.title ?? "Exposure",
  }
}
