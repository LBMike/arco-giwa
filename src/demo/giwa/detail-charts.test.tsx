import assert from "node:assert/strict"
import test from "node:test"
import type { GiwaPriceHistory } from "./api"
import {
  apyChangePct,
  buildApySeries,
  buildProductSeries,
  buildRegisteredPriceSeries,
  defaultRange,
  filterByRange,
  priceReturnPct,
  type RawPoint,
} from "./detail-charts"
import { navSharePrice } from "./price-policy"

const DAY = 86_400
const history = (points: Array<{ t: number; navBase: number; navUsd?: number | null }>): GiwaPriceHistory => ({
  productId: "beqty",
  apy: null,
  points: points.map((p) => ({ t: p.t, navBase: p.navBase, navUsd: p.navUsd ?? p.navBase })),
})

// bEQTY's post-backfill history: two near-instant early posts (17-min gap) + a ~1-day gap.
const BEQTY = history([
  { t: 1783353375, navBase: 1 },
  { t: 1783360296, navBase: 1 },
  { t: 1783361339, navBase: 1.0013 },
  { t: 1783447443, navBase: 1.00163636 },
])

test("buildRegisteredPriceSeries plots REAL navBase history with precision; empty at <2 posts", () => {
  const series = buildRegisteredPriceSeries(BEQTY)
  assert.equal(series.projected, false)
  assert.equal(series.points.length, 4)
  assert.equal(series.points[3].value, 1.0016) // round4 keeps sub-cent precision
  assert.equal(navSharePrice(series.points[3].value), "$1.0016") // real movement, not flat "$1"

  assert.deepEqual(buildRegisteredPriceSeries(history([{ t: 1, navBase: 1 }])).points, [])
  assert.deepEqual(buildRegisteredPriceSeries(undefined).points, [])
})

test("buildApySeries skips short-gap intervals (no astronomical values) and stays sane", () => {
  const series = buildApySeries(BEQTY)
  // The two sub-hour gaps are skipped; only the ~1-day interval survives.
  assert.equal(series.length, 1)
  assert.ok(series[0].value > 5 && series[0].value < 30, `expected ~13%, got ${series[0].value}`)
  // Nothing astronomical anywhere in the series.
  assert.ok(series.every((p) => Math.abs(p.value) <= 1000))

  assert.deepEqual(buildApySeries(history([{ t: 0, navBase: 1 }])), [])
  assert.deepEqual(buildApySeries(undefined), [])
})

test("buildApySeries clamps an in-window but absurd jump to the display bound", () => {
  // navBase doubles over 0.25 day → annualizes astronomically → clamped to +1000%.
  const series = buildApySeries(history([{ t: 0, navBase: 1 }, { t: Math.round(0.25 * DAY), navBase: 2 }]))
  assert.equal(series.length, 1)
  assert.equal(series[0].value, 1000)
})

test("buildApySeries: clean daily-cadence fixture yields the per-interval APY (2% over 365d)", () => {
  const series = buildApySeries(history([{ t: 0, navBase: 1 }, { t: 365 * DAY, navBase: 1.02 }]))
  assert.equal(series.length, 1)
  assert.equal(series[0].value, 2)
})

test("buildProductSeries (built-in legacy path) unchanged: real >=3 points, else projected curve", () => {
  const now = 1_000_000
  const real = buildProductSeries(
    history([
      { t: 1, navBase: 1, navUsd: 1.0 },
      { t: 2, navBase: 1, navUsd: 1.001 },
      { t: 3, navBase: 1, navUsd: 1.002 },
    ]),
    1.002,
    11.58,
    now,
  )
  assert.equal(real.projected, false)
  assert.equal(real.points.length, 3)

  const projected = buildProductSeries(history([]), 1.0, 11.58, now)
  assert.equal(projected.projected, true)
  assert.equal(projected.points.length, 31)
})

test("filterByRange filters by timestamp; All / empty pass through", () => {
  const now = 100 * DAY
  const points: RawPoint[] = [
    { ts: now - 60 * DAY, value: 1 },
    { ts: now - 20 * DAY, value: 2 },
    { ts: now - 3 * DAY, value: 3 },
  ]
  assert.equal(filterByRange(points, "All", now).length, 3)
  assert.equal(filterByRange(points, "7D", now).length, 1) // only the 3-day-old point
  assert.equal(filterByRange(points, "30D", now).length, 2)
  assert.equal(filterByRange(points, "90D", now).length, 3)
  assert.deepEqual(filterByRange([], "7D", now), [])
})

test("defaultRange = 30D when data spans >=30d, else All (sparse testnet)", () => {
  const now = 100 * DAY
  assert.equal(defaultRange([{ ts: now - 40 * DAY, value: 1 }, { ts: now, value: 2 }]), "30D")
  assert.equal(defaultRange([{ ts: now - 2 * DAY, value: 1 }, { ts: now, value: 2 }]), "All") // bEQTY-like
  assert.equal(defaultRange([{ ts: now, value: 1 }]), "All")
})

test("range delta: price = relative return, APY = point change; null under 2 points", () => {
  const price: RawPoint[] = [{ ts: 1, value: 1.0 }, { ts: 2, value: 1.0016 }]
  assert.ok(Math.abs(priceReturnPct(price)! - 0.16) < 0.01) // ~+0.16%
  const apy: RawPoint[] = [{ ts: 1, value: 0 }, { ts: 2, value: 13.09 }]
  assert.equal(apyChangePct(apy), 13.09)
  assert.equal(priceReturnPct([{ ts: 1, value: 1 }]), null)
  assert.equal(apyChangePct([{ ts: 1, value: 5 }]), null)
})
