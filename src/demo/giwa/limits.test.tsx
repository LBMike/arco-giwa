import assert from "node:assert/strict"
import test from "node:test"
import {
  UNLIMITED_HUMAN,
  allowanceBelowCap,
  attentionLabel,
  depositLimitNote,
  isPositiveHuman,
  limitAttention,
  limitBadges,
  redemptionLimitNote,
  resolveLimit,
  usageLine,
  usdHint,
  type LimitUsageSide,
  type VaultLimitUsage,
} from "./limits-helpers"

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

const side = (used: string, limit: string, remaining: string, usedPct: number, level: LimitUsageSide["level"]): LimitUsageSide => ({ used, limit, remaining, usedPct, level })
const roomy = side("10", "1000", "990", 1, "ok")
const usageOf = (deposit: Partial<VaultLimitUsage["deposit"]>, redemption: LimitUsageSide = roomy): VaultLimitUsage => ({
  deposit: { mintAllowance: roomy, supplyCap: roomy, remainingShares: "990", binding: "mintAllowance", level: "ok", ...deposit },
  redemption,
})

test("usageLine: used/left with max 2 decimals; exhausted and unlimited read plainly", () => {
  assert.equal(usageLine(side("499996.548245", "500000", "3.451755", 99.99, "near"), "Minted"), "Minted 499,996.55 of 500,000 · 3.45 left (99.99% used)")
  assert.equal(usageLine(side("500000", "500000", "0", 100, "exhausted"), "Minted"), "Minted 500,000 of 500,000 · none left")
  assert.equal(usageLine(side("503989.48", UNLIMITED_HUMAN, "999999999496010.52", 0, "ok"), "Minted"), "Minted 503,989.48 · unlimited")
})

test("limitBadges: nothing when there is room or usage is unknown; one badge per side that needs attention", () => {
  assert.deepEqual(limitBadges(null), [])
  assert.deepEqual(limitBadges(usageOf({})), [])
  assert.deepEqual(limitBadges(usageOf({ level: "near", remainingShares: "3.451755" }, side("250000", "250000", "0", 100, "exhausted"))), [
    "Deposit limit · 3.45 shares left",
    "Withdrawals blocked · limit reached",
  ])
  assert.deepEqual(limitBadges(usageOf({ level: "exhausted" })), ["Deposits blocked · limit reached"])
})

test("limit notes name the contract check an operator will see in the revert", () => {
  assert.equal(depositLimitNote(usageOf({})), null)
  assert.match(depositLimitNote(usageOf({ level: "near", remainingShares: "3.451755" }))!, /more than 3\.45 shares .*ADV: vault allowance/)
  assert.match(depositLimitNote(usageOf({ level: "exhausted", binding: "supplyCap" }))!, /Deposits revert now.*ADV: max supply/)
  assert.equal(redemptionLimitNote(usageOf({}), "tXRP"), null)
  assert.match(redemptionLimitNote(usageOf({}, side("90", "100", "10", 90, "near")), "tXRP")!, /more than 10 tXRP .*ARV: vault allowance/)
})

test("limitAttention + attentionLabel: summary tile counts; unreadable vaults are not counted as clear", () => {
  const count = limitAttention([
    { usage: usageOf({ level: "exhausted" }) },
    { usage: usageOf({ level: "near" }, side("90", "100", "10", 90, "near")) },
    { usage: usageOf({}) },
    { usage: null },
  ])
  assert.deepEqual(count, { depositBlocked: 1, depositNear: 1, withdrawBlocked: 0, withdrawNear: 1, unread: 1 })
  assert.equal(attentionLabel(1, 1), "1 blocked · 1 near limit")
  assert.equal(attentionLabel(0, 2), "2 near limit")
  assert.equal(attentionLabel(0, 0), "All clear")
})
