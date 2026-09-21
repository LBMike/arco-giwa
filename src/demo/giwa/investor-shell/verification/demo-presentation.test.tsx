import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { DemoPresentationContext } from "../../demo-presentation"
import { MarketChart } from "../../stocks-market/MarketChart"
import { SecurityDetailView } from "../../stocks-market/MarketDetail"
import { fixtureEnvelope, fixtureTop40Chart, fixtureTop40Profile, fixtureTop40Quote } from "../../stocks-market/fixtures"
import type { Envelope } from "../../stocks-market/contracts"
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
  assert.doesNotMatch(demo, /type="range"|관측값 선택|미확인|fixture|OHLCV|모의 주문/)
  assert.match(demo, /171\.63/)
  assert.match(demo, /About/)
  assert.match(demo, /Statistics/)
  assert.match(demo, /1Y/)
  assert.match(demo, /방향키로 가격 탐색/)
  assert.match(normal, /type="range"/)
  assert.match(normal, /미확인/)
  assert.match(normal, /OHLCV/)
})
test("missing chart data remains an unavailable state in the demo", () => {
  const html = renderToStaticMarkup(<DemoPresentationContext.Provider value><MarketChart response={{ ...envelope(fixtureTop40Chart("SOXL", "1D")), data: null, status: "UNAVAILABLE" }} /></DemoPresentationContext.Provider>)
  assert.match(html, /시세를 불러올 수 없습니다/)
  assert.doesNotMatch(html, /type="range"/)
})
test("demo trade panel removes test annotations without enabling signed-out trading or hiding an expired session", async () => {
  const h = createHarness()
  await h.enter(null)
  const view = (demo: boolean, hostError: GiwaStocksAccess["hostError"] = null) => renderToStaticMarkup(<DemoPresentationContext.Provider value={demo}><GiwaStocksFeatureView state={h.controller.getState()} actions={actionsFor(h.controller)} tab="stocks" onTabChange={noop} detailOpen onDetailChange={noop} access={{ wallet: "disconnected", host: "signed-out", hostError, canSignIn: false, connectWallet: noop }} /></DemoPresentationContext.Provider>)
  const demo = view(true)
  assert.doesNotMatch(plain(demo), /Mock broker|Test units|test cash|fixed, test|base units/)
  assert.match(demo, /Connect wallet/)
  assert.match(demo, /<fieldset[^>]*disabled/)
  assert.match(demo, /Order price/)
  assert.match(plain(view(true, "SESSION_EXPIRED")), /session ended/)
  assert.match(view(false), /Mock broker/)
})
