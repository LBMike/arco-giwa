import { useCallback, useContext, useMemo, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { ArrowRight } from "lucide-react"
import { StocksHighlights } from "./StocksHighlights"
import { StocksDemoMarketNotice } from "./StocksDemoMarketNotice"
import { stockHighlights } from "./highlights"
import type { ReadState } from "./useOwnedRead"
import { GIWA_STOCKS_ROUTE } from "../routes"
import { createGiwaStocksHttpClient } from "../stocks-investor/client"
import { createMarketClient, type MarketClient } from "./client"
import type { Catalog, Envelope, Quote } from "./contracts"
import { StocksPageEnvironment, usePageApiBase } from "./environment"
import { MarketStatus, StocksMarketTable, useOrderCapabilities, type OrdersCatalogClient } from "./StocksMarketTable"
import { useMarketRows } from "./useMarketRows"
import { useOwnedRead } from "./useOwnedRead"
const NO_SERIES = Object.freeze({})
const stockHref = (symbol: string) => `${GIWA_STOCKS_ROUTE}?symbol=${encodeURIComponent(symbol)}`
/** Home preview: the server catalog's first 10 by rank, linking to /stocks?symbol=…; catalog, quotes, profiles and capabilities. */
export function StocksHomeList({ withHighlights = false }: { withHighlights?: boolean }) {
  const environment = useContext(StocksPageEnvironment)
  const apiBase = usePageApiBase()
  const clients = useMemo(() => {
    if (!apiBase) return { market: null, orders: null }
    try { return { market: createMarketClient(apiBase, environment.fetch), orders: createGiwaStocksHttpClient({ baseUrl: apiBase, fetch: environment.fetch }) } }
    catch { return { market: null, orders: null } }
  }, [apiBase, environment.fetch])
  if (!clients.market) return <HomeLayout withHighlights={withHighlights} status="Market data unavailable"><p role="status" className="text-sm text-[var(--color-arco-text-soft)]">시장정보 API 연결 준비 중</p></HomeLayout>
  return <HomeCatalog key={clients.market.baseUrl} client={clients.market} ordersClient={clients.orders} withHighlights={withHighlights} />
}
function HomeCatalog({ client, ordersClient, withHighlights }: { client: MarketClient; ordersClient: OrdersCatalogClient | null; withHighlights: boolean }) {
  const load = useCallback((signal: AbortSignal) => client.catalog(signal), [client])
  const catalog = useOwnedRead(client.baseUrl, load)
  if (catalog.phase !== "ready") return <HomeLayout withHighlights={withHighlights} status={catalog.phase === "loading" ? "Loading…" : "Market data unavailable"}><MarketStatus status={catalog.phase} /></HomeLayout>
  if (!catalog.value.data) return <HomeLayout withHighlights={withHighlights} status="Market data unavailable"><MarketStatus status={catalog.value.status} /></HomeLayout>
  return <HomeTable key={JSON.stringify(catalog.value.data.securities.map(item => item.symbol))} client={client} ordersClient={ordersClient} withHighlights={withHighlights} response={catalog.value as Envelope<Catalog> & { data: Catalog }} />
}
function HomeTable({ client, ordersClient, response, withHighlights }: { client: MarketClient; ordersClient: OrdersCatalogClient | null; withHighlights: boolean; response: Envelope<Catalog> & { data: Catalog } }) {
  const catalog = response.data
  const names = useMemo(() => catalog.securities.map(item => item.symbol), [catalog])
  const load = useCallback((signal: AbortSignal) => client.quotes(names, signal), [client, names])
  const quotes = useOwnedRead(JSON.stringify([client.baseUrl, names]), load, 30_000)
  const capabilities = useOrderCapabilities(ordersClient)
  const first = [...catalog.securities].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity)).slice(0, 10).map(item => item.symbol)
  const overview = useMarketRows(client, first, false)
  // Its own surface card: the pinned # and Asset Name cells are opaque surface while the table scrolls sideways.
  return <HomeLayout withHighlights={withHighlights} catalog={catalog} quotes={quotes}><div className="w-full min-w-0 space-y-3 rounded-[var(--radius-strategy)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-4 sm:p-6">
    {quotes.phase !== "ready" ? <MarketStatus status={quotes.phase} /> : quotes.value.status !== "AVAILABLE" && <MarketStatus status={quotes.value.status} />}
    <StocksMarketTable variant="home" limit={10} rowHref={stockHref} catalog={catalog} quotes={quotes} capabilities={capabilities} series={NO_SERIES} profiles={overview.profiles} />
  </div></HomeLayout>
}

/** Highlights and the table consume the same catalog/quote read, without another API request. */
function HomeLayout({ withHighlights, catalog = null, quotes, status, children }: {
  withHighlights: boolean; catalog?: Catalog | null; quotes?: ReadState<Envelope<Quote[]>>; status?: string; children: ReactNode
}) {
  if (!withHighlights) return <>{children}</>
  const data = quotes?.phase === "ready" ? quotes.value.data ?? [] : []
  const message = status ?? (quotes?.phase === "loading" ? "Loading…"
    : quotes?.phase === "error" ? "Market data unavailable"
    : quotes?.phase === "ready" && quotes.value.status !== "AVAILABLE" ? "No current market data"
    : undefined)
  return <div className="w-full min-w-0 space-y-10">
    <StocksDemoMarketNotice />
    <StocksHighlights groups={stockHighlights(catalog, data)} status={message} />
    <section aria-labelledby="home-stocks" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="home-stocks" className="text-xl font-medium text-[var(--color-arco-ink)]">Stocks</h2>
        <Link to={GIWA_STOCKS_ROUTE} className="inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-medium text-[var(--color-arco-ink)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]">
          View all stocks<ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      </div>
      {children}
    </section>
  </div>
}
