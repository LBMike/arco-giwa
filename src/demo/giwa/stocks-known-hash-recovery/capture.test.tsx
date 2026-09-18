import assert from "node:assert/strict"
import test from "node:test"

import type { AttemptRecord, SubmissionGate } from "../stocks-wallet/types"
import { captureKnownHashes, type KnownHashCaptureScope } from "./capture"
import { createKnownHashStore, type KnownHashScope } from "./store"

const WALLET = "0x000000000000000000000000000000000000A11C"
const SCOPE: KnownHashCaptureScope = { side: "SELL", orderId: "order-7", deploymentDigest: "d".repeat(64), wallet: WALLET, chainId: 91342, apiBase: "https://api.example.test", origin: "https://app.example.test" }
const OWNER: KnownHashScope = { wallet: WALLET, chainId: 91342, apiBase: SCOPE.apiBase, origin: SCOPE.origin }
const HASH = `0x${"7".repeat(64)}` as const
const CLAIM: AttemptRecord = Object.freeze({ claimId: "claim-7", intentKey: "a".repeat(64), stage: "TRANSFER", transactionDigest: "b".repeat(64), status: "REQUEST_MAY_START" })
const claimRequest = (overrides: Record<string, unknown> = {}) => ({ intentKey: CLAIM.intentKey, stage: CLAIM.stage, transactionDigest: CLAIM.transactionDigest, transaction: {} as never, orderId: SCOPE.orderId, deploymentDigest: SCOPE.deploymentDigest, ...overrides })

type Script = { claim?: AttemptRecord | null | Error; record?: "resolve" | Error }

function fakeGate(script: Script) {
  const calls: { method: string; input: unknown }[] = []
  let recordPromise: Promise<void> | null = null
  const gate: SubmissionGate = {
    inspect(intentKey) {
      calls.push({ method: "inspect", input: intentKey })
      return Promise.resolve({ approval: null, transfer: null })
    },
    claim(input) {
      calls.push({ method: "claim", input })
      const result = script.claim === undefined ? CLAIM : script.claim
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
    },
    record(input) {
      calls.push({ method: "record", input })
      recordPromise = script.record instanceof Error ? Promise.reject(script.record) : Promise.resolve()
      return recordPromise
    },
    reconcile(input) {
      calls.push({ method: "reconcile", input })
      return Promise.resolve({ ...CLAIM, status: "SUBMITTED", txHash: HASH })
    },
  }
  return { gate, calls, lastRecord: () => recordPromise }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test("a hash the original record could not store is kept with the original binding and the owner's fixed scope; the original failure is returned unchanged", async () => {
  const refusal = new Error("SUBMISSION_AUTH_REQUIRED")
  const { gate, calls, lastRecord } = fakeGate({ record: refusal })
  const store = createKnownHashStore()
  const wrapped = captureKnownHashes(gate, SCOPE, store)
  assert.deepEqual(await wrapped.claim(claimRequest()), CLAIM)
  const input = Object.freeze({ ...CLAIM, status: "SUBMITTED" as const, txHash: HASH })
  const returned = wrapped.record(input)
  assert.equal(returned, lastRecord(), "the original gate's own promise")
  await assert.rejects(returned, (error) => error === refusal)
  await settle()
  assert.deepEqual(calls.map((call) => call.method), ["claim", "record"])
  assert.equal(calls[1]!.input, input, "the original gate receives the identical input")
  const [kept] = store.entries(OWNER)
  assert.ok(kept)
  assert.deepEqual(
    { claimId: kept.claimId, intentKey: kept.intentKey, stage: kept.stage, transactionDigest: kept.transactionDigest, side: kept.side, orderId: kept.orderId, deploymentDigest: kept.deploymentDigest, wallet: kept.wallet, chainId: kept.chainId, apiBase: kept.apiBase, origin: kept.origin, txHash: kept.txHash },
    { claimId: CLAIM.claimId, intentKey: CLAIM.intentKey, stage: CLAIM.stage, transactionDigest: CLAIM.transactionDigest, side: "SELL", orderId: "order-7", deploymentDigest: "d".repeat(64), wallet: WALLET.toLowerCase(), chainId: 91342, apiBase: SCOPE.apiBase, origin: SCOPE.origin, txHash: HASH },
  )
})

test("a completed original record, an UNKNOWN outcome, a hashless record, an unclaimed or other binding keep nothing", async () => {
  const cases: { name: string; script: Script; claim?: Record<string, unknown>; record: Record<string, unknown> }[] = [
    { name: "original record completed", script: { record: "resolve" }, record: { ...CLAIM, status: "SUBMITTED", txHash: HASH } },
    { name: "UNKNOWN (no wallet answer)", script: { record: new Error("x") }, record: { ...CLAIM, status: "UNKNOWN" } },
    { name: "UNKNOWN with a hash-shaped field", script: { record: new Error("x") }, record: { ...CLAIM, status: "UNKNOWN", txHash: HASH } },
    { name: "no claim won", script: { claim: null, record: new Error("x") }, record: { ...CLAIM, status: "SUBMITTED", txHash: HASH } },
    { name: "claim failed", script: { claim: new Error("SUBMISSION_HTTP_ERROR"), record: new Error("x") }, record: { ...CLAIM, status: "SUBMITTED", txHash: HASH } },
    { name: "another claim ID", script: { record: new Error("x") }, record: { ...CLAIM, claimId: "claim-8", status: "SUBMITTED", txHash: HASH } },
    { name: "another transaction digest", script: { record: new Error("x") }, record: { ...CLAIM, transactionDigest: "c".repeat(64), status: "SUBMITTED", txHash: HASH } },
    { name: "another stage", script: { record: new Error("x") }, record: { ...CLAIM, stage: "APPROVAL", status: "SUBMITTED", txHash: HASH } },
    { name: "claim for another order", script: { record: new Error("x") }, claim: { orderId: "order-9" }, record: { ...CLAIM, status: "SUBMITTED", txHash: HASH } },
    { name: "claim for another deployment", script: { record: new Error("x") }, claim: { deploymentDigest: "e".repeat(64) }, record: { ...CLAIM, status: "SUBMITTED", txHash: HASH } },
  ]
  for (const item of cases) {
    const { gate } = fakeGate(item.script)
    const store = createKnownHashStore()
    const wrapped = captureKnownHashes(gate, SCOPE, store)
    await wrapped.claim(claimRequest(item.claim)).catch(() => undefined)
    await wrapped.record(item.record as AttemptRecord).catch(() => undefined)
    await settle()
    assert.equal(store.entries(OWNER).length, 0, item.name)
  }
})

test("inspect and reconcile pass through unchanged; a gate without reconcile stays without one; a failing store never changes the outcome", async () => {
  const { gate, calls } = fakeGate({ record: new Error("SUBMISSION_TIMEOUT") })
  const store = createKnownHashStore()
  const wrapped = captureKnownHashes(gate, SCOPE, store)
  await wrapped.inspect(CLAIM.intentKey)
  await wrapped.reconcile!({ claimId: CLAIM.claimId, intentKey: CLAIM.intentKey, stage: CLAIM.stage, transactionDigest: CLAIM.transactionDigest, txHash: HASH })
  assert.deepEqual(calls.map((call) => call.method), ["inspect", "reconcile"])
  const { reconcile: _unused, ...withoutReconcile } = gate
  assert.equal(typeof captureKnownHashes(withoutReconcile as SubmissionGate, SCOPE, store).reconcile, "undefined")

  const throwing = { ...createKnownHashStore(), remember() { throw new Error("store broken") } }
  const failing = captureKnownHashes(fakeGate({ record: new Error("SUBMISSION_AUTH_REQUIRED") }).gate, SCOPE, throwing)
  await failing.claim(claimRequest())
  await assert.rejects(failing.record({ ...CLAIM, status: "SUBMITTED", txHash: HASH }), /SUBMISSION_AUTH_REQUIRED/)
  await settle()
})
