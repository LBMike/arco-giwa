import assert from "node:assert/strict"
import test from "node:test"

import { addBaseUnits, formatBaseUnits, formatHumanDecimal, isBaseUnits, isDecimalKeystroke, parseHumanDecimal, subtractBaseUnits } from "./decimal"
import { formatCash, formatQuantity } from "./display"

test("human quantity input follows the server grammar exactly and yields exact base units", () => {
  assert.deepEqual(parseHumanDecimal("0.5", 9), { ok: true, input: "0.5", baseUnits: "500000000" })
  assert.deepEqual(parseHumanDecimal("1.50", 9), { ok: true, input: "1.50", baseUnits: "1500000000" })
  assert.deepEqual(parseHumanDecimal("0.000000001", 9), { ok: true, input: "0.000000001", baseUnits: "1" })
  assert.equal(parseHumanDecimal("", 9).ok, false)
  for (const bad of [".5", "1.", "01", "+1", "-1", "1e3", " 1", "1 ", "1,000", "0x10", "NaN", "Infinity", "１"]) {
    const result = parseHumanDecimal(bad, 9)
    assert.equal(result.ok, false, bad)
    if (!result.ok) assert.equal(result.reason, "FORMAT", bad)
  }
  assert.deepEqual(parseHumanDecimal("0.0000000001", 9), { ok: false, input: "0.0000000001", reason: "PRECISION" })
  assert.deepEqual(parseHumanDecimal("0.000000000", 9), { ok: false, input: "0.000000000", reason: "ZERO" })
  assert.deepEqual(parseHumanDecimal("0", 9), { ok: false, input: "0", reason: "ZERO" })
})

test("large quantities stay exact up to the server bound of 10^30 base units, and above it are refused", () => {
  const max = parseHumanDecimal("1000000000000000000000", 9)
  assert.deepEqual(max, { ok: true, input: "1000000000000000000000", baseUnits: `1${"0".repeat(30)}` })
  assert.deepEqual(parseHumanDecimal("1000000000000000000000.000000001", 9).ok, false)
  assert.deepEqual(parseHumanDecimal("999999999999999999999.999999999", 9), { ok: true, input: "999999999999999999999.999999999", baseUnits: "9".repeat(30) })
  // A float would collapse these; strings do not.
  assert.equal(formatBaseUnits("9".repeat(30), 9), "999999999999999999999.999999999")
})

test("base units render exactly, trimmed and grouped, without rounding", () => {
  assert.equal(formatBaseUnits("0", 6), "0")
  assert.equal(formatBaseUnits("1", 6), "0.000001")
  assert.equal(formatBaseUnits("120000000", 6), "120")
  assert.equal(formatBaseUnits("120000001", 6), "120.000001")
  assert.equal(formatBaseUnits("123456789123456789000000", 6, { group: true }), "123,456,789,123,456,789")
  assert.equal(formatQuantity("1"), "0.000000001")
  assert.equal(formatQuantity("3500000000"), "3.5")
  assert.equal(formatCash("120000000000000000000000000000000000"), "120,000,000,000,000,000,000,000,000,000")
  assert.equal(formatHumanDecimal("120.000000"), "120")
  assert.equal(formatHumanDecimal("0.120000"), "0.12")
  assert.throws(() => formatBaseUnits("1.5", 6))
  assert.throws(() => formatBaseUnits("-1", 6))
})

test("base-unit validation and arithmetic use strings and BigInt only", () => {
  assert.equal(isBaseUnits("0"), true)
  assert.equal(isBaseUnits("0123"), false)
  assert.equal(isBaseUnits(120), false)
  assert.equal(isBaseUnits("1".repeat(38)), false)
  assert.equal(addBaseUnits("3000000000", "500000000"), "3500000000")
  assert.equal(subtractBaseUnits("3000000000", "1000000000"), "2000000000")
  assert.equal(subtractBaseUnits("1", "2"), null)
})

test("keystroke filter allows partial decimals but never more than 9 fraction digits", () => {
  for (const ok of ["", "0", "0.", "0.5", ".5", "123456789.123456789"]) assert.equal(isDecimalKeystroke(ok, 9), true, ok)
  for (const bad of ["1.2.3", "1e3", "-1", "0.1234567890", "1,0", "abc"]) assert.equal(isDecimalKeystroke(bad, 9), false, bad)
})
