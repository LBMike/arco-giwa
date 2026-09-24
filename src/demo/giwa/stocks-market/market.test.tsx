import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { createMarketClient, normalizeApiBase, type MarketEventSourceFactory } from "./client"
import { fixtureCatalog, fixtureChart, fixtureEnvelope, fixtureMarketFetch, fixtureProfile, fixtureQuote } from "./fixtures"
import { decimal, envelope, parseCatalog, parseChart, parseNvdaLiveSnapshot, parseProfile, parseQuotes, safeLogo } from "./validate"
import { chartPoints, dollars, windowChange } from "./display"
import { MarketChart } from "./MarketChart"

test("strict display context and bounded symbols reject malformed or mixed contracts", () => {
  assert.equal(envelope(fixtureEnvelope(fixtureCatalog()), parseCatalog).data?.securities.length, 2)
  for (const patch of [{ schemaVersion: 2 }, { chainId: 1 }, { purpose: "TRADING" }, { provider: "OTHER" }, { executionPriceSource: "LIVE" }, { fetchedAt: "yesterday" }]) assert.throws(() => envelope({ ...fixtureEnvelope(fixtureCatalog()), ...patch }, parseCatalog))
  assert.throws(() => parseCatalog({ ...fixtureCatalog(), securities: [fixtureCatalog().securities[0], fixtureCatalog().securities[0]] }))
})
test("quotes join exact symbols despite reversed ordering and reject duplicates or missing symbols", async () => {
  const client = createMarketClient("https://api.fixture", fixtureMarketFetch())
  const quotes = await client.quotes(["NVDA", "AAPL"], new AbortController().signal)
  const bySymbol = new Map(quotes.data!.map(q => [q.symbol, q]))
  assert.equal(bySymbol.get("NVDA")?.price, "183.123456789012345678")
  for (const list of [[fixtureQuote()], [fixtureQuote(), fixtureQuote()], [fixtureQuote(), fixtureQuote("TSLA")]]) assert.throws(() => parseQuotes(list, ["NVDA", "AAPL"]))
})
test("decimal strings retain all precision and reject numeric/exponent/overflow forms", () => {
  assert.equal(dollars(decimal("123456789012345678901234567890.123456789012345678")), "$123,456,789,012,345,678,901,234,567,890.123456789012345678")
  for (const value of [1.2, "1e9", "01", "NaN", "0.1234567890123456789", "1".repeat(31), "-1"]) assert.throws(() => decimal(value))
  assert.equal(dollars(null), "—")
})
test("profile logo accepts only the matching symbol's same-API proxy, never remote credentials", () => {
  assert.equal(safeLogo("/api/v1/stocks/market/NVDA/logo", "https://api.fixture", "NVDA"), "https://api.fixture/api/v1/stocks/market/NVDA/logo")
  for (const value of ["https://api.massive.com/icon?apiKey=secret", "//evil.invalid/icon", "/api/v1/stocks/market/AAPL/logo", "/api/v1/stocks/market/NVDA/logo?key=x"]) assert.throws(() => safeLogo(value, "https://api.fixture", "NVDA"))
  assert.throws(() => parseProfile({ ...fixtureProfile(), website: "javascript:alert(1)" }, "NVDA", "https://api.fixture"))
})
test("chart rejects wrong symbol/range, out-of-order/future bars and impossible OHLC", () => {
  const good = fixtureChart()
  assert.equal(parseChart(good, "NVDA", "1D").bars.length, 12)
  for (const bad of [{ ...good, symbol: "AAPL" }, { ...good, range: "1M" }, { ...good, bars: [...good.bars].reverse() }, { ...good, bars: [{ ...good.bars[0], close: "999" }] }, { ...good, bars: [{ ...good.bars[0], timestamp: "2099-01-01T00:00:00.000Z" }] }, { ...good, complete: false }]) assert.throws(() => parseChart(bad, "NVDA", "1D"))
})
test("returned-window change uses exact closes, not snapshot daily percentage; gaps are segmented", () => {
  const chart = fixtureChart(); const bars = chart.bars; chart.bars = [bars[0], { ...bars[2], close: "187" }]
  assert.equal(windowChange(chart), "+10.00%")
  assert.notEqual(windowChange(chart), `${fixtureQuote().changePercent}%`)
  assert.deepEqual(chartPoints(chart).map(p => p.segment), [0, 0], "nearby observed closes can form one line without an invented bar")
  chart.bars = [bars[0], bars[4]]
  assert.deepEqual(chartPoints(chart).map(p => p.segment), [0, 1], "a longer unobserved interval remains a visible gap")
  chart.bars = chart.bars.slice(0, 1); assert.equal(windowChange(chart), "—")
})
test("historical closes stay connected across market closures without inventing observations", () => {
  const daily = fixtureChart()
  daily.interval = "1d"
  daily.range = "3M"
  const sample = daily.bars[0]
  daily.bars = ["2026-09-18T20:00:00.000Z", "2026-09-21T20:00:00.000Z", "2026-09-22T20:00:00.000Z"].map(timestamp => ({ ...sample, timestamp }))
  assert.deepEqual(chartPoints(daily).map(point => point.segment), [0, 0, 0], "Friday and Monday closes form one historical line")
  assert.equal(chartPoints(daily).length, 3, "non-trading days add no artificial bars")
  daily.bars.push({ ...sample, timestamp: "2026-09-29T20:00:00.000Z" })
  assert.deepEqual(chartPoints(daily).map(point => point.segment), [0, 0, 0, 1], "a missing trading week stays visibly disconnected")

  const hourly = fixtureChart()
  hourly.interval = "1h"
  hourly.range = "1W"
  hourly.bars = ["2026-09-18T19:00:00.000Z", "2026-09-21T14:00:00.000Z"].map(timestamp => ({ ...sample, timestamp }))
  assert.deepEqual(chartPoints(hourly).map(point => point.segment), [0, 0], "hourly charts also span a normal weekend")
})
test("keyless calls have explicit null values, public GET, no Bearer/cookies or provider endpoint", async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fixture = fixtureMarketFetch("keyless", ["NVDA"])
  const client = createMarketClient("https://api.fixture", async (url, init) => { calls.push({ url, init }); return fixture(url, init) })
  assert.equal((await client.catalog(new AbortController().signal)).data?.provenance.verification, "PILOT")
  assert.equal((await client.quotes(["NVDA"], new AbortController().signal)).data?.[0].price, null)
  assert.equal((await client.chart("NVDA", "1D", new AbortController().signal)).status, "UNCONFIGURED")
  for (const call of calls) { assert.ok(call.url.startsWith("https://api.fixture/api/v1/stocks/market/")); assert.equal(call.init.method, "GET"); assert.equal(call.init.credentials, "omit"); assert.equal(new Headers(call.init.headers).get("authorization"), null) }
})
test("bounded transport terminates ignored-abort fetches, bad HTTP and oversized bodies", async () => {
  const never = createMarketClient("https://api.fixture", () => new Promise(() => {}), 5)
  await assert.rejects(never.catalog(new AbortController().signal))
  const large = createMarketClient("https://api.fixture", async () => new Response("x".repeat(2_000_001)))
  await assert.rejects(large.catalog(new AbortController().signal))
  const denied = createMarketClient("https://api.fixture", async () => new Response("secret upstream", { status: 401 }))
  await assert.rejects(denied.catalog(new AbortController().signal), /MARKET_HTTP_UNAVAILABLE/)
})
test("keyless/empty/one/partial/stale charts have explicit distinct presentation without invented observations", () => {
  const keyless = renderToStaticMarkup(<MarketChart response={{ status: "UNCONFIGURED", reason: "NOT_CONFIGURED", fetchedAt: null, cacheAgeMs: null, feedDelay: "UNKNOWN", data: null }} />)
  assert.match(keyless, /시세 연결 준비 중/); assert.doesNotMatch(keyless, /recharts|\$0/)
  for (const kind of ["empty", "one", "partial", "stale"]) {
    const chart = fixtureChart(); if (kind === "empty") { chart.bars = []; chart.history = "EMPTY" }; if (kind === "one") chart.bars = chart.bars.slice(0, 1); if (kind === "partial") { chart.history = "TRUNCATED"; chart.complete = false }
    const html = renderToStaticMarkup(<MarketChart response={{ status: kind === "stale" ? "STALE" : "AVAILABLE", reason: null, fetchedAt: null, cacheAgeMs: null, feedDelay: "UNKNOWN", data: chart }} />)
    assert.match(html, new RegExp(kind === "empty" ? "반환된 차트 관측값이 없습니다" : kind === "one" ? "관측값 1개" : kind === "partial" ? "일부 이력만 반환됨" : "마지막 확인 시세 · 오래된 데이터"))
  }
})

test("monotonic elapsed guard rejects late success before a delayed timeout callback can run", async () => {
  const client = createMarketClient("https://api.fixture", async () => {
    const until = performance.now() + 20
    while (performance.now() < until) { /* Simulate a main-thread stall before timer delivery. */ }
    return Response.json(fixtureEnvelope(fixtureCatalog()))
  }, 5)
  await assert.rejects(client.catalog(new AbortController().signal), /MARKET_REQUEST_CANCELLED/)
})
test("a base with a bare query or fragment delimiter is refused before the public catalog request", () => {
  for (const base of ["https://api.test?", "https://api.test#", "https://api.test/prefix?", "https://api.test/prefix#"]) {
    const calls: string[] = []
    assert.throws(() => createMarketClient(base, async url => { calls.push(url); return Response.json({}) }), (error: unknown) => error instanceof Error && error.message === "INVALID_API_BASE", base)
    assert.throws(() => normalizeApiBase(base), (error: unknown) => error instanceof Error && error.message === "INVALID_API_BASE", base)
    assert.equal(calls.length, 0)
  }
})
test("a path-prefixed base sends the public catalog under the prefix without Authorization", async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fixture = fixtureMarketFetch()
  const client = createMarketClient("https://api.test/prefix//", async (url, init) => { calls.push({ url, init }); return fixture(url, init) })
  assert.equal(client.baseUrl, "https://api.test/prefix")
  assert.equal(normalizeApiBase("https://api.test/prefix%3Fsegment/"), "https://api.test/prefix%3Fsegment")
  await client.catalog(new AbortController().signal)
  assert.deepEqual(calls.map(c => [c.url, new Headers(c.init.headers).get("authorization")]), [["https://api.test/prefix/api/v1/stocks/market/catalog", null]])
})

test("Alpaca envelopes retain feed coverage, accept public quotes and reject ambiguous providers", async () => {
  for (const marketFeed of ["IEX", "SIP"] as const) {
    const reply = { ...fixtureEnvelope([fixtureQuote()]), provider: "ALPACA", marketFeed }
    const client = createMarketClient("https://api.fixture", async (_url, init) => {
      const headers = new Headers(init.headers)
      assert.equal(headers.get("APCA-API-KEY-ID"), null)
      assert.equal(headers.get("APCA-API-SECRET-KEY"), null)
      return Response.json(reply)
    })
    const response = await client.quotes(["NVDA"], new AbortController().signal)
    assert.equal(response.provider, "ALPACA")
    assert.equal(response.marketFeed, marketFeed)
    assert.equal(response.data?.[0].price, "183.123456789012345678")
  }
  for (const patch of [{ provider: "ALPACA" }, { provider: "ALPACA", marketFeed: "ALL" }, { provider: "ALPACA", marketFeed: "iex" }, { provider: "MASSIVE", marketFeed: "SIP" }]) {
    assert.throws(() => envelope({ ...fixtureEnvelope(fixtureCatalog()), ...patch }, parseCatalog))
  }
  const profile = envelope(fixtureEnvelope(fixtureProfile()), value => parseProfile(value, "NVDA", "https://api.fixture"))
  assert.equal(profile.provider, "MASSIVE", "hybrid fundamentals keep their own source")
  assert.equal(profile.marketFeed, undefined)
})

const liveNvdaFixture = () => ({
  schemaVersion: 1, symbol: "NVDA", observedAt: "2026-09-24T18:00:00.000Z",
  underlying: { basis: "UNDERLYING_SECURITY", currency: "USD", price: "125.25", change: "5.25", changePercent: "4.375", sessionVolume: "1000", previousClose: "120", observationAgeMs: 30000, status: "AVAILABLE", reason: null, sourceTimestamp: "2026-09-24T17:59:30.000Z", priceSource: "LAST_TRADE", provider: "ALPACA", marketFeed: "IEX", feedDelay: "REALTIME" },
  marketSession: { state: "OPEN", observedAt: "2026-09-24T18:00:00.000Z", nextOpen: "2026-09-25T13:30:00.000Z", nextClose: "2026-09-24T20:00:00.000Z" },
  token: { basis: "ARCO_TOKEN", indicativePrice: null, status: "UNAVAILABLE" },
  testnetExecution: { mode: "FIXED_MOCK_PRICE", status: "CATALOG_ONLY", unitPrice: "120.000000", quoteRequired: true },
})

test("NVDA live parser accepts the separate price lanes and rejects malformed market or order claims", () => {
  const fixture = liveNvdaFixture()
  assert.deepEqual(parseNvdaLiveSnapshot(fixture), fixture)
  const unavailable = { ...fixture, underlying: { ...fixture.underlying, price: null, change: null, changePercent: null, sessionVolume: null, previousClose: null, observationAgeMs: null, sourceTimestamp: null, priceSource: null, provider: null, marketFeed: null, feedDelay: "UNKNOWN", status: "UNAVAILABLE" }, marketSession: { state: "UNKNOWN", observedAt: null, nextOpen: null, nextClose: null }, testnetExecution: { ...fixture.testnetExecution, status: "UNAVAILABLE", unitPrice: null } }
  assert.equal(parseNvdaLiveSnapshot(unavailable).underlying.price, null)
  const badValues = [
    { ...fixture, schemaVersion: 2 },
    { ...fixture, symbol: "AAPL" },
    { ...fixture, underlying: { ...fixture.underlying, price: 125.25 } },
    { ...fixture, underlying: { ...fixture.underlying, changePercent: "4e2" } },
    { ...fixture, underlying: { ...fixture.underlying, observationAgeMs: -1 } },
    { ...fixture, underlying: { ...fixture.underlying, sourceTimestamp: "2026-09-24T18:02:00.000Z" } },
    { ...fixture, underlying: { ...fixture.underlying, marketFeed: null } },
    { ...fixture, underlying: { ...fixture.underlying, status: "UNAVAILABLE" } },
    { ...fixture, marketSession: { ...fixture.marketSession, nextClose: null } },
    { ...fixture, token: { ...fixture.token, indicativePrice: "125.25" } },
    { ...fixture, testnetExecution: { ...fixture.testnetExecution, quoteRequired: false } },
    { ...fixture, testnetExecution: { ...fixture.testnetExecution, unitPrice: null } },
  ]
  for (const value of badValues) assert.throws(() => parseNvdaLiveSnapshot(value), /MARKET_RESPONSE_INVALID/)
})

test("NVDA live JSON read uses a bounded public GET at the validated base", async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const client = createMarketClient("https://api.fixture/prefix//", async (url, init) => { calls.push({ url, init }); return Response.json(liveNvdaFixture()) })
  const live = await client.liveNvda(new AbortController().signal)
  assert.equal(live.underlying.price, "125.25")
  assert.deepEqual(calls.map(({ url, init }) => [url, init.method, init.credentials, init.redirect, new Headers(init.headers).get("authorization")]), [["https://api.fixture/prefix/api/v1/stocks/market/NVDA/live", "GET", "omit", "error", null]])
  const oversized = createMarketClient("https://api.fixture", async () => new Response("x".repeat(65_537)))
  await assert.rejects(oversized.liveNvda(new AbortController().signal), /MARKET_RESPONSE_INVALID/)
})

class FakeMarketStream extends EventTarget {
  closes = 0
  close() { this.closes++ }
  snapshot(data: unknown) { const event = new Event("snapshot"); Object.defineProperty(event, "data", { value: data }); this.dispatchEvent(event) }
  fail() { this.dispatchEvent(new Event("error")) }
}

test("NVDA EventSource accepts named snapshots, reports reconnect errors, and closes malformed events", () => {
  const stream = new FakeMarketStream()
  const starts: { url: string; init: { withCredentials: false } }[] = []
  const factory: MarketEventSourceFactory = (url, init) => { starts.push({ url, init }); return stream }
  const client = createMarketClient("https://api.fixture/prefix", undefined, 10_000, factory)
  const prices: string[] = []
  let errors = 0
  const stop = client.subscribeNvda(snapshot => prices.push(snapshot.underlying.price ?? "—"), () => { errors++ })
  assert.ok(stop)
  assert.deepEqual(starts, [{ url: "https://api.fixture/prefix/api/v1/stocks/market/NVDA/live/stream", init: { withCredentials: false } }])
  const ignored = new Event("message"); Object.defineProperty(ignored, "data", { value: JSON.stringify(liveNvdaFixture()) }); stream.dispatchEvent(ignored)
  assert.deepEqual(prices, [], "only the named snapshot event is consumed")
  stream.snapshot(JSON.stringify(liveNvdaFixture()))
  assert.deepEqual(prices, ["125.25"])
  stream.fail()
  assert.equal(errors, 1)
  assert.equal(stream.closes, 0, "browser EventSource may reconnect after a transport error")
  stream.snapshot(JSON.stringify({ ...liveNvdaFixture(), token: { basis: "ARCO_TOKEN", indicativePrice: "125.25", status: "AVAILABLE" } }))
  assert.equal(errors, 2)
  assert.equal(stream.closes, 1)
  stream.snapshot(JSON.stringify(liveNvdaFixture()))
  stop()
  assert.deepEqual(prices, ["125.25"])
  assert.equal(stream.closes, 1)
})

test("NVDA EventSource rejects oversized snapshots and failed construction without leaking payloads", () => {
  const stream = new FakeMarketStream()
  const client = createMarketClient("https://api.fixture", undefined, 10_000, () => stream)
  let errors = 0
  const stop = client.subscribeNvda(() => assert.fail("oversized data must not publish"), () => { errors++ })
  assert.ok(stop)
  stream.snapshot("x".repeat(65_537))
  assert.equal(errors, 1)
  assert.equal(stream.closes, 1)
  assert.equal(createMarketClient("https://api.fixture", undefined, 10_000, () => { throw new Error("secret") }).subscribeNvda(() => {}, () => { errors++ }), null)
  assert.equal(errors, 2)
  if (typeof globalThis.EventSource !== "function") assert.equal(createMarketClient("https://api.fixture").subscribeNvda(() => {}, () => {}), null)
})
