// The /stocks security detail's presentational pieces, rendered statically with the synthetic fixtures (no Figma values).
import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Chart, Envelope, Profile, Quote, Security } from "./contracts"
import { axisPrice, axisTicks, axisTime, barRange, chartPoints, compactDollars, dollars } from "./display"
import { MarketChart } from "./MarketChart"
import { AboutCard, DetailHeader, PeriodTabs, SecurityDetailView, StatisticsCard, UnavailableDetail } from "./MarketDetail"
import { FIXTURE_TIME, fixtureTop40Chart, fixtureTop40Quote } from "./fixtures"
import { MarketStatus, type Capabilities } from "./StocksMarketTable"
import type { ReadState } from "./useOwnedRead"

const envelope = <T,>(data: T | null, status: Envelope<T>["status"] = "AVAILABLE"): Envelope<T> => ({ status, reason: null, fetchedAt: FIXTURE_TIME, cacheAgeMs: 0, feedDelay: "DELAYED_15_MIN", data })
const ready = <T,>(value: T): ReadState<T> => ({ phase: "ready", value })
const NVDA: Security = { symbol: "NVDA", name: "NVIDIA Corporation", isin: "US67066G1040", rank: 10 }
const ORDERS: Capabilities = { phase: "ready", bySymbol: new Map([["NVDA", "CHECK_PAUSE_AT_ORDER"]]) }
const LONG = "Offline fixture company text for the clamp. ".repeat(8).trim()
// Invented test values only.
const PROFILE: Profile = { symbol: "NVDA", name: "NVIDIA Corporation", currency: "USD", description: LONG, exchange: "XNAS", securityType: "CS", marketCap: "4210987654321", website: "https://fixture.invalid/about", industry: "Fixture semiconductors", logoUrl: null, sourceDate: "2026-09-15" }
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'")
const count = (html: string, needle: string) => text(html).split(needle).length - 1
const esc = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function detail(overrides: Partial<Parameters<typeof SecurityDetailView>[0]> = {}) {
  const quote = fixtureTop40Quote("NVDA")
  const chart = fixtureTop40Chart("NVDA", "1D")
  return renderToStaticMarkup(<SecurityDetailView security={NVDA} profile={ready(envelope(PROFILE))} quote={quote} quotes={ready(envelope([quote]))} capabilities={ORDERS} day={chart} range="1D" onRange={() => {}} selection={null}
    chart={<MarketChart response={envelope(chart)} />} {...overrides} />)
}

test("header: the h1 names the security with the ticker muted after it, and the table's order-capability badge; no session pill", () => {
  const html = renderToStaticMarkup(<DetailHeader symbol="NVDA" name="NVIDIA Corporation" logoUrl={null} capabilities={ORDERS} headingId="h" />)
  assert.match(html, /<h1 id="h" tabindex="-1"[^>]*>NVIDIA Corporation <span class="text-\[var\(--color-arco-chip-ink\)\]">NVDA<\/span><\/h1>/)
  assert.match(html, /<img src="\/logos\/stocks\/nvidia\.png" alt="" width="40" height="40"/)
  assert.match(text(html), /모의 주문$/)
  for (const [capabilities, label] of [[{ phase: "loading" }, "확인 중"], [{ phase: "error" }, "상태 확인 불가"], [{ phase: "ready", bySymbol: new Map([["NVDA", "NOT_ACTIVATED"]]) }, "미활성"], [{ phase: "ready", bySymbol: new Map() }, "시장정보만"]] as const) {
    assert.match(text(renderToStaticMarkup(<DetailHeader symbol="NVDA" name="NVIDIA Corporation" logoUrl={null} capabilities={capabilities as Capabilities} headingId="h" />)), new RegExp(`${label}$`))
  }
  assert.match(renderToStaticMarkup(<DetailHeader symbol="ZZZZ" name="ZZZZ" logoUrl={null} capabilities={ORDERS} headingId="h" />), /<h1[^>]*>ZZZZ<\/h1>/, "no repeated ticker when there is no name")
})

test("price card: one caption, rounded price with the exact title, unsigned change with triangle and sr direction, feed and time", () => {
  const html = detail()
  const quote = fixtureTop40Quote("NVDA")
  assert.equal(count(html, "기초 주식 시세 · USD"), 1)
  assert.match(html, new RegExp(`<p title="${esc(dollars(quote.price))}"[^>]*text-\\[40px\\][^>]*>\\$[0-9,]+(\\.\\d{1,2})?</p>`))
  assert.match(html, /text-\[var\(--color-arco-down\)\]"><svg aria-hidden="true" width="12" height="10"[^>]*>.*?<\/svg><span class="sr-only">하락 <\/span>\$\d+\.\d+ \(\d+\.\d+%\)<\/span><span[^>]*>전일 종가 대비<\/span>/)
  assert.match(text(html), /Sep 16, 2026, 08:00:00 AM EDT · 15분 지연/)
  const up = renderToStaticMarkup(<SecurityDetailView security={NVDA} profile={ready(envelope(PROFILE))} quote={{ ...quote, change: "5.01", changePercent: "2.81" }} quotes={ready(envelope([quote]))} capabilities={ORDERS} day={null} range="1D" onRange={() => {}} selection={null} chart={null} />)
  assert.match(up, /text-\[var\(--color-arco-up-text\)\]"><svg[^]*?상승 <\/span>\$5\.01 \(2\.81%\)/, "rising change text uses the AA text token")
  const flat = renderToStaticMarkup(<SecurityDetailView security={NVDA} profile={ready(envelope(PROFILE))} quote={{ ...quote, change: "0.001", changePercent: "0" }} quotes={ready(envelope([quote]))} capabilities={ORDERS} day={null} range="1D" onRange={() => {}} selection={null} chart={null} />)
  assert.match(flat, /<span class="text-\[var\(--color-arco-text-soft\)\]">\$0 \(0%\)<\/span>/, "flat stays neutral")
  const missing = renderToStaticMarkup(<SecurityDetailView security={NVDA} profile={{ phase: "loading" }} quote={null} quotes={{ phase: "loading" }} capabilities={ORDERS} day={null} range="1D" onRange={() => {}} selection={null} chart={null} />)
  assert.equal(count(missing, "기초 주식 시세 · USD"), 1)
  assert.match(text(missing), /기초 주식 시세 · USD—— ?전일 종가 대비/)
  assert.match(text(missing), /시장정보 불러오는 중…/)
})

test("a picked bar replaces the quote in the header (same caption slot) and hides the previous-close change", () => {
  const chart = fixtureTop40Chart("NVDA", "1D")
  const bar = chart.bars[3]
  const html = detail({ selection: { bar, interval: "5m", feedDelay: "UNKNOWN" } })
  assert.equal(count(html, "기초 주식 시세 · USD"), 0)
  assert.equal(count(html, "5m 구간 종가 · 시각은 봉 시작"), 1)
  assert.match(html, new RegExp(`title="${esc(dollars(bar.close))}"`))
  assert.match(html, /<p class="flex flex-wrap items-center gap-x-1\.5 text-sm invisible">/)
  assert.match(text(html), /시세 지연 정보 미확인/, "the picked bar's own feed label")
})

test("price card: this symbol's own non-AVAILABLE quote status whatever the chart shows; the envelope's only when there is no row", () => {
  const sgov = fixtureTop40Quote("SGOV")
  assert.equal(sgov.status, "STALE", "fixture: SGOV's quote is stale")
  const SGOV: Security = { symbol: "SGOV", name: "iShares 0-3 Month Treasury Bond ETF" }
  const view = (quote: Quote | null, quotes: ReadState<Envelope<Quote[]>>, chart: JSX.Element | null) => text(renderToStaticMarkup(<SecurityDetailView security={SGOV} profile={{ phase: "loading" }} quote={quote} quotes={quotes} capabilities={ORDERS} day={null} range="1D" onRange={() => {}} selection={null} chart={chart} />))
  const stale = "마지막 확인 시세 · 오래된 데이터"
  // The chart read failed, or is loading (every period switch): the stale headline price still says it is stale.
  for (const chart of [<MarketStatus key="error" status="error" />, <MarketStatus key="loading" status="loading" />]) {
    const page = view(sgov, ready(envelope([sgov], "STALE")), chart)
    assert.match(page, /기초 주식 시세 · USD\$422\.82하락/, "the stale price is the headline")
    assert.equal(page.split(stale).length - 1, 1, `one stale marker with a ${chart.props.status} chart`)
  }
  // Once an AVAILABLE chart loads, the marker is still there, once (the chart no longer repeats the quote's status).
  assert.equal(view(sgov, ready(envelope([sgov], "STALE")), <MarketChart response={envelope(fixtureTop40Chart("SGOV", "1D"))} />).split(stale).length - 1, 1)
  // Quote and chart both stale: two different statements, each scoped to its data, never the same line twice.
  const both = view(sgov, ready(envelope([sgov], "STALE")), <MarketChart response={envelope(fixtureTop40Chart("SGOV", "1D"), "STALE")} />)
  assert.equal(both.split(`차트 · ${stale}`).length - 1, 1, "the chart's own status")
  assert.equal(both.split(stale).length - 1, 2, "plus the quote's, once")
  // One stale symbol marks the whole envelope STALE: a symbol whose own row is AVAILABLE gets no marker.
  const nvda = fixtureTop40Quote("NVDA")
  assert.doesNotMatch(view(nvda, ready(envelope([nvda, sgov], "STALE")), null), /오래된 데이터/)
  for (const [status, copy] of [["UNAVAILABLE", "시세를 불러올 수 없습니다"], ["UNCONFIGURED", "시세 연결 준비 중"]] as const) {
    assert.match(view(null, ready(envelope<Quote[]>(null, status)), null), new RegExp(`—— ?전일 종가 대비.*${copy}`), `no quote row: the envelope's ${status} explains the dashes`)
    const row: Quote = { ...sgov, status, price: null, change: null, changePercent: null }
    assert.match(view(row, ready(envelope([row], status)), null), new RegExp(copy), `the row's own ${status}`)
  }
  const none = view(null, ready(envelope<Quote[]>([], "AVAILABLE")), null)
  assert.doesNotMatch(none, /시세를 불러올 수 없습니다|시세 연결 준비 중|오래된 데이터|시장정보 불러오는 중/, "an AVAILABLE envelope adds no status line")
})

test("period buttons: exactly 1D 1W 1M 3M 1Y as <button>s in the 차트 기간 group, pressed state on the active one, no ALL", () => {
  const html = renderToStaticMarkup(<PeriodTabs range="1W" onRange={() => {}} />)
  assert.match(html, /^<div role="group" aria-label="차트 기간" class="[^"]*bg-\[var\(--color-arco-chip\)\][^"]*">/)
  assert.deepEqual([...html.matchAll(/<button type="button" aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g)].map(match => [match[2], match[1]]), [["1D", "false"], ["1W", "true"], ["1M", "false"], ["3M", "false"], ["1Y", "false"]])
  assert.match(html, /aria-pressed="true" class="[^"]*bg-\[var\(--color-arco-surface\)\] text-\[var\(--color-arco-ink\)\]/)
  // A non-colour cue for the selected period (the white pill on the chip track and ink vs chip-ink are both below 3:1).
  const ringed = [...html.matchAll(/<button type="button" aria-pressed="(true|false)" class="([^"]*)"/g)].map(match => [match[1], /(^| )ring-1 ring-inset ring-\[var\(--color-arco-ink\)\]( |$)/.test(match[2])])
  assert.deepEqual(ringed, [["false", false], ["true", true], ["false", false], ["false", false], ["false", false]], "only the pressed period carries the inset ink ring")
  assert.doesNotMatch(html, /ALL/)
  // The buttons sit outside the chart subtree (which is keyed by range) and appear once.
  const page = detail()
  assert.equal([...page.matchAll(/aria-label="차트 기간"/g)].length, 1)
  assert.ok(page.indexOf('aria-label="차트 기간"') < page.indexOf('aria-label="Underlying security chart"'))
})

test("About: two-line clamp with a Show More control for long text, provider-less fallback, facts without values are left out", () => {
  const html = renderToStaticMarkup(<AboutCard security={NVDA} profile={ready(envelope(PROFILE))} />)
  assert.match(html, /<h2 id="[^"]+"[^>]*>About<\/h2>/)
  assert.match(html, /<p id="([^"]+)" class="[^"]*line-clamp-2">Offline fixture company text/)
  const control = /<button type="button" aria-expanded="false" aria-controls="([^"]+)"[^>]*>Show More<\/button>/.exec(html)
  assert.ok(control, "long text gets the expand control")
  assert.match(html, new RegExp(`<p id="${control[1]}"`))
  const labels = [...html.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map(match => match[1])
  assert.deepEqual(labels, ["Underlying Asset Name", "Underlying Asset Ticker", "Category", "Exchange", "Industry", "Website", "ISIN"])
  assert.equal([...html.matchAll(/<dl /g)].length, 2, "two columns on md+")
  assert.match(html, /<a href="https:\/\/fixture\.invalid\/about" target="_blank" rel="noopener noreferrer"[^>]*>fixture\.invalid<span class="sr-only"> \(새 창\)<\/span><\/a>/)
  assert.match(text(html), /주식CS/, "curated kind and the provider security type as category pills")
  assert.match(text(html), /US67066G1040/)
  const etf = renderToStaticMarkup(<AboutCard security={{ symbol: "SOXL", name: "Direxion Daily Semiconductor Bull 3X Shares" }} profile={ready(envelope({ ...PROFILE, symbol: "SOXL", securityType: "ETF" }))} />)
  assert.deepEqual([...etf.matchAll(/<span class="inline-flex h-5[^"]*">([^<]+)<\/span>/g)].map(match => match[1]), ["ETF", "레버리지·인버스"], "a provider type equal to the curated kind is shown once")
  const short = renderToStaticMarkup(<AboutCard security={NVDA} profile={ready(envelope({ ...PROFILE, description: "Short fixture text." }))} />)
  assert.doesNotMatch(short, /Show More/, "short text has nothing to expand")
  const bare = renderToStaticMarkup(<AboutCard security={{ symbol: "ZZZZ", name: "Fixture Co" }} profile={ready(envelope({ ...PROFILE, symbol: "ZZZZ", name: "Fixture Co", description: null, exchange: null, securityType: null, website: null, industry: null }))} />)
  assert.match(text(bare), /공급자 설명 없음/)
  assert.deepEqual([...bare.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map(match => match[1]), ["Underlying Asset Name", "Underlying Asset Ticker"], "rows without a value are hidden, never dashed")
  assert.doesNotMatch(text(bare), /—/)
  const status = /<section aria-label="기업정보 상태"[^>]*>(.*?)<\/section>/.exec(html)![1]
  assert.match(text(status), /^기업정보 · 공급자 참조 데이터기업정보 최근 수집: Sep 16, 2026, 08:00:00 AM EDT · 공급자 기준일: 2026-09-15\. 시세 관측 시각과 별개입니다\.$/)
  assert.match(text(renderToStaticMarkup(<AboutCard security={NVDA} profile={{ phase: "error" }} />)), /기업정보를 불러올 수 없습니다/)
  // "No provider description" states a fact about a loaded profile; a read that did not load one never claims it.
  for (const [profile, status] of [[ready(envelope<Profile>(null, "UNAVAILABLE")), "기업정보를 불러올 수 없습니다"], [ready(envelope<Profile>(null, "UNCONFIGURED")), "기업정보 연결 준비 중"], [{ phase: "error" }, "기업정보를 불러올 수 없습니다"], [{ phase: "loading" }, "기업정보 불러오는 중…"]] as const) {
    const about = text(renderToStaticMarkup(<AboutCard security={NVDA} profile={profile as ReadState<Envelope<Profile>>} />))
    assert.doesNotMatch(about, /공급자 설명 없음/, status)
    assert.match(about, new RegExp(status))
  }
})

test("Statistics: 24H open/high/low from the loaded 1D bars only; quote and profile values; source line; '—' otherwise", () => {
  const chart = fixtureTop40Chart("NVDA", "1D")
  const quote = fixtureTop40Quote("NVDA")
  const expected = barRange(chart)!
  const html = renderToStaticMarkup(<StatisticsCard symbol="NVDA" quote={quote} quotes={ready(envelope([quote]))} profile={ready(envelope(PROFILE))} day={chart} />)
  const rows = [...html.matchAll(/<dt[^>]*>([^<]+)<\/dt><dd(?: title="([^"]*)")?[^>]*>([^<]*)<\/dd>/g)].map(match => [match[1], match[3], match[2] ?? null])
  const label = (value: string) => `$${value.replace(/\.?0+$/, "")}`
  assert.deepEqual(rows.slice(0, 3).map(([name, , title]) => [name, title]), [["Open", dollars(expected.open)], ["High", dollars(expected.high)], ["Low", dollars(expected.low)]])
  for (const [, value] of rows.slice(0, 3)) assert.match(value, /^\$[0-9,]+(\.\d{1,2})?$/)
  assert.equal(rows[0][1], label(expected.open).replace(/\B(?=(\d{3})+(?!\d))/g, ","))
  assert.deepEqual(rows.slice(3).map(([name, value, title]) => [name, value, title]), [["Total Market Cap", "$4.21T", "Market cap: $4,210,987,654,321"], ["세션 거래량", `${Number(quote.sessionVolume).toLocaleString("en-US")} 주`, null], ["전일 종가", `$${Number(quote.previousClose).toLocaleString("en-US", { maximumFractionDigits: 2 })}`, dollars(quote.previousClose)]])
  assert.match(html, /<h3[^>]*>Underlying Asset Price<span class="text-sm text-\[var\(--color-arco-chip-ink\)\]">24H<\/span><\/h3>/)
  assert.match(text(html), /최근 24시간\(rolling\) · 반환된 1D 5m 봉의 첫 시가·최고가·최저가/)
  assert.match(text(html), /Massive · 15분 지연 · 시세 관측: Sep 16, 2026, 08:00:00 AM EDT\. 주식 시세·기업 시가총액은 ARCO 토큰 가격·유동성·보유량이 아닙니다\./)
  assert.match(text(html), /NVDA 모의 주문은 주문 패널에서 진행합니다\. 표시 시세는 체결에 사용하지 않습니다\./)
  const empty = renderToStaticMarkup(<StatisticsCard symbol="MU" quote={null} quotes={{ phase: "loading" }} profile={{ phase: "loading" }} day={null} />)
  assert.deepEqual([...empty.matchAll(/<dd[^>]*>([^<]*)<\/dd>/g)].map(match => match[1]), ["—", "—", "—", "—", "—", "—"])
  // True for every missing-series case (loading, STALE, UNAVAILABLE, one bar, failed): it never promises the values will come.
  assert.match(text(empty), /현재 1D 차트 관측값\(봉 2개 이상\)이 있을 때만 표시합니다\./)
  assert.doesNotMatch(text(empty), /불러오면/)
  assert.doesNotMatch(text(empty), /NVDA 모의 주문/, "the order-panel pointer is NVDA's only")
})

test("display helpers: compact market cap with integer rounding, bar range by exact comparison, axis labels", () => {
  assert.equal(compactDollars(null), "—")
  assert.equal(compactDollars("4210987654321"), "$4.21T")
  assert.equal(compactDollars("999995000000"), "$1T", "999.995B rounds into the next unit")
  assert.equal(compactDollars("999994999999.99"), "$999.99B")
  assert.equal(compactDollars("995000000000"), "$995B")
  assert.equal(compactDollars("999999.996"), "$1M")
  assert.equal(compactDollars("1500000000.5"), "$1.5B")
  assert.equal(compactDollars("2000000"), "$2M")
  assert.equal(compactDollars("994999"), "$994,999")
  assert.equal(compactDollars("123456789012345678901234.56"), "$123,456,789,012.35T")
  const chart: Chart = { ...fixtureTop40Chart("MU", "1D"), bars: [{ timestamp: "2026-09-16T10:00:00.000Z", open: "10.5", high: "11.000000000000000001", low: "10", close: "10.7", volume: "1" }, { timestamp: "2026-09-16T10:05:00.000Z", open: "10.7", high: "11", low: "9.999999999999999999", close: "10.8", volume: "1" }] }
  assert.deepEqual(barRange(chart), { open: "10.5", high: "11.000000000000000001", low: "9.999999999999999999" })
  assert.equal(barRange({ ...chart, bars: [] }), null)
  const at = Date.parse("2026-09-16T04:05:00.000Z")
  assert.equal(axisTime(at, "1D"), "09/16 00:05")
  assert.equal(axisTime(at, "1W"), "09/16 00:05")
  assert.equal(axisTime(at, "1M"), "09/16")
  assert.equal(axisPrice(219.5), "$219.5")
  assert.equal(axisPrice(1234.004999), "$1,234")
  assert.equal(axisPrice(Number.NaN), "")
})

test("without a ready market catalog only NVDA and the curated 40 are known: an unknown symbol gets no badge and a neutral line", () => {
  const selection = { symbol: "ZZZZ", focus: { tick: 0, target: null, symbol: null }, openDetail() {}, closeDetail() {}, claimFocus: () => false }
  const render = (symbol: string, capabilities: Capabilities) => renderToStaticMarkup(<UnavailableDetail symbol={symbol} status={<MarketStatus status="error" />} capabilities={capabilities} selection={{ ...selection, symbol }} anchor={{ current: null }} settled />)
  const noOrders: Capabilities = { phase: "ready", bySymbol: new Map() }
  for (const capabilities of [noOrders, { phase: "error" }, { phase: "loading" }] as Capabilities[]) {
    const unknown = render("ZZZZ", capabilities)
    assert.match(unknown, /<h1[^>]*>ZZZZ<\/h1>/)
    assert.doesNotMatch(text(unknown), /시장정보만|상태 확인 불가|확인 중|모의 주문|미활성/, `no order-capability badge (${capabilities.phase})`)
    assert.match(text(unknown), /시세를 불러올 수 없습니다ZZZZ은 아직 시장정보 목록에서 확인되지 않은 종목입니다\.$/)
  }
  const curated = text(render("MU", noOrders))
  assert.match(curated, /시장정보만/, "a curated symbol keeps its badge")
  assert.doesNotMatch(curated, /확인되지 않은/)
  assert.match(text(render("NVDA", ORDERS)), /모의 주문/)
  assert.doesNotMatch(text(render("NVDA", ORDERS)), /확인되지 않은/)
})

test("Y-axis ticks: whole-cent 1-2-5 steps spanning the closes, so every two-decimal label is exactly its gridline and labels never repeat", () => {
  const exactLabel = (tick: number) => `$${Number(tick.toFixed(2)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
  // Low-volatility (SGOV-like) series where a library "nice" step falls between cents, plus wide and flat ones.
  const cases: [number[], number[]][] = [
    [[100.01, 100.03, 100.02, 100.04], [100.01, 100.02, 100.03, 100.04]],
    [[100.49, 100.52], [100.49, 100.5, 100.51, 100.52]],
    [[100.5, 100.51, 100.5], [100.5, 100.51]],
    [[22.31, 22.36], [22.3, 22.32, 22.34, 22.36]],
    [[231.4, 242.9], [230, 235, 240, 245]],
    [[5, 5], [4.99, 5, 5.01]],
  ]
  for (const [closes, expected] of cases) {
    const ticks = axisTicks(closes)
    assert.deepEqual(ticks, expected, JSON.stringify(closes))
    const labels = ticks.map(axisPrice)
    assert.equal(new Set(labels).size, labels.length, `distinct labels for ${JSON.stringify(closes)}: ${labels.join(" ")}`)
    ticks.forEach((tick, index) => {
      assert.ok(Number.isInteger(Math.round(tick * 100)) && Math.abs(tick * 100 - Math.round(tick * 100)) < 1e-9, `${tick} is a whole cent`)
      assert.equal(labels[index], exactLabel(tick), "the label is the gridline's own value")
    })
    assert.ok(ticks[0] <= Math.min(...closes) && ticks[ticks.length - 1] >= Math.max(...closes), "the ticks span every close (they are the domain)")
  }
  assert.deepEqual(axisTicks([]), [])
  assert.deepEqual(axisTicks([Number.NaN]), [])
  // The plotted coordinates of a real series (the chart feeds exactly these).
  const series = fixtureTop40Chart("SGOV", "1D")
  const ticks = axisTicks(chartPoints(series).map(point => point.coordinate))
  assert.equal(new Set(ticks.map(axisPrice)).size, ticks.length)
})

test("the detail never shows Figma-only claims or data", () => {
  const html = text(detail())
  for (const forbidden of [/NVDAon/, /Asset Open/i, /Off-Hours/i, /Shares per Token/i, /Dividend/i, /Onchain/i, /Supported Chains/i, /Mint/i, /Redemption/i, /Tokenholder/i, /Prospectus/i, /Session Limits/i, /Average Volume/i, /Investors Also Own/i, /Ondo/i, /ALL/]) assert.doesNotMatch(html, forbidden)
})
