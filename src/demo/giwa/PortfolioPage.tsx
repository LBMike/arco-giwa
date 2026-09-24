import { useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { ArrowUp, Wallet } from "lucide-react"
import { giwaApi, type GiwaMarketEntry, type GiwaPriceHistory } from "./api"
import { readShareSupply, readTokenBalance } from "./contracts"
import { positionUsdValue } from "./usd-prices"
import { GiwaActivityTable, GiwaHoldingsTable, type HoldingPriceCell } from "./components"
import { buildActivityFeed } from "./activity-feed"
import { formatPriceDelta, navSharePriceValue, priceChange24hPct } from "./price-policy"
import { GiwaTwoMetricChartCard, pctLabel, type ChartMetric } from "./TwoMetricChartCard"
import { apyChangePct, priceReturnPct } from "./detail-charts"
import { buildNetRateSeries, buildNetWorthSeries } from "./portfolio-series"
import { nextSort, sortByNumericKey } from "./sort"
import { GIWA_CHAIN_ID } from "./config"
import { GIWA_FUNDS_ROUTE } from "./routes"
import type { GiwaCatalogItem, GiwaPortfolio, HexAddress } from "./types"
import { useGiwaWallet } from "./wallet"
import { aumLabel } from "../data/products"
import { money } from "../lib/format"

const TABS = [
  { id: "portfolio", label: "Portfolio" },
  { id: "activity", label: "Activity" },
] as const
type Tab = (typeof TABS)[number]["id"]

type RawHolding = { product: GiwaCatalogItem; shares: number }
// `navBase` is the current NAV/share in the payment asset (what the Price/24hΔ column shows);
// `delta24h` is its 24h % change, null when the vault has no indexed price history.
type Holding = RawHolding & {
  navUsd: number | null
  apy: number | null
  usd: number | null
  navBase: number | null
  delta24h: number | null
}

// Backend positions aren't indexed (services/evm-portfolio-service returns []), so the held
// products + share counts are derived on-chain (balanceOf, formatUnits by token decimals).
// Pricing/APY come live from the backend market endpoint so operator updates flow through.
async function readHoldings(products: GiwaCatalogItem[], account: HexAddress): Promise<RawHolding[]> {
  const candidates = products.filter((p) => p.productTokenAddress)
  const withBalance = await Promise.all(
    candidates.map(async (product) => {
      const { decimals } = await readShareSupply(product.productTokenAddress as HexAddress)
      const shares = Number(await readTokenBalance(product.productTokenAddress as HexAddress, account, decimals))
      return { product, shares }
    }),
  )
  return withBalance.filter((h) => Number.isFinite(h.shares) && h.shares > 0)
}

export default function GiwaPortfolioPage() {
  const wallet = useGiwaWallet()
  const [tab, setTab] = useState<Tab>("portfolio")
  // Holdings list sort: numeric Balance / 24hΔ / Your Deposit / APY, null-last; default Your Deposit desc.
  const [holdingsSort, setHoldingsSort] = useState<{ key: "balance" | "delta" | "deposit" | "apy"; dir: "asc" | "desc" }>({
    key: "deposit",
    dir: "desc",
  })

  const catalogQuery = useQuery({ queryKey: ["giwa", "catalog"], queryFn: giwaApi.catalog })
  const products = catalogQuery.data ?? []

  // Live: refetch keeps NAV/APY current and reflects operator price updates.
  const marketQuery = useQuery({
    queryKey: ["giwa", "market", GIWA_CHAIN_ID],
    queryFn: () => giwaApi.market(GIWA_CHAIN_ID),
    refetchInterval: 45_000,
  })
  const marketByProduct = new Map<string, GiwaMarketEntry>((marketQuery.data ?? []).map((m) => [m.productId, m]))

  const holdingsQuery = useQuery({
    queryKey: ["giwa", "portfolio-holdings", wallet.address, products.map((p) => p.productId).join(",")],
    queryFn: () => readHoldings(products, wallet.address as HexAddress),
    enabled: Boolean(wallet.address && products.length),
  })
  const rawHoldings = holdingsQuery.data ?? []
  const heldIds = rawHoldings.map((h) => h.product.productId)

  const historyQuery = useQuery({
    queryKey: ["giwa", "price-history", heldIds.join(",")],
    queryFn: async () => {
      const entries = await Promise.all(heldIds.map(async (id) => [id, await giwaApi.priceHistory(GIWA_CHAIN_ID, id)] as const))
      return Object.fromEntries(entries) as Record<string, GiwaPriceHistory>
    },
    enabled: heldIds.length > 0,
    refetchInterval: 60_000,
  })

  const activityQuery = useQuery({
    queryKey: ["giwa", "activity", wallet.address],
    queryFn: () => giwaApi.activity(wallet.address!),
    enabled: Boolean(wallet.address),
  })

  // Request-based redemptions are the second Activity stream: buildActivityFeed merges them with
  // the indexed deposit/instant-redeem events (and drops FaucetDrip et al.) into one feed.
  const redemptionsQuery = useQuery({
    queryKey: ["giwa", "redemptions", wallet.address],
    queryFn: () => giwaApi.redemptions(wallet.address!),
    enabled: Boolean(wallet.address),
  })

  const holdings: Holding[] = rawHoldings.map((h) => {
    const entry = marketByProduct.get(h.product.productId)
    const navUsd = entry?.navUsd ?? null
    // Resolved current APY per vault: published rate, else implied-from-posts (matches the
    // vault list/detail), so registered vaults (e.g. bEQTY) contribute to Net Rate too.
    const apy = entry?.apy ?? entry?.impliedApy ?? null
    // Price/24hΔ: current NAV/share (live market, else the newest indexed post) and its 24h
    // change from the same price history the Net Worth chart already fetches.
    const points = (historyQuery.data ?? {})[h.product.productId]?.points ?? []
    const navBase = entry?.navBase ?? (points.length ? points[points.length - 1].navBase : null)
    const delta24h = priceChange24hPct(points)
    return {
      ...h,
      navUsd,
      apy,
      usd: navUsd != null ? positionUsdValue({ shares: h.shares, navUsd }) : null,
      navBase,
      delta24h,
    }
  })
  const valued = holdings.filter((h) => h.usd != null)
  const totalUsd = valued.reduce((sum, h) => sum + (h.usd as number), 0)
  const incomplete = holdings.some((h) => h.usd == null)
  const netWorthLabel =
    holdingsQuery.isLoading || marketQuery.isLoading
      ? "—"
      : holdings.length === 0
        ? aumLabel(0)
        : valued.length === 0
          ? "—"
          : aumLabel(totalUsd)

  // Blended APY weights only holdings that HAVE an APY — never diluted by null-APY products.
  const apyHoldings = holdings.filter((h) => h.apy != null && h.usd != null)
  const apyWeight = apyHoldings.reduce((sum, h) => sum + (h.usd as number), 0)
  const blendedApy =
    apyHoldings.length > 0 && apyWeight > 0
      ? apyHoldings.reduce((sum, h) => sum + (h.apy as number) * (h.usd as number), 0) / apyWeight
      : null

  // Net Worth / Net Rate series from current shares × per-vault price/apy history.
  const seriesPositions = holdings.map((h) => ({ shares: h.shares, history: (historyQuery.data ?? {})[h.product.productId] }))
  const netWorthMetric: ChartMetric = {
    key: "networth",
    label: "Net Worth",
    series: buildNetWorthSeries(seriesPositions),
    headline: netWorthLabel,
    valueFormat: aumLabel,
    delta: priceReturnPct,
    emptyLabel: "No net worth history yet",
  }
  const netRateMetric: ChartMetric = {
    key: "netrate",
    label: "Net Rate",
    series: buildNetRateSeries(seriesPositions),
    headline: blendedApy != null ? pctLabel(blendedApy) : "—",
    valueFormat: pctLabel,
    delta: apyChangePct,
    emptyLabel: "No net rate history yet",
  }

  // Sort holdings upstream (numeric values live here) so positions/depositUsd/apyValues/priceCells
  // stay index-aligned; the table renders in this order. Aggregates above are order-independent.
  const holdingKey = (h: Holding) =>
    holdingsSort.key === "balance"
      ? h.shares
      : holdingsSort.key === "delta"
        ? h.delta24h
        : holdingsSort.key === "deposit"
          ? h.usd
          : h.apy
  const ordered = sortByNumericKey(holdings, holdingKey, holdingsSort.dir, (h) => h.product.symbol)
  const positions = ordered.map((h) => ({ productId: h.product.productId, balance: trimShares(h.shares), status: "Held" }))
  const depositUsd = ordered.map((h) => (h.usd != null ? money(h.usd) : null))
  const apyValues = ordered.map((h) => (h.apy != null ? `${trimPct(h.apy)}%` : null))
  // "—" when the vault has no price history (delta24h null) or no NAV to show.
  const priceCells: HoldingPriceCell[] = ordered.map((h) => {
    if (h.delta24h == null || h.navBase == null) return null
    const delta = formatPriceDelta(h.delta24h)
    return { price: navSharePriceValue(h.navBase), deltaText: delta.text, up: delta.up }
  })
  const portfolio = {
    walletAddress: wallet.address ?? "",
    chainId: GIWA_CHAIN_ID,
    positions,
    redemptions: [],
  } as unknown as GiwaPortfolio

  if (!wallet.address) {
    return (
      <EmptyState
        title="Connect your wallet"
        body="Connect the GIWA wallet to see your portfolio and holdings valued in USD."
        action={
          <button
            type="button"
            onClick={() => void wallet.connect()}
            className="mt-1 inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-arco-ink)] px-4 py-2 text-sm font-medium text-[var(--color-arco-on-dark)]"
          >
            <Wallet className="size-4" />
            Connect wallet
          </button>
        }
      />
    )
  }

  return (
    <div className="w-full space-y-8">
      <div
        className="flex items-start justify-between gap-6 rounded-[var(--radius-strategy)] bg-[var(--color-arco-surface)] p-6"
        style={{ boxShadow: "var(--shadow-control)" }}
      >
        <div className="flex flex-col gap-1">
          <span className="text-sm text-[var(--color-arco-muted)]">Net Worth</span>
          <span className="tabular-nums text-4xl font-medium tracking-tight text-[var(--color-arco-ink)]">{netWorthLabel}</span>
          {incomplete && valued.length > 0 && (
            <span className="text-[11px] text-[var(--color-arco-muted)]">Partial — some asset prices are unavailable</span>
          )}
        </div>
        <div
          className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface-muted)] px-5 py-3"
          style={{ boxShadow: "var(--shadow-control)" }}
        >
          <span className="text-xs text-[var(--color-arco-muted)]">Net Rate</span>
          <div className="mt-1 flex items-center gap-4">
            <span className="tabular-nums text-2xl font-medium text-[var(--color-arco-ink)]">
              {blendedApy != null ? `${trimPct(blendedApy)}%` : "—"}
            </span>
            <span className="flex items-center gap-1 rounded-[var(--radius-control)] bg-[var(--color-arco-chip)] px-2 py-1">
              <ArrowUp className="size-3 text-[var(--color-arco-up)]" />
              <span className="text-xs text-[var(--color-arco-text-soft)]">APY</span>
            </span>
          </div>
        </div>
      </div>

      <GiwaTwoMetricChartCard metrics={[netWorthMetric, netRateMetric]} />

      <section className="space-y-4">
        <nav aria-label="Portfolio sections" className="flex items-center gap-6 border-b border-[var(--color-arco-border)]">
          {TABS.map((t) => {
            const active = tab === t.id
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={active ? "true" : undefined}
                className={`relative -mb-px py-2.5 text-sm ${
                  active ? "font-semibold text-[var(--color-arco-ink)]" : "text-[var(--color-arco-text)]"
                }`}
              >
                {t.label}
                {active && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[var(--color-arco-ink)]" />}
              </button>
            )
          })}
        </nav>

        {tab === "portfolio" ? (
          holdings.length === 0 && !holdingsQuery.isLoading ? (
            <EmptyState
              title="No holdings yet"
              body="Deposit into a product to start building your portfolio."
              action={
                <Link
                  to={GIWA_FUNDS_ROUTE}
                  className="mt-1 inline-flex items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-arco-border)] px-4 py-2 text-sm font-medium text-[var(--color-arco-ink)]"
                >
                  Browse products
                </Link>
              }
            />
          ) : (
            <GiwaHoldingsTable
              portfolio={portfolio}
              products={products}
              depositUsd={depositUsd}
              apyValues={apyValues}
              priceCells={priceCells}
              sortKey={holdingsSort.key}
              sortDir={holdingsSort.dir}
              onSort={(key) => setHoldingsSort((current) => nextSort(current, key))}
            />
          )
        ) : (
          <GiwaActivityTable rows={buildActivityFeed(activityQuery.data ?? [], redemptionsQuery.data ?? [], products)} />
        )}
      </section>
    </div>
  )
}

function trimPct(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, "")
}

function trimShares(n: number): string {
  return n.toFixed(6).replace(/\.?0+$/, "")
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div
      className="flex w-full flex-col items-center gap-3 rounded-[var(--radius-strategy)] bg-[var(--color-arco-surface)] p-10 text-center"
      style={{ boxShadow: "var(--shadow-control)" }}
    >
      <Wallet className="size-6 text-[var(--color-arco-muted)]" />
      <h2 className="text-lg font-semibold text-[var(--color-arco-ink)]">{title}</h2>
      <p className="max-w-[420px] text-sm text-[var(--color-arco-text-soft)]">{body}</p>
      {action}
    </div>
  )
}
