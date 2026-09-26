import { CURATED_40_CATALOG } from './catalog.js'
import {
  createStocksMarketDataService,
  type FeedDelay,
  type StocksMarketDataOptions,
  type StocksMarketDataService,
} from "../stocks-market-data/index.js"
import { createAlpacaMarketClock } from "../stocks-market-data/session.js"

const delays: readonly string[] = ["UNKNOWN", "DELAYED_15_MIN", "END_OF_DAY", "REALTIME"]
type RuntimePorts = Pick<StocksMarketDataOptions, "catalog" | "fetch" | "now" | "requestsPerMinute" | "massiveRequestsPerMinute" | "etfGlobalEnabled" | "issuerFundamentalsEnabled" | "profileCachePath" | "snapshotStore" | "profileStore">

/**
 * Alpaca Basic (IEX) prices with Massive Basic profiles: the limits the local live market already runs with
 * (scripts/stocks-local/live-market.ts). Alpaca's free plan allows 200 data calls a minute, so 60 lets one list view read
 * all 40 one-day charts; Massive Basic allows 5, so profiles and logos keep one call of headroom. ETF Global is not part of
 * Massive Basic, and DRAM/RAM AUM comes from the issuer instead. Explicit ports still win.
 */
export const ALPACA_FREE_PLAN_LIMITS = Object.freeze({
  requestsPerMinute: 60,
  massiveRequestsPerMinute: 4,
  etfGlobalEnabled: false,
  issuerFundamentalsEnabled: true,
})

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
  const plan = provider === "ALPACA" ? ALPACA_FREE_PLAN_LIMITS : null
  return createStocksMarketDataService({
    ...ports,
    requestsPerMinute: ports.requestsPerMinute ?? plan?.requestsPerMinute,
    massiveRequestsPerMinute: ports.massiveRequestsPerMinute ?? plan?.massiveRequestsPerMinute,
    etfGlobalEnabled: ports.etfGlobalEnabled ?? plan?.etfGlobalEnabled,
    issuerFundamentalsEnabled: ports.issuerFundamentalsEnabled ?? plan?.issuerFundamentalsEnabled,
    catalog: ports.catalog ?? (catalogMode === "CURATED_40" ? CURATED_40_CATALOG : undefined),
    apiKey, feedDelay: feedDelay as FeedDelay, provider: provider as "MASSIVE" | "ALPACA",
    alpacaFeed: alpacaFeed as "iex" | "sip",
    alpacaKeyId: source.ALPACA_API_KEY_ID || undefined,
    alpacaSecretKey: source.ALPACA_API_SECRET_KEY || undefined,
    profileCachePath: ports.profileCachePath ?? source.STOCKS_MARKET_PROFILE_CACHE_PATH ?? undefined,
  })
}

/**
 * STOCKS_MARKET_PROFILE_STORE=1 keeps the market page's company facts (market cap, shares outstanding, fund assets) in
 * Postgres, so a restart does not empty the Mkt Cap column while the free Massive plan refetches them a few a minute.
 * It needs the stocks_market_profiles migration. Unset or 0: in memory only, as before.
 */
export function stocksMarketProfileStoreEnabled(source: NodeJS.ProcessEnv): boolean {
  const value = source.STOCKS_MARKET_PROFILE_STORE
  if (value !== undefined && value !== "0" && value !== "1") throw new Error("INVALID_MARKET_DATA_CONFIG")
  return value === "1"
}

/** Market-open information is independent of quote freshness and order eligibility. */
export function configuredStocksMarketClock(source: NodeJS.ProcessEnv, ports: { fetch?: typeof fetch; now?: () => number } = {}) {
  if (source.STOCKS_MARKET_DATA_PROVIDER !== "ALPACA" || !source.ALPACA_API_KEY_ID || !source.ALPACA_API_SECRET_KEY) return undefined
  return createAlpacaMarketClock({ keyId: source.ALPACA_API_KEY_ID, secretKey: source.ALPACA_API_SECRET_KEY, ...ports })
}
