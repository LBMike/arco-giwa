import assert from "node:assert/strict"
import test from "node:test"
import { UNLIMITED_HUMAN, allowanceBelowCap, isPositiveHuman, resolveLimit, usdHint } from "./limits-helpers"

test("resolveLimit: a blank/whitespace input keeps the CURRENT value (never 0)", () => {
  assert.equal(resolveLimit("", "50000000"), "50000000") // untouched → current
  assert.equal(resolveLimit("   ", "50000000"), "50000000")
  assert.equal(resolveLimit("100", "50000000"), "100") // edited → new value
  assert.equal(resolveLimit("0", "50000000"), "0") // an explicit 0 IS honoured (minimums may be 0)
})

test("isPositiveHuman gates the three caps: >0 only (bricking guard)", () => {
  assert.equal(isPositiveHuman("50000000"), true)
  assert.equal(isPositiveHuman("0.0001"), true)
  assert.equal(isPositiveHuman("0"), false) // 0 cap would brick the vault
  assert.equal(isPositiveHuman(""), false)
  assert.equal(isPositiveHuman("abc"), false)
})

test("blank→current then never-0: an untouched cap resolves to its current value and passes the >0 gate", () => {
  const currentCap = "50000000"
  const resolved = resolveLimit("", currentCap) // operator didn't touch the cap
  assert.equal(resolved, currentCap)
  assert.equal(isPositiveHuman(resolved), true) // → button stays enabled, resubmits current (not 0)
  // But if the operator explicitly types 0 into a cap, the gate blocks it.
  assert.equal(isPositiveHuman(resolveLimit("0", currentCap)), false)
})

test("usdHint uses navUsd for SHARE fields and baseUsd for PAYMENT fields (per-field multiplier)", () => {
  const navUsd = 1.02 // USD per share
  const baseUsd = 1 // USD per payment token
  // Share field × navUsd.
  assert.equal(usdHint("1000000", navUsd), `~$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(1_020_000)}`)
  // Payment field × baseUsd.
  assert.equal(usdHint("250000", baseUsd), `~$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(250_000)}`)
})

test("usdHint returns null when the multiplier is null or the amount is non-positive (never ~$NaN)", () => {
  assert.equal(usdHint("1000000", null), null) // no price → no hint
  assert.equal(usdHint("1000000", undefined), null)
  assert.equal(usdHint("0", 1.02), null)
  assert.equal(usdHint("", 1.02), null)
  assert.equal(usdHint("abc", 1.02), null)
})

test("allowanceBelowCap is a NON-blocking signal, not a constraint", () => {
  assert.equal(allowanceBelowCap("1000000", "50000000"), true) // allowance < cap (the deployed default)
  assert.equal(allowanceBelowCap("50000000", "50000000"), false) // equal
  assert.equal(allowanceBelowCap("60000000", "50000000"), false) // above
  // It only informs; the caps still pass the >0 gate, so a below-cap allowance is submittable.
  assert.equal(isPositiveHuman("1000000") && isPositiveHuman("50000000"), true)
})

test("UNLIMITED_HUMAN is a large-but-safe fill (positive, far below uint256 after 18-dec scaling)", () => {
  assert.equal(isPositiveHuman(UNLIMITED_HUMAN), true)
  // 1e15 human × 1e18 = 1e33 ≪ 2^256 (~1.15e77).
  assert.ok(BigInt(UNLIMITED_HUMAN) * 10n ** 18n < 2n ** 256n)
})
