import { CURATED_40_CATALOG } from './catalog.js'
import {
  createStocksMarketDataService,
  type FeedDelay,
  type StocksMarketDataOptions,
  type StocksMarketDataService,
} from "../stocks-market-data/index.js"
import { createAlpacaMarketClock } from "../stocks-market-data/session.js"

const delays: readonly string[] = ["UNKNOWN", "DELAYED_15_MIN", "END_OF_DAY", "REALTIME"]
type RuntimePorts = Pick<StocksMarketDataOptions, "catalog" | "fetch" | "now" | "requestsPerMinute" | "massiveRequestsPerMinute" | "etfGlobalEnabled" | "issuerFundamentalsEnabled" | "profileCachePath" | "snapshotStore">

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
    profileCachePath: ports.profileCachePath ?? source.STOCKS_MARKET_PROFILE_CACHE_PATH ?? undefined,
  })
}

/** Market-open information is independent of quote freshness and order eligibility. */
export function configuredStocksMarketClock(source: NodeJS.ProcessEnv, ports: { fetch?: typeof fetch; now?: () => number } = {}) {
  if (source.STOCKS_MARKET_DATA_PROVIDER !== "ALPACA" || !source.ALPACA_API_KEY_ID || !source.ALPACA_API_SECRET_KEY) return undefined
  return createAlpacaMarketClock({ keyId: source.ALPACA_API_KEY_ID, secretKey: source.ALPACA_API_SECRET_KEY, ...ports })
}
