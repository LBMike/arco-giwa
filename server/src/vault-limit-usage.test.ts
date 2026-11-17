import assert from "node:assert/strict"
import test from "node:test"
import { computeVaultLimitUsage } from "./vault-limit-usage.js"

const e18 = (n: string) => `${n}${"0".repeat(18)}`
const e6 = (n: string) => `${n}${"0".repeat(6)}`

test("a vault whose lifetime mints reached the allowance is exhausted even with supply far below the cap", () => {
  // The aXRP incident: 499,996.548245 of 500,000 minted, supply cap 1,000,000.
  const usage = computeVaultLimitUsage(
    {
      vaultMintAllowance: e18("500000"),
      maxSupplyCap: e18("1000000"),
      vaultRedeemAllowance: e6("500000"),
      mintedByVault: "499996548245000000000000",
      redeemedByVault: e6("100"),
      shareSupply: e18("400000"),
    },
    6,
  )
  assert.equal(usage.deposit.mintAllowance.remaining, "3.451755")
  assert.equal(usage.deposit.mintAllowance.level, "near")
  assert.equal(usage.deposit.mintAllowance.usedPct, 99.99)
  assert.equal(usage.deposit.supplyCap?.level, "ok")
  assert.equal(usage.deposit.binding, "mintAllowance")
  assert.equal(usage.deposit.remainingShares, "3.451755")
  assert.equal(usage.deposit.level, "near")
  assert.equal(usage.redemption.level, "ok")
  assert.equal(usage.redemption.remaining, "499900")
})

test("used >= limit is exhausted with nothing remaining; the supply cap binds when it is the smaller remainder", () => {
  const usage = computeVaultLimitUsage(
    {
      vaultMintAllowance: e18("1000"),
      maxSupplyCap: e18("500"),
      vaultRedeemAllowance: e6("50"),
      mintedByVault: e18("100"),
      redeemedByVault: e6("60"),
      shareSupply: e18("450"),
    },
    6,
  )
  assert.equal(usage.deposit.binding, "supplyCap")
  assert.equal(usage.deposit.remainingShares, "50")
  assert.equal(usage.deposit.supplyCap?.level, "near")
  assert.equal(usage.deposit.level, "near")
  assert.equal(usage.redemption.level, "exhausted")
  assert.equal(usage.redemption.remaining, "0")
  assert.equal(usage.redemption.usedPct, 100)
})

test("an unreadable supply leaves the cap side null and the allowance decides; a zero limit is exhausted", () => {
  const usage = computeVaultLimitUsage(
    {
      vaultMintAllowance: "0",
      maxSupplyCap: e18("500"),
      vaultRedeemAllowance: e6("1000"),
      mintedByVault: "0",
      redeemedByVault: "0",
      shareSupply: null,
    },
    6,
  )
  assert.equal(usage.deposit.supplyCap, null)
  assert.equal(usage.deposit.binding, "mintAllowance")
  assert.equal(usage.deposit.level, "exhausted")
  assert.equal(usage.redemption.usedPct, 0)
  assert.equal(usage.redemption.level, "ok")
})
