import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { DemoPresentationContext } from "../demo-presentation"
import { StocksHighlights } from "./StocksHighlights"
import { stockHighlights } from "./highlights"
import { fixtureCatalog, fixtureQuote, fixtureTop40Catalog, fixtureTop40Quotes } from "./fixtures"
import type { Quote } from "./contracts"

const quote = (symbol: string, changePercent: string | null, overrides: Partial<Quote> = {}): Quote => ({ ...fixtureQuote(symbol), changePercent, ...overrides })
const symbols = (rows: ReturnType<typeof stockHighlights>["gainers"]) => rows.map(row => row.security.symbol)

test("gainers ranks positive changes precisely, excludes missing/stale/unlisted rows, and caps at three", () => {
  const catalog = fixtureCatalog(["A", "B", "C", "D", "E", "F", "G", "H"])
  const quotes = [quote("A", "1"), quote("B", "2.000000000000000001"), quote("C", "2.000000000000000002"), quote("D", "0"), quote("E", "-3"), quote("F", "100", { status: "STALE" }), quote("G", null), quote("H", "0.5"), quote("UNLISTED", "999")]
  const original = JSON.stringify({ catalog, quotes })
  assert.deepEqual(symbols(stockHighlights(catalog, quotes).gainers), ["C", "B", "A"])
  assert.equal(JSON.stringify({ catalog, quotes }), original, "ranking must not mutate shared catalog/quotes")
})

test("trending uses dollar turnover rather than share count and handles zero/missing values", () => {
  const catalog = fixtureCatalog(["A", "B", "C", "D", "E", "F"])
  const quotes = [quote("A", "1", { price: "1", sessionVolume: "100" }), quote("B", "1", { price: "20", sessionVolume: "10" }), quote("C", "1", { price: null }), quote("D", "1", { sessionVolume: null }), quote("E", "1", { sessionVolume: "0" }), quote("F", "1", { status: "UNAVAILABLE" })]
  assert.deepEqual(symbols(stockHighlights(catalog, quotes).trending), ["B", "A"])
})

test("ties are deterministic and all three cards are limited to catalog securities", () => {
  const groups = stockHighlights(fixtureTop40Catalog(), fixtureTop40Quotes().reverse())
  assert.deepEqual(Object.values(groups).map(rows => rows.length), [3, 3, 3])
  const catalog = fixtureCatalog(["C", "B", "A"])
  const quotes = ["A", "B", "C"].map(symbol => quote(symbol, "2", { price: "2", sessionVolume: "2" }))
  assert.deepEqual(symbols(stockHighlights(catalog, quotes).gainers), ["A", "B", "C"])
})

test("Newly Added uses the known expansion batch, never quote order or reverse rank; prices may be missing", () => {
  const catalog = fixtureCatalog(["NVDA", "TSLA", "UNLISTED", "MU", "SOXL"])
  catalog.securities.forEach((row, index) => { row.rank = index + 1 })
  assert.deepEqual(symbols(stockHighlights(catalog).newlyAdded), ["SOXL", "MU", "TSLA"])
  assert.deepEqual(stockHighlights(fixtureCatalog(["NVDA", "UNKNOWN"])).newlyAdded, [])
  assert.deepEqual(stockHighlights(null), { gainers: [], trending: [], newlyAdded: [] })
})

test("last observed quotes populate all three cards when the market has no current observations", () => {
  const catalog = fixtureCatalog(["SOXL", "MU", "TSLA"])
  const quotes = [quote("SOXL", "2", { status: "STALE", sourceTimestamp: "2026-09-23T20:00:00.000Z" }), quote("MU", "1", { status: "STALE", sourceTimestamp: "2026-09-23T20:00:00.000Z" }), quote("TSLA", "-1", { status: "STALE", sourceTimestamp: "2026-09-23T20:00:00.000Z" })]
  const groups = stockHighlights(catalog, quotes)
  assert.deepEqual(symbols(groups.gainers), ["SOXL", "MU"])
  assert.deepEqual(symbols(groups.trending), ["MU", "SOXL", "TSLA"])
  assert.equal(groups.newlyAdded[0].quote?.price, quotes[0].price)
  const html = renderToStaticMarkup(<MemoryRouter><StocksHighlights groups={groups} /></MemoryRouter>)
  assert.doesNotMatch(html, /No current market data|Price —/)
  assert.match(html, /Last observed/)
  assert.match(html, /Sep 23/)
  const customer = renderToStaticMarkup(<DemoPresentationContext.Provider value><MemoryRouter><StocksHighlights groups={groups} /></MemoryRouter></DemoPresentationContext.Provider>)
  assert.doesNotMatch(customer, /Last observed|Sep 23|>24H<\/span>/)
  assert.equal((customer.match(/<h2 /g) ?? []).length, 3)
  assert.equal((customer.match(/<li /g) ?? []).length, 8)
})

test("cards render titles, badges, actual detail links and at most three rows even if oversized input is supplied", () => {
  const groups = stockHighlights(fixtureTop40Catalog(), fixtureTop40Quotes())
  groups.gainers.push(...groups.trending)
  const html = renderToStaticMarkup(<MemoryRouter><StocksHighlights groups={groups} /></MemoryRouter>)
  assert.equal((html.match(/<h2 /g) ?? []).length, 3)
  assert.equal((html.match(/>24H<\/span>/g) ?? []).length, 2)
  assert.equal((html.match(/<li /g) ?? []).length, 9)
  assert.equal((html.match(/href="\/stocks\?symbol=/g) ?? []).length, 9)
  for (const title of ["Top Gainers", "Trending", "Newly Added"]) assert.ok(html.includes(title))
  assert.match(html, /href="\/stocks\?symbol=SOXL"/)
  assert.match(html, /Estimated session volume/)
})

test("empty/loading cards keep headings without fabricated quotes or links", () => {
  const html = renderToStaticMarkup(<MemoryRouter><StocksHighlights groups={stockHighlights(null)} status="Loading…" /></MemoryRouter>)
  assert.equal((html.match(/Loading…/g) ?? []).length, 3)
  assert.doesNotMatch(html, /<a /)
})
