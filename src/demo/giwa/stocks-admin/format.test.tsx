import assert from "node:assert/strict"
import test from "node:test"
import {
  CASH_SCALE,
  QUANTITY_SCALE,
  formatBaseUnits,
  formatCount,
  formatDuration,
  formatElapsed,
  formatEpochSeconds,
  formatUtc,
  shortId,
  sumCounts,
} from "./format"
import { FIXTURE_LARGE_CASH, FIXTURE_LARGE_QUANTITY } from "./fixtures"

test("formatBaseUnits renders 36-digit server amounts exactly, with no float conversion or rounding", () => {
  assert.equal(formatBaseUnits(FIXTURE_LARGE_QUANTITY, QUANTITY_SCALE), "123,456,789,012,345,678,901,234,567.890123456")
  assert.equal(formatBaseUnits(FIXTURE_LARGE_CASH, CASH_SCALE), "987,654,321,098,765,432,109,876,543,210.987654")
  // Beyond Number.MAX_SAFE_INTEGER a float round-trip would print ...992.
  assert.equal(formatBaseUnits("9007199254740993", 0), "9,007,199,254,740,993")
  assert.equal(formatBaseUnits("1000000000000000000000000000000000001", 9), "1,000,000,000,000,000,000,000,000,000.000000001")
})

test("formatBaseUnits applies the scale, trims only trailing fractional zeros, and keeps signs", () => {
  assert.equal(formatBaseUnits("120000000", CASH_SCALE), "120")
  assert.equal(formatBaseUnits("1500000000", QUANTITY_SCALE), "1.5")
  assert.equal(formatBaseUnits("1", QUANTITY_SCALE), "0.000000001")
  assert.equal(formatBaseUnits("100", CASH_SCALE), "0.0001")
  assert.equal(formatBaseUnits("0", CASH_SCALE), "0")
  assert.equal(formatBaseUnits("-480000000", CASH_SCALE), "-480")
  assert.equal(formatBaseUnits("-0", CASH_SCALE), "0")
})

test("formatBaseUnits rejects anything that is not an integer base-unit string", () => {
  for (const bad of ["1.5", "01", "", " 1", "1e6", "0x10", "abc", "+1", "--1"]) {
    assert.equal(formatBaseUnits(bad, CASH_SCALE), null, JSON.stringify(bad))
  }
  assert.equal(formatBaseUnits(12 as unknown as string, CASH_SCALE), null)
  assert.equal(formatBaseUnits("1", -1), null)
  assert.equal(formatBaseUnits("1", 1.5), null)
})

test("counts are grouped and summed exactly as integers", () => {
  assert.equal(formatCount("1234567"), "1,234,567")
  assert.equal(sumCounts(["9007199254740993", "1"]), "9007199254740994")
  assert.equal(sumCounts([]), "0")
})

test("times are absolute UTC; elapsed and durations are compact; invalid input is not hidden", () => {
  assert.equal(formatUtc("2026-09-17T03:04:05.678Z"), "2026-09-17 03:04:05 UTC")
  assert.equal(formatUtc("not-a-time"), "not-a-time")
  assert.equal(formatEpochSeconds("1789613990"), "2026-09-17 02:59:50 UTC")
  assert.equal(formatEpochSeconds("12.5"), null)
  assert.equal(formatEpochSeconds(null), null)
  assert.equal(formatDuration(45_900), "45s")
  assert.equal(formatDuration(192_000), "3m 12s")
  assert.equal(formatDuration(7_500_000), "2h 5m")
  assert.equal(formatDuration(356_400_000), "4d 3h")
  assert.equal(formatDuration(-1), null)
  const now = Date.parse("2026-09-17T03:00:30.000Z")
  assert.equal(formatElapsed("2026-09-17T02:57:18.000Z", now), "3m 12s ago")
  assert.equal(formatElapsed("2026-09-17T03:01:00.000Z", now), "in the future (clock skew)")
  assert.equal(formatElapsed("bad", now), "unknown")
})

test("shortId keeps short values and abbreviates long identifiers", () => {
  assert.equal(shortId("abc"), "abc")
  assert.equal(shortId(`0x${"ab".repeat(32)}`), "0xabab…abab")
})
