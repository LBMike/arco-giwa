import assert from "node:assert/strict"
import test from "node:test"

import { formatUsd } from "./display"
import { BURN_FEE_BPS, buyCost, buyQuantity, formatFee, MINT_FEE_BPS, perShareCash, priceUnits, sellPayout } from "./pricing"

test("panel previews use the server's quote formulas at the price on screen", () => {
  assert.equal(MINT_FEE_BPS, 0n)
  assert.equal(BURN_FEE_BPS, 0n)
  assert.equal(priceUnits("223.71"), 223_710_000n)
  assert.equal(priceUnits("120.000000"), 120_000_000n)
  assert.equal(priceUnits("223.7100005"), 223_710_001n)
  for (const value of [null, undefined, "", "0", "abc", "-1", "1e3", "0.0000004"]) assert.equal(priceUnits(value), null, String(value))
  // 60 tUSDC at the chart's 223.71: every base unit it buys costs no more than 60.
  const quantity = buyQuantity(60_000_000n, 223_710_000n)
  assert.equal(quantity, 268_204_371n)
  assert.ok(buyCost(quantity, 223_710_000n) <= 60_000_000n)
  assert.ok(buyCost(quantity + 1n, 223_710_000n) > 60_000_000n)
  assert.equal(sellPayout(500_000_000n, 120_000_000n), 60_000_000n)
  assert.equal(buyQuantity(60_000_000n, 120_000_000n, 10n), 499_500_000n)
  assert.equal(sellPayout(500_000_000n, 120_000_000n, 10n), 59_940_000n)
})

test("fees read as percentages", () => {
  assert.equal(formatFee(0n), "0%")
  assert.equal(formatFee(10n), "0.1%")
  assert.equal(formatFee(25n), "0.25%")
  assert.equal(formatFee(100n), "1%")
  assert.equal(formatFee(150n), "1.5%")
})

test("the quote row: one NVDA at the price on screen, and its dollar price as the header shows it", () => {
  assert.equal(perShareCash("BUY", 225_050_000n), 225_050_000n)
  assert.equal(perShareCash("SELL", 225_050_000n), 225_050_000n)
  assert.equal(perShareCash("BUY", 120_000_000n), buyCost(1_000_000_000n, 120_000_000n))
  assert.equal(formatUsd("225050000"), "$225.05")
  assert.equal(formatUsd("120000000"), "$120")
  assert.equal(formatUsd("225055000"), "$225.06")
  assert.equal(formatUsd("225104999"), "$225.1")
  assert.equal(formatUsd("1234500000"), "$1,234.5")
})
