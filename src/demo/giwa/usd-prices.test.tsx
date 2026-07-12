import assert from "node:assert/strict"
import test from "node:test"
import { positionUsdValue } from "./usd-prices"

test("positionUsdValue = human shares × navUsd", () => {
  assert.equal(positionUsdValue({ shares: 2, navUsd: 1 }), 2)
  assert.equal(positionUsdValue({ shares: 1.5, navUsd: 60000 }), 90000)
  assert.equal(positionUsdValue({ shares: 0, navUsd: 1.23 }), 0)
  const v = positionUsdValue({ shares: 100, navUsd: 1.002 })
  assert.ok(Math.abs(v - 100.2) < 1e-9, `got ${v}`)
})
