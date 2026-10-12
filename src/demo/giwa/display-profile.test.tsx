import assert from "node:assert/strict"
import test from "node:test"
import {
  bpsToPercentInput,
  formatPercentFromBps,
  parseAumToNumber,
  percentInputToBps,
  parseDecimalInput,
  resolveDonutTotal,
  resolveSliceValue,
  sliceToBreakdownRow,
  validatePortfolioSlices,
} from "./display-profile"

test("formatPercentFromBps applies the max-2-decimals no-trailing-zeros rule", () => {
  assert.equal(formatPercentFromBps(20), "0.2%")
  assert.equal(formatPercentFromBps(25), "0.25%")
  assert.equal(formatPercentFromBps(125), "1.25%")
  assert.equal(formatPercentFromBps(0), "0%")
  assert.equal(formatPercentFromBps(10000), "100%")
})

test("percentInputToBps parses, blanks to null, and rejects out-of-range", () => {
  assert.equal(percentInputToBps(""), null)
  assert.equal(percentInputToBps("0.25"), 25)
  assert.equal(percentInputToBps("1.25"), 125)
  assert.equal(percentInputToBps("100"), 10000)
  assert.equal(percentInputToBps("0"), 0)
  assert.equal(percentInputToBps("-1"), "invalid")
  assert.equal(percentInputToBps("100.5"), "invalid")
  assert.equal(percentInputToBps("abc"), "invalid")
  // Decimal-only: reject Number()-parseable but non-decimal forms (would coerce to a fee).
  assert.equal(percentInputToBps("0x10"), "invalid")
  assert.equal(percentInputToBps("1e2"), "invalid")
  assert.equal(percentInputToBps("0b101"), "invalid")
  assert.equal(percentInputToBps("0o17"), "invalid")
  // Leading-dot decimals stay valid (".5" == 0.5%).
  assert.equal(percentInputToBps(".5"), 50)
})

test("bpsToPercentInput round-trips a stored value into an editable percent", () => {
  assert.equal(bpsToPercentInput(null), "")
  assert.equal(bpsToPercentInput(25), "0.25")
  assert.equal(bpsToPercentInput(20), "0.2")
  assert.equal(bpsToPercentInput(0), "0")
})

test("validatePortfolioSlices: valid sum, normalization, and error cases", () => {
  const ok = validatePortfolioSlices([
    { label: "A", percent: 60, valueUsd: 6_000_000 },
    { label: "B", percent: 40 },
  ])
  assert.equal(ok.ok, true)
  assert.equal(ok.slices![1].valueUsd, null) // missing valueUsd normalized to null

  // Empty array is valid (caller clears to null); no sum check.
  assert.equal(validatePortfolioSlices([]).ok, true)

  // Sum not ~100 → error.
  const badSum = validatePortfolioSlices([{ label: "A", percent: 60 }, { label: "B", percent: 30 }])
  assert.equal(badSum.ok, false)
  assert.match(String(badSum.error), /sum to ~100/)

  // Bad slice shapes.
  assert.equal(validatePortfolioSlices("nope").ok, false)
  assert.equal(validatePortfolioSlices([{ label: "", percent: 100 }]).ok, false) // empty label
  assert.equal(validatePortfolioSlices([{ label: "A", percent: 150 }]).ok, false) // out of range
  assert.equal(validatePortfolioSlices([{ label: "A", percent: 100, valueUsd: -5 }]).ok, false) // negative value

  // Row mapping to BreakdownRow: explicit value kept; unset → null (was the "$0" bug).
  assert.deepEqual(sliceToBreakdownRow({ label: "X", percent: 25, valueUsd: 100 }), { label: "X", value: 100, pct: 25 })
  assert.deepEqual(sliceToBreakdownRow({ label: "Y", percent: 25, valueUsd: null }), { label: "Y", value: null, pct: 25 })
})

test("parseAumToNumber parses $/commas/suffixes/trailing text; junk → null", () => {
  assert.equal(parseAumToNumber("$903M"), 903_000_000)
  assert.equal(parseAumToNumber("$1.2B"), 1.2e9)
  assert.equal(parseAumToNumber("$1.2B+"), 1.2e9) // trailing "+" ignored
  assert.equal(parseAumToNumber("50B"), 50e9)
  assert.equal(parseAumToNumber("$28.53M"), 28_530_000)
  assert.equal(parseAumToNumber("$1,250,000"), 1_250_000) // commas, no suffix
  assert.equal(parseAumToNumber("12.5"), 12.5)
  assert.equal(parseAumToNumber("$1.5T"), 1.5e12)
  assert.equal(parseAumToNumber(""), null)
  assert.equal(parseAumToNumber(null), null)
  assert.equal(parseAumToNumber("N/A"), null)
  assert.equal(parseAumToNumber("about $50m"), null) // no leading number
})

test("resolveSliceValue = valueUsd ?? pct×AUM ?? null", () => {
  assert.equal(resolveSliceValue({ value: 100, pct: 25 }, 400), 100) // explicit wins
  assert.equal(resolveSliceValue({ value: null, pct: 25 }, 400), 100) // 25% × 400
  assert.equal(resolveSliceValue({ value: null, pct: 45.8 }, 903_000_000), (45.8 / 100) * 903_000_000)
  assert.equal(resolveSliceValue({ value: null, pct: 25 }, null), null) // no AUM → "—"
})

test("resolveDonutTotal = explicit ?? sum-of-explicit ?? AUM ?? null (legacy total preserved)", () => {
  const explicitRows = [{ value: 100 }, { value: 200 }]
  assert.equal(resolveDonutTotal(29_620_000, explicitRows, null), 29_620_000) // legacy explicit total wins
  assert.equal(resolveDonutTotal(null, explicitRows, 999), 300) // sum of explicit
  assert.equal(resolveDonutTotal(null, [{ value: null }, { value: null }], 903_000_000), 903_000_000) // → AUM
  assert.equal(resolveDonutTotal(null, [{ value: null }], null), null) // → "—"
})

test("parseDecimalInput: blank→null, decimals ok, exotic strings rejected", () => {
  assert.equal(parseDecimalInput(""), null)
  assert.equal(parseDecimalInput("0.5"), 0.5)
  assert.equal(parseDecimalInput(".5"), 0.5)
  assert.equal(parseDecimalInput("100"), 100)
  assert.equal(parseDecimalInput("1e5"), "invalid")
  assert.equal(parseDecimalInput("0x64"), "invalid")
  assert.equal(parseDecimalInput("abc"), "invalid")
})
