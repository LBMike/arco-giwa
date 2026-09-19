import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { createMarketClient, normalizeApiBase } from "./client"
import { fixtureCatalog, fixtureChart, fixtureEnvelope, fixtureMarketFetch, fixtureProfile, fixtureQuote } from "./fixtures"
import { decimal, envelope, parseCatalog, parseChart, parseProfile, parseQuotes, safeLogo } from "./validate"
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
  const chart = fixtureChart(); chart.bars = [chart.bars[0], { ...chart.bars[2], close: "187" }]
  assert.equal(windowChange(chart), "+10.00%")
  assert.notEqual(windowChange(chart), `${fixtureQuote().changePercent}%`)
  assert.deepEqual(chartPoints(chart).map(p => p.segment), [0, 1])
  chart.bars = chart.bars.slice(0, 1); assert.equal(windowChange(chart), "—")
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
