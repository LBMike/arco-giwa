import assert from "node:assert/strict"
import test from "node:test"
import type { GiwaPriceHistory } from "./api"
import { buildApySeries } from "./detail-charts"
import { SAVINGS_APY_SEED, withSeededApy } from "./savings-apy-seed"

const DAY = 86_400
const NOW = 1_792_670_400 // 2026-10-22 12:00 UTC
const history = (points: Array<{ t: number; apy: number; navBase?: number }>): GiwaPriceHistory => ({
  productId: "sarcousd",
  apy: null,
  points: points.map((point) => ({ t: point.t, navBase: point.navBase ?? 1, navUsd: point.navBase ?? 1, apy: point.apy })),
})

test("nothing paid yet: a month rising from 3.8% to 4.6% that ends now; the 0% snapshots are left out", () => {
  const zeros = history([{ t: NOW - 3 * DAY, apy: 0 }, { t: NOW - DAY, apy: 0 }, { t: NOW - 60, apy: 0 }])
  const series = buildApySeries(withSeededApy(zeros, NOW))
  assert.equal(series.length, SAVINGS_APY_SEED.days + 1)
  assert.deepEqual(series[0], { ts: NOW - 30 * DAY, value: 3.8 })
  assert.deepEqual(series[series.length - 1], { ts: NOW, value: 4.6 })
  assert.ok(series.every((point) => point.value >= 3.7 && point.value <= 4.7), JSON.stringify(series))
  // Rising: each week ends higher than the one before.
  const weekly = [0, 7, 14, 21, 28].map((day) => series[day]!.value)
  for (let i = 1; i < weekly.length; i++) assert.ok(weekly[i]! > weekly[i - 1]!, JSON.stringify(weekly))
})

test("once a rate is paid: the month ends at the first paid snapshot and every snapshot from it is drawn as read", () => {
  const paidAt = NOW - 2 * DAY
  const read = history([
    { t: NOW - 3 * DAY, apy: 0 },
    { t: paidAt, apy: 4.61, navBase: 1.0001 },
    { t: paidAt + 300, apy: 4.6, navBase: 1.0001 },
    { t: NOW, apy: 0, navBase: 1.0002 },
  ])
  const seeded = withSeededApy(read, NOW)!
  const series = buildApySeries(seeded)
  assert.deepEqual(series[0], { ts: paidAt - 30 * DAY, value: 3.8 })
  // The seeded month stops a day before the first paid snapshot; from there the snapshots as read (a later 0 included).
  assert.deepEqual(series.slice(-4), [
    { ts: paidAt - DAY, value: series[series.length - 4]!.value },
    { ts: paidAt, value: 4.61 },
    { ts: paidAt + 300, value: 4.6 },
    { ts: NOW, value: 0 },
  ])
  assert.equal(series.length, SAVINGS_APY_SEED.days + 3)
  // The seeded days carry the share price of the first paid snapshot.
  assert.equal(seeded.points[0]!.navBase, 1.0001)
  // Anchored to the first paid snapshot: a later "now" draws the same values.
  assert.deepEqual(buildApySeries(withSeededApy(read, NOW + 5 * DAY)), series)
})

test("a lone 0% snapshot between two paid ones (the keeper's minutes between distributions) is left out", () => {
  const paidAt = NOW - 2 * DAY
  const read = history([
    { t: paidAt, apy: 4.6 },
    { t: paidAt + DAY - 60, apy: 4.6 },
    { t: paidAt + DAY + 120, apy: 0 },
    { t: paidAt + DAY + 420, apy: 4.61 },
    { t: NOW - 600, apy: 0 },
    { t: NOW - 300, apy: 0 },
    { t: NOW, apy: 4.6 },
  ])
  const tail = buildApySeries(withSeededApy(read, NOW)).filter((point) => point.ts >= paidAt)
  // The lone gap goes; two 0% snapshots in a row stay (that is a stop, not a gap).
  assert.deepEqual(
    tail.map((point) => point.value),
    [4.6, 4.6, 4.61, 0, 0, 4.6],
  )
})

test("no history read yet stays empty; switched off, the history is drawn as read", () => {
  assert.equal(withSeededApy(undefined, NOW), undefined)
  const read = history([{ t: NOW, apy: 0 }])
  assert.equal(withSeededApy(read, NOW, { ...SAVINGS_APY_SEED, enabled: false }), read)
})
