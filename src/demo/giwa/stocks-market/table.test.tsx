import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { StaticRouter } from "react-router-dom"
import type { Catalog, Envelope, Quote } from "./contracts"
import { changeParts, exact } from "./display"
import { FIXTURE_TIME, fixtureCatalog, fixtureQuote, fixtureTop40Catalog, fixtureTop40Chart, fixtureTop40Quote, fixtureTop40Quotes, TOP40_FLAT, TOP40_STALE, TOP40_UNAVAILABLE } from "./fixtures"
import { StocksMarketTable, type Capabilities, type StocksMarketTableProps } from "./StocksMarketTable"
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
  assert.deepEqual(headers, ["#", "Asset Name", "Price", "24h ($)", "24H (%)", "24H Volume", "Asset Status", "24h Chart"])
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

test("row values: rounded price with exact title, unsigned change with direction cue, share volume, dashes for missing data", () => {
  const html = render()
  const soxl = fixtureTop40Quote("SOXL")
  const row = rowOf(html, "SOXL")
  assert.match(row, new RegExp(`title="\\$${soxl.price!.replace(".", "\\.")}"`))
  assert.deepEqual(cells(row).slice(2, 6), ["$171.63", "하락 $1.14", "하락 0.66%", `${exact(soxl.sessionVolume)} 주`])
  assert.match(rowOf(html, "SOXS"), /상승 <\/span>\$29\.84/)
  assert.match(row, /<svg aria-hidden="true" width="12" height="10"/)
  for (const symbol of TOP40_UNAVAILABLE) assert.deepEqual(cells(rowOf(html, symbol)).slice(2, 6), ["—", "—", "—", "—"], symbol)
  const flat = cells(rowOf(html, TOP40_FLAT)).slice(3, 5)
  assert.deepEqual(flat, ["$0", "0%"])
  assert.doesNotMatch(rowOf(html, TOP40_FLAT), /상승|하락|width="12" height="10"/)
  for (const symbol of TOP40_STALE) assert.match(cells(rowOf(html, symbol))[2], /오래된 데이터$/)
  assert.doesNotMatch(text(html), /\$[0-9][0-9,.]* 주/, "volume is a share count, never dollars")
  for (const quote of fixtureTop40Quotes().filter(item => item.sessionVolume)) assert.match(text(rowOf(html, quote.symbol)), new RegExp(`${exact(quote.sessionVolume).replace(/[.,]/g, "\\$&")} 주`))
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

test("full rows: the ticker/name button has the accessible name 'NVDA NVIDIA' and marks the selection", () => {
  const html = render({ catalog: fixtureCatalog(["NVDA", "AAPL"]), quotes: ready([fixtureQuote("NVDA"), fixtureQuote("AAPL")]), selectedSymbol: "NVDA" })
  const button = /<button type="button" data-row-primary="" data-symbol="NVDA" aria-pressed="true"[^>]*>(.*?)<\/button>/.exec(html)
  assert.ok(button)
  assert.equal(text(button[1]), "NVDA NVIDIA")
  assert.match(button[1], /<img src="\/logos\/stocks\/nvidia\.png" alt="" width="40" height="40" loading="lazy"/)
  assert.match(html, /data-symbol="AAPL" aria-pressed="false"/)
  assert.match(html, /data-logo-fallback="" aria-hidden="true"[^>]*>A<\/span>/, "an unmapped symbol gets the letter fallback, never another logo")
})

test("footnote and provenance: price meaning, PILOT copy kept, curated reference only for the exact 40", () => {
  const top40 = text(render())
  assert.match(top40, /¹ Price는 기초 미국 주식·ETF의 USD 시세\(Massive, 시세 지연 정보 미확인\)이며 ARCO 토큰 가격이나 모의 체결가가 아닙니다\./)
  assert.match(top40, /24h \(\$\)·24H \(%\)는 공급자가 제공한 전일 종가 대비 변동입니다\. 24H Volume은 기초 종목의 시장 세션 거래량\(주식 수\)입니다\. 24h Chart는 상세 화면에서 이미 불러온 1D\(rolling 24시간\) 종가만 표시합니다\./)
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
  assert.match(text(html), /24h \(\$\)·24H \(%\)는 공급자가 제공한 전일 종가 대비 변동입니다\. 24H Volume은 기초 종목의 시장 세션 거래량\(주식 수\)입니다\./, "home columns carry the same meaning")
  assert.doesNotMatch(text(html), /24h Chart는|당일/)
})

test("24h Chart draws only a series the detail already loaded; other rows say it is not loaded", () => {
  const without = render()
  assert.doesNotMatch(without, /role="img"/)
  assert.equal([...without.matchAll(/24시간 차트 미로드 · 상세에서 확인/g)].length, 40)
  const chart = fixtureTop40Chart("NVDA", "1D")
  const html = render({ series: { NVDA: chart } })
  const row = rowOf(html, "NVDA")
  assert.match(row, /<svg role="img" aria-label="최근 24시간 종가 추이 · 하락 \d+\.\d\d%" width="148" height="48" viewBox="0 0 148 48" class="text-\[var\(--color-arco-down\)\]">/)
  assert.match(row, /stop-color="currentColor" stop-opacity="0.24"/)
  assert.match(row, /stroke="currentColor" stroke-width="2" stroke-linecap="round"/)
  assert.doesNotMatch(row, /차트 미로드/)
  assert.equal([...html.matchAll(/role="img"/g)].length, 1)
  const gap = { ...chart, bars: [chart.bars[0], chart.bars[1], chart.bars[10], chart.bars[11]] }
  assert.equal([...rowOf(render({ series: { NVDA: gap } }), "NVDA").matchAll(/stroke-width="2"/g)].length, 2, "a gap splits the line")
})
