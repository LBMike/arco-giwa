import { readFileSync } from "node:fs"
import { parse } from "dotenv"
import Fastify from "fastify"
import { configuredStocksMarketData } from "../../server/src/stocks-market-runtime/config"
import { stocksMarketDataPlugin } from "../../server/src/stocks-market-data/plugin"

function optionalMassiveCredentials(): Record<string, string> {
  try { return parse(readFileSync(new URL("../../.secrets/massive.env", import.meta.url))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw new Error("MASSIVE_CREDENTIAL_FILE_UNAVAILABLE")
  }
}
/** Local free-plan setup: IEX prices and optional Massive Basic profiles, independently limited. */
export async function createLiveMarket(ports: { readCredentials?: () => Record<string, string>; readMassiveCredentials?: () => Record<string, string>; fetch?: typeof fetch } = {}) {
  const values = ports.readCredentials ? ports.readCredentials() : parse(readFileSync(new URL("../../.secrets/alpaca.env", import.meta.url)))
  if (!values.ALPACA_API_KEY_ID || !values.ALPACA_API_SECRET_KEY) throw new Error("ALPACA_CREDENTIALS_REQUIRED")
  const fundamentals = ports.readMassiveCredentials ? ports.readMassiveCredentials() : ports.readCredentials ? {} : optionalMassiveCredentials()
  const service = configuredStocksMarketData({
    MASSIVE_API_KEY: fundamentals.MASSIVE_API_KEY,
    ALPACA_API_KEY_ID: values.ALPACA_API_KEY_ID,
    ALPACA_API_SECRET_KEY: values.ALPACA_API_SECRET_KEY,
    STOCKS_MARKET_DATA_PROVIDER: "ALPACA",
    STOCKS_MARKET_DATA_CATALOG: "CURATED_40",
    ALPACA_DATA_FEED: "iex",
    STOCKS_MARKET_DATA_FEED_DELAY: "REALTIME",
  }, { requestsPerMinute: 60, massiveRequestsPerMinute: 4, etfGlobalEnabled: false, fetch: ports.fetch })
  const app = Fastify({ logger: false })
  await app.register(stocksMarketDataPlugin, { service })
  await app.ready()
  return app
}
