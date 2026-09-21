import { CURATED_40_CATALOG } from './catalog.js'
import {
  createStocksMarketDataService,
  type FeedDelay,
  type StocksMarketDataOptions,
  type StocksMarketDataService,
} from "../stocks-market-data/index.js"

const delays: readonly string[] = ["UNKNOWN", "DELAYED_15_MIN", "END_OF_DAY", "REALTIME"]
type RuntimePorts = Pick<StocksMarketDataOptions, "catalog" | "fetch" | "now" | "requestsPerMinute" | "massiveRequestsPerMinute" | "etfGlobalEnabled">

/** One service per server instance: the provider budget/cache is shared across routes. */
export function configuredStocksMarketData(
  source: NodeJS.ProcessEnv,
  ports: RuntimePorts = {},
): StocksMarketDataService {
  const provider = source.STOCKS_MARKET_DATA_PROVIDER ?? "MASSIVE"
  const alpacaFeed = source.ALPACA_DATA_FEED ?? "iex"
  const catalogMode = source.STOCKS_MARKET_DATA_CATALOG ?? "PILOT"
  if (!["MASSIVE", "ALPACA"].includes(provider) || !["iex", "sip"].includes(alpacaFeed) || !["PILOT", "CURATED_40"].includes(catalogMode)) throw new Error("INVALID_MARKET_DATA_CONFIG")
  const feedDelay = source.STOCKS_MARKET_DATA_FEED_DELAY ?? "UNKNOWN"
  if (!delays.includes(feedDelay)) throw new Error("INVALID_MARKET_DATA_CONFIG")
  // Do not trim or echo credentials. The service validates any nonempty key.
  const apiKey = source.MASSIVE_API_KEY || undefined
  return createStocksMarketDataService({
    ...ports,
    catalog: ports.catalog ?? (catalogMode === "CURATED_40" ? CURATED_40_CATALOG : undefined),
    apiKey, feedDelay: feedDelay as FeedDelay, provider: provider as "MASSIVE" | "ALPACA",
    alpacaFeed: alpacaFeed as "iex" | "sip",
    alpacaKeyId: source.ALPACA_API_KEY_ID || undefined,
    alpacaSecretKey: source.ALPACA_API_SECRET_KEY || undefined,
  })
}
