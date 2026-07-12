import { useMemo, useState } from "react"
import type { GiwaMarketEntry, GiwaPriceHistory } from "./api"
import {
  apyChangePct,
  buildApySeries,
  buildProductSeries,
  buildRegisteredPriceSeries,
  priceReturnPct,
} from "./detail-charts"
import { GiwaTwoMetricChartCard, pctLabel, type ChartMetric } from "./TwoMetricChartCard"
import { marketApyText, navSharePrice } from "./price-policy"
import { aumLabel } from "../data/products"

// Vault-detail Performance card: a Price/APY toggle over one vault's series, rendered by the
// shared GiwaTwoMetricChartCard. Price = real navBase history (built-ins keep the legacy
// series + projected curve); APY = implied-from-posts, headline reuses market impliedApy.
export function GiwaPerformanceCard({
  market,
  history,
  isBuiltIn,
  initialMetric = "price",
  now: nowProp,
}: {
  market: GiwaMarketEntry | null
  history: GiwaPriceHistory | undefined
  isBuiltIn: boolean
  initialMetric?: "price" | "apy"
  now?: number
}) {
  const [now] = useState(() => nowProp ?? Math.floor(Date.now() / 1000))

  const priceSeries = useMemo(
    () =>
      isBuiltIn
        ? buildProductSeries(history, market?.navUsd ?? null, market?.apy ?? null, now)
        : buildRegisteredPriceSeries(history),
    [isBuiltIn, history, market?.navUsd, market?.apy, now],
  )
  const apySeries = useMemo(() => buildApySeries(history), [history])

  const priceMetric: ChartMetric = {
    key: "price",
    label: "Price",
    series: priceSeries.points,
    headline: market?.navUsd != null ? navSharePrice(market.navUsd) : "—",
    valueFormat: isBuiltIn ? aumLabel : navSharePrice,
    delta: priceReturnPct,
    emptyLabel: "No performance data yet",
    projected: priceSeries.projected,
    projectedApy: market?.apy ?? null,
  }
  const apyMetric: ChartMetric = {
    key: "apy",
    label: "APY",
    series: apySeries,
    headline: marketApyText(market),
    valueFormat: pctLabel,
    delta: apyChangePct,
    emptyLabel: "No APY data yet",
    projected: false,
    projectedApy: market?.apy ?? null,
  }

  return (
    <GiwaTwoMetricChartCard
      metrics={[priceMetric, apyMetric]}
      initialIndex={initialMetric === "apy" ? 1 : 0}
      now={now}
    />
  )
}
