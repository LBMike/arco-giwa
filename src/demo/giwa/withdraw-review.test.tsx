import assert from "node:assert/strict"
import test from "node:test"
import { prepareWithdrawReview } from "./withdraw-review"

const ADMIN = "0x00000000000000000000000000000000000000dd"
const OTHER = "0x00000000000000000000000000000000000000ee"

test("withdraw review: an empty amount never means the full balance", () => {
  const result = prepareWithdrawReview({ amount: " ", to: OTHER, configuredAdminAddress: ADMIN, decimals: 6 })
  assert.deepEqual(result, { ok: false, error: "Enter the amount to withdraw" })
})

test("withdraw review: zero, negative, malformed and over-precise amounts are refused", () => {
  for (const amount of ["0", "0.000", "-1", "1e3", "abc", "1.2345678"]) {
    const result = prepareWithdrawReview({ amount, to: OTHER, configuredAdminAddress: null, decimals: 6 })
    assert.equal(result.ok, false, amount)
  }
})

test("withdraw review: explicit recipient wins, then the configured admin deposit address", () => {
  const explicit = prepareWithdrawReview({ amount: "12.5", to: OTHER, configuredAdminAddress: ADMIN, decimals: 6 })
  assert.ok(explicit.ok)
  assert.equal(explicit.review.to, OTHER)
  assert.equal(explicit.review.amountBase, 12_500_000n)
  assert.equal(explicit.review.amountHuman, "12.5")

  const configured = prepareWithdrawReview({ amount: "1", to: "", configuredAdminAddress: ADMIN, decimals: 18 })
  assert.ok(configured.ok)
  assert.equal(configured.review.to, ADMIN)
  assert.equal(configured.review.amountBase, 10n ** 18n)
})

test("withdraw review: no recipient at all, or a bad one, is refused (no wallet fallback)", () => {
  assert.deepEqual(prepareWithdrawReview({ amount: "1", to: "", configuredAdminAddress: null, decimals: 6 }), {
    ok: false,
    error: "Enter a recipient on the withdrawal allowlist",
  })
  assert.equal(prepareWithdrawReview({ amount: "1", to: "0x123", configuredAdminAddress: null, decimals: 6 }).ok, false)
})
