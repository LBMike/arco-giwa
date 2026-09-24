import { useId } from "react"
import { Link } from "react-router-dom"
import { GIWA_STOCKS_ROUTE } from "../routes"
import { changeParts, compactDollars, priceLabel, volumeDollars } from "./display"
import type { HighlightGroups, HighlightRow } from "./highlights"
import { StockLogo } from "./StockLogo"
import { Triangle } from "./StocksMarketTable"

const FOCUS = "focus-visible:relative focus-visible:z-[1] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"

/** Home discovery cards use only the listed securities supplied by the market catalog. */
export function StocksHighlights({ groups, status }: { groups: HighlightGroups; status?: string }) {
  return <div className="grid w-full min-w-0 gap-6 lg:grid-cols-3" aria-label="Stock highlights">
    <HighlightCard title="Top Gainers" rows={groups.gainers} metric="change" period status={status} />
    <HighlightCard title="Trending" rows={groups.trending} metric="volume" period status={status} />
    <HighlightCard title="Newly Added" rows={groups.newlyAdded} metric="volume" status={status} />
  </div>
}

function HighlightCard({ title, rows, metric, period = false, status }: {
  title: string
  rows: readonly HighlightRow[]
  metric: "change" | "volume"
  period?: boolean
  status?: string
}) {
  const headingId = useId()
  return <section aria-labelledby={headingId} className="w-full min-w-0 rounded-3xl border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-3">
    <div className="flex min-h-10 items-center gap-2 px-3 py-2">
      <h2 id={headingId} title={title === "Newly Added" ? "Recently added to our catalog; products added together retain catalog order." : undefined} className="text-lg font-medium leading-6 text-[var(--color-arco-ink)]">{title}</h2>
      {period && <span className="rounded-full bg-[var(--color-arco-chip)] px-1.5 py-0.5 text-xs leading-4 text-[var(--color-arco-chip-ink)]">24H</span>}
    </div>
    <p className="sr-only">{metric === "change" ? "Price change compared with the previous close." : "Estimated session volume in USD, calculated as the latest price multiplied by traded shares."}</p>
    {rows.length > 0 ? <ul className="divide-y divide-[var(--color-arco-border)]">
      {rows.slice(0, 3).map(row => <HighlightItem key={row.security.symbol} row={row} metric={metric} />)}
    </ul> : <p role="status" className="flex min-h-[222px] items-center justify-center px-3 text-center text-sm text-[var(--color-arco-text-soft)]">{status ?? "No products to show"}</p>}
  </section>
}

function HighlightItem({ row: { security, quote }, metric }: { row: HighlightRow; metric: "change" | "volume" }) {
  return <li className="min-w-0">
    <Link to={`${GIWA_STOCKS_ROUTE}?symbol=${encodeURIComponent(security.symbol)}`} className={`flex min-h-[74px] min-w-0 items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-[var(--color-arco-surface-muted)] ${FOCUS}`}>
      <StockLogo symbol={security.symbol} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xl font-medium leading-7 text-[var(--color-arco-ink)]">{security.symbol}</span>
        <span title={security.name} className="block truncate text-sm leading-5 text-[var(--color-arco-text-soft)]">{security.name}</span>
      </span>
      <span className="shrink-0 text-right tabular-nums">
        <span className="block text-xl font-medium leading-7 text-[var(--color-arco-ink)]"><span className="sr-only">Price </span>{priceLabel(quote?.price ?? null)}</span>
        {metric === "change" ? <HighlightChange raw={quote?.changePercent ?? null} /> : <span className="block text-sm leading-5 text-[var(--color-arco-text-soft)]" title="Estimated session volume (latest price × traded shares)"><span className="sr-only">Estimated volume </span>{compactDollars(volumeDollars(quote?.price ?? null, quote?.sessionVolume ?? null))}</span>}
      </span>
    </Link>
  </li>
}

function HighlightChange({ raw }: { raw: string | null }) {
  const parts = changeParts(raw)
  if (!parts || parts.direction === "flat") return <span className="block text-sm leading-5 text-[var(--color-arco-text-soft)]">{parts ? `${parts.magnitude}%` : "—"}</span>
  const up = parts.direction === "up"
  return <span className={`inline-flex items-center justify-end gap-1 text-sm leading-5 ${up ? "text-[var(--color-arco-up-text)]" : "text-[var(--color-arco-down)]"}`}>
    <Triangle up={up} /><span className="sr-only">{up ? "Up " : "Down "}</span>{parts.magnitude}%
  </span>
}
