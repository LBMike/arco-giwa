import { readFileSync } from "node:fs"
import { parse } from "dotenv"
import Fastify from "fastify"
import { configuredStocksMarketData } from "../../server/src/stocks-market-runtime/config"
import { stocksMarketDataPlugin } from "../../server/src/stocks-market-data/plugin"

/** Explicit local opt-in: IEX only, no fundamentals vendor, one shared cache/budget. */
export async function createLiveMarket(ports: { readCredentials?: () => Record<string, string>; fetch?: typeof fetch } = {}) {
  const values = ports.readCredentials ? ports.readCredentials() : parse(readFileSync(new URL("../../.secrets/alpaca.env", import.meta.url)))
  if (!values.ALPACA_API_KEY_ID || !values.ALPACA_API_SECRET_KEY) throw new Error("ALPACA_CREDENTIALS_REQUIRED")
  const service = configuredStocksMarketData({
    ALPACA_API_KEY_ID: values.ALPACA_API_KEY_ID,
    ALPACA_API_SECRET_KEY: values.ALPACA_API_SECRET_KEY,
    STOCKS_MARKET_DATA_PROVIDER: "ALPACA",
    STOCKS_MARKET_DATA_CATALOG: "CURATED_40",
    ALPACA_DATA_FEED: "iex",
    STOCKS_MARKET_DATA_FEED_DELAY: "REALTIME",
  }, { requestsPerMinute: 60, fetch: ports.fetch })
  const app = Fastify({ logger: false })
  await app.register(stocksMarketDataPlugin, { service })
  await app.ready()
  return app
}
