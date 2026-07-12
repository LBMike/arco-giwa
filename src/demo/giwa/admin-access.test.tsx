import assert from "node:assert/strict"
import test from "node:test"
import { isAdminAddress, parseAdminAddresses } from "./admin-access"

// A real EIP-55 checksummed address and its lowercase form (same address, different case).
const CHECKSUM = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
const LOWER = CHECKSUM.toLowerCase()
const OTHER = "0x1111111111111111111111111111111111111111"

test("parseAdminAddresses splits a comma list, trims whitespace, normalizes case", () => {
  const allow = parseAdminAddresses(`  ${CHECKSUM} , ${OTHER}  `)
  assert.equal(allow.size, 2)
  assert.ok(allow.has(LOWER))
  assert.ok(allow.has(OTHER.toLowerCase()))
})

test("parseAdminAddresses dedupes the same address given in different case", () => {
  const allow = parseAdminAddresses(`${CHECKSUM}, ${LOWER}`)
  assert.equal(allow.size, 1)
  assert.ok(allow.has(LOWER))
})

test("parseAdminAddresses drops blank and invalid entries", () => {
  const allow = parseAdminAddresses(`${CHECKSUM},,not-an-address, 0x123 ,${OTHER}`)
  assert.equal(allow.size, 2)
  assert.ok(allow.has(LOWER))
  assert.ok(allow.has(OTHER.toLowerCase()))
})

test("parseAdminAddresses returns an empty set for empty/blank input", () => {
  assert.equal(parseAdminAddresses("").size, 0)
  assert.equal(parseAdminAddresses("   ,  , ").size, 0)
})

test("isAdminAddress matches regardless of input case", () => {
  const allow = parseAdminAddresses(CHECKSUM)
  assert.equal(isAdminAddress(LOWER, allow), true)
  assert.equal(isAdminAddress(CHECKSUM, allow), true)
  assert.equal(isAdminAddress(OTHER, allow), false)
})

test("isAdminAddress is fail-closed: null, malformed, and empty allowlist => false", () => {
  const allow = parseAdminAddresses(CHECKSUM)
  assert.equal(isAdminAddress(null, allow), false)
  assert.equal(isAdminAddress("not-an-address", allow), false)
  assert.equal(isAdminAddress(CHECKSUM, new Set()), false) // empty allowlist (fail-closed)
  assert.equal(isAdminAddress(null, new Set()), false)
})
