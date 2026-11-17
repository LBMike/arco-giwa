// The Crypto Native savings vaults' APY chart: a month of daily rates inside each vault's band, ending on the rate shown.

import assert from "node:assert/strict"
import test from "node:test"
import { buildApySeries } from "./detail-charts"
import { SAVINGS_VAULT_APY_BANDS, withBandedApy } from "./savings-apy-seed"

const DAY = 86_400
const NOW = 1_795_000_000
const history = { productId: "abtc", apy: 2.79, points: [{ t: NOW - 100 * DAY, navBase: 1, navUsd: 60_000 }, { t: NOW - 600, navBase: 1.0109, navUsd: 60_600 }] }

test("banded APY: aBTC stays in 2–3.5% and aXRP in 3–5%, a point a day for a month, ending now on the rate shown", () => {
  assert.deepEqual(SAVINGS_VAULT_APY_BANDS, { abtc: { low: 2, high: 3.5 }, axrp: { low: 3, high: 5 } })
  for (const [id, rate] of [["abtc", 2.79], ["axrp", 4.57]] as const) {
    const band = SAVINGS_VAULT_APY_BANDS[id]!
    const drawn = withBandedApy({ ...history, productId: id }, id, rate, NOW)!
    assert.equal(drawn.points.length, 31)
    for (const point of drawn.points) assert.ok(point.apy! >= band.low && point.apy! <= band.high, `${id} ${point.apy}`)
    const last = drawn.points[drawn.points.length - 1]!
    assert.equal(last.t, NOW)
    assert.equal(last.apy, rate)
    // A day apart, oldest first; the vault's own price throughout (the chart reads the stated rates, not the price).
    for (let i = 1; i < drawn.points.length - 1; i += 1) assert.equal(drawn.points[i]!.t - drawn.points[i - 1]!.t, DAY)
    assert.ok(drawn.points.every((point) => point.navBase === 1.0109))
    // The line moves: it is not a ruler, and no day jumps by more than half a point.
    const rates = drawn.points.map((point) => point.apy!)
    assert.ok(Math.max(...rates) - Math.min(...rates) > 0.25, `${id} moves`)
    for (let i = 1; i < rates.length; i += 1) assert.ok(Math.abs(rates[i]! - rates[i - 1]!) <= 0.5, `${id} day ${i}`)
    // The chart plots exactly these.
    assert.deepEqual(buildApySeries(drawn).map((point) => point.value), rates)
  }
})

test("banded APY: a day keeps its value from one visit to the next; each vault draws its own line", () => {
  const first = withBandedApy(history, "abtc", 2.79, NOW)!.points
  const later = withBandedApy(history, "abtc", 2.79, NOW + 3 * 3600)!.points
  // Same calendar day: only the last point (now) moves in time; days well before the lean are identical.
  assert.deepEqual(later.slice(0, 20).map((point) => [point.t, point.apy]), first.slice(0, 20).map((point) => [point.t, point.apy]))
  const nextDay = withBandedApy(history, "abtc", 2.79, NOW + DAY)!.points
  assert.deepEqual(nextDay.slice(0, 15).map((point) => point.apy), first.slice(1, 16).map((point) => point.apy))
  const xrpShape = withBandedApy(history, "axrp", 4, NOW)!.points.map((point) => point.apy! - 3)
  assert.notDeepEqual(xrpShape.slice(0, 20), first.slice(0, 20).map((point) => point.apy! - 2))
})

test("banded APY: other vaults, and a vault with no rate to show, keep their history as read", () => {
  assert.equal(withBandedApy(history, "aeth", 3.86, NOW), history)
  assert.equal(withBandedApy(history, "abtc", null, NOW), history)
  assert.equal(withBandedApy(undefined, "umint", 4, NOW), undefined)
  // No history read yet: the banded month is still drawn, at price 1.
  assert.equal(withBandedApy(undefined, "ABTC", 2.79, NOW)!.points.length, 31)
})
