import assert from "node:assert/strict"
import test from "node:test"

import {
  INVALID_ADMIN_WITHDRAW_ALLOWLIST,
  allowedWithdrawRecipients,
  parseAdminWithdrawAllowlist,
} from "./withdraw-allowlist.js"

const A = "0x00000000000000000000000000000000000000Aa"
const B = "0x00000000000000000000000000000000000000bB"

test("ADMIN_WITHDRAW_ALLOWLIST: unset or blank has no env entries", () => {
  assert.deepEqual(parseAdminWithdrawAllowlist(undefined), [])
  assert.deepEqual(parseAdminWithdrawAllowlist(""), [])
  assert.deepEqual(parseAdminWithdrawAllowlist("  "), [])
})

test("ADMIN_WITHDRAW_ALLOWLIST: comma list is trimmed, lowercased and de-duplicated", () => {
  assert.deepEqual(parseAdminWithdrawAllowlist(` ${A}, ${B} ,${A.toLowerCase()},`), [A.toLowerCase(), B.toLowerCase()])
})

test("ADMIN_WITHDRAW_ALLOWLIST: a bad or zero address fails without echoing the value", () => {
  for (const raw of ["not-an-address", `${A},0x123`, "0x0000000000000000000000000000000000000000"]) {
    assert.throws(() => parseAdminWithdrawAllowlist(raw), { message: INVALID_ADMIN_WITHDRAW_ALLOWLIST })
  }
})

test("allowed recipients combine the env list with the product's adminDepositAddress", () => {
  assert.deepEqual([...allowedWithdrawRecipients([], null)], [])
  assert.deepEqual([...allowedWithdrawRecipients(undefined, B)], [B.toLowerCase()])
  assert.deepEqual(
    [...allowedWithdrawRecipients([A.toLowerCase()], B)].sort(),
    [A.toLowerCase(), B.toLowerCase()].sort(),
  )
  // a malformed stored config value is ignored, not trusted
  assert.deepEqual([...allowedWithdrawRecipients([], "garbage")], [])
})
