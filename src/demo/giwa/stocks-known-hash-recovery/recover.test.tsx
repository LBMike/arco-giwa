// Known-hash capture and explicit recovery against the REAL execution registry (owner composition, wallet
// controller, read adapter, submission client, wallet-source ports) and the REAL server plugins (Stocks, execution,
// wallet submissions with the real receipt verifier) over the test-only in-process harness and a fake EIP-1193 wallet
// on the same fake chain. One wall clock is shared by the server fixture and the browser clocks and shifted by the
// test (session expiry, quote deadline). No socket, database, public network, key or signature.

import assert from "node:assert/strict"
import test from "node:test"

import { getAddress } from "viem"

import type { HostSession } from "../stocks-host/session"
import { digest } from "../stocks-wallet/planner"
import type { Plan, Side, Stage, SubmissionGate } from "../stocks-wallet/types"
import { createSubmissionGate } from "../stocks-wallet-submissions/client"
import type { ActiveWalletSource } from "../stocks-wallet-source"
import { createExecutionRegistry, type ExecutionHostView, type ExecutionOwner, type ExecutionRegistry } from "../stocks-execution-host/registry"
import { createFakeEip1193Wallet, providerError } from "../stocks-execution-host/testing/fake-wallet"
import { createInProcessStocks, HARNESS_FRONTEND_ORIGIN } from "../stocks-execution-host/testing/in-process-stocks"
import { recoverKnownHash, type RecoverKnownHashOptions } from "./recover"
import { createKnownHashStore, type KnownHashEntry, type KnownHashStore } from "./store"

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const A = getAddress("0x000000000000000000000000000000000000a11c")
const B = getAddress("0x000000000000000000000000000000000000b0b0")
const QUANTITY = 1_000_000_000n
const CASH = 120_000_000n
const SHORT_SESSION_MS = 20_000

type Rewrite = (path: string, method: string, response: Response) => Promise<Response> | Response

async function world(side: Side, options: { finalizeImmediately?: boolean } = {}) {
  const offsets = { wall: 0 }
  const wall = () => Date.now() + offsets.wall
  const h = await createInProcessStocks({ wall })
  if (options.finalizeImmediately === false) h.chain.setFinalizeImmediately(false)
  if (side === "SELL") h.seedStock(A, QUANTITY)
  else h.seedCash(A, CASH)
  let session: HostSession = h.session(A, { lifetimeMs: SHORT_SESSION_MS })
  const created = await h.createOrder(side, session)
  const wallet = createFakeEip1193Wallet(h.chain, { account: A })
  const source: ActiveWalletSource = { mode: "injected", provider: wallet }
  let view: ExecutionHostView = { session, wallet: { source, address: A, chainId: 91342, epoch: "injected:1" }, apiBase: h.apiBase }
  const invalidated: string[] = []
  let rewrite: Rewrite | null = null
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await h.fetch(input, init)
    return rewrite ? rewrite(new URL(String(input)).pathname, init?.method ?? "GET", response) : response
  }) as typeof globalThis.fetch
  const store = createKnownHashStore()
  const browserNow = () => Date.now() + offsets.wall
  const browserMonotonic = () => performance.now() + offsets.wall
  const newRegistry = () => createExecutionRegistry({ view: () => view, invalidate: (id) => invalidated.push(id), fetch, now: browserNow, monotonicNow: browserMonotonic, activeSource: () => source, knownHashes: store, origin: HARNESS_FRONTEND_ORIGIN })
  let registry: ExecutionRegistry = newRegistry()
  const order = created.order as Json
  const owner = (): ExecutionOwner => {
    const lookup = registry.ownerFor(side, order)
    assert.ok(lookup.owner, `owner: ${lookup.code}`)
    return lookup.owner
  }
  const w = {
    h, wallet, order, side, offsets, invalidated, store, fetch,
    get session() { return session },
    get registry() { return registry },
    owner,
    async check(o: ExecutionOwner = owner()) {
      await o.refreshEvidence()
      await o.controller.prepare()
      return o.controller.getSnapshot()
    },
    sends: () => wallet.callsOf("eth_sendTransaction").length,
    forbiddenSends: () => wallet.calls.filter((call) => call.method === "wallet_sendTransaction" || call.method === "eth_sendRawTransaction").length,
    server: (method: string, suffix: string) => h.requests.filter((request) => request.method === method && request.path.endsWith(suffix)),
    bodies: (suffix: string) => h.requests.filter((request) => request.method === "POST" && request.path.endsWith(suffix)).map((request) => JSON.parse(request.body!) as Json),
    /** The server journal through the current session (a separate read, not the recovery gate). */
    async journal(): Promise<Json> {
      const response = await h.fetch(`${h.apiBase}/api/v1/stocks/wallet-submissions/${side}/${order.id}`, { headers: { authorization: `Bearer ${session.accessToken}`, accept: "application/json" } })
      return ((await response.json()) as Json).data
    },
    /** The session ended and the same wallet signed in again: the old registry is gone, a new one owns the view. */
    signInAgain(lifetimeMs = 900_000) {
      session = h.session(A, { lifetimeMs })
      view = { ...view, session }
      registry.dispose()
      registry = newRegistry()
      return session
    },
    setRewrite(next: Rewrite | null) { rewrite = next },
    recover(entry: KnownHashEntry, extra: Partial<RecoverKnownHashOptions> = {}) {
      return recoverKnownHash({ candidate: entry, session, apiBase: h.apiBase, store, alive: () => true, onSessionRejected: (id) => invalidated.push(id), fetch, now: browserNow, monotonicNow: browserMonotonic, ...extra })
    },
    async close() { registry.dispose(); await h.close() },
  }
  return w
}
type World = Awaited<ReturnType<typeof world>>

async function run(side: Side, options: Parameters<typeof world>[1], body: (w: World) => Promise<void>) {
  const w = await world(side, options)
  try {
    await body(w)
  } finally {
    await w.close()
  }
}

/**
 * The original owner's wallet request is open when its short session expires; the wallet then returns a hash. The
 * original gate refuses the late record before any request, so the wrapper keeps the hash. Returns the kept entry.
 */
async function lateHash(w: World, stage: Stage): Promise<{ entry: KnownHashEntry; hash: string; plan: Plan }> {
  const owner = w.owner()
  assert.equal((await w.check(owner)).status, "APPROVAL_REQUIRED")
  const plan = owner.controller.getSnapshot().plan!
  if (stage === "TRANSFER") {
    await owner.controller.approve()
    assert.equal(owner.controller.getSnapshot().status, "READY_TRANSFER")
  }
  const held = w.wallet.holdNext("eth_sendTransaction")
  const pending = stage === "APPROVAL" ? owner.controller.approve() : owner.controller.submit()
  await held.arrived
  const outcomes = w.server("POST", "/outcomes").length
  const claims = w.server("POST", "/claims").length
  w.offsets.wall += SHORT_SESSION_MS + 1_000
  held.release()
  await pending
  assert.equal(w.server("POST", "/outcomes").length, outcomes, "the original gate refuses the late hash before any request")
  assert.equal(w.server("POST", "/claims").length, claims)
  const hash = w.h.chain.transactions[w.h.chain.transactions.length - 1]!.hash
  const entries = w.store.entries({ wallet: A, chainId: 91342, apiBase: w.h.apiBase, origin: HARNESS_FRONTEND_ORIGIN })
  assert.equal(entries.length, 1, "exactly one kept hash")
  const entry = entries[0]!
  assert.equal(entry.txHash, hash)
  assert.equal(entry.stage, stage)
  assert.deepEqual(entry.state, { kind: "KEPT" })
  return { entry, hash, plan }
}

const stageRow = (journal: Json, stage: Stage) => (stage === "APPROVAL" ? journal.approval : journal.transfer)

for (const side of ["BUY", "SELL"] as const) {
  for (const stage of ["APPROVAL", "TRANSFER"] as const) {
    test(`${side} ${stage}: a late hash is kept with the exact original binding and recovered by an explicit run with a new session; no claim, no wallet request`, async () => {
      await run(side, {}, async (w) => {
        const originalSession = w.session
        const { entry, hash } = await lateHash(w, stage)
        const fresh = w.signInAgain()
        assert.notEqual(fresh.id, originalSession.id)
        const before = stageRow(await w.journal(), stage)
        // The kept hash is exactly the original claim's binding, order, deployment and owner scope; nothing else.
        assert.deepEqual(Object.keys(entry).sort(), ["apiBase", "busy", "capturedAt", "chainId", "claimId", "deploymentDigest", "intentKey", "orderId", "origin", "side", "stage", "state", "transactionDigest", "txHash", "wallet"])
        assert.deepEqual([entry.claimId, entry.intentKey, entry.stage, entry.transactionDigest], [before.claimId, before.intentKey, stage, before.transactionDigest])
        assert.deepEqual([entry.side, entry.orderId, entry.deploymentDigest, entry.wallet, entry.chainId, entry.apiBase, entry.origin], [side, w.order.id, w.order.deploymentDigest, A.toLowerCase(), 91342, w.h.apiBase, HARNESS_FRONTEND_ORIGIN])
        assert.ok(!JSON.stringify(entry).includes(originalSession.accessToken) && !JSON.stringify(entry).includes(fresh.accessToken))
        assert.deepEqual([before.status, before.txHash], ["REQUEST_MAY_START", undefined])

        const sends = w.sends(), claims = w.server("POST", "/claims").length, outcomes = w.bodies("/outcomes").length, reconciles = w.bodies("/reconcile").length
        const reads = w.server("GET", `/wallet-submissions/${side}/${w.order.id}`).length
        const result = await w.recover(entry)
        assert.deepEqual(result, { kind: "CONFIRMED" })
        assert.equal(w.sends(), sends, "no wallet request")
        assert.equal(w.forbiddenSends(), 0)
        assert.equal(w.server("POST", "/claims").length, claims, "no claim")
        const newOutcomes = w.bodies("/outcomes").slice(outcomes)
        assert.deepEqual(newOutcomes, [{ claimId: entry.claimId, intentKey: entry.intentKey, stage, transactionDigest: entry.transactionDigest, status: "SUBMITTED", txHash: hash }])
        assert.deepEqual(w.bodies("/reconcile").slice(reconciles), [{ claimId: entry.claimId, intentKey: entry.intentKey, stage, transactionDigest: entry.transactionDigest, txHash: hash }])
        assert.equal(w.server("GET", `/wallet-submissions/${side}/${w.order.id}`).length, reads + 1, "one inspect")
        // The recovery requests carried the new session only.
        const recoveryRequests = w.h.requests.slice(-3)
        assert.ok(recoveryRequests.every((request) => request.authorization))
        const after = stageRow(await w.journal(), stage)
        assert.deepEqual([after.claimId, after.status, after.txHash], [entry.claimId, "CONFIRMED", hash])
        assert.deepEqual(w.store.get(entry.claimId)?.state, { kind: "VERIFIED", status: "CONFIRMED" })
        // Nothing more is offered for a verified hash; a second run does nothing.
        assert.deepEqual(await w.recover(w.store.get(entry.claimId)!), { kind: "STOPPED" })
        assert.equal(w.bodies("/outcomes").length, outcomes + 1)
        // A receipt is not order completion: the business order is unchanged.
        const row = (w.h.sql.snapshot() as unknown as Record<string, Json[]>)[side === "BUY" ? "StocksOrder" : "StocksSellOrder"]!.find((r) => r.id === w.order.id)!
        assert.equal(row.state, side === "BUY" ? "AWAITING_FUNDING" : "AWAITING_ESCROW")
        assert.deepEqual(w.invalidated, [])
      })
    })
  }
}

test("after the quote deadline and with trading paused, the kept approval is recorded and verified; a new transfer claim is still refused", async () => {
  await run("BUY", {}, async (w) => {
    const { entry, hash, plan } = await lateHash(w, "APPROVAL")
    w.offsets.wall += 61_000 // Past the original 60-second quote deadline (server clock and browser clocks).
    w.h.setPaused(true)
    w.signInAgain()
    const outcomes = w.bodies("/outcomes").length
    assert.deepEqual(await w.recover(entry), { kind: "CONFIRMED" })
    assert.equal(w.bodies("/outcomes").length, outcomes + 1)
    assert.deepEqual([(await w.journal()).approval.status, (await w.journal()).approval.txHash], ["CONFIRMED", hash])
    // New execution admission keeps its own rules: an explicit TRANSFER claim with the new session is refused by the
    // real server while trading is paused, and again after resuming because the original deadline has passed.
    const sends = w.sends()
    const gate = createSubmissionGate({ session: w.session, side: "BUY", orderId: w.order.id, deploymentDigest: w.order.deploymentDigest, apiBase: w.h.apiBase, fetch: w.fetch, now: () => Date.now() + w.offsets.wall, monotonicNow: () => performance.now() + w.offsets.wall })
    await gate.inspect(plan.intentKey)
    const transfer = { intentKey: plan.intentKey, stage: "TRANSFER" as const, transactionDigest: digest(plan.transfer), transaction: plan.transfer, orderId: w.order.id, deploymentDigest: w.order.deploymentDigest }
    await assert.rejects(gate.claim(transfer), /SUBMISSION_HTTP_ERROR/)
    w.h.setPaused(false)
    await assert.rejects(gate.claim(transfer), /SUBMISSION_HTTP_ERROR/)
    const refused = w.h.requests.filter((request) => request.method === "POST" && request.path.endsWith("/claims")).slice(-2)
    // Paused: 503 (not ready for new execution). Resumed: 409 (the original deadline has passed).
    assert.deepEqual(refused.map((request) => request.status), [503, 409])
    assert.equal((await w.journal()).transfer, null, "no transfer claim")
    assert.equal(w.sends(), sends, "no wallet request")
  })
})

test("the original gate's lost answer: the server already has the same hash, so recovery records nothing and only verifies", async () => {
  await run("SELL", {}, async (w) => {
    const owner = w.owner()
    assert.equal((await w.check(owner)).status, "APPROVAL_REQUIRED")
    // The original session is valid; its outcomes request reaches the server but the answer is lost.
    w.setRewrite((path, _method, response) => {
      if (path.endsWith("/outcomes")) throw new TypeError("network lost after the server stored it")
      return response
    })
    await owner.controller.approve()
    w.setRewrite(null)
    const journal = await w.journal()
    const hash = journal.approval.txHash
    assert.match(hash, /^0x[0-9a-f]{64}$/)
    const [entry] = w.store.entries({ wallet: A, chainId: 91342, apiBase: w.h.apiBase, origin: HARNESS_FRONTEND_ORIGIN })
    assert.ok(entry, "the failed original record keeps the hash")
    assert.equal(entry.txHash, hash)
    w.signInAgain()
    const outcomes = w.bodies("/outcomes").length
    assert.deepEqual(await w.recover(entry), { kind: "CONFIRMED" })
    assert.equal(w.bodies("/outcomes").length, outcomes, "the same hash is not recorded again")
    assert.equal(w.bodies("/reconcile").length > 0, true)
  })
})

test("a completed original record (session still valid) keeps nothing; a wallet error after expiry keeps nothing", async () => {
  await run("BUY", {}, async (w) => {
    const owner = w.owner()
    assert.equal((await w.check(owner)).status, "APPROVAL_REQUIRED")
    await owner.controller.approve()
    assert.equal(w.store.entries({ wallet: A, chainId: 91342, apiBase: w.h.apiBase, origin: HARNESS_FRONTEND_ORIGIN }).length, 0)
    assert.equal((await w.journal()).approval.status, "CONFIRMED")
  })
  await run("SELL", {}, async (w) => {
    const owner = w.owner()
    assert.equal((await w.check(owner)).status, "APPROVAL_REQUIRED")
    const held = w.wallet.holdNext("eth_sendTransaction")
    const pending = owner.controller.approve()
    await held.arrived
    w.offsets.wall += SHORT_SESSION_MS + 1_000
    held.reject(providerError(4001, "User rejected the request."))
    await pending
    assert.equal(owner.controller.getSnapshot().status, "UNKNOWN")
    assert.equal(w.store.entries({ wallet: A, chainId: 91342, apiBase: w.h.apiBase, origin: HARNESS_FRONTEND_ORIGIN }).length, 0, "no hash, no candidate")
    assert.equal(w.bodies("/outcomes").length, 0)
  })
})

test("a different hash already on the server is a conflict: nothing is recorded or overwritten", async () => {
  await run("BUY", {}, async (w) => {
    const { entry, hash } = await lateHash(w, "APPROVAL")
    w.signInAgain()
    // Another well-formed hash reaches the server first (for example from another app).
    const other = `0x${"ab".repeat(32)}`
    const gate = createSubmissionGate({ session: w.session, side: "BUY", orderId: w.order.id, deploymentDigest: w.order.deploymentDigest, apiBase: w.h.apiBase, fetch: w.fetch, now: () => Date.now() + w.offsets.wall, monotonicNow: () => performance.now() + w.offsets.wall })
    const row = (await gate.inspect(entry.intentKey)).approval!
    await gate.record({ claimId: row.claimId, intentKey: row.intentKey, stage: row.stage, transactionDigest: row.transactionDigest, status: "SUBMITTED", txHash: other as `0x${string}` })
    const outcomes = w.bodies("/outcomes").length, reconciles = w.bodies("/reconcile").length
    assert.deepEqual(await w.recover(entry), { kind: "CONFLICT" })
    assert.equal(w.bodies("/outcomes").length, outcomes)
    assert.equal(w.bodies("/reconcile").length, reconciles)
    assert.equal((await w.journal()).approval.txHash, other)
    assert.notEqual(other, hash)
    assert.deepEqual(w.store.get(entry.claimId)?.state, { kind: "BLOCKED", reason: "CONFLICT" })
    assert.deepEqual(await w.recover(w.store.get(entry.claimId)!), { kind: "STOPPED" }, "a blocked hash offers nothing more")
  })
})

test("no claim for the stage, another binding, another owner, an expired or rejected session: fail closed", async () => {
  await run("SELL", {}, async (w) => {
    const { entry } = await lateHash(w, "APPROVAL")
    w.signInAgain()
    const requests = w.h.requests.length
    // Another owner never runs, whatever it is handed.
    const other = w.h.session(B)
    assert.deepEqual(await w.recover(entry, { session: other }), { kind: "STOPPED" })
    assert.equal(w.h.requests.length, requests)
    // A pinned session that has already expired is refused before any request.
    const expired = { ...w.session, expiresAt: Date.now() + w.offsets.wall - 1 }
    assert.deepEqual(await w.recover(entry, { session: expired }), { kind: "SESSION_REQUIRED" })
    assert.equal(w.h.requests.length, requests)
    // A rejected session: only the pinned session's ID is reported; the kept hash stays.
    const rejected = { ...w.session, id: "pinned-session-for-401", accessToken: "not-a-valid-token" }
    assert.deepEqual(await w.recover(entry, { session: rejected }), { kind: "SESSION_REJECTED" })
    assert.deepEqual(w.invalidated, ["pinned-session-for-401"])
    assert.deepEqual(w.store.get(entry.claimId)?.state, { kind: "KEPT" })
    // Test-only candidates (never produced by capture): a stage without a claim, and a changed binding.
    const store = createKnownHashStore()
    const base = { ...entry }
    assert.ok(store.remember({ ...base, claimId: "no-claim-transfer", stage: "TRANSFER" }))
    assert.ok(store.remember({ ...base, claimId: entry.claimId, transactionDigest: "f".repeat(64) }))
    const noClaim = store.get("no-claim-transfer")!
    assert.deepEqual(await w.recover(noClaim, { store }), { kind: "NO_CLAIM" })
    assert.deepEqual(await w.recover(store.get(entry.claimId)!, { store }), { kind: "BINDING_MISMATCH" })
    assert.equal(w.bodies("/outcomes").length, 0, "nothing was recorded by any of these")
    assert.equal((await w.journal()).approval.status, "REQUEST_MAY_START")
  })
})

test("a server error or a lost recovery answer keeps the hash; an explicit check again records nothing twice", async () => {
  await run("BUY", {}, async (w) => {
    const { entry, hash } = await lateHash(w, "TRANSFER")
    w.signInAgain()
    w.setRewrite((path, method, response) => (method === "GET" && path.includes("/wallet-submissions/") ? new Response(JSON.stringify({ error: "INTERNAL" }), { status: 500 }) : response))
    assert.deepEqual(await w.recover(entry), { kind: "FAILED", code: "SUBMISSION_HTTP_ERROR" })
    assert.deepEqual(w.store.get(entry.claimId)?.state, { kind: "KEPT" })
    // The recording request reaches the server, but its answer is lost.
    w.setRewrite((path, _method, response) => {
      if (path.endsWith("/outcomes")) throw new TypeError("answer lost")
      return response
    })
    assert.deepEqual(await w.recover(entry), { kind: "FAILED", code: "SUBMISSION_REQUEST_FAILED" })
    assert.equal((await w.journal()).transfer.txHash, hash, "the server stored it")
    assert.deepEqual(w.store.get(entry.claimId)?.state, { kind: "KEPT" }, "not settled from a lost answer")
    w.setRewrite(null)
    const outcomes = w.bodies("/outcomes").length
    assert.deepEqual(await w.recover(w.store.get(entry.claimId)!), { kind: "CONFIRMED" })
    assert.equal(w.bodies("/outcomes").length, outcomes, "the same hash is not recorded twice")
  })
})

test("a receipt that is not final yet stays RECORDED until an explicit check again; a reverted transaction is reported as REVERTED", async () => {
  await run("SELL", { finalizeImmediately: false }, async (w) => {
    const owner = w.owner()
    assert.equal((await w.check(owner)).status, "APPROVAL_REQUIRED")
    const held = w.wallet.holdNext("eth_sendTransaction")
    const pending = owner.controller.approve()
    await held.arrived
    w.offsets.wall += SHORT_SESSION_MS + 1_000
    held.release()
    await pending
    const [entry] = w.store.entries({ wallet: A, chainId: 91342, apiBase: w.h.apiBase, origin: HARNESS_FRONTEND_ORIGIN })
    assert.ok(entry)
    w.signInAgain()
    assert.deepEqual(await w.recover(entry), { kind: "RECORDED_PENDING" })
    assert.deepEqual(w.store.get(entry.claimId)?.state, { kind: "RECORDED" })
    assert.equal((await w.journal()).approval.status, "SUBMITTED")
    w.h.chain.finalize()
    const outcomes = w.bodies("/outcomes").length
    assert.deepEqual(await w.recover(w.store.get(entry.claimId)!), { kind: "CONFIRMED" })
    assert.equal(w.bodies("/outcomes").length, outcomes)
  })
  await run("BUY", {}, async (w) => {
    const owner = w.owner()
    assert.equal((await w.check(owner)).status, "APPROVAL_REQUIRED")
    w.h.chain.revertNextTransaction()
    const held = w.wallet.holdNext("eth_sendTransaction")
    const pending = owner.controller.approve()
    await held.arrived
    w.offsets.wall += SHORT_SESSION_MS + 1_000
    held.release()
    await pending
    const [entry] = w.store.entries({ wallet: A, chainId: 91342, apiBase: w.h.apiBase, origin: HARNESS_FRONTEND_ORIGIN })
    w.signInAgain()
    assert.deepEqual(await w.recover(entry!), { kind: "REVERTED" })
    assert.deepEqual(w.store.get(entry!.claimId)?.state, { kind: "VERIFIED", status: "REVERTED" })
    assert.equal((await w.journal()).approval.status, "REVERTED")
  })
})

test("an owner change during a slow answer stops the run: nothing is reported or stored; a duplicate run is BUSY", async () => {
  await run("BUY", {}, async (w) => {
    const { entry } = await lateHash(w, "APPROVAL")
    w.signInAgain()
    let alive = true
    let releaseInspect!: () => void
    const inspectHeld = new Promise<void>((resolve) => { releaseInspect = resolve })
    w.setRewrite(async (path, method, response) => {
      if (method === "GET" && path.includes("/wallet-submissions/")) await inspectHeld
      return response
    })
    const first = w.recover(entry, { alive: () => alive })
    assert.deepEqual(await w.recover(entry), { kind: "BUSY" }, "one action per kept hash at a time")
    assert.equal(w.store.get(entry.claimId)?.busy, true)
    alive = false // For example the user signed out or another wallet is shown.
    releaseInspect()
    assert.deepEqual(await first, { kind: "STOPPED" })
    assert.equal(w.bodies("/outcomes").length, 0, "nothing recorded after the owner changed")
    assert.deepEqual(w.store.get(entry.claimId)?.state, { kind: "KEPT" })
    assert.equal(w.store.get(entry.claimId)?.busy, false)
  })
})

test("the capture wrapper keeps the controller's exact gate behaviour (identical promise and error)", async () => {
  const store: KnownHashStore = createKnownHashStore()
  const refusal = new Error("SUBMISSION_AUTH_REQUIRED")
  const calls: string[] = []
  const claimRow = { claimId: "claim-1", intentKey: "a".repeat(64), stage: "APPROVAL" as const, transactionDigest: "b".repeat(64), status: "REQUEST_MAY_START" as const }
  const recordPromise = Promise.reject(refusal)
  recordPromise.catch(() => undefined)
  const gate: SubmissionGate = {
    inspect: async () => { calls.push("inspect"); return { approval: null, transfer: null } },
    claim: async () => { calls.push("claim"); return claimRow },
    record: () => { calls.push("record"); return recordPromise },
    reconcile: async () => { calls.push("reconcile"); return { ...claimRow, status: "SUBMITTED", txHash: `0x${"1".repeat(64)}` } },
  }
  const { captureKnownHashes } = await import("./capture")
  const wrapped = captureKnownHashes(gate, { side: "BUY", orderId: "order-1", deploymentDigest: "c".repeat(64), wallet: A, chainId: 91342, apiBase: "https://api.example.test", origin: "https://app.example.test" }, store)
  await wrapped.claim({ intentKey: claimRow.intentKey, stage: "APPROVAL", transactionDigest: claimRow.transactionDigest, transaction: {} as never, orderId: "order-1", deploymentDigest: "c".repeat(64) })
  const returned = wrapped.record({ ...claimRow, status: "SUBMITTED", txHash: `0x${"1".repeat(64)}` })
  assert.equal(returned, recordPromise, "the original promise itself")
  await assert.rejects(returned, (error) => error === refusal)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, ["claim", "record"])
  assert.equal(store.entries({ wallet: A, chainId: 91342, apiBase: "https://api.example.test", origin: "https://app.example.test" }).length, 1)
})
