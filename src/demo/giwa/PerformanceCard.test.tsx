import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { GiwaMarketEntry, GiwaPriceHistory } from "./api"
import { GiwaPerformanceCard } from "./PerformanceCard"

const NOW = 1783460000
const market: GiwaMarketEntry = {
  productId: "beqty",
  navBase: 1.00163636,
  baseUsd: 1,
  navUsd: 1.00163636,
  apy: null,
  impliedApy: 13.09,
}
const history: GiwaPriceHistory = {
  productId: "beqty",
  apy: null,
  points: [
    { t: 1783353375, navBase: 1, navUsd: 1 },
    { t: 1783360296, navBase: 1, navUsd: 1 },
    { t: 1783361339, navBase: 1.0013, navUsd: 1.0013 },
    { t: 1783447443, navBase: 1.00163636, navUsd: 1.00163636 },
  ],
}

const render = (metric: "price" | "apy") =>
  renderToStaticMarkup(
    <GiwaPerformanceCard market={market} history={history} isBuiltIn={false} initialMetric={metric} now={NOW} />,
  )

test("Performance card has a Price/APY toggle and the range selector", () => {
  const html = render("price")
  assert.match(html, /Price/)
  assert.match(html, /APY/)
  for (const range of ["7D", "30D", "90D", "1Y", "All"]) assert.match(html, new RegExp(range))
})

test("Price tab headline = live navSharePrice ($1.0016)", () => {
  assert.match(render("price"), /\$1\.0016/)
})

test("APY tab headline = the market impliedApy the list/stat show (single source, 13.09%)", () => {
  const html = render("apy")
  assert.match(html, /13\.09%/)
})

test("built-in on the projected price curve keeps the 'projected at X%' disclaimer", () => {
  const builtin: GiwaMarketEntry = { ...market, productId: "acapix", apy: 11.58, navUsd: 1.0 }
  const html = renderToStaticMarkup(
    <GiwaPerformanceCard
      market={builtin}
      history={{ productId: "acapix", apy: 11.58, points: [] }}
      isBuiltIn
      initialMetric="price"
      now={NOW}
    />,
  )
  assert.match(html, /projected at 11\.58%/)
})

test("empty state at <2 points (registered vault, single post)", () => {
  const html = renderToStaticMarkup(
    <GiwaPerformanceCard
      market={market}
      history={{ productId: "beqty", apy: null, points: [{ t: 1783447443, navBase: 1.0016, navUsd: 1.0016 }] }}
      isBuiltIn={false}
      initialMetric="price"
      now={NOW}
    />,
  )
  assert.match(html, /No performance data yet/)
})
