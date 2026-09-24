import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { stocksMarketDataPlugin } from "../../../../server/src/stocks-market-data/plugin"
import { configuredStocksMarketData } from "../../../../server/src/stocks-market-runtime/config"
import { CURATED_STOCKS } from "./curated"
import { createMarketClient } from "./client"
import { marketSourceLabel, volumeDollars } from "./display"

// Actual public route + browser decoder; the only fake boundary is the external vendor.
test("Alpaca runtime routes reach the stock UI client with exact values and separate fundamentals provenance", async () => {
  const configured = configuredStocksMarketData({ STOCKS_MARKET_DATA_CATALOG: "CURATED_40" }).catalog().data!
  assert.deepEqual(configured.securities, CURATED_STOCKS.map(({ symbol, name, isin, rank }) => ({ symbol, name, isin, rank })), "backend catalog must match the listed UI products")
  const now = Date.parse("2026-09-21T15:00:00.000Z")
  let alpacaReads = 0
  const service = configuredStocksMarketData({ STOCKS_MARKET_DATA_PROVIDER: "ALPACA", ALPACA_API_KEY_ID: "fixture-id", ALPACA_API_SECRET_KEY: "fixture-secret", ALPACA_DATA_FEED: "iex", MASSIVE_API_KEY: "fixture-fundamentals" }, {
    now: () => now,
    fetch: async (input, init) => {
      const url = new URL(String(input))
      if (url.origin === "https://data.alpaca.markets") {
        alpacaReads++
        assert.equal(new Headers(init?.headers).get("APCA-API-KEY-ID"), "fixture-id")
        assert.equal(url.searchParams.get("feed"), "iex")
        return new Response('{"NVDA":{"latestTrade":{"p":120.123456789012345678,"t":"2026-09-21T14:59:59Z"},"dailyBar":{"v":100,"t":"2026-09-21T04:00:00Z"},"prevDailyBar":{"c":100,"t":"2026-09-18T04:00:00Z"}}}', { headers: { "content-type": "application/json" } })
      }
      assert.equal(url.origin, "https://api.massive.com")
      assert.equal(new Headers(init?.headers).get("APCA-API-SECRET-KEY"), null)
      return Response.json({ status: "OK", results: { ticker: "NVDA", name: "NVIDIA", locale: "us", market: "stocks", currency_name: "usd", type: "CS", market_cap: 4200000000000 } })
    },
  })
  const app = Fastify()
  await app.register(stocksMarketDataPlugin, { service })
  const client = createMarketClient("https://local-backend.test", async (url, init) => {
    assert.equal(new Headers(init.headers).get("APCA-API-KEY-ID"), null)
    const reply = await app.inject({ method: "GET", url: new URL(url).pathname })
    assert.doesNotMatch(reply.body, /fixture-id|fixture-secret|fixture-fundamentals/)
    return new Response(reply.body, { status: reply.statusCode, headers: { "content-type": "application/json" } })
  })
  try {
    const signal = new AbortController().signal
    const catalog = await client.catalog(signal)
    assert.equal(catalog.provider, "ALPACA")
    const quotes = await client.quotes(["NVDA"], signal)
    assert.equal(quotes.status, "AVAILABLE")
    assert.equal(quotes.data?.[0].price, "120.123456789012345678")
    assert.equal(quotes.data?.[0].sessionVolume, "100")
    assert.equal(volumeDollars(quotes.data![0].price, quotes.data![0].sessionVolume), "12012.3456789012345678")
    assert.equal(marketSourceLabel(quotes), "Alpaca · IEX (single exchange)")
    const profile = await client.profile("NVDA", signal)
    assert.equal(profile.provider, "MASSIVE")
    assert.equal(profile.marketFeed, undefined)
    assert.equal(profile.data?.marketCap, "4200000000000")
    await client.quotes(["NVDA"], signal)
    assert.equal(alpacaReads, 1, "UI requests share the backend quote cache")
  } finally { await app.close() }
})
