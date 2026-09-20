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
