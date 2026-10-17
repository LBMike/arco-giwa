import assert from "node:assert/strict"
import test from "node:test"

import { FUNCTION_PAUSE_SELECTORS } from "./admin-transactions.js"
import { planFunctionPause, planVaultPause, summarizePauseDetail } from "./pause-state.js"

const DEPOSIT = FUNCTION_PAUSE_SELECTORS.deposit.selectors.map((entry) => entry.selector)

test("summary: whole-vault pause counts as paused but is reported on its own", () => {
  assert.deepEqual(
    summarizePauseDetail({
      deposit: { vaultPaused: true, fnPaused: [false, false] },
      withdraw: { vaultPaused: false, fnPaused: [true, true] },
    }),
    {
      depositPaused: true,
      withdrawPaused: true,
      depositPartial: false,
      withdrawPartial: false,
      depositVaultPaused: true,
      withdrawVaultPaused: false,
    },
  )
  // A missing vault address reads as running, never as paused.
  assert.equal(summarizePauseDetail({ deposit: null, withdraw: null }).depositPaused, false)
})

test("function plan: no live state sends both selectors (legacy behavior)", () => {
  assert.deepEqual(planFunctionPause(null, "deposit", true), { ok: true, value: DEPOSIT })
  assert.deepEqual(planFunctionPause(null, "deposit", false), { ok: true, value: DEPOSIT })
})

test("function plan: skips selectors already in the requested state; refuses no-ops", () => {
  assert.deepEqual(planFunctionPause({ vaultPaused: false, fnPaused: [true, false] }, "deposit", true), {
    ok: true,
    value: [DEPOSIT[1]],
  })
  const noop = planFunctionPause({ vaultPaused: false, fnPaused: [false, false] }, "deposit", false)
  assert.equal(noop.ok, false)
  assert.equal(!noop.ok && noop.code, "NO_CHANGE")
})

test("function plan: pausing under a whole-vault pause is allowed, unpausing is refused", () => {
  assert.deepEqual(planFunctionPause({ vaultPaused: true, fnPaused: [false, false] }, "deposit", true), {
    ok: true,
    value: DEPOSIT,
  })
  const refused = planFunctionPause({ vaultPaused: true, fnPaused: [true, true] }, "deposit", false)
  assert.equal(!refused.ok && refused.code, "VAULT_PAUSED")
})

test("vault plan: only vaults that would change are touched", () => {
  const detail = {
    deposit: { vaultPaused: true, fnPaused: [false, false] },
    withdraw: { vaultPaused: false, fnPaused: [false, false] },
  }
  assert.deepEqual(planVaultPause(detail, "pause", "allVaults"), { ok: true, value: ["redemptionVault"] })
  assert.deepEqual(planVaultPause(detail, "unpause", "allVaults"), { ok: true, value: ["depositVault"] })
  assert.equal(planVaultPause(detail, "unpause", "redemptionVault").ok, false)
  assert.deepEqual(planVaultPause(null, "pause", "allVaults"), { ok: true, value: ["depositVault", "redemptionVault"] })
})
