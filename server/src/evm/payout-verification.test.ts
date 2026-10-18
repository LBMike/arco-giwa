import assert from "node:assert/strict"
import test from "node:test"
import { keccak256, pad, toBytes, toHex } from "viem"
import { createPayoutVerifier, matchPayoutReceipt, type PayoutReceipt } from "./payout-verification.js"

const TOKEN = "0x869d9c8D9bf0A961fc2Fd3bbA300FdbEee3C2633"
const OTHER_TOKEN = "0x2330e111FB116bF8041F694145E961eD9B66243e"
const OPERATOR = "0x00000000000000000000000000000000000000a1"
const STRANGER = "0x00000000000000000000000000000000000000f9"
const RECIPIENT = "0x00000000000000000000000000000000000000c2"
const TRANSFER = keccak256(toBytes("Transfer(address,address,uint256)"))
const topic = (address: string) => pad(address as `0x${string}`, { size: 32 })
const transfer = (token: string, to: string, amount: bigint, from = OPERATOR) => ({
  address: token,
  topics: [TRANSFER, topic(from), topic(to)],
  data: toHex(amount, { size: 32 }),
})
const expected = {
  txHash: `0x${"ab".repeat(32)}` as const,
  token: TOKEN as `0x${string}`,
  recipient: RECIPIENT as `0x${string}`,
  amount: 1020000n,
  allowedSenders: [OPERATOR.toUpperCase().replace("0X", "0x")],
  afterBlock: 100n,
}
const receipt = (logs: PayoutReceipt["logs"], extra: Partial<PayoutReceipt> = {}): PayoutReceipt => ({
  status: "success",
  from: OPERATOR,
  blockNumber: 120n,
  logs,
  ...extra,
})

test("matches an operator-signed payment-token transfer of the exact amount to the recipient", () => {
  assert.deepEqual(matchPayoutReceipt(receipt([transfer(TOKEN, RECIPIENT, 1020000n)]), expected), { ok: true })
  // afterBlock unknown → only the sender/transfer checks apply
  assert.deepEqual(
    matchPayoutReceipt(receipt([transfer(TOKEN, RECIPIENT, 1020000n)], { blockNumber: 1n }), { ...expected, afterBlock: null }),
    { ok: true },
  )
})

test("rejects reverted receipts, other tokens, other recipients and other amounts", () => {
  assert.equal(matchPayoutReceipt(receipt([transfer(TOKEN, RECIPIENT, 1020000n)], { status: "reverted" }), expected).ok, false)
  assert.equal(matchPayoutReceipt(receipt([transfer(OTHER_TOKEN, RECIPIENT, 1020000n)]), expected).ok, false)
  assert.equal(matchPayoutReceipt(receipt([transfer(TOKEN, OPERATOR, 1020000n)]), expected).ok, false)
  assert.equal(matchPayoutReceipt(receipt([transfer(TOKEN, RECIPIENT, 1000000n)]), expected).ok, false)
  assert.equal(matchPayoutReceipt(receipt([]), expected).ok, false)
})

test("rejects transfers that are not a payout by an operator after the request", () => {
  // Signed by someone outside the operator directory (e.g. the recipient's own self-transfer).
  assert.equal(matchPayoutReceipt(receipt([transfer(TOKEN, RECIPIENT, 1020000n, STRANGER)], { from: STRANGER }), expected).ok, false)
  // Operator-signed tx, but the matching Transfer moved someone else's tokens (e.g. a vault claim).
  assert.equal(matchPayoutReceipt(receipt([transfer(TOKEN, RECIPIENT, 1020000n, STRANGER)]), expected).ok, false)
  // Mined at or before the requestRedeem block: an older transfer cannot settle a newer request.
  assert.equal(matchPayoutReceipt(receipt([transfer(TOKEN, RECIPIENT, 1020000n)], { blockNumber: 100n }), expected).ok, false)
  // No operator directory: nothing settles.
  assert.equal(matchPayoutReceipt(receipt([transfer(TOKEN, RECIPIENT, 1020000n)]), { ...expected, allowedSenders: [] }).ok, false)
})

test("a missing receipt is retried, then a rejection, never a throw", async () => {
  let calls = 0
  const verify = createPayoutVerifier(
    async () => {
      calls += 1
      throw new Error("TransactionReceiptNotFoundError")
    },
    { attempts: 3, sleep: async () => undefined },
  )
  const result = await verify(expected)
  assert.equal(result.ok, false)
  assert.equal(calls, 3)
})

test("RPC read-after-write lag: a receipt that appears on a later attempt settles", async () => {
  let calls = 0
  const verify = createPayoutVerifier(
    async () => {
      calls += 1
      if (calls < 3) throw new Error("TransactionReceiptNotFoundError")
      return receipt([transfer(TOKEN, RECIPIENT, 1020000n)])
    },
    { attempts: 5, sleep: async () => undefined },
  )
  assert.deepEqual(await verify(expected), { ok: true })
  assert.equal(calls, 3)
})

test("requireDirectTransfer: only a transaction that called the payment token itself counts", () => {
  const direct = { ...expected, requireDirectTransfer: true }
  const log = [transfer(TOKEN, RECIPIENT, 1020000n)]
  assert.deepEqual(matchPayoutReceipt(receipt(log, { to: TOKEN.toLowerCase() }), direct), { ok: true })
  // Same Transfer log, but emitted inside a call to another contract (e.g. the operator's own
  // Reserve.deposit pulling the same amount): not a payout.
  const viaContract = matchPayoutReceipt(receipt(log, { to: RECIPIENT }), direct)
  assert.equal(viaContract.ok, false)
  assert.match(viaContract.ok ? "" : viaContract.reason, /direct payment-token transfer/)
  assert.equal(matchPayoutReceipt(receipt(log, { to: null }), direct).ok, false)
  assert.equal(matchPayoutReceipt(receipt(log), direct).ok, false) // `to` unknown
  // Without the flag (customer payouts) the call target is not checked, as before.
  assert.deepEqual(matchPayoutReceipt(receipt(log, { to: RECIPIENT }), expected), { ok: true })
})
