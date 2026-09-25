import assert from "node:assert/strict"
import test from "node:test"
import type { GiwaPriceHistory } from "./api"
import { buildNetWorthSeries } from "./portfolio-series"
import {
  allocationOf, formatValueChange, historyStart, productPortfolioCategory, stockPriceHistory, valueChange, withCurrentPrice,
} from "./portfolio-view"
import type { GiwaCatalogItem } from "./types"

const product = (kind: "saving" | "product" | null) => ({ vaultConfig: kind === null ? null : { kind } }) as unknown as Pick<GiwaCatalogItem, "vaultConfig">
const history = (points: Array<[number, number]>): GiwaPriceHistory => ({ productId: "v", apy: null, points: points.map(([t, nav]) => ({ t, navBase: nav, navUsd: nav })) })

test("Savings are the saving vaults; every other GIWA product, including unconfigured ones, is a Fund", () => {
  assert.equal(productPortfolioCategory(product("saving")), "savings")
  assert.equal(productPortfolioCategory(product("product")), "funds")
  assert.equal(productPortfolioCategory(product(null)), "funds")
})

test("allocation sums each product line, shares the valued total and flags an unpriced holding", () => {
  const slices = allocationOf([
    { category: "savings", usd: 600 }, { category: "savings", usd: 150 },
    { category: "funds", usd: 200 },
    { category: "stocks", usd: 50 }, { category: "stocks", usd: null },
  ])
  assert.deepEqual(slices.map((s) => [s.category, s.usd, s.count, s.share, s.complete]), [
    ["savings", 750, 2, 75, true], ["funds", 200, 1, 20, true], ["stocks", 50, 2, 5, false],
  ])
  assert.deepEqual(allocationOf([]).map((s) => [s.usd, s.count, s.share, s.complete]), [[0, 0, null, true], [0, 0, null, true], [0, 0, null, true]])
})

test("value change is last − first with a percent of the first; formatting is signed, cent-rounded and flat under half a cent", () => {
  assert.equal(valueChange([{ ts: 1, value: 100 }]), null)
  assert.deepEqual(valueChange([{ ts: 1, value: 200 }, { ts: 2, value: 150 }, { ts: 3, value: 212.5 }]), { amount: 12.5, pct: 6.25 })
  assert.deepEqual(valueChange([{ ts: 1, value: 0 }, { ts: 2, value: 5 }]), { amount: 5, pct: null })
  assert.deepEqual(formatValueChange({ amount: 12.5, pct: 6.25 }), { text: "+$12.50 (+6.25%)", dir: "up" })
  assert.deepEqual(formatValueChange({ amount: -1234.567, pct: -1.234 }), { text: "-$1,234.57 (-1.23%)", dir: "down" })
  assert.deepEqual(formatValueChange({ amount: 0.004, pct: 0.0001 }), { text: "$0.00 (0.00%)", dir: "flat" })
  assert.deepEqual(formatValueChange({ amount: 5, pct: null }), { text: "+$5.00", dir: "up" })
})

test("history start is the earliest point of any held vault", () => {
  assert.equal(historyStart([undefined, history([])]), null)
  assert.equal(historyStart([history([[300, 1]]), undefined, history([[200, 1], [400, 1]])]), 200)
})

test("a vault with history ends at its current USD price; one without history stays out", () => {
  const withNow = withCurrentPrice(history([[100, 1], [200, 1.1]]), { navUsd: 1.2, navBase: 1.15 }, 300)
  assert.deepEqual(withNow?.points[withNow.points.length - 1], { t: 300, navBase: 1.15, navUsd: 1.2 })
  assert.equal(withCurrentPrice(history([]), { navUsd: 1.2, navBase: 1 }, 300)?.points.length, 0)
  assert.equal(withCurrentPrice(undefined, { navUsd: 1.2, navBase: 1 }, 300), undefined)
  assert.equal(withCurrentPrice(history([[100, 1]]), { navUsd: null, navBase: 1 }, 300)?.points.length, 1)
  assert.equal(withCurrentPrice(history([[400, 1]]), { navUsd: 2, navBase: 2 }, 300)?.points.length, 1, "no point before the newest post")
})

test("stock closes start where the vault line starts, end at the live price and join the Net Worth line", () => {
  const closes = [{ t: 50, close: 100 }, { t: 150, close: 110 }, { t: 250, close: 120 }]
  const line = stockPriceHistory("stocks:NVDA", closes, { from: 100, price: 125, now: 300 })
  assert.deepEqual(line.points.map((p) => [p.t, p.navUsd]), [[100, 100], [150, 110], [250, 120], [300, 125]])
  assert.deepEqual(stockPriceHistory("s", closes, { from: 150, price: null, now: 300 }).points.map((p) => p.t), [150, 250])
  assert.deepEqual(stockPriceHistory("s", closes, { from: null, price: 125, now: 300 }).points.map((p) => p.t), [50, 150, 250, 300])
  assert.deepEqual(stockPriceHistory("s", [], { from: 100, price: 125, now: 300 }).points, [], "no closes: the stock stays out of the line")
  // 2 units of the stock plus 10 shares of a vault: both priced from t=100, ending at the current valuation.
  const series = buildNetWorthSeries([
    { shares: 10, history: withCurrentPrice(history([[100, 1], [200, 1.1]]), { navUsd: 1.2, navBase: 1.2 }, 300) },
    { shares: 2, history: line },
  ])
  assert.deepEqual(series, [
    { ts: 100, value: 210 }, { ts: 150, value: 230 }, { ts: 200, value: 231 }, { ts: 250, value: 251 }, { ts: 300, value: 262 },
  ])
})
