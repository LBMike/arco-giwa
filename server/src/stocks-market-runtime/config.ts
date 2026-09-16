import {
  createStocksMarketDataService,
  type FeedDelay,
  type StocksMarketDataOptions,
  type StocksMarketDataService,
} from "../stocks-market-data/index.js"

const delays: readonly string[] = ["UNKNOWN", "DELAYED_15_MIN", "END_OF_DAY", "REALTIME"]
type RuntimePorts = Pick<StocksMarketDataOptions, "catalog" | "fetch" | "now">

/** One service per server instance: the provider budget/cache is shared across routes. */
export function configuredStocksMarketData(
  source: NodeJS.ProcessEnv,
  ports: RuntimePorts = {},
): StocksMarketDataService {
  const feedDelay = source.STOCKS_MARKET_DATA_FEED_DELAY ?? "UNKNOWN"
  if (!delays.includes(feedDelay)) throw new Error("INVALID_MARKET_DATA_CONFIG")
  // Do not trim or echo credentials. The service validates any nonempty key.
  const apiKey = source.MASSIVE_API_KEY || undefined
  return createStocksMarketDataService({ ...ports, apiKey, feedDelay: feedDelay as FeedDelay })
}
