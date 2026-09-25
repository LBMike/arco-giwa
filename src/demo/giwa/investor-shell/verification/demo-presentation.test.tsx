import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { StaticRouter } from "react-router-dom"
import { DemoPresentationContext } from "../../demo-presentation"
import { MarketChart } from "../../stocks-market/MarketChart"
import { SecurityDetailView } from "../../stocks-market/MarketDetail"
import { fixtureEnvelope, fixtureTop40Catalog, fixtureTop40Chart, fixtureTop40Profile, fixtureTop40Quote, fixtureTop40Quotes } from "../../stocks-market/fixtures"
import type { Envelope } from "../../stocks-market/contracts"
import { MarketQuoteStatus, MarketStatus, StatusBadge, StocksMarketTable } from "../../stocks-market/StocksMarketTable"
import { GiwaStocksFeatureView } from "../../stocks-investor/GiwaStocksFeature"
import { actionsFor } from "../../stocks-investor/actions"
import { createHarness } from "../../stocks-investor/fixtures/controller-harness"
import type { GiwaStocksAccess } from "../../stocks-investor/access"

const ready = <T,>(value: T) => ({ phase: "ready" as const, value })
const envelope = <T,>(value: T) => fixtureEnvelope(value) as Envelope<T>
const noop = () => undefined
const plain = (html: string) => html.replace(/<[^>]+>/g, " ")
function detail(demo: boolean) {
  const quote = fixtureTop40Quote("SOXL"), chart = fixtureTop40Chart("SOXL", "1D"), profile = fixtureTop40Profile("SOXL")
  return renderToStaticMarkup(<DemoPresentationContext.Provider value={demo}><SecurityDetailView security={{ symbol: "SOXL", name: profile.name }} profile={ready(envelope(profile))} quote={quote} quotes={ready(envelope([quote]))} capabilities={{ phase: "ready", bySymbol: new Map() }} day={chart} range="1D" onRange={noop} selection={null} chart={<MarketChart response={envelope(chart)} />} /></DemoPresentationContext.Provider>)
}
test("customer detail keeps prices, periods and facts but removes the requested slider and technical copy; normal rendering keeps them", () => {
  const demo = detail(true), normal = detail(false)
  assert.doesNotMatch(demo, /type="range"|Select an observation|Feed delay unknown|fixture|OHLCV|Demo trading/)
  assert.match(demo, /171\.63/)
  assert.match(demo, /About/)
  assert.match(demo, /Statistics/)
  assert.match(demo, /1Y/)
  assert.match(demo, /최근 24시간 주가 차트 · 방향키로 가격 확인/)
  assert.match(normal, /type="range"/)
  assert.match(normal, /Feed delay unknown/)
  assert.match(normal, /OHLCV/)
})
test("missing chart data remains an unavailable state in the demo", () => {
  const html = renderToStaticMarkup(<DemoPresentationContext.Provider value><MarketChart response={{ ...envelope(fixtureTop40Chart("SOXL", "1D")), data: null, status: "UNAVAILABLE" }} /></DemoPresentationContext.Provider>)
  assert.match(html, /Chart · Market data unavailable/)
  assert.doesNotMatch(html, /type="range"/)
})
test("demo prices still disclose a retained stale observation", () => {
  const quote = fixtureTop40Quote("NVDA")
  const rows = fixtureTop40Quotes().map(row => row.symbol === "NVDA" ? { ...quote, status: "STALE" as const, reason: "OLD_OBSERVATION" as const } : row)
  const table = renderToStaticMarkup(<DemoPresentationContext.Provider value><StaticRouter location="/stocks"><StocksMarketTable catalog={fixtureTop40Catalog()} quotes={ready({ ...envelope(rows), status: "STALE" })} capabilities={{ phase: "ready", bySymbol: new Map() }} series={{}} variant="full" /></StaticRouter></DemoPresentationContext.Provider>)
  assert.doesNotMatch(table, /오래된 데이터/, "the demo does not repeat the same warning under every price")
  assert.match(table, /sr-only[^>]*>Last observed price · /, "the stale NVDA row keeps an accessible observation timestamp")
  const status = renderToStaticMarkup(<DemoPresentationContext.Provider value><MarketStatus status="STALE" /></DemoPresentationContext.Provider>)
  assert.match(status, /Last observed prices/)
  assert.doesNotMatch(status, /오래된 데이터/)
})
test("demo list omits the closed-market notice and retains delay and provider failure notices", () => {
  const sourceTimestamp = "2026-09-23T19:59:59.000Z"
  const rows = ["NVDA", "SOXL"].map(symbol => ({ ...fixtureTop40Quote(symbol), status: "STALE" as const, reason: "OLD_OBSERVATION" as const, sourceTimestamp }))
  const quotes = ready({ ...envelope(rows), status: "STALE" as const, reason: "OLD_OBSERVATION" })
  const render = (state: "OPEN" | "CLOSED") => renderToStaticMarkup(<DemoPresentationContext.Provider value><MarketQuoteStatus quotes={quotes} marketSession={{ state, observedAt: "2026-09-24T04:00:00.000Z", nextOpen: null, nextClose: null }} /></DemoPresentationContext.Provider>)
  const closed = render("CLOSED")
  assert.equal(closed, "")
  assert.match(render("OPEN"), /Price updates delayed · Last observed prices/)
  const failure = ready({ ...quotes.value, reason: "PROVIDER_UNAVAILABLE" })
  const failed = renderToStaticMarkup(<DemoPresentationContext.Provider value><MarketQuoteStatus quotes={failure} marketSession={{ state: "CLOSED", observedAt: null, nextOpen: null, nextClose: null }} /></DemoPresentationContext.Provider>)
  assert.match(failed, /Price updates delayed/)
  assert.doesNotMatch(failed, /장 마감/)
})
test("preview labels every listed stock Live without changing the server's order capability", () => {
  const capabilities = { phase: "ready" as const, bySymbol: new Map([["NVDA", "CHECK_PAUSE_AT_ORDER" as const]]) }
  const table = renderToStaticMarkup(<DemoPresentationContext.Provider value><StaticRouter location="/stocks"><StocksMarketTable catalog={fixtureTop40Catalog()} quotes={ready(envelope(fixtureTop40Quotes()))} capabilities={capabilities} series={{}} variant="full" /></StaticRouter></DemoPresentationContext.Provider>)
  assert.equal((table.match(/>Live<\/span>/g) ?? []).length, 40)
  assert.doesNotMatch(table, /Coming soon|Available/)
  assert.match(detail(true), />Live<\/span>/, "the detail header uses the same presentation label")
  assert.match(detail(false), /Market data only/, "normal status still reflects the order catalog")
  const badge = renderToStaticMarkup(<DemoPresentationContext.Provider value><StatusBadge symbol="SOXL" capabilities={capabilities} /></DemoPresentationContext.Provider>)
  assert.match(badge, /bg-\[var\(--color-arco-stock-chart-chip\)\]/, "Figma's neutral 5% badge background")
  assert.match(badge, /text-\[var\(--color-arco-up-text\)\]/, "Figma's green label colour")
  assert.match(badge, /size-3/, "Figma's 12px halo")
  assert.match(badge, /opacity-40/, "Figma's 40% green halo")
  assert.match(badge, /size-2 rounded-full bg-\[var\(--color-arco-up-text\)\]/, "Figma's 8px green dot")
})
test("demo trade panel removes test annotations without enabling signed-out trading or hiding an expired session", async () => {
  const h = createHarness()
  await h.enter(null)
  const view = (demo: boolean, hostError: GiwaStocksAccess["hostError"] = null) => renderToStaticMarkup(<DemoPresentationContext.Provider value={demo}><GiwaStocksFeatureView state={h.controller.getState()} actions={actionsFor(h.controller)} tab="stocks" onTabChange={noop} detailOpen onDetailChange={noop} access={{ wallet: "disconnected", host: "signed-out", hostError, canSignIn: false, connectWallet: noop }} /></DemoPresentationContext.Provider>)
  const demo = view(true)
  assert.doesNotMatch(plain(demo), /Mock broker|Test units|test cash|fixed, test|base units/)
  assert.match(demo, /Connect wallet/)
  assert.match(demo, /<fieldset[^>]*disabled/)
  // The customer panel prices at the market chart above it, so it shows no separate price row.
  assert.doesNotMatch(demo, /Order price/)
  assert.match(plain(view(true, "SESSION_EXPIRED")), /session ended/)
  assert.match(view(false), /Mock broker/)
})
