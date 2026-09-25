import { readFileSync } from "node:fs"
import { parse } from "dotenv"
import Fastify from "fastify"
import { fileURLToPath } from "node:url"
import { configuredStocksMarketData } from "../../server/src/stocks-market-runtime/config"
import { stocksMarketDataPlugin } from "../../server/src/stocks-market-data/plugin"
import { createAlpacaMarketClock } from "../../server/src/stocks-market-data/session"
import { createDiskMarketSnapshotStore } from "./disk-snapshot-store"

function optionalMassiveCredentials(): Record<string, string> {
  try { return parse(readFileSync(new URL("../../.secrets/massive.env", import.meta.url))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw new Error("MASSIVE_CREDENTIAL_FILE_UNAVAILABLE")
  }
}
/** Local free-plan setup: IEX prices and optional Massive Basic profiles, independently limited. */
export async function createLiveMarket(ports: { readCredentials?: () => Record<string, string>; readMassiveCredentials?: () => Record<string, string>; fetch?: typeof fetch; profileCachePath?: string; snapshotCachePath?: string } = {}) {
  const values = ports.readCredentials ? ports.readCredentials() : parse(readFileSync(new URL("../../.secrets/alpaca.env", import.meta.url)))
  if (!values.ALPACA_API_KEY_ID || !values.ALPACA_API_SECRET_KEY) throw new Error("ALPACA_CREDENTIALS_REQUIRED")
  const fundamentals = ports.readMassiveCredentials ? ports.readMassiveCredentials() : ports.readCredentials ? {} : optionalMassiveCredentials()
  const snapshotPath = ports.snapshotCachePath ?? (ports.readCredentials ? undefined : fileURLToPath(new URL("../../.cache/stocks-market-snapshots-v1.json", import.meta.url)))
  const service = configuredStocksMarketData({
    MASSIVE_API_KEY: fundamentals.MASSIVE_API_KEY,
    ALPACA_API_KEY_ID: values.ALPACA_API_KEY_ID,
    ALPACA_API_SECRET_KEY: values.ALPACA_API_SECRET_KEY,
    STOCKS_MARKET_DATA_PROVIDER: "ALPACA",
    STOCKS_MARKET_DATA_CATALOG: "CURATED_40",
    ALPACA_DATA_FEED: "iex",
    STOCKS_MARKET_DATA_FEED_DELAY: "REALTIME",
  }, { requestsPerMinute: 60, massiveRequestsPerMinute: 4, etfGlobalEnabled: false, issuerFundamentalsEnabled: true, fetch: ports.fetch,
    snapshotStore: snapshotPath ? createDiskMarketSnapshotStore(snapshotPath) : undefined,
    // Test-injected credentials leave disk writes disabled unless the caller supplies a temp path.
    profileCachePath: ports.profileCachePath ?? (ports.readCredentials ? undefined : fileURLToPath(new URL("../../.cache/stocks-market-profiles-v1.json", import.meta.url))) })
  const marketClock = createAlpacaMarketClock({
    keyId: values.ALPACA_API_KEY_ID,
    secretKey: values.ALPACA_API_SECRET_KEY,
    fetch: ports.fetch,
  })
  const app = Fastify({ logger: false })
  await app.register(stocksMarketDataPlugin, { service, marketClock })
  await app.ready()
  return app
}
