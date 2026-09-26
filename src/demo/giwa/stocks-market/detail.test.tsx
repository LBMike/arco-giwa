// The /stocks security detail's presentational pieces, rendered statically with the synthetic fixtures (no Figma values).
import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { DemoPresentationContext } from "../demo-presentation"
import type { Chart, Dividend, Envelope, Profile, Quote, Security } from "./contracts"
import { axisPrice, axisTicks, axisTime, barRange, chartPoints, compactDollars, dollars, windowChange } from "./display"
import { MarketChart } from "./MarketChart"
import { AboutCard, DetailHeader, DividendGroup, PeriodTabs, PriceCard, SecurityDetailView, StatisticsCard, UnavailableDetail } from "./MarketDetail"
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
const DIVIDEND: Dividend = { symbol: "NVDA", currency: "USD", cashAmount: "0.22", splitAdjustedCashAmount: "0.22", frequency: 4, exDividendDate: "2026-09-10", payDate: "2026-10-02" }
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'")
const count = (html: string, needle: string) => text(html).split(needle).length - 1
const esc = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function detail(overrides: Partial<Parameters<typeof SecurityDetailView>[0]> = {}) {
  const quote = fixtureTop40Quote("NVDA")
  const chart = fixtureTop40Chart("NVDA", "1D")
  return renderToStaticMarkup(<SecurityDetailView security={NVDA} profile={ready(envelope(PROFILE))} quote={quote} quotes={ready(envelope([quote]))} capabilities={ORDERS} day={chart} range="1D" onRange={() => {}} selection={null}
    chart={<MarketChart response={envelope(chart)} />} {...overrides} />)
}

test("stock detail distinguishes the rolling chart from About and Statistics", () => {
  const page = detail()
  assert.match(page, /aria-label="24-hour price chart/)
  assert.match(text(page), /over the observed period/)
  assert.match(text(page), /About.*Statistics/)
})

test("header: the h1 names the security with the ticker muted after it, and the table's order-capability badge; no session pill", () => {
  const html = renderToStaticMarkup(<DetailHeader symbol="NVDA" name="NVIDIA Corporation" logoUrl={null} capabilities={ORDERS} headingId="h" />)
  assert.match(html, /<h1 id="h" tabindex="-1"[^>]*>NVIDIA Corporation <span class="text-\[var\(--color-arco-chip-ink\)\]">NVDA<\/span><\/h1>/)
  assert.match(html, /<img src="\/logos\/stocks\/nvidia\.png" alt="" width="40" height="40"/)
  assert.match(text(html), /Demo trading$/)
  for (const [capabilities, label] of [[{ phase: "loading" }, "Checking"], [{ phase: "error" }, "Status unavailable"], [{ phase: "ready", bySymbol: new Map([["NVDA", "NOT_ACTIVATED"]]) }, "Inactive"], [{ phase: "ready", bySymbol: new Map() }, "Market data only"]] as const) {
    assert.match(text(renderToStaticMarkup(<DetailHeader symbol="NVDA" name="NVIDIA Corporation" logoUrl={null} capabilities={capabilities as Capabilities} headingId="h" />)), new RegExp(`${label}$`))
  }
  assert.match(renderToStaticMarkup(<DetailHeader symbol="ZZZZ" name="ZZZZ" logoUrl={null} capabilities={ORDERS} headingId="h" />), /<h1[^>]*>ZZZZ<\/h1>/, "no repeated ticker when there is no name")
})

test("price card: 1D change follows the chart; other periods retain previous-close change", () => {
  const html = detail()
  const quote = fixtureTop40Quote("NVDA")
  assert.equal(count(html, "Underlying stock price · USD"), 1)
  assert.match(html, new RegExp(`<p title="${esc(dollars(quote.price))}"[^>]*text-\\[40px\\][^>]*>\\$[0-9,]+(\\.\\d{1,2})?</p>`))
  assert.match(text(html), new RegExp(`${esc(windowChange(fixtureTop40Chart("NVDA", "1D"), quote))}over the observed period`))
  assert.match(text(html), /Sep 16, 2026, 08:00:00 AM EDT · 15-minute delay/)
  const up = renderToStaticMarkup(<SecurityDetailView security={NVDA} profile={ready(envelope(PROFILE))} quote={{ ...quote, change: "5.01", changePercent: "2.81" }} quotes={ready(envelope([quote]))} capabilities={ORDERS} day={null} range="1W" onRange={() => {}} selection={null} chart={null} />)
  assert.match(up, /text-\[var\(--color-arco-up-text\)\]"><svg[^]*?Up <\/span>\$5\.01 \(2\.81%\)/, "rising change text uses the AA text token")
  const flat = renderToStaticMarkup(<SecurityDetailView security={NVDA} profile={ready(envelope(PROFILE))} quote={{ ...quote, change: "0.001", changePercent: "0" }} quotes={ready(envelope([quote]))} capabilities={ORDERS} day={null} range="1W" onRange={() => {}} selection={null} chart={null} />)
  assert.match(flat, /<span class="text-\[var\(--color-arco-text-soft\)\]">\$0 \(0%\)<\/span>/, "flat stays neutral")
  const missing = renderToStaticMarkup(<SecurityDetailView security={NVDA} profile={{ phase: "loading" }} quote={null} quotes={{ phase: "loading" }} capabilities={ORDERS} day={null} range="1D" onRange={() => {}} selection={null} chart={null} />)
  assert.equal(count(missing, "Underlying stock price · USD"), 1)
  assert.match(text(missing), /Underlying stock price · USD—— ?over the observed period/)
  assert.match(text(missing), /Loading market data…/)
})

test("NVDA detail labels the exchange session separately from quote freshness and stream recovery", () => {
  const closed = text(detail({ marketSession: { state: "CLOSED", observedAt: FIXTURE_TIME, nextOpen: "2026-09-17T13:30:00.000Z", nextClose: null }, liveConnection: "streaming" }))
  assert.match(closed, /US stock market · Closed/)
  assert.doesNotMatch(closed, /Reconnecting to market data…/)

  const reconnecting = text(detail({ marketSession: null, liveConnection: "reconnecting" }))
  assert.match(reconnecting, /Reconnecting to market data…/)
  assert.doesNotMatch(reconnecting, /US stock market · Closed/)

  const unknown = text(detail({ marketSession: { state: "UNKNOWN", observedAt: null, nextOpen: null, nextClose: null }, liveConnection: "streaming" }))
  assert.match(unknown, /US stock market · Session status unavailable/)
  assert.doesNotMatch(unknown, /US stock market · Open|US stock market · Closed/)
})

test("demo price card omits routine session and stale notices but keeps unavailable and loading states", () => {
  const quote = fixtureTop40Quote("SGOV")
  const render = (current: Quote | null, quotes: ReadState<Envelope<Quote[]>>) => renderToStaticMarkup(<DemoPresentationContext.Provider value>
    <PriceCard quote={current} quotes={quotes} selection={null} range="1D" onRange={() => {}} marketSession={{ state: "CLOSED", observedAt: FIXTURE_TIME, nextOpen: null, nextClose: null }}>{null}</PriceCard>
  </DemoPresentationContext.Provider>)
  const stale = render(quote, ready(envelope([quote], "STALE")))
  assert.match(stale, /\$422\.82/)
  assert.match(stale, /Sep 16, 2026/)
  assert.doesNotMatch(stale, /US stock market|Last observed prices/)
  assert.match(render(null, ready(envelope<Quote[]>(null, "UNAVAILABLE"))), /Market prices unavailable/)
  assert.match(render(null, { phase: "loading" }), /Loading market data…/)
})

test("statistics source follows the quote provider instead of naming a different feed", () => {
  const quote = fixtureTop40Quote("NVDA")
  const html = detail({ quotes: ready({ ...envelope([quote]), provider: "ALPACA", marketFeed: "IEX", feedDelay: "REALTIME" }) })
  assert.match(text(html), /Alpaca · IEX \(single exchange\) · Real-time feed configured/)
  assert.doesNotMatch(text(html), /Massive · Real-time feed configured/)
})

test("a picked bar replaces the quote in the header (same caption slot) and hides the previous-close change", () => {
  const chart = fixtureTop40Chart("NVDA", "1D")
  const bar = chart.bars[3]
  const html = detail({ selection: { bar, interval: "5m", feedDelay: "UNKNOWN" } })
  assert.equal(count(html, "Underlying stock price · USD"), 0)
  assert.equal(count(html, "5m bar close · time marks bar start"), 1)
  assert.match(html, new RegExp(`title="${esc(dollars(bar.close))}"`))
  assert.match(html, /<p class="flex flex-wrap items-center gap-x-1\.5 text-sm invisible">/)
  assert.match(text(html), /Feed delay unknown/, "the picked bar's own feed label")
})

test("price card: this symbol's own non-AVAILABLE quote status whatever the chart shows; the envelope's only when there is no row", () => {
  const sgov = fixtureTop40Quote("SGOV")
  assert.equal(sgov.status, "STALE", "fixture: SGOV's quote is stale")
  const SGOV: Security = { symbol: "SGOV", name: "iShares 0-3 Month Treasury Bond ETF" }
  const view = (quote: Quote | null, quotes: ReadState<Envelope<Quote[]>>, chart: JSX.Element | null) => text(renderToStaticMarkup(<SecurityDetailView security={SGOV} profile={{ phase: "loading" }} quote={quote} quotes={quotes} capabilities={ORDERS} day={null} range="1D" onRange={() => {}} selection={null} chart={chart} />))
  const stale = "Last observed prices · Stale data"
  // The chart read failed, or is loading (every period switch): the stale headline price still says it is stale.
  for (const chart of [<MarketStatus key="error" status="error" />, <MarketStatus key="loading" status="loading" />]) {
    const page = view(sgov, ready(envelope([sgov], "STALE")), chart)
    assert.match(page, /Underlying stock price · USD\$422\.82—over the observed period/, "the stale price is the headline without an unavailable 24h change")
    assert.equal(page.split(stale).length - 1, 1, `one stale marker with a ${chart.props.status} chart`)
  }
  // Once an AVAILABLE chart loads, the marker is still there, once (the chart no longer repeats the quote's status).
  assert.equal(view(sgov, ready(envelope([sgov], "STALE")), <MarketChart response={envelope(fixtureTop40Chart("SGOV", "1D"))} />).split(stale).length - 1, 1)
  // Quote and chart both stale: two different statements, each scoped to its data, never the same line twice.
  const both = view(sgov, ready(envelope([sgov], "STALE")), <MarketChart response={envelope(fixtureTop40Chart("SGOV", "1D"), "STALE")} />)
  assert.equal(both.split("Chart · Last observed prices · stale data").length - 1, 1, "the chart's own status")
  assert.equal(both.split("Last observed prices").length - 1, 2, "plus the quote's, once")
  // One stale symbol marks the whole envelope STALE: a symbol whose own row is AVAILABLE gets no marker.
  const nvda = fixtureTop40Quote("NVDA")
  assert.doesNotMatch(view(nvda, ready(envelope([nvda, sgov], "STALE")), null), /Stale data/)
  for (const [status, copy] of [["UNAVAILABLE", "Market prices unavailable"], ["UNCONFIGURED", "Price feed setup pending"]] as const) {
    assert.match(view(null, ready(envelope<Quote[]>(null, status)), null), new RegExp(`—— ?over the observed period.*${copy}`), `no quote row: the envelope's ${status} explains the dashes`)
    const row: Quote = { ...sgov, status, price: null, change: null, changePercent: null }
    assert.match(view(row, ready(envelope([row], status)), null), new RegExp(copy), `the row's own ${status}`)
  }
  const none = view(null, ready(envelope<Quote[]>([], "AVAILABLE")), null)
  assert.doesNotMatch(none, /Market prices unavailable|Price feed setup pending|Stale data|Loading market data/, "an AVAILABLE envelope adds no status line")
})

test("period buttons: exactly 1D 1W 1M 3M 1Y as <button>s in the Chart period group, pressed state on the active one, no ALL", () => {
  const html = renderToStaticMarkup(<PeriodTabs range="1W" onRange={() => {}} />)
  assert.match(html, /^<div role="group" aria-label="Chart period" class="[^"]*bg-\[var\(--color-arco-stock-chart-chip\)\][^"]*">/)
  assert.deepEqual([...html.matchAll(/<button type="button" aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g)].map(match => [match[2], match[1]]), [["1D", "false"], ["1W", "true"], ["1M", "false"], ["3M", "false"], ["1Y", "false"]])
  assert.match(html, /aria-pressed="true" class="[^"]*bg-\[var\(--color-arco-surface\)\] text-\[var\(--color-arco-ink\)\]/)
  // A non-colour cue for the selected period (the white pill on the chip track and ink vs chip-ink are both below 3:1).
  const ringed = [...html.matchAll(/<button type="button" aria-pressed="(true|false)" class="([^"]*)"/g)].map(match => [match[1], /(^| )ring-1 ring-inset ring-\[var\(--color-arco-ink\)\]( |$)/.test(match[2])])
  assert.deepEqual(ringed, [["false", false], ["true", true], ["false", false], ["false", false], ["false", false]], "only the pressed period carries the inset ink ring")
  assert.doesNotMatch(html, /ALL/)
  // The buttons sit outside the chart subtree (which is keyed by range) and appear once.
  const page = detail()
  assert.equal([...page.matchAll(/aria-label="Chart period"/g)].length, 1)
  assert.ok(page.indexOf('aria-label="Chart period"') < page.indexOf('aria-label="Underlying security chart"'))
})

test("About: two-line clamp with a Show More control for long text, provider-less fallback, facts without values are left out", () => {
  const html = renderToStaticMarkup(<AboutCard security={NVDA} profile={ready(envelope(PROFILE))} />)
  assert.match(html, /<h2 id="[^"]+"[^>]*>About<\/h2>/)
  assert.match(html, /<p id="([^"]+)" class="[^"]*line-clamp-2">Offline fixture company text/)
  const control = /<button type="button" aria-expanded="false" aria-controls="([^"]+)"[^>]*>Show More<\/button>/.exec(html)
  assert.ok(control, "long text gets the expand control")
  assert.match(html, new RegExp(`<p id="${control[1]}"`))
  const labels = [...html.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map(match => match[1])
  assert.deepEqual(labels, ["Underlying Asset Name", "Underlying Asset Ticker", "Category", "Industry", "Website", "ISIN"])
  assert.doesNotMatch(text(html), /Exchange|XNAS/, "exchange is omitted from About")
  assert.equal([...html.matchAll(/<dl /g)].length, 2, "two columns on md+")
  assert.match(html, /<a href="https:\/\/fixture\.invalid\/about" target="_blank" rel="noopener noreferrer"[^>]*>fixture\.invalid<span class="sr-only"> \(opens in a new tab\)<\/span><\/a>/)
  assert.deepEqual([...html.matchAll(/<span class="inline-flex h-5[^\"]*">([^<]+)<\/span>/g)].map(match => match[1]), ["Common Stock"], "the provider's CS code is expanded without a duplicate Stock pill")
  assert.match(text(html), /US67066G1040/)
  const etf = renderToStaticMarkup(<AboutCard security={{ symbol: "SOXL", name: "Direxion Daily Semiconductor Bull 3X Shares" }} profile={ready(envelope({ ...PROFILE, symbol: "SOXL", securityType: "ETF" }))} />)
  assert.deepEqual([...etf.matchAll(/<span class="inline-flex h-5[^"]*">([^<]+)<\/span>/g)].map(match => match[1]), ["ETF", "Leveraged / Inverse"], "a provider type equal to the curated kind is shown once")
  const short = renderToStaticMarkup(<AboutCard security={NVDA} profile={ready(envelope({ ...PROFILE, description: "Short fixture text." }))} />)
  assert.doesNotMatch(short, /Show More/, "short text has nothing to expand")
  const bare = renderToStaticMarkup(<AboutCard security={{ symbol: "ZZZZ", name: "Fixture Co" }} profile={ready(envelope({ ...PROFILE, symbol: "ZZZZ", name: "Fixture Co", description: null, exchange: null, securityType: null, website: null, industry: null }))} />)
  assert.match(text(bare), /No provider description/)
  assert.deepEqual([...bare.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map(match => match[1]), ["Underlying Asset Name", "Underlying Asset Ticker"], "rows without a value are hidden, never dashed")
  assert.doesNotMatch(text(bare), /—/)
  const status = /<section aria-label="Company profile status"[^>]*>(.*?)<\/section>/.exec(html)![1]
  assert.match(text(status), /^Company profile · provider reference dataCompany profile fetched: Sep 16, 2026, 08:00:00 AM EDT · provider data date: 2026-09-15\. Separate from the quote observation time\.$/)
  assert.match(text(renderToStaticMarkup(<AboutCard security={NVDA} profile={{ phase: "error" }} />)), /Company profile unavailable/)
  // "No provider description" states a fact about a loaded profile; a read that did not load one never claims it.
  for (const [profile, status] of [[ready(envelope<Profile>(null, "UNAVAILABLE")), "Company profile unavailable"], [ready(envelope<Profile>(null, "UNCONFIGURED")), "Company profile connection pending"], [{ phase: "error" }, "Company profile unavailable"], [{ phase: "loading" }, "Loading company profile…"]] as const) {
    const about = text(renderToStaticMarkup(<AboutCard security={NVDA} profile={profile as ReadState<Envelope<Profile>>} />))
    assert.doesNotMatch(about, /No provider description/, status)
    assert.match(about, new RegExp(status))
  }
})

test("Statistics: 24H open/high/low from the loaded 1D bars only; quote and profile values; source line; '—' otherwise", () => {
  const chart = fixtureTop40Chart("NVDA", "1D")
  const quote = fixtureTop40Quote("NVDA")
  const expected = barRange(chart)!
  const html = renderToStaticMarkup(<StatisticsCard symbol="NVDA" quote={quote} quotes={ready({ ...envelope([quote]), provider: "MASSIVE" })} profile={ready(envelope(PROFILE))} day={chart} />)
  const rows = [...html.matchAll(/<dt[^>]*>([^<]+)<\/dt><dd(?: title="([^"]*)")?[^>]*>([^<]*)<\/dd>/g)].map(match => [match[1], match[3], match[2] ?? null])
  const label = (value: string) => `$${value.replace(/\.?0+$/, "")}`
  assert.deepEqual(rows.slice(0, 3).map(([name, , title]) => [name, title]), [["Open", dollars(expected.open)], ["High", dollars(expected.high)], ["Low", dollars(expected.low)]])
  for (const [, value] of rows.slice(0, 3)) assert.match(value, /^\$[0-9,]+(\.\d{1,2})?$/)
  assert.equal(rows[0][1], label(expected.open).replace(/\B(?=(\d{3})+(?!\d))/g, ","))
  assert.deepEqual(rows.slice(3).map(([name, value, title]) => [name, value, title]), [["Total Market Cap", "$4.21T", "Market cap: $4,210,987,654,321"], ["Session Volume", `${Number(quote.sessionVolume).toLocaleString("en-US")} shares`, null], ["Previous Close", `$${Number(quote.previousClose).toLocaleString("en-US", { maximumFractionDigits: 2 })}`, dollars(quote.previousClose)]])
  assert.match(html, /<h3[^>]*>Underlying Asset Price<span class="text-sm text-\[var\(--color-arco-chip-ink\)\]">1D<\/span><\/h3>/)
  assert.match(text(html), /Recent 24 hours · observed 5m bars/)
  assert.match(text(html), /Massive · 15-minute delay · quote observed: Sep 16, 2026, 08:00:00 AM EDT\. Stock prices and company market cap are separate from ARCO token price, liquidity, and holdings\./)
  assert.match(text(html), /Place simulated NVDA orders in the order panel\. Displayed market prices are not used for execution\./)
  const empty = renderToStaticMarkup(<StatisticsCard symbol="MU" quote={null} quotes={{ phase: "loading" }} profile={{ phase: "loading" }} day={null} />)
  assert.deepEqual([...empty.matchAll(/<dd[^>]*>([^<]*)<\/dd>/g)].map(match => match[1]), ["—", "—", "—", "—", "—", "—"])
  // True for every missing-series case (loading, STALE, UNAVAILABLE, one bar, failed): it never promises the values will come.
  assert.match(text(empty), /Shown when the 1D chart has a usable observed price line\./)
  assert.doesNotMatch(text(empty), /will be available/)
  assert.doesNotMatch(text(empty), /Place simulated NVDA orders/, "the order-panel pointer is NVDA's only")
})

test("dividend group shows recurring facts and an indicative yield only with a recent observed quote", () => {
  const current: Quote = { ...fixtureTop40Quote("NVDA"), price: "223.71", status: "AVAILABLE" }
  const card = renderToStaticMarkup(<DividendGroup dividend={DIVIDEND} quote={current} />)
  const rows = [...card.matchAll(/<dt[^>]*>([^<]+)<\/dt><dd(?: title="([^"]*)")?[^>]*>([^<]*)<\/dd>/g)].map(match => [match[1], match[3]])
  assert.match(card, /<h3[^>]*>Underlying Asset Dividend<\/h3>/)
  assert.deepEqual(rows, [["Indicative Dividend Yield", "0.39%"], ["Payout Frequency", "Quarterly"], ["Latest Dividend Amount", "$0.22"]])
  assert.doesNotMatch(text(card), /Indicative yield =|Price last observed|Future payments may differ/)
  assert.match(card, /title="Ex-dividend date: 2026-09-10 · Payment date: 2026-10-02"/)

  const recentStale = renderToStaticMarkup(<DividendGroup dividend={DIVIDEND} quote={{ ...current, status: "STALE", observationAgeMs: 3600000 }} />)
  assert.match(text(recentStale), /Indicative Dividend Yield0\.39%/)
  assert.doesNotMatch(text(recentStale), /Price last observed/)
  for (const quote of [null, { ...current, status: "STALE" as const, observationAgeMs: 8 * 86400000 }, { ...current, symbol: "MU" }, { ...current, price: null }]) {
    const withoutYield = text(renderToStaticMarkup(<DividendGroup dividend={DIVIDEND} quote={quote} />))
    assert.doesNotMatch(withoutYield, /Yield|Indicative yield/)
    assert.match(withoutYield, /Payout FrequencyQuarterlyLatest Dividend Amount\$0\.22/)
  }

  const withoutAdjustedAmount = text(renderToStaticMarkup(<DividendGroup dividend={{ ...DIVIDEND, splitAdjustedCashAmount: null }} quote={current} />))
  assert.doesNotMatch(withoutAdjustedAmount, /Yield|Indicative yield/, "an unknown split-adjusted amount cannot support a yield")
  assert.match(withoutAdjustedAmount, /Payout FrequencyQuarterlyLatest Dividend Amount\$0\.22/)

  const detailWithDividend = detail({ dividendContent: <DividendGroup dividend={DIVIDEND} quote={current} /> })
  const statisticsStart = detailWithDividend.indexOf(">Statistics</h2>")
  const dividendStart = detailWithDividend.indexOf("Underlying Asset Dividend")
  assert.ok(statisticsStart >= 0 && dividendStart > statisticsStart && dividendStart < detailWithDividend.indexOf("</section>", statisticsStart), "dividend is inside Statistics")
  assert.equal((detailWithDividend.match(/<section\b/g) ?? []).length, (detail().match(/<section\b/g) ?? []).length, "dividend adds no separate section")
  assert.doesNotMatch(detail(), /Underlying Asset Dividend/, "no dividend means no section at all")
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
    assert.doesNotMatch(text(unknown), /Market data only|Status unavailable|Checking|Demo trading|Inactive/, `no order-capability badge (${capabilities.phase})`)
    assert.match(text(unknown), /Market prices unavailableZZZZ has not been verified in the market data catalog\.$/)
  }
  const curated = text(render("MU", noOrders))
  assert.match(curated, /Market data only/, "a curated symbol keeps its badge")
  assert.doesNotMatch(curated, /has not been verified/)
  assert.match(text(render("NVDA", ORDERS)), /Demo trading/)
  assert.doesNotMatch(text(render("NVDA", ORDERS)), /has not been verified/)
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
