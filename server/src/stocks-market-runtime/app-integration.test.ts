import assert from "node:assert/strict"
import test from "node:test"
import { buildApp, type AppEnv, type ArcoAppServices } from "../app.js"
import type { StocksService } from "../stocks/service.js"
import type { DisplayCatalog } from "../stocks-market-data/index.js"
import { configuredStocksMarketData } from "./config.js"

const env: AppEnv = {
  corsAllowedOrigins: ["https://market-integration.test"], authNonceTtlSeconds: 60,
  authJwtSecret: "TEST_ONLY_MARKET_AUTH_SECRET", adminOperatorToken: "TEST_ONLY_LEGACY",
  registryPath: "/NO_REGISTRY_FILE_IS_READ",
}
function legacy(): ArcoAppServices {
  return {
    arco: { vaultConfigs: async () => [] },
    registry: { getRegistry: async () => ({ network: { chainId: 91342 }, assets: [], products: [] }) },
    portfolio: {}, readiness: { check: async () => ({ ok: true, checks: {} }) },
    loadRegistry: () => { throw new Error("NO_DEPLOYED_REGISTRY") },
  } as unknown as ArcoAppServices
}
const root = "/api/v1/stocks/market"
const now = Date.parse("2026-09-17T18:00:00.000Z")
const json = (body: string, status = 200) => new Response(body, { status, headers: { "Content-Type": "application/json" } })
const snapshot = `{"status":"OK","tickers":[{"ticker":"NVDA","lastTrade":{"p":123.456789012345678901,"t":${BigInt(now - 1000) * 1000000n}},"day":{"v":9007199254740993}}]}`

test("optional display service omission preserves route absence and legacy behavior", async () => {
  const app = buildApp(env, legacy())
  try {
    assert.equal((await app.inject(`${root}/catalog`)).statusCode, 404)
    assert.equal((await app.inject("/api/v1/stocks/catalog")).statusCode, 404)
    assert.deepEqual((await app.inject("/health")).json(), { ok: true, service: "arco-giwa-api" })
    assert.deepEqual((await app.inject("/api/v1/evm/catalog/91342")).json(), [])
  } finally { await app.close() }
})

test("startup factory without a key exposes pilot and unconfigured endpoints with network zero", async () => {
  let calls = 0
  const service = configuredStocksMarketData({}, { fetch: async () => { calls++; throw new Error("NO_NETWORK") } })
  const app = buildApp(env, { ...legacy(), stocksMarketData: service })
  try {
    const catalog = (await app.inject(`${root}/catalog`)).json()
    assert.equal(catalog.status, "AVAILABLE")
    assert.equal(catalog.data.provenance.verification, "PILOT")
    assert.deepEqual(catalog.data.securities, [{ symbol: "NVDA", name: "NVIDIA" }])
    for (const suffix of ["quotes", "NVDA/profile", ...["1D", "1W", "1M", "3M", "1Y"].map(range => `NVDA/chart?range=${range}`), "NVDA/logo"]) {
      const response = await app.inject(`${root}/${suffix}`)
      assert.equal(response.statusCode, suffix.endsWith("logo") ? 404 : 200)
      assert.equal(response.json().status, "UNCONFIGURED")
      assert.equal(response.json().feedDelay, "UNKNOWN")
      assert.equal(response.json().purpose, "DISPLAY_ONLY")
      assert.equal(response.headers["cache-control"], "no-store")
      assert.equal(response.headers["x-content-type-options"], "nosniff")
    }
    assert.equal((await app.inject(`${root}/quotes`)).json().data[0].price, null)
    assert.equal((await app.inject("/api/v1/stocks/quotes")).statusCode, 404)
    assert.equal((await app.inject("/api/v1/evm/catalog/91342")).statusCode, 200)
    assert.equal(calls, 0)
  } finally { await app.close() }
})

test("explicit provider configuration shares cache, preserves decimal strings and keeps keys server-side", async () => {
  let calls = 0
  const key = "SYNTHETIC_FIXTURE_KEY"
  const service = configuredStocksMarketData({ MASSIVE_API_KEY: key, STOCKS_MARKET_DATA_FEED_DELAY: "DELAYED_15_MIN" }, {
    now: () => now,
    fetch: async (input, init) => {
      calls++
      const url = new URL(String(input))
      assert.equal(url.origin, "https://api.massive.com")
      assert.equal(url.searchParams.get("tickers"), "NVDA")
      assert.equal(url.searchParams.has("apiKey"), false)
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`)
      return json(snapshot)
    },
  })
  assert.equal(calls, 0, "construction never fetches")
  const app = buildApp(env, { ...legacy(), stocksMarketData: service })
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => app.inject(`${root}/quotes`)))
    assert.equal(calls, 1)
    for (const result of results) {
      assert.equal(result.statusCode, 200)
      assert.equal(result.json().data[0].price, "123.456789012345678901")
      assert.equal(result.json().data[0].sessionVolume, "9007199254740993")
      assert.equal(result.json().executionPriceSource, "FIXED_MOCK_PRICE")
      assert.equal(result.json().feedDelay, "DELAYED_15_MIN")
      assert.ok(!result.body.includes(key))
      assert.ok(!result.body.includes("api.massive.com"))
    }
  } finally { await app.close() }
})

test("invalid symbols/ranges and arbitrary universe queries are rejected before provider access", async () => {
  let calls = 0
  const app = buildApp(env, { ...legacy(), stocksMarketData: configuredStocksMarketData({ MASSIVE_API_KEY: "fixture" }, {
    fetch: async () => { calls++; throw new Error("NO_NETWORK") },
  }) })
  try {
    for (const [path, status] of [["/quotes?symbols=ALL", 400], ["/catalog?url=https://invalid.test", 400], ["/AAPL/profile", 404], ["/NVDA/chart", 400], ["/NVDA/chart?range=ALL", 400], ["/NVDA/chart?range=1D&range=1M", 400]] as const) {
      assert.equal((await app.inject(root + path)).statusCode, status)
    }
    assert.equal(calls, 0)
  } finally { await app.close() }
})

test("provider denial is availability data and raw credentials/errors are never public", async () => {
  const secret = "SYNTHETIC_PRIVATE_MARKER"
  const app = buildApp(env, { ...legacy(), stocksMarketData: configuredStocksMarketData({ MASSIVE_API_KEY: secret }, {
    fetch: async () => json(JSON.stringify({ message: secret, url: `https://api.massive.com?apiKey=${secret}` }), 403),
  }) })
  try {
    const result = await app.inject(`${root}/quotes`)
    assert.equal(result.statusCode, 200)
    assert.equal(result.json().status, "UNAVAILABLE")
    assert.equal(result.json().reason, "PROVIDER_UNAUTHORIZED")
    assert.ok(!result.body.includes(secret))
  } finally { await app.close() }
})

test("display catalog grants no trading capability or authority and does not replace existing handlers", async () => {
  let tradingReads = 0
  const catalog: DisplayCatalog = {
    securities: [{ symbol: "NVDA", name: "NVIDIA" }, { symbol: "AAPL", name: "Apple" }],
    provenance: { verification: "CURATED", sourceUrl: null, rankingMetric: null, period: null, asOfDate: null },
  }
  const app = buildApp(env, {
    ...legacy(), stocksMarketData: configuredStocksMarketData({}, { catalog }),
    stocks: {
      service: {
        catalog: () => { tradingReads++; return { instruments: [{ symbol: "NVDA", price: "120.000000", orderCapability: "NOT_ACTIVATED" }] } },
        // The trading catalog route reads the current price first, then answers with the same catalog.
        currentCatalog: async () => { tradingReads++; return { instruments: [{ symbol: "NVDA", price: "120.000000", orderCapability: "NOT_ACTIVATED" }] } },
      } as unknown as StocksService,
    },
  })
  try {
    assert.equal((await app.inject(`${root}/catalog`)).json().data.securities.length, 2)
    assert.equal(tradingReads, 0)
    const trade = await app.inject("/api/v1/stocks/catalog")
    assert.equal(trade.json().instruments.length, 1)
    assert.equal(trade.json().instruments[0].price, "120.000000")
    const denied = await app.inject({ method: "POST", url: "/api/v1/stocks/quotes", payload: { symbol: "NVDA", quantity: "1" } })
    assert.equal(denied.statusCode, 401)
    assert.equal(denied.json().purpose, undefined)
    assert.equal((await app.inject("/api/v1/admin/stocks/overview")).statusCode, 403)
    const invalidLegacy = await app.inject("/api/v1/evm/registry/not-a-chain")
    assert.equal(invalidLegacy.statusCode, 400)
    assert.equal(invalidLegacy.json().purpose, undefined)
    assert.equal((await app.inject("/health")).headers["x-content-type-options"], undefined)
  } finally { await app.close() }
})

test("invalid server config fails without echoing input or making provider calls", () => {
  let calls = 0
  for (const config of [{ MASSIVE_API_KEY: "private\nvalue" }, { STOCKS_MARKET_DATA_FEED_DELAY: "private-invalid-value" }]) {
    assert.throws(() => configuredStocksMarketData(config, { fetch: async () => { calls++; throw new Error("NO_NETWORK") } }), error => {
      assert.equal((error as Error).message, "INVALID_MARKET_DATA_CONFIG")
      return true
    })
  }
  assert.equal(calls, 0)
})
