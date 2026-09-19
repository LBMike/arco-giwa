import { useCallback, useContext, useMemo } from "react"
import { GIWA_STOCKS_ROUTE } from "../routes"
import { createGiwaStocksHttpClient } from "../stocks-investor/client"
import { createMarketClient, type MarketClient } from "./client"
import type { Catalog, Envelope } from "./contracts"
import { StocksPageEnvironment, usePageApiBase } from "./environment"
import { MarketStatus, StocksMarketTable, useOrderCapabilities, type OrdersCatalogClient } from "./StocksMarketTable"
import { useOwnedRead } from "./useOwnedRead"
const NO_SERIES = Object.freeze({})
const stockHref = (symbol: string) => `${GIWA_STOCKS_ROUTE}?symbol=${encodeURIComponent(symbol)}`
/** Home preview: the server catalog's first 10 by rank, linking to /stocks?symbol=…; catalog, quotes and capabilities only. */
export function StocksHomeList() {
  const environment = useContext(StocksPageEnvironment)
  const apiBase = usePageApiBase()
  const clients = useMemo(() => {
    if (!apiBase) return { market: null, orders: null }
    try { return { market: createMarketClient(apiBase, environment.fetch), orders: createGiwaStocksHttpClient({ baseUrl: apiBase, fetch: environment.fetch }) } }
    catch { return { market: null, orders: null } }
  }, [apiBase, environment.fetch])
  if (!clients.market) return <p role="status" className="text-sm text-[var(--color-arco-text-soft)]">시장정보 API 연결 준비 중</p>
  return <HomeCatalog key={clients.market.baseUrl} client={clients.market} ordersClient={clients.orders} />
}
function HomeCatalog({ client, ordersClient }: { client: MarketClient; ordersClient: OrdersCatalogClient | null }) {
  const load = useCallback((signal: AbortSignal) => client.catalog(signal), [client])
  const catalog = useOwnedRead(client.baseUrl, load)
  if (catalog.phase !== "ready") return <MarketStatus status={catalog.phase} />
  if (!catalog.value.data) return <MarketStatus status={catalog.value.status} />
  return <HomeTable key={JSON.stringify(catalog.value.data.securities.map(item => item.symbol))} client={client} ordersClient={ordersClient} response={catalog.value as Envelope<Catalog> & { data: Catalog }} />
}
function HomeTable({ client, ordersClient, response }: { client: MarketClient; ordersClient: OrdersCatalogClient | null; response: Envelope<Catalog> & { data: Catalog } }) {
  const catalog = response.data
  const names = useMemo(() => catalog.securities.map(item => item.symbol), [catalog])
  const load = useCallback((signal: AbortSignal) => client.quotes(names, signal), [client, names])
  const quotes = useOwnedRead(JSON.stringify([client.baseUrl, names]), load)
  const capabilities = useOrderCapabilities(ordersClient)
  // Its own surface card: the pinned # and Asset Name cells are opaque surface while the table scrolls sideways.
  return <div className="w-full min-w-0 space-y-3 rounded-[var(--radius-strategy)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-4 sm:p-6">
    {quotes.phase !== "ready" ? <MarketStatus status={quotes.phase} /> : quotes.value.status !== "AVAILABLE" && <MarketStatus status={quotes.value.status} />}
    <StocksMarketTable variant="home" limit={10} rowHref={stockHref} catalog={catalog} quotes={quotes} capabilities={capabilities} series={NO_SERIES} />
  </div>
}
