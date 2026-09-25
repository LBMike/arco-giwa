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
import { apyChangePct, defaultRange, filterByRange, priceReturnPct, type ChartRange } from "./detail-charts"
import { buildNetRateSeries, buildNetWorthSeries } from "./portfolio-series"
import {
  allocationOf, CATEGORY_LABEL, formatValueChange, historyStart, PORTFOLIO_VIEWS, productPortfolioCategory, stockPriceHistory,
  valueChange, withCurrentPrice, type AllocationSlice, type ChangeLabel, type PortfolioCategory, type PortfolioView,
} from "./portfolio-view"
import { STOCK_DISPLAY, useStocksActivity, useStocksHolding, type StocksHolding } from "./portfolio-stocks"
import { nextSort, sortByNumericKey } from "./sort"
import { GIWA_CHAIN_ID } from "./config"
import { GIWA_FUNDS_ROUTE, GIWA_SAVINGS_ROUTE, GIWA_STOCKS_ROUTE } from "./routes"
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

// One holdings-table row: a GIWA product (Savings or Funds) or the Stocks token. `position` carries the
// table's display fields; a Stocks row names itself because it is not in the GIWA catalog.
type PortfolioRow = {
  key: string
  category: PortfolioCategory
  sortName: string
  units: number
  usd: number | null
  apy: number | null
  delta24h: number | null
  priceCell: HoldingPriceCell
  position: Record<string, string>
}
type SortKey = "balance" | "delta" | "deposit" | "apy"

const STOCK_ROW_ID = `stocks:${STOCK_DISPLAY.symbol}`
const SEGMENT_ACTIVE = "bg-[var(--color-arco-surface)] font-medium text-[var(--color-arco-ink)] shadow-[var(--shadow-control)]"
const SEGMENT_IDLE = "text-[var(--color-arco-muted)]"
const LINK_BUTTON =
  "mt-1 inline-flex items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-arco-border)] px-4 py-2 text-sm font-medium text-[var(--color-arco-ink)]"
const CHANGE_TONE: Record<ChangeLabel["dir"], string> = {
  up: "text-[var(--color-arco-up)]",
  down: "text-[var(--color-arco-down)]",
  flat: "text-[var(--color-arco-muted)]",
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
  const [view, setView] = useState<PortfolioView>("all")
  // Chosen chart range, shared with the Net Worth change above the chart; null follows the data (defaultRange).
  const [range, setRange] = useState<ChartRange | null>(null)
  const [now] = useState(() => Math.floor(Date.now() / 1000))
  // Holdings list sort: numeric Balance / 24hΔ / Your Deposit / APY, null-last; default Your Deposit desc.
  const [holdingsSort, setHoldingsSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
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
  const marketByProduct = new Map<string, GiwaMarketEntry>((marketQuery.isSuccess ? marketQuery.data : []).map((m) => [m.productId, m]))

  const holdingsQuery = useQuery({
    queryKey: ["giwa", "portfolio-holdings", wallet.address, products.map((p) => p.productId).join(",")],
    queryFn: () => readHoldings(products, wallet.address as HexAddress),
    enabled: Boolean(wallet.address && products.length),
  })
  const holdingsKnown = catalogQuery.isSuccess && (products.length === 0 || holdingsQuery.isSuccess)
  const holdingsError = catalogQuery.isError || (products.length > 0 && holdingsQuery.isError)
  const rawHoldings = holdingsKnown ? holdingsQuery.data ?? [] : []
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

  // The wallet's NVDA, read on GIWA like the balances above (no Stocks sign-in).
  const stocks = useStocksHolding(wallet.address ?? null)
  const stock: StocksHolding = stocks.holding
  // The third Activity stream: the wallet's Stocks trades and their GIWA transactions (public, no sign-in).
  const stocksActivity = useStocksActivity(wallet.address ?? null)
  const stockTrades = stocksActivity.activity.status === "ready" ? stocksActivity.activity.entries : []

  const history = historyQuery.isSuccess ? historyQuery.data : {}
  const activityError = catalogQuery.isError || activityQuery.isError || redemptionsQuery.isError
  const activityKnown = catalogQuery.isSuccess && activityQuery.isSuccess && redemptionsQuery.isSuccess && stocksActivity.activity.status !== "loading"
  const activityRows = activityKnown ? buildActivityFeed(activityQuery.data, redemptionsQuery.data, products, stockTrades) : []
  // Stocks trades that could not be read are said so; with nothing else to show that is an unconfirmed history.
  const stocksActivityError = stocksActivity.activity.status === "error"
  const refreshing = [catalogQuery, holdingsQuery, marketQuery, historyQuery, activityQuery, redemptionsQuery].some(query => query.isFetching) || stocks.fetching || stocksActivity.fetching
  const refresh = () => {
    void Promise.allSettled([
      catalogQuery.refetch(), marketQuery.refetch(), activityQuery.refetch(), redemptionsQuery.refetch(), stocks.refresh(), stocksActivity.refresh(),
      ...(products.length ? [holdingsQuery.refetch()] : []),
      ...(heldIds.length ? [historyQuery.refetch()] : []),
    ])
  }

  const holdings: Holding[] = rawHoldings.map((h) => {
    const entry = marketByProduct.get(h.product.productId)
    const navUsd = entry?.navUsd ?? null
    // Resolved current APY per vault: published rate, else implied-from-posts (matches the
    // vault list/detail), so registered vaults (e.g. bEQTY) contribute to Net Rate too.
    const apy = entry?.apy ?? entry?.impliedApy ?? null
    // Price/24hΔ: current NAV/share (live market, else the newest indexed post) and its 24h
    // change from the same price history the Net Worth chart already fetches.
    const points = history[h.product.productId]?.points ?? []
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

  // "—" when the vault has no price history (delta24h null) or no NAV to show.
  const priceCellOf = (price: number | null, delta: number | null): HoldingPriceCell => {
    if (delta == null || price == null) return null
    const formatted = formatPriceDelta(delta)
    return { price: navSharePriceValue(price), deltaText: formatted.text, up: formatted.up }
  }
  const stockUnits = stock.status === "ready" ? stock.units : 0
  const stockPrice = stock.status === "ready" ? stock.price : null
  const rows: PortfolioRow[] = [
    ...holdings.map((h) => ({
      key: h.product.productId,
      category: productPortfolioCategory(h.product),
      sortName: h.product.symbol,
      units: h.shares,
      usd: h.usd,
      apy: h.apy,
      delta24h: h.delta24h,
      priceCell: priceCellOf(h.navBase, h.delta24h),
      position: { productId: h.product.productId, balance: trimShares(h.shares), status: "Held" },
    })),
    ...(stockUnits > 0
      ? [{
          key: STOCK_ROW_ID,
          category: "stocks" as const,
          sortName: STOCK_DISPLAY.symbol,
          units: stockUnits,
          usd: stockPrice ? stockUnits * stockPrice.value : null,
          apy: null,
          // The live quote's change since the previous close.
          delta24h: stockPrice?.changePct ?? null,
          priceCell: priceCellOf(stockPrice?.value ?? null, stockPrice?.changePct ?? null),
          position: {
            productId: STOCK_ROW_ID,
            balance: trimShares(stockUnits),
            status: "Held",
            symbol: STOCK_DISPLAY.symbol,
            displayName: STOCK_DISPLAY.name,
            categoryLabel: CATEGORY_LABEL.stocks,
            ...(STOCK_DISPLAY.imageUrl ? { imageUrl: STOCK_DISPLAY.imageUrl } : {}),
          },
        }]
      : []),
  ]

  const valued = rows.filter((row) => row.usd != null)
  const totalUsd = valued.reduce((sum, row) => sum + (row.usd as number), 0)
  // A held NVDA whose first price read is still in flight is loading, not a partial total.
  const stockPricePending = stock.status === "ready" && stock.units > 0 && !stock.priceSettled
  const netWorthLabel =
    !holdingsKnown || !marketQuery.isSuccess || stock.status === "loading" || stockPricePending
      ? "—"
      : rows.length === 0
        ? stock.status === "error" ? "—" : aumLabel(0)
        : valued.length === 0
          ? "—"
          : aumLabel(totalUsd)
  const partialNote =
    netWorthLabel === "—"
      ? null
      : stock.status === "error"
        ? "Partial — Stocks holdings could not be confirmed"
        : rows.some((row) => row.usd == null)
          ? "Partial — some asset prices are unavailable"
          : null

  // Blended APY weights only holdings that HAVE an APY — never diluted by null-APY products.
  const apyHoldings = holdings.filter((h) => h.apy != null && h.usd != null)
  const apyWeight = apyHoldings.reduce((sum, h) => sum + (h.usd as number), 0)
  const blendedApy =
    apyHoldings.length > 0 && apyWeight > 0
      ? apyHoldings.reduce((sum, h) => sum + (h.apy as number) * (h.usd as number), 0) / apyWeight
      : null

  // Net Worth: current shares × each vault's price history, ending at today's price, plus the NVDA holding at its
  // daily closes (from where the vault line starts) and live price. Net Rate stays the yield-bearing vaults only.
  const marketAt = marketQuery.isSuccess ? Math.floor(marketQuery.dataUpdatedAt / 1000) : null
  const vaultLines = holdings.map((h) => ({
    shares: h.shares,
    history: withCurrentPrice(history[h.product.productId], { navUsd: h.navUsd, navBase: marketByProduct.get(h.product.productId)?.navBase ?? null }, marketAt),
  }))
  const stockLine =
    stock.status === "ready" && stock.units > 0 && stock.closes
      ? [{
          shares: stock.units,
          history: stockPriceHistory(STOCK_ROW_ID, stock.closes, {
            from: historyStart(heldIds.map((id) => history[id])),
            price: stock.price?.value ?? null,
            now: stock.price?.at ?? null,
          }),
        }]
      : []
  const netWorthSeries = buildNetWorthSeries([...vaultLines, ...stockLine])
  const activeRange = range ?? defaultRange(netWorthSeries)
  const rangeChange = valueChange(filterByRange(netWorthSeries, activeRange, now))
  const headerChange = netWorthLabel !== "—" && rangeChange ? formatValueChange(rangeChange) : null

  const stockLineLoading = stock.status === "loading" || (stock.status === "ready" && stock.units > 0 && !stock.closesSettled)
  const chartEmpty = holdingsError || historyQuery.isError
    ? "Portfolio history could not be loaded"
    : !holdingsKnown || (heldIds.length > 0 && !historyQuery.isSuccess) || stockLineLoading
      ? "Loading portfolio history…"
      : null
  const netWorthMetric: ChartMetric = {
    key: "networth",
    label: "Net Worth",
    series: netWorthSeries,
    headline: netWorthLabel,
    valueFormat: aumLabel,
    delta: priceReturnPct,
    change: (points) => {
      const change = valueChange(points)
      return change ? formatValueChange(change) : null
    },
    emptyLabel: chartEmpty ?? "No net worth history yet",
  }
  const netRateMetric: ChartMetric = {
    key: "netrate",
    label: "Net Rate",
    series: buildNetRateSeries(holdings.map((h) => ({ shares: h.shares, history: history[h.product.productId] }))),
    headline: blendedApy != null ? pctLabel(blendedApy) : "—",
    valueFormat: pctLabel,
    delta: apyChangePct,
    emptyLabel: chartEmpty ?? "No net rate history yet",
  }

  const allocation = allocationOf(rows)
  const viewRows = view === "all" ? rows : rows.filter((row) => row.category === view)

  // Sort rows upstream (numeric values live here) so positions/depositUsd/apyValues/priceCells
  // stay index-aligned; the table renders in this order. Aggregates above are order-independent.
  const rowKey = (row: PortfolioRow) =>
    holdingsSort.key === "balance"
      ? row.units
      : holdingsSort.key === "delta"
        ? row.delta24h
        : holdingsSort.key === "deposit"
          ? row.usd
          : row.apy
  const ordered = sortByNumericKey(viewRows, rowKey, holdingsSort.dir, (row) => row.sortName)
  const portfolio = {
    walletAddress: wallet.address ?? "",
    chainId: GIWA_CHAIN_ID,
    positions: ordered.map((row) => row.position),
    redemptions: [],
  } as unknown as GiwaPortfolio
  const table = (
    <GiwaHoldingsTable
      portfolio={portfolio}
      products={products}
      depositUsd={ordered.map((row) => (row.usd != null ? money(row.usd) : null))}
      apyValues={ordered.map((row) => (row.apy != null ? `${trimPct(row.apy)}%` : null))}
      priceCells={ordered.map((row) => row.priceCell)}
      sortKey={holdingsSort.key}
      sortDir={holdingsSort.dir}
      onSort={(key) => setHoldingsSort((current) => nextSort(current, key))}
    />
  )

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

  const stockNotice = stock.status === "error"
    ? "Stocks holdings could not be confirmed. Use Refresh to try again."
    : stock.status === "loading"
      ? "Checking your Stocks holdings…"
      : null
  const holdingsContent = (): ReactNode => {
    if (view === "stocks") {
      if (stock.status === "error") return <EmptyState title="Stocks holdings could not be loaded" body="Your NVDA balance has not been confirmed. Use Refresh to try again." />
      if (stock.status === "loading") return <EmptyState title="Loading your Stocks holdings…" body="Checking your connected wallet on GIWA." />
      if (viewRows.length === 0) return <EmptyState title="No Stocks holdings yet" body="Buy NVDA on the Stocks page to see it here." action={<Link to={GIWA_STOCKS_ROUTE} className={LINK_BUTTON}>Open Stocks</Link>} />
      return table
    }
    if (holdingsError) return <EmptyState title="Holdings could not be loaded" body="Your balance has not been confirmed. Use Refresh to try again." />
    if (!holdingsKnown) return <EmptyState title="Loading your holdings…" body="Checking your connected wallet on GIWA." />
    if (view === "savings" && viewRows.length === 0) {
      return <EmptyState title="No Savings holdings yet" body="Deposit into a Savings account to see it here." action={<Link to={GIWA_SAVINGS_ROUTE} className={LINK_BUTTON}>Open Savings</Link>} />
    }
    if (view === "funds" && viewRows.length === 0) {
      return <EmptyState title="No Funds holdings yet" body="Invest in a Fund to see it here." action={<Link to={GIWA_FUNDS_ROUTE} className={LINK_BUTTON}>Browse Funds</Link>} />
    }
    if (view === "all" && rows.length === 0) {
      if (stock.status === "loading") return <EmptyState title="Loading your holdings…" body="Checking your connected wallet on GIWA." />
      return stock.status === "error" ? (
        <EmptyState
          title="No Savings or Funds holdings yet"
          body="Stocks holdings could not be confirmed. Use Refresh to try again."
          action={<Link to={GIWA_FUNDS_ROUTE} className={LINK_BUTTON}>Browse products</Link>}
        />
      ) : (
        <EmptyState
          title="No holdings yet"
          body="Deposit into Savings or Funds, or buy Stocks, to start building your portfolio."
          action={<Link to={GIWA_FUNDS_ROUTE} className={LINK_BUTTON}>Browse products</Link>}
        />
      )
    }
    return (
      <>
        {table}
        {view === "all" && stockNotice ? <p role="status" className="text-sm text-[var(--color-arco-text-soft)]">{stockNotice}</p> : null}
      </>
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
          {headerChange && (
            <span data-testid="net-worth-change" className={`text-sm font-medium ${CHANGE_TONE[headerChange.dir]}`}>
              {headerChange.text} · {activeRange}
            </span>
          )}
          <span className="text-[11px] text-[var(--color-arco-muted)]">Savings, Funds and Stocks at current prices</span>
          {partialNote && <span className="text-[11px] text-[var(--color-arco-muted)]">{partialNote}</span>}
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

      <GiwaTwoMetricChartCard metrics={[netWorthMetric, netRateMetric]} now={now} range={activeRange} onRangeChange={setRange} />
      {marketQuery.isError || historyQuery.isError ? <p role="status" className="text-sm text-[var(--color-arco-text-soft)]">{marketQuery.isError ? "Current valuations are unavailable." : "Portfolio history could not be loaded."} Use Refresh to try again.</p> : null}

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
          <button type="button" onClick={refresh} disabled={refreshing} className="ml-auto py-2.5 text-sm text-[var(--color-arco-text-soft)] disabled:opacity-50">{refreshing ? "Refreshing…" : "Refresh"}</button>
        </nav>

        {tab === "portfolio" ? (
          <>
            <div role="group" aria-label="Portfolio products" className="inline-flex max-w-full flex-wrap rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] p-0.5 text-sm">
              {PORTFOLIO_VIEWS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={view === option.id}
                  onClick={() => setView(option.id)}
                  className={`rounded-[var(--radius-pill)] px-3 py-1.5 sm:px-4 ${view === option.id ? SEGMENT_ACTIVE : SEGMENT_IDLE}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {view === "all" && holdingsKnown && !holdingsError && marketQuery.isSuccess && rows.length > 0 ? (
              <AllocationTiles slices={allocation} stock={stock} onSelect={setView} />
            ) : null}
            {holdingsContent()}
          </>
        ) : (
          activityError || (activityKnown && stocksActivityError && activityRows.length === 0) ? <EmptyState title="Activity could not be loaded" body="Your transaction history has not been confirmed. Use Refresh to try again." />
            : !activityKnown ? <EmptyState title="Loading your activity…" body="Checking transactions, redemption requests and Stocks trades." />
              : <>
                {stocksActivityError ? <p role="status" className="mb-3 text-sm text-[var(--color-arco-text-soft)]" data-testid="stocks-activity-unavailable">Stocks trades could not be loaded. Use Refresh to try again.</p> : null}
                <GiwaActivityTable rows={activityRows} />
              </>
        )}
      </section>
    </div>
  )
}

// All Portfolio overview: the current value of each product line and its share of the valued total. Shown only
// while current valuations are known.
function AllocationTiles({
  slices,
  stock,
  onSelect,
}: {
  slices: AllocationSlice[]
  stock: StocksHolding
  onSelect: (view: PortfolioView) => void
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3" data-testid="portfolio-allocation">
      {slices.map((slice) => {
        const label = CATEGORY_LABEL[slice.category]
        const { value, detail } = tileText(slice, stock)
        const share = value !== "—" && slice.share != null ? slice.share : null
        return (
          <button
            key={slice.category}
            type="button"
            onClick={() => onSelect(slice.category)}
            aria-label={`${label}: ${value}${share != null ? `, ${trimPct(share)}% of portfolio` : ""}. Show ${label} holdings`}
            className="flex flex-col gap-1 rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-4 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)]"
            style={{ boxShadow: "var(--shadow-control)" }}
          >
            <span className="text-sm text-[var(--color-arco-muted)]">{label}</span>
            <span className="text-xl font-medium text-[var(--color-arco-ink)]">{value}</span>
            <span className="text-xs text-[var(--color-arco-text-soft)]">
              {share != null ? `${trimPct(share)}% · ` : ""}
              {detail}
            </span>
            <span aria-hidden className="mt-2 block h-1 w-full overflow-hidden rounded-full bg-[var(--color-arco-chip)]">
              <span className="block h-full rounded-full bg-[var(--color-arco-ink)]" style={{ width: `${Math.min(100, Math.max(0, share ?? 0))}%` }} />
            </span>
          </button>
        )
      })}
    </div>
  )
}

function tileText(slice: AllocationSlice, stock: StocksHolding): { value: string; detail: string } {
  if (slice.category === "stocks") {
    if (stock.status === "error") return { value: "—", detail: "Not confirmed" }
    if (stock.status === "loading") return { value: "—", detail: "Checking…" }
    if (slice.count === 0) return { value: money(0), detail: "No holdings" }
    return { value: slice.complete ? money(slice.usd) : "—", detail: `${trimShares(stock.units)} ${STOCK_DISPLAY.symbol}` }
  }
  const detail = slice.count === 0 ? "No holdings" : slice.count === 1 ? "1 holding" : `${slice.count} holdings`
  if (slice.count > 0 && slice.usd === 0 && !slice.complete) return { value: "—", detail }
  return { value: money(slice.usd), detail }
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
