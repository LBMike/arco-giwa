import assert from "node:assert/strict"
import test from "node:test"
import { createLiveMarket } from "../../../../../scripts/stocks-local/live-market"

test("live preview forces free IEX, shares the quote cache and never exposes credentials", async () => {
  const calls: string[] = []
  const app = await createLiveMarket({
    readCredentials: () => ({ ALPACA_API_KEY_ID: "TEST_ID", ALPACA_API_SECRET_KEY: "TEST_SECRET", ALPACA_DATA_FEED: "sip", MASSIVE_API_KEY: "MUST_NOT_USE" }),
    fetch: async (input, init) => {
      const url = new URL(String(input)); calls.push(url.href)
      assert.equal(url.origin, "https://data.alpaca.markets")
      assert.equal(url.searchParams.get("feed"), "iex")
      assert.equal(new Headers(init?.headers).get("APCA-API-SECRET-KEY"), "TEST_SECRET")
      return new Response(JSON.stringify({ NVDA: { latestTrade: { p: 120, t: new Date().toISOString() } } }), { headers: { "content-type": "application/json" } })
    },
  })
  try {
    const replies = await Promise.all(Array.from({ length: 8 }, () => app.inject({ method: "GET", url: "/api/v1/stocks/market/quotes" })))
    assert.equal(calls.length, 1)
    for (const reply of replies) {
      assert.equal(reply.statusCode, 200)
      assert.equal(reply.json().provider, "ALPACA")
      assert.equal(reply.json().marketFeed, "IEX")
      assert.equal(reply.json().data.find((row: { symbol: string }) => row.symbol === "NVDA").price, "120")
      assert.ok(!/TEST_SECRET|TEST_ID|MUST_NOT_USE/.test(reply.body))
    }
    const profile = await app.inject({ method: "GET", url: "/api/v1/stocks/market/NVDA/profile" })
    assert.equal(profile.json().status, "UNCONFIGURED")
    assert.equal(calls.length, 1)
  } finally { await app.close() }
})

test("Massive Basic caps profiles at four calls, skips paid ETF AUM and does not consume Alpaca budget", async () => {
  const calls: string[] = []
  const app = await createLiveMarket({
    readCredentials: () => ({ ALPACA_API_KEY_ID: "TEST_ID", ALPACA_API_SECRET_KEY: "TEST_SECRET" }),
    readMassiveCredentials: () => ({ MASSIVE_API_KEY: "MASSIVE_TEST_SECRET" }),
    fetch: async (input, init) => {
      const url = new URL(String(input)); calls.push(url.href)
      const headers = new Headers(init?.headers)
      if (url.hostname === "api.massive.com") {
        assert.equal(headers.get("authorization"), "Bearer MASSIVE_TEST_SECRET")
        assert.equal(headers.get("APCA-API-SECRET-KEY"), null)
        assert.ok(url.pathname.startsWith("/v3/reference/tickers/"))
        const symbol = url.pathname.split("/").slice(-1)[0]
        return new Response(JSON.stringify({ status: "OK", results: { ticker: symbol, name: symbol, locale: "us", market: "stocks", currency_name: "usd", type: symbol === "SOXL" ? "ETF" : "CS", market_cap: 5367153690000, share_class_shares_outstanding: symbol === "SOXL" ? 175700060 : undefined } }), { headers: { "content-type": "application/json" } })
      }
      assert.equal(url.hostname, "data.alpaca.markets")
      assert.equal(headers.get("authorization"), null)
      return new Response(JSON.stringify({ NVDA: { latestTrade: { p: 120, t: new Date().toISOString() } } }), { headers: { "content-type": "application/json" } })
    },
  })
  try {
    for (const symbol of ["NVDA", "MU", "SOXL", "TSLA"]) {
      const reply = await app.inject({ method: "GET", url: `/api/v1/stocks/market/${symbol}/profile` })
      const data = reply.json()
      assert.equal(data.status, "AVAILABLE")
      assert.equal(data.provider, "MASSIVE")
      assert.equal(data.data.marketCap, "5367153690000")
      assert.equal(data.data.aum, null)
      assert.equal(data.data.sharesOutstanding, symbol === "SOXL" ? "175700060" : null)
      assert.ok(!/MASSIVE_TEST_SECRET|TEST_SECRET/.test(reply.body))
    }
    assert.equal(calls.length, 4)
    const cached = await app.inject({ method: "GET", url: "/api/v1/stocks/market/NVDA/profile" })
    assert.equal(cached.json().status, "AVAILABLE"); assert.equal(calls.length, 4)
    const limited = await app.inject({ method: "GET", url: "/api/v1/stocks/market/GOOGL/profile" })
    assert.equal(limited.json().reason, "REQUEST_BUDGET_EXHAUSTED"); assert.equal(calls.length, 4)
    const quote = await app.inject({ method: "GET", url: "/api/v1/stocks/market/quotes" })
    assert.equal(quote.json().status, "AVAILABLE"); assert.equal(quote.json().provider, "ALPACA")
    assert.equal(calls.length, 5)
  } finally { await app.close() }
})
