import assert from "node:assert/strict"
import test from "node:test"
import { buildDryRunGiwaRegistry } from "./generate.js"
import { validateGiwaRegistry } from "./validation.js"

test("dry-run GIWA registry validates without fabricated addresses", () => {
  const registry = buildDryRunGiwaRegistry(new Date("2026-06-25T00:00:00.000Z"))
  const result = validateGiwaRegistry(registry)

  assert.equal(result.ok, true)
  assert.equal(registry.activationFlags.deployed, false)
  assert.equal(registry.products.every((product) => product.depositVault.proxy === null), true)
  assert.deepEqual(
    result.eventMismatches.map((mismatch) => mismatch.eventName),
    ["ProductDepositRequested", "ProductDepositFulfilled"],
  )
})

test("GIWA registry rejects prague evmVersion on the GIWA path", () => {
  const registry = {
    ...buildDryRunGiwaRegistry(new Date("2026-06-25T00:00:00.000Z")),
    evmVersion: "prague",
  } as const
  const result = validateGiwaRegistry(registry)

  assert.equal(result.ok, false)
  assert.match(result.errors.join("\n"), /prague/)
})
