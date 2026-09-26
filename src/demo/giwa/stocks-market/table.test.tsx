import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { StaticRouter } from "react-router-dom"
import type { Catalog, Envelope, Quote } from "./contracts"
import { changeParts, compactDollars, volumeDollars } from "./display"
import { MarketChart } from "./MarketChart"
import { FIXTURE_TIME, fixtureCatalog, fixtureChart, fixtureQuote, fixtureTop40Catalog, fixtureTop40Chart, fixtureTop40Quote, fixtureTop40Quotes, TOP40_FLAT, TOP40_STALE, TOP40_UNAVAILABLE } from "./fixtures"
import { DEFAULT_TABLE_VIEW, StocksMarketTable, type Capabilities, type StocksMarketTableProps } from "./StocksMarketTable"
import type { ReadState } from "./useOwnedRead"

const ready = (data: Quote[]): ReadState<Envelope<Quote[]>> => ({ phase: "ready", value: { status: "AVAILABLE", reason: null, fetchedAt: FIXTURE_TIME, cacheAgeMs: 0, feedDelay: "UNKNOWN", data } })
const NVDA_ORDERS: Capabilities = { phase: "ready", bySymbol: new Map([["NVDA", "CHECK_PAUSE_AT_ORDER"]]) }
function render(props: Partial<StocksMarketTableProps> = {}) {
  return renderToStaticMarkup(<StaticRouter location="/"><StocksMarketTable catalog={fixtureTop40Catalog()} quotes={ready(fixtureTop40Quotes())} capabilities={NVDA_ORDERS} series={{}} variant="full" selectedSymbol="SOXL" onSelect={() => {}} {...props} /></StaticRouter>)
}
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&")
const bodyRows = (html: string) => html.split('<div role="row"').slice(2)
const rowOf = (html: string, symbol: string) => { const row = bodyRows(html).find(chunk => chunk.includes(`data-symbol="${symbol}"`) || chunk.includes(`symbol=${symbol}"`)); assert.ok(row, symbol); return row }
const ranks = (html: string) => bodyRows(html).map(chunk => Number(/role="cell" class="[^"]*">(\d+)<\/div>/.exec(chunk)?.[1]))
const cells = (row: string) => row.split('<div role="cell"').slice(1).map(chunk => text(chunk.slice(chunk.indexOf(">") + 1)))

test("header distinguishes previous-close return without restoring the removed price footnote marker", () => {
  const html = render()
  const headers = [...html.matchAll(/role="columnheader"[^>]*>(.*?)<\/div>/g)].map(match => text(match[1].replace(/<sup[^>]*>.*?<\/sup>/, "")))
  assert.deepEqual(headers, ["#", "Asset Name", "Price", "Prev Close (%)", "Mkt Cap", "Volume (USD)", "Asset Status", "1D Chart"])
  assert.match(html, /title="Change versus the previous close, not the rolling 24-hour chart return">Prev Close \(%\)/)
  assert.match(html, /title="Stocks: market capitalization · ETFs: assets under management">Mkt Cap/)
  assert.doesNotMatch(html, /Price<sup aria-hidden="true"[^>]*>1<\/sup>/)
  assert.match(html, /role="table" aria-label="Stocks &amp; ETFs"/)
  assert.match(html, /role="region" aria-label="[^"]+" tabindex="0"[^>]*overflow-x-auto/)
})

test("# shows the server rank (catalog position only when the server ranks no row) and default sorting is by that rank", () => {
  assert.deepEqual(ranks(render()), Array.from({ length: 40 }, (_, index) => index + 1))
  const quotes = ready([fixtureQuote("NVDA"), fixtureQuote("AAPL")])
  const partial: Catalog = { securities: [{ symbol: "AAPL", name: "Apple" }, { symbol: "NVDA", name: "NVIDIA", rank: 10 }], provenance: fixtureCatalog().provenance }
  const html = render({ catalog: partial, quotes })
  assert.deepEqual(bodyRows(html).map(chunk => /data-symbol="([A-Z]+)"/.exec(chunk)?.[1]), ["NVDA", "AAPL"], "unranked rows sort after ranked ones")
  assert.deepEqual(bodyRows(html).map(chunk => cells(chunk)[0]), ["10", "—"], "a missing rank is never invented from the position")
  const unranked: Catalog = { securities: [{ symbol: "AAPL", name: "Apple" }, { symbol: "NVDA", name: "NVIDIA" }], provenance: fixtureCatalog().provenance }
  assert.deepEqual(ranks(render({ catalog: unranked, quotes })), [1, 2])
})

test("changeParts: two-decimal half-up magnitude; anything that rounds to zero is flat; null stays null", () => {
  assert.equal(changeParts(null), null)
  assert.deepEqual(changeParts("-0.004"), { direction: "flat", magnitude: "0" })
  assert.deepEqual(changeParts("0.004999"), { direction: "flat", magnitude: "0" })
  assert.deepEqual(changeParts("0.005"), { direction: "up", magnitude: "0.01" })
  assert.deepEqual(changeParts("-3.355"), { direction: "down", magnitude: "3.36" })
  assert.deepEqual(changeParts("3.60"), { direction: "up", magnitude: "3.6" })
})

test("row values: rounded price with exact title, unsigned change with direction cue, estimated USD volume, dashes for missing data", () => {
  const html = render()
  const soxl = fixtureTop40Quote("SOXL")
  const row = rowOf(html, "SOXL")
  assert.match(row, new RegExp(`title="\\$${soxl.price!.replace(".", "\\.")}"`))
  assert.deepEqual(cells(row).slice(2, 6), ["$171.63", "Down 0.66%", "—", "$7.53B"])
  assert.match(rowOf(html, "SOXS"), /Up <\/span>3\.67%/)
  assert.match(row, /<svg aria-hidden="true" width="12" height="10"/)
  for (const symbol of TOP40_UNAVAILABLE) assert.deepEqual(cells(rowOf(html, symbol)).slice(2, 6), ["—", "—", "—", "—"], symbol)
  const flat = cells(rowOf(html, TOP40_FLAT)).slice(3, 5)
  assert.deepEqual(flat, ["0%", "—"])
  assert.doesNotMatch(rowOf(html, TOP40_FLAT), /Up|Down|width="12" height="10"/)
  for (const symbol of TOP40_STALE) {
    const staleRow = rowOf(html, symbol)
    assert.doesNotMatch(staleRow, /Stale data/)
    assert.match(staleRow, /title="[^"]+ · Last observed /)
    assert.match(staleRow, /class="sr-only">Last observed price · /)
  }
  assert.match(html, /Estimated session turnover:/)
  for (const quote of fixtureTop40Quotes().filter(item => item.sessionVolume)) assert.equal(cells(rowOf(html, quote.symbol))[5], compactDollars(volumeDollars(quote.price, quote.sessionVolume)))
})

test("Asset Status shows the order capability, market-data-only, loading and error states; never session claims", () => {
  const html = render({ capabilities: { phase: "ready", bySymbol: new Map([["NVDA", "CHECK_PAUSE_AT_ORDER"], ["SOXL", "NOT_ACTIVATED"]]) } })
  assert.match(cells(rowOf(html, "NVDA"))[6], /^Demo trading$/)
  assert.match(rowOf(html, "NVDA"), /title="Testnet simulated trading · Pause status checked when ordering"/)
  assert.equal(cells(rowOf(html, "SOXL"))[6], "Inactive")
  assert.match(rowOf(html, "SOXL"), /class="[^"]*text-\[var\(--color-arco-chip-ink\)\][^"]*">.*Inactive/, "not-activated reads quieter, like Figma's closed state")
  assert.doesNotMatch(rowOf(html, "NVDA"), /text-\[var\(--color-arco-ink\)\][^"]*text-\[var\(--color-arco-chip-ink\)\]/, "one text colour per badge")
  assert.equal(cells(rowOf(html, "MU"))[6], "Market data only")
  assert.ok(bodyRows(render({ capabilities: { phase: "loading" } })).every(row => cells(row)[6] === "Checking"))
  assert.ok(bodyRows(render({ capabilities: { phase: "error" } })).every(row => cells(row)[6] === "Status unavailable"))
  for (const html of [render(), render({ variant: "home", rowHref: symbol => `/stocks?symbol=${symbol}` })]) assert.doesNotMatch(text(html), /Asset Open|Market Closed|24\/7|Off-Hours|452|Most Popular/)
})

test("full toolbar: title with count pill, asset-type chips, labelled search, sort options disabled without values, live count", () => {
  const html = render()
  assert.match(html, /<h2[^>]*>Stocks &amp; ETFs<\/h2><span[^>]*>40<span class="sr-only"> assets<\/span><\/span>/)
  assert.match(html, /role="group" aria-label="Asset type"/)
  assert.deepEqual([...html.matchAll(/aria-pressed="(true|false)"[^>]*>(All assets|Stocks|ETF)</g)].map(match => [match[2], match[1]]), [["All assets", "true"], ["Stocks", "false"], ["ETF", "false"]])
  assert.match(html, /<label for="([^"]+)" class="sr-only">Search asset name or ticker<\/label>.*<input id="\1" type="search"[^>]*placeholder="Search asset name or ticker"/)
  assert.match(html, /<label for="([^"]+)" class="sr-only">Sort<\/label><select id="\1"/)
  assert.deepEqual([...html.matchAll(/<option value="[a-zA-Z]+"[^>]*>([^<]+)<\/option>/g)].map(match => match[1]), ["Rank", "Top Gainer", "Top Loser", "Price: High to Low", "Price: Low to High"])
  assert.match(html, /role="status" class="sr-only">Showing 40 of 40 assets</)
  const loading = render({ quotes: { phase: "loading" } })
  assert.equal([...loading.matchAll(/<option value="(gainer|loser|priceHigh|priceLow)" disabled=""/g)].length, 4)
  assert.match(loading, /<option value="rank" selected=""/)
  const pilot = render({ catalog: fixtureCatalog(["NVDA", "AAPL"]), quotes: ready([fixtureQuote("NVDA"), fixtureQuote("AAPL")]) })
  assert.match(pilot, /<button type="button" aria-pressed="false" disabled=""[^>]*>ETF<\/button>/, "a chip with no matches is disabled")
  assert.doesNotMatch(pilot, /<button type="button" aria-pressed="false" disabled=""[^>]*>Stocks<\/button>/)
})

test("toolbar state can be held by the page (defaults: all assets, empty search, rank) so it survives a detail visit", () => {
  const etf = render({ view: { filter: "ETF", query: "", sort: "rank" }, onViewChange: () => {} })
  assert.equal(bodyRows(etf).length, 14)
  assert.match(etf, /aria-pressed="true"[^>]*>ETF<\/button>/)
  assert.match(etf, /role="status" class="sr-only">Showing 14 of 40 assets</)
  const search = render({ view: { filter: "ALL", query: "nvid", sort: "priceHigh" }, onViewChange: () => {} })
  assert.deepEqual(bodyRows(search).map(chunk => /data-symbol="([A-Z]+)"/.exec(chunk)?.[1]), ["NVDA"])
  assert.match(search, /<input id="[^"]+" type="search"[^>]* value="nvid"/)
  assert.match(search, /<option value="priceHigh" selected="">/)
  assert.deepEqual(DEFAULT_TABLE_VIEW, { filter: "ALL", query: "", sort: "rank" })
  assert.equal(bodyRows(render()).length, 40, "without a view the table keeps its own state from the same defaults")
})

test("full rows: the ticker/name button has the accessible name 'NVDA NVIDIA' and marks the selection", () => {
  const html = render({ catalog: fixtureCatalog(["NVDA", "AAPL"]), quotes: ready([fixtureQuote("NVDA"), fixtureQuote("AAPL")]), selectedSymbol: "NVDA" })
  const button = /<button type="button" data-row-primary="" data-symbol="NVDA" aria-pressed="true"[^>]*>(.*?)<\/button>/.exec(html)
  assert.ok(button)
  assert.equal(text(button[1]), "NVDA NVIDIA")
  assert.match(button[1], /<img src="\/logos\/stocks\/nvidia\.png" alt="" width="40" height="40" loading="lazy"/)
  assert.match(html, /data-symbol="AAPL" aria-pressed="false"/)
  assert.doesNotMatch(render({ catalog: fixtureCatalog(["NVDA", "AAPL"]), quotes: ready([fixtureQuote("NVDA"), fixtureQuote("AAPL")]), selectedSymbol: undefined }), /data-symbol="[A-Z]+" aria-pressed/, "without a shown selection the rows are plain buttons")
  assert.match(html, /data-logo-fallback="" aria-hidden="true"[^>]*>A<\/span>/, "an unmapped symbol gets the letter fallback, never another logo")
})

test("tables omit the price and selection footer paragraphs", () => {
  const partial = fixtureTop40Catalog(); partial.securities = partial.securities.slice(0, 39)
  for (const html of [
    render(),
    render({ catalog: fixtureCatalog(["NVDA"]), quotes: ready([fixtureQuote("NVDA")]) }),
    render({ catalog: partial, quotes: ready(fixtureTop40Quotes().slice(0, 39)) }),
  ]) assert.doesNotMatch(text(html), /¹ Price|Price는 기초|Volume \(USD\)은|서버 선정 목록|선정 참고|선정 기준일|NVDA 파일럿 목록/)
})

test("home variant: no toolbar, chart column or footer copy; first rows by rank as links", () => {
  const catalog = fixtureTop40Catalog(); catalog.securities = [...catalog.securities].reverse()
  const html = render({ variant: "home", catalog, limit: 10, rowHref: symbol => `/stocks?symbol=${encodeURIComponent(symbol)}`, selectedSymbol: undefined, onSelect: undefined })
  assert.deepEqual(ranks(html), Array.from({ length: 10 }, (_, index) => index + 1))
  assert.deepEqual([...html.matchAll(/<a [^>]*data-row-primary=""[^>]*>/g)].map(match => /href="([^"]+)"/.exec(match[0])?.[1]), fixtureTop40Catalog().securities.slice(0, 10).map(item => `/stocks?symbol=${item.symbol}`))
  assert.doesNotMatch(html, /24h Chart|role="group"|<h2|type="search"|<select|role="status"|aria-pressed|<svg role="img"|차트 미로드/)
  assert.doesNotMatch(html, /<sup|¹ Price|Price는 기초|서버 선정 목록|선정 참고|Market Cap은|24h Chart는|당일/)
})

test("1D Chart draws a continuous 15-minute sparkline; missing data remains empty", () => {
  const without = render()
  assert.doesNotMatch(without, /role="img"/)
  assert.equal([...without.matchAll(/1D chart data unavailable/g)].length, 40)
  const chart = fixtureTop40Chart("NVDA", "1D")
  const html = render({ series: { NVDA: chart } })
  const row = rowOf(html, "NVDA")
  assert.match(row, /<svg role="img" aria-label="24-hour price · Down \d+\.\d\d%" width="148" height="48" viewBox="0 0 148 48" class="text-\[var\(--color-arco-down\)\]">/)
  assert.match(row, /stop-color="currentColor" stop-opacity="0.24"/)
  assert.match(row, /stroke="currentColor" stroke-opacity="1" stroke-width="2" stroke-linecap="round"/)
  assert.doesNotMatch(row, /차트 미로드/)
  assert.equal([...html.matchAll(/role="img"/g)].length, 1)
  const gap = { ...chart, bars: [chart.bars[0], chart.bars[1], chart.bars[10], chart.bars[11]] }
  const sparseRow = rowOf(render({ series: { NVDA: gap } }), "NVDA")
  assert.ok([...sparseRow.matchAll(/stroke-width="2"/g)].length >= 1, "a sparse IEX gap stays drawn")
  assert.doesNotMatch(sparseRow.slice(sparseRow.indexOf('<svg role="img"')), /<circle\b/, "style changes may split paths, never into isolated point markers")
})

// WCAG 2.x relative luminance / contrast, measured on the backgrounds the table and detail actually use.
function channel(value: number) { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
function luminance([r, g, b]: number[]) { return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b) }
function contrast(a: number[], b: number[]) { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
function token(css: string, name: string) { const value = new RegExp(`${name}:\\s*([^;]+);`).exec(css)?.[1].trim(); assert.ok(value, name); return value }
function channelsOf(value: string): number[] { if (value.startsWith("#")) return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)); return /rgba?\(([^)]+)\)/.exec(value)![1].split(",").map(Number) }
function over(value: string, base: number[]) { const [r, g, b, a = 1] = channelsOf(value); return [r, g, b].map((c, i) => Math.round(c * a + base[i] * (1 - a))) }

test("positive change text meets 4.5:1 on the table's row, selected-row and hover backgrounds", () => {
  const css = readFileSync(new URL("../../theme.css", import.meta.url), "utf8")
  const surface = channelsOf(token(css, "--color-arco-surface")), page = channelsOf(token(css, "--color-arco-page"))
  const backgrounds = { surface, page, hover: over(token(css, "--color-row-hover-weak"), surface) }
  const upText = channelsOf(token(css, "--color-arco-up-text"))
  for (const [name, background] of Object.entries(backgrounds)) assert.ok(contrast(upText, background) >= 4.5, `--color-arco-up-text on ${name}: ${contrast(upText, background).toFixed(2)}`)
  assert.ok(contrast(channelsOf(token(css, "--color-arco-up")), surface) < 4.5, "the graphic up colour is why a separate text token exists")
})

test("change text: up uses the AA text token, down/flat/missing keep their meaning; graphics keep --color-arco-up", () => {
  const html = render({ series: { SOXS: { ...fixtureTop40Chart("SOXS", "1D") } } })
  const up = rowOf(html, "SOXS"), down = rowOf(html, "SOXL")
  assert.match(up, /class="inline-flex items-center gap-1 text-\[var\(--color-arco-up-text\)\]"><svg aria-hidden="true" width="12" height="10"[^]*?Up /)
  assert.match(down, /class="inline-flex items-center gap-1 text-\[var\(--color-arco-down\)\]"><svg aria-hidden="true" width="12" height="10"[^]*?Down /)
  assert.doesNotMatch(html, /inline-flex items-center gap-1 text-\[var\(--color-arco-up\)\]/, "no change text on the 3.78:1 token")
  assert.match(rowOf(html, TOP40_FLAT), /<span class="text-\[var\(--color-arco-text-soft\)\]">0%<\/span>/, "zero stays neutral")
  for (const symbol of TOP40_UNAVAILABLE) assert.match(rowOf(html, symbol), /<span class="text-\[var\(--color-arco-text-soft\)\]">—<\/span>/, "missing stays neutral")
  assert.match(rowOf(html, "NVDA"), /Demo trading/)
  assert.match(html, /bg-\[var\(--color-arco-up\)\] opacity-40/, "the status dot is a graphic and keeps --color-arco-up")
  const detail = renderToStaticMarkup(<MarketChart response={{ status: "AVAILABLE", reason: null, fetchedAt: FIXTURE_TIME, cacheAgeMs: 0, feedDelay: "UNKNOWN", data: fixtureChart("NVDA", "1D") }} />)
  assert.match(detail, /Change over returned observations <strong class="text-\[var\(--color-arco-up-text\)\]">\+/, "the detail's rising window change uses the text token")
})


test("Market Cap / AUM uses distinct measures, not ETF market capitalization", () => {
  const base = { currency: "USD" as const, description: null, exchange: null, website: null, industry: null, logoUrl: null, sourceDate: null }
  const html = render({ profiles: {
    SOXL: { ...base, symbol: "SOXL", name: "SOXL", securityType: "ETF", marketCap: "999", aum: "12000000000", aumAsOf: "2026-09-16" },
    MU: { ...base, symbol: "MU", name: "Micron", securityType: "CS", marketCap: "100000000000", aum: "888" },
    QQQ: { ...base, symbol: "QQQ", name: "QQQ", securityType: "ETF", marketCap: "123456" },
  } })
  assert.equal(cells(rowOf(html, "SOXL"))[4], "$12B")
  assert.equal(cells(rowOf(html, "MU"))[4], "$100B")
  assert.equal(cells(rowOf(html, "QQQ"))[4], "—")
  assert.doesNotMatch(html, />24h \(\$\)</)
})
test("USD volume multiplies decimal share counts exactly, preserving zero and missing values", () => {
  assert.equal(volumeDollars("171.63", "43896163"), "7533898455.69")
  assert.equal(volumeDollars("0.1", "9007199254740993.5"), "900719925474099.35")
  assert.equal(volumeDollars("1", "0"), "0")
  assert.equal(volumeDollars(null, "100"), null)
  assert.equal(volumeDollars("100", null), null)
})
