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

test("header texts are the Figma labels in order; Price carries a decorative superscript 1", () => {
  const html = render()
  const headers = [...html.matchAll(/role="columnheader"[^>]*>(.*?)<\/div>/g)].map(match => text(match[1].replace(/<sup[^>]*>.*?<\/sup>/, "")))
  assert.deepEqual(headers, ["#", "Asset Name", "Price", "24H (%)", "Mkt Cap", "Volume (USD)", "Asset Status", "1D Chart"])
  assert.match(html, /title="Stocks: market capitalization · ETFs: assets under management">Mkt Cap/)
  assert.match(html, /Price<sup aria-hidden="true"[^>]*>1<\/sup>/)
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
  assert.deepEqual(cells(row).slice(2, 6), ["$171.63", "하락 0.66%", "—", "$7.53B"])
  assert.match(rowOf(html, "SOXS"), /상승 <\/span>3\.67%/)
  assert.match(row, /<svg aria-hidden="true" width="12" height="10"/)
  for (const symbol of TOP40_UNAVAILABLE) assert.deepEqual(cells(rowOf(html, symbol)).slice(2, 6), ["—", "—", "—", "—"], symbol)
  const flat = cells(rowOf(html, TOP40_FLAT)).slice(3, 5)
  assert.deepEqual(flat, ["0%", "—"])
  assert.doesNotMatch(rowOf(html, TOP40_FLAT), /상승|하락|width="12" height="10"/)
  for (const symbol of TOP40_STALE) assert.match(cells(rowOf(html, symbol))[2], /오래된 데이터$/)
  assert.match(html, /Estimated session turnover:/)
  for (const quote of fixtureTop40Quotes().filter(item => item.sessionVolume)) assert.equal(cells(rowOf(html, quote.symbol))[5], compactDollars(volumeDollars(quote.price, quote.sessionVolume)))
})

test("Asset Status shows the order capability, market-data-only, loading and error states; never session claims", () => {
  const html = render({ capabilities: { phase: "ready", bySymbol: new Map([["NVDA", "CHECK_PAUSE_AT_ORDER"], ["SOXL", "NOT_ACTIVATED"]]) } })
  assert.match(cells(rowOf(html, "NVDA"))[6], /^모의 주문$/)
  assert.match(rowOf(html, "NVDA"), /title="테스트넷 모의 주문 · 주문 시점에 일시중지 여부 확인"/)
  assert.equal(cells(rowOf(html, "SOXL"))[6], "미활성")
  assert.match(rowOf(html, "SOXL"), /class="[^"]*text-\[var\(--color-arco-chip-ink\)\][^"]*">.*미활성/, "not-activated reads quieter, like Figma's closed state")
  assert.doesNotMatch(rowOf(html, "NVDA"), /text-\[var\(--color-arco-ink\)\][^"]*text-\[var\(--color-arco-chip-ink\)\]/, "one text colour per badge")
  assert.equal(cells(rowOf(html, "MU"))[6], "시장정보만")
  assert.ok(bodyRows(render({ capabilities: { phase: "loading" } })).every(row => cells(row)[6] === "확인 중"))
  assert.ok(bodyRows(render({ capabilities: { phase: "error" } })).every(row => cells(row)[6] === "상태 확인 불가"))
  for (const html of [render(), render({ variant: "home", rowHref: symbol => `/stocks?symbol=${symbol}` })]) assert.doesNotMatch(text(html), /Asset Open|Market Closed|24\/7|Off-Hours|452|Most Popular/)
})

test("full toolbar: title with count pill, asset-type chips, labelled search, sort options disabled without values, live count", () => {
  const html = render()
  assert.match(html, /<h2[^>]*>Stocks &amp; ETFs<\/h2><span[^>]*>40<span class="sr-only">개 종목<\/span><\/span>/)
  assert.match(html, /role="group" aria-label="Asset type"/)
  assert.deepEqual([...html.matchAll(/aria-pressed="(true|false)"[^>]*>(All assets|Stocks|ETF)</g)].map(match => [match[2], match[1]]), [["All assets", "true"], ["Stocks", "false"], ["ETF", "false"]])
  assert.match(html, /<label for="([^"]+)" class="sr-only">Search asset name or ticker<\/label>.*<input id="\1" type="search"[^>]*placeholder="Search asset name or ticker"/)
  assert.match(html, /<label for="([^"]+)" class="sr-only">Sort<\/label><select id="\1"/)
  assert.deepEqual([...html.matchAll(/<option value="[a-zA-Z]+"[^>]*>([^<]+)<\/option>/g)].map(match => match[1]), ["Rank", "Top Gainer", "Top Loser", "Price: High to Low", "Price: Low to High"])
  assert.match(html, /role="status" class="sr-only">40개 표시 · 전체 40개</)
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
  assert.match(etf, /role="status" class="sr-only">14개 표시 · 전체 40개</)
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

test("footnote and provenance: price meaning, PILOT copy kept, curated reference only for the exact 40", () => {
  const top40 = text(render())
  assert.match(top40, /¹ Price는 기초 미국 주식·ETF의 USD 시세\(Massive, 시세 지연 정보 미확인\)이며 ARCO 토큰 가격이나 모의 체결가가 아닙니다\./)
  assert.match(top40, /Volume \(USD\)은 세션 거래량 × 표시 가격으로 계산한 추정 거래대금입니다\./)
  assert.match(top40, /서버 선정 목록 · 40종목 · CURATED · 기준 .+ · 기간 2026-08-16~2026-09-15 · 선정 기준일 2026-09-16/)
  assert.match(top40, /선정 참고: 한국예탁결제원 SEIBro 해외주식 종목별내역\(주식TOP50\) · 매수결제금액 상위 40 · 2026-08-16~2026-09-15 · 2026-09-16 조회 · 이전에 조회한 자료를/)
  assert.doesNotMatch(top40, /최근 24시간/, "the rolling chart copy stays in the detail view")
  const pilot = text(render({ catalog: fixtureCatalog(["NVDA"]), quotes: ready([fixtureQuote("NVDA")]) }))
  assert.match(pilot, /NVDA 파일럿 목록 · 40종목 선정 완료를 의미하지 않습니다\. 선정 기준일 미확인/)
  assert.doesNotMatch(pilot, /선정 참고/)
  const partial = fixtureTop40Catalog(); partial.securities = partial.securities.slice(0, 39)
  assert.doesNotMatch(text(render({ catalog: partial, quotes: ready(fixtureTop40Quotes().slice(0, 39)) })), /선정 참고/)
})

test("home variant: no toolbar or chart column, first rows by rank as links, a short footnote", () => {
  const catalog = fixtureTop40Catalog(); catalog.securities = [...catalog.securities].reverse()
  const html = render({ variant: "home", catalog, limit: 10, rowHref: symbol => `/stocks?symbol=${encodeURIComponent(symbol)}`, selectedSymbol: undefined, onSelect: undefined })
  assert.deepEqual(ranks(html), Array.from({ length: 10 }, (_, index) => index + 1))
  assert.deepEqual([...html.matchAll(/<a [^>]*data-row-primary=""[^>]*>/g)].map(match => /href="([^"]+)"/.exec(match[0])?.[1]), fixtureTop40Catalog().securities.slice(0, 10).map(item => `/stocks?symbol=${item.symbol}`))
  assert.doesNotMatch(html, /24h Chart|role="group"|<h2|type="search"|<select|role="status"|aria-pressed|<svg role="img"|차트 미로드/)
  assert.match(text(html), /^.*¹ Price는 기초 미국 주식·ETF의 USD 시세\(Massive, 시세 지연 정보 미확인\)이며 ARCO 토큰 가격이나 모의 체결가가 아닙니다\./s)
  assert.match(text(html), /Market Cap은 주식 시가총액, AUM은 ETF 운용자산입니다\./)
  assert.doesNotMatch(text(html), /24h Chart는|당일/)
})

test("24h Chart draws supplied per-symbol series; missing data remains empty", () => {
  const without = render()
  assert.doesNotMatch(without, /role="img"/)
  assert.equal([...without.matchAll(/1D 차트 데이터 없음/g)].length, 40)
  const chart = fixtureTop40Chart("NVDA", "1D")
  const html = render({ series: { NVDA: chart } })
  const row = rowOf(html, "NVDA")
  assert.match(row, /<svg role="img" aria-label="최근 관측 거래일 종가 추이 · 하락 \d+\.\d\d%" width="148" height="48" viewBox="0 0 148 48" class="text-\[var\(--color-arco-down\)\]">/)
  assert.match(row, /stop-color="currentColor" stop-opacity="0.24"/)
  assert.match(row, /stroke="currentColor" stroke-width="2" stroke-linecap="round"/)
  assert.doesNotMatch(row, /차트 미로드/)
  assert.equal([...html.matchAll(/role="img"/g)].length, 1)
  const gap = { ...chart, bars: [chart.bars[0], chart.bars[1], chart.bars[10], chart.bars[11]] }
  assert.equal([...rowOf(render({ series: { NVDA: gap } }), "NVDA").matchAll(/stroke-width="2"/g)].length, 2, "a gap splits the line")
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
  assert.match(up, /class="inline-flex items-center gap-1 text-\[var\(--color-arco-up-text\)\]"><svg aria-hidden="true" width="12" height="10"[^]*?상승 /)
  assert.match(down, /class="inline-flex items-center gap-1 text-\[var\(--color-arco-down\)\]"><svg aria-hidden="true" width="12" height="10"[^]*?하락 /)
  assert.doesNotMatch(html, /inline-flex items-center gap-1 text-\[var\(--color-arco-up\)\]/, "no change text on the 3.78:1 token")
  assert.match(rowOf(html, TOP40_FLAT), /<span class="text-\[var\(--color-arco-text-soft\)\]">0%<\/span>/, "zero stays neutral")
  for (const symbol of TOP40_UNAVAILABLE) assert.match(rowOf(html, symbol), /<span class="text-\[var\(--color-arco-text-soft\)\]">—<\/span>/, "missing stays neutral")
  assert.match(rowOf(html, "NVDA"), /모의 주문/)
  assert.match(html, /bg-\[var\(--color-arco-up\)\] opacity-40/, "the status dot is a graphic and keeps --color-arco-up")
  const detail = renderToStaticMarkup(<MarketChart response={{ status: "AVAILABLE", reason: null, fetchedAt: FIXTURE_TIME, cacheAgeMs: 0, feedDelay: "UNKNOWN", data: fixtureChart("NVDA", "1D") }} />)
  assert.match(detail, /반환 관측 구간 등락 <strong class="text-\[var\(--color-arco-up-text\)\]">\+/, "the detail's rising window change uses the text token")
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
