import assert from "node:assert/strict"
import test from "node:test"
import type { GiwaPriceHistory } from "./api"
import { buildNetRateSeries, buildNetWorthSeries, type PortfolioPosition } from "./portfolio-series"

const DAY = 86_400

// A position from [t, nav] pairs (navBase = navUsd for these USD-vault fixtures).
function pos(shares: number, points: Array<[number, number]>): PortfolioPosition {
  const history: GiwaPriceHistory = {
    productId: "x",
    apy: null,
    points: points.map(([t, nav]) => ({ t, navBase: nav, navUsd: nav })),
  }
  return { shares, history }
}

test("buildNetWorthSeries sums shares×navUsd across vaults on a merged axis with forward-fill", () => {
  const series = buildNetWorthSeries([
    pos(10, [[100, 1.0], [300, 1.2]]), // vault A
    pos(5, [[200, 2.0]]), // vault B — single post
  ])
  // axis = {100,200,300}; B has no price ≤100 (excluded there); B forward-fills 2.0 to t=300.
  assert.deepEqual(series, [
    { ts: 100, value: 10 }, // 10×1.0
    { ts: 200, value: 20 }, // 10×1.0 + 5×2.0
    { ts: 300, value: 22 }, // 10×1.2 + 5×2.0 (forward-filled)
  ])
})

test("buildNetWorthSeries: empty at no holdings / <2 points", () => {
  assert.deepEqual(buildNetWorthSeries([]), [])
  assert.deepEqual(buildNetWorthSeries([pos(10, [[100, 1.0]])]), []) // single point → empty
})

test("buildNetRateSeries = value-weighted APY over apy-bearing vaults (nulls excluded, not 0%)", () => {
  // Two vaults, 3 posts each → 2 implied-APY intervals (0% then A:2% / B:10%).
  const a = pos(10, [[0, 1.0], [365 * DAY, 1.0], [730 * DAY, 1.02]])
  const b = pos(5, [[0, 1.0], [365 * DAY, 1.0], [730 * DAY, 1.1]])
  const series = buildNetRateSeries([a, b])
  assert.equal(series.length, 2)
  assert.equal(series[0].value, 0) // first interval: both 0%
  // second interval: value-weighted 2% and 10% by value_v = shares×nav → (10.2·2 + 5.5·10)/(10.2+5.5)
  assert.ok(Math.abs(series[1].value - (10.2 * 2 + 5.5 * 10) / (10.2 + 5.5)) < 1e-4)
})

test("buildNetRateSeries excludes null-APY vaults (does not dilute toward 0%)", () => {
  const a = pos(10, [[0, 1.0], [365 * DAY, 1.0], [730 * DAY, 1.02]]) // has APY
  const noApy = pos(100, [[0, 5.0]]) // single post → buildApySeries [] → no apy(t)
  const series = buildNetRateSeries([a, noApy])
  // The big null-APY position (value 500) must NOT be in the weight → net rate = A alone (2%),
  // not (10.2·2 + 500·0)/(10.2+500) ≈ 0.04%.
  assert.ok(Math.abs(series[series.length - 1].value - 2) < 1e-4)
})

test("buildNetRateSeries: empty when no vault has an APY series", () => {
  assert.deepEqual(buildNetRateSeries([]), [])
  assert.deepEqual(buildNetRateSeries([pos(10, [[0, 1.0]])]), []) // single post → no apy → empty
})
