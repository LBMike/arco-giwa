// React-free execution registry: lifetime, capability, pinned selection, live context and the explicit evidence
// read. Fake HTTP and a fake EIP-1193 provider only; the full server and wallet flows are in full-stack.test.tsx.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import type { HostSession } from "../stocks-host/session"
import { API, clocks, envelope, evidence, fakeFetch, flush, json, orderRow, START, TOKEN, WALLET } from "../stocks-wallet-http/test-support"
import type { ActiveWalletSource, WalletSourceView } from "../stocks-wallet-source"
import { fakeProvider, touchSpy, windowEthereumSpy } from "../stocks-wallet-source/test-support"
import { createExecutionRegistry, executionIdentityKey, type ExecutionHostView } from "./registry"

const SESSION: HostSession = Object.freeze({ id: "session-a", walletAddress: WALLET, chainId: 91342, accessToken: TOKEN, createdAt: START - 1_000, expiresAt: START + 600_000 })

function world(options: { source?: "injected" | "dynamic" | "none"; session?: HostSession | null; apiBase?: string | null; address?: string } = {}) {
  const clock = clocks()
  const provider = fakeProvider()
  const dynamic = touchSpy({ request: async () => "0x" })
  const source: ActiveWalletSource | null = options.source === "none" ? null : options.source === "dynamic" ? { mode: "dynamic", client: dynamic.proxy } : { mode: "injected", provider }
  let active: ActiveWalletSource | null = source
  let view: ExecutionHostView = {
    session: options.session === undefined ? SESSION : options.session,
    wallet: { source, address: options.address ?? WALLET, chainId: 91342, epoch: "injected:1" },
    apiBase: options.apiBase === undefined ? API : options.apiBase,
  }
  let answer: (url: string) => Response | Promise<Response> = () => json(envelope(evidence()))
  const http = fakeFetch((call) => answer(call.url))
  const invalidated: string[] = []
  const registry = createExecutionRegistry({ view: () => view, invalidate: (id) => invalidated.push(id), fetch: http.fetch as typeof globalThis.fetch, now: clock.now, monotonicNow: clock.monotonicNow, activeSource: () => active })
  return {
    clock, provider, dynamic, registry, http, invalidated,
    get view() { return view },
    setView(change: { session?: HostSession | null; apiBase?: string | null; wallet?: Partial<WalletSourceView> }) { view = { ...view, ...change, wallet: { ...view.wallet, ...change.wallet } } },
    setActive(next: ActiveWalletSource | null) { active = next },
    answer(next: (url: string) => Response | Promise<Response>) { answer = next },
  }
}

test("creating a registry and an owner issues no request, no wallet call and no evidence read", () => {
  const w = world()
  assert.deepEqual(w.registry.capability, { status: "READY" })
  assert.equal(w.provider.listenerCount(), 3, "the capture only subscribes to account, chain and disconnect events")
  const lookup = w.registry.ownerFor("BUY", orderRow("BUY"))
  assert.ok(lookup.owner)
  assert.equal(lookup.owner.controller.getSnapshot().status, "IDLE")
  assert.equal(w.http.calls.length, 0)
  assert.equal(w.provider.calls.length, 0)
  assert.equal(lookup.owner.ports.context().deployment, null, "no evidence until an explicit check")
  w.registry.dispose()
  assert.equal(w.provider.listenerCount(), 0)
  assert.equal(w.registry.ownerFor("BUY", orderRow("BUY")).owner, null, "a disposed registry never hands out owners")
})

test("capability codes: API base, session, wallet mismatch, missing source and Dynamic (no client touch, no window.ethereum)", () => {
  assert.deepEqual(world({ apiBase: null }).registry.capability, { status: "UNAVAILABLE", code: "API_BASE_NOT_CONFIGURED" })
  const signedOut = world({ session: null })
  assert.deepEqual(signedOut.registry.capability, { status: "UNAVAILABLE", code: "SESSION_REQUIRED" })
  assert.equal(signedOut.provider.listenerCount(), 0, "no subscription without a session")
  assert.deepEqual(world({ address: "0x2222222222222222222222222222222222222222" }).registry.capability, { status: "UNAVAILABLE", code: "WALLET_MISMATCH" })
  assert.deepEqual(world({ source: "none" }).registry.capability, { status: "UNAVAILABLE", code: "WALLET_SOURCE_MISSING" })
  const spy = windowEthereumSpy(fakeProvider())
  try {
    const dynamic = world({ source: "dynamic" })
    assert.deepEqual(dynamic.registry.capability, { status: "UNAVAILABLE", code: "WALLET_SOURCE_UNSUPPORTED" })
    assert.deepEqual(dynamic.registry.ownerFor("BUY", orderRow("BUY")), { owner: null, code: "WALLET_SOURCE_UNSUPPORTED" })
    assert.deepEqual(dynamic.dynamic.touched, [], "the Dynamic client is never used")
    assert.equal(spy.spy.reads, 0, "window.ethereum is never read in its place")
    assert.equal(dynamic.http.calls.length, 0)
  } finally {
    spy.restore()
  }
})

test("identity keys separate session, address, epoch, API base and a replaced source object at the same address", () => {
  const w = world()
  const base = executionIdentityKey(w.view)
  const variants: Partial<ExecutionHostView>[] = [
    { session: { ...SESSION, id: "session-b" } },
    { session: null },
    { wallet: { ...w.view.wallet, epoch: "injected:2" } },
    { wallet: { ...w.view.wallet, address: "0x2222222222222222222222222222222222222222" } },
    { wallet: { ...w.view.wallet, source: { mode: "injected", provider: fakeProvider() } } },
    { apiBase: "https://other-stocks-api.test" },
  ]
  for (const change of variants) assert.notEqual(executionIdentityKey({ ...w.view, ...change }), base, JSON.stringify(Object.keys(change)))
  assert.equal(executionIdentityKey({ ...w.view, wallet: { ...w.view.wallet, address: WALLET.toUpperCase().replace("0X", "0x") } }), base, "address case is not identity")
})

test("the first row is pinned per order: refreshed rows reuse the owner and its selection; another order gets another owner", () => {
  const w = world()
  const first = orderRow("BUY")
  const owner = w.registry.ownerFor("BUY", first).owner!
  const refreshed = orderRow("BUY", { state: "FUNDED_QUOTE_EXPIRED", version: 3, updatedAt: new Date(START).toISOString() })
  assert.equal(w.registry.ownerFor("BUY", refreshed).owner, owner, "a refresh never recreates the controller or gate")
  assert.deepEqual(owner.selection, { side: "BUY", order: first })
  assert.equal(w.registry.hasOwner("BUY", first.id), true)
  const other = w.registry.ownerFor("BUY", orderRow("BUY", { id: "order-2" })).owner
  assert.ok(other && other !== owner)
  assert.notEqual(w.registry.ownerFor("SELL", orderRow("SELL")).owner, owner, "side is part of the order identity")
  assert.deepEqual(w.registry.ownerFor("BUY", { id: "bad id!" }), { owner: null, code: "INVALID_ORDER" })
  assert.deepEqual(w.registry.ownerFor("BUY", orderRow("BUY", { id: "order-3", deploymentDigest: "not-a-digest" })), { owner: null, code: "INVALID_ORDER" }, "the submission gate refuses to bind a malformed digest")
})

test("context() is live: session only while it is the host's same session, wallet and epoch as shown now", () => {
  const w = world()
  const owner = w.registry.ownerFor("BUY", orderRow("BUY")).owner!
  assert.equal(owner.ports.context().session, SESSION)
  w.setView({ wallet: { epoch: "injected:9" } })
  assert.equal(owner.ports.context().walletEpoch, "injected:9")
  w.setView({ session: { ...SESSION, id: "session-b" } })
  assert.equal(owner.ports.context().session, null, "a newer session is never mixed into the old owner")
  w.setView({ session: null })
  assert.equal(owner.ports.context().session, null)
})

test("refreshEvidence: one in-flight read; the same cached evidence keeps the lease; new evidence replaces it", async () => {
  const w = world()
  const owner = w.registry.ownerFor("BUY", orderRow("BUY")).owner!
  let release!: () => void
  w.answer(() => new Promise<Response>((resolve) => { release = () => resolve(json(envelope(evidence()))) }))
  const one = owner.refreshEvidence()
  const two = owner.refreshEvidence()
  await flush()
  assert.equal(w.http.calls.length, 1, "shared in-flight read")
  assert.equal(w.http.calls[0]!.url, `${API}/api/v1/stocks/execution/deployment`)
  assert.deepEqual(w.http.calls[0]!.init.headers, { accept: "application/json", authorization: `Bearer ${TOKEN}` })
  release()
  await Promise.all([one, two])
  const lease = owner.ports.context().deployment
  assert.equal(lease?.evidenceId, "evidence-1")
  assert.equal(owner.version() > 0, true, "subscribers re-render after the read")

  w.answer(() => json(envelope(evidence())))
  await owner.refreshEvidence()
  assert.equal(owner.ports.context().deployment, lease, "same evidence: the current lease object and window are kept")

  w.clock.advance(1_000)
  w.answer(() => json(envelope(evidence({ evidenceId: "evidence-2", verifiedAt: START + 500, validUntil: START + 15_000 }), START + 1_000)))
  await owner.refreshEvidence()
  assert.equal(owner.ports.context().deployment?.evidenceId, "evidence-2")
  assert.equal(owner.evidenceFailure(), null)
})

test("refreshEvidence ignores an answer for a scope the host left, records a failure code and invalidates only the captured session on 401", async () => {
  const w = world()
  const owner = w.registry.ownerFor("BUY", orderRow("BUY")).owner!
  let release!: () => void
  w.answer(() => new Promise<Response>((resolve) => { release = () => resolve(json(envelope(evidence()))) }))
  const pending = owner.refreshEvidence()
  await flush()
  w.setView({ session: { ...SESSION, id: "session-b" } })
  release()
  await pending
  assert.equal(owner.ports.context().deployment, null)

  const fresh = world()
  const other = fresh.registry.ownerFor("BUY", orderRow("BUY")).owner!
  fresh.answer(() => json({ error: "EXECUTION_DEPLOYMENT_UNVERIFIED" }, 503))
  await other.refreshEvidence()
  assert.equal(other.evidenceFailure(), "DEPLOYMENT_NOT_REVIEWED")
  assert.equal(other.ports.context().deployment, null)
  fresh.answer(() => json({ error: "UNAUTHORIZED" }, 401))
  await other.refreshEvidence()
  assert.deepEqual(fresh.invalidated, ["session-a"])
  assert.equal(other.evidenceFailure(), "SESSION_REJECTED")
})

test("dispose aborts an in-flight evidence read and a late answer changes nothing", async () => {
  const w = world()
  const owner = w.registry.ownerFor("BUY", orderRow("BUY")).owner!
  let release!: () => void
  w.answer(() => new Promise<Response>((resolve) => { release = () => resolve(json(envelope(evidence()))) }))
  const pending = owner.refreshEvidence()
  await flush()
  assert.equal(w.http.calls[0]!.init.signal?.aborted, false)
  w.registry.dispose()
  assert.equal(w.http.calls[0]!.init.signal?.aborted, true)
  release()
  await pending
  assert.equal(owner.ports.context().deployment, null)
  assert.equal(w.provider.listenerCount(), 0)
})

test("a broken clock is reported, and only an explicit restart creates a new owner for the same pinned row", () => {
  const w = world()
  const row = orderRow("BUY")
  const owner = w.registry.ownerFor("BUY", row).owner!
  assert.equal(owner.healthy(), true)
  w.clock.setMonotonic(1)
  assert.equal(owner.healthy(), false)
  assert.equal(w.registry.ownerFor("BUY", row).owner, owner, "nothing is replaced automatically")
  w.registry.restart(owner)
  const renewed = w.registry.ownerFor("BUY", orderRow("BUY", { version: 7 })).owner!
  assert.notEqual(renewed, owner)
  assert.deepEqual(renewed.selection.order, row, "the pinned first row survives a restart")
  assert.equal(w.http.calls.length + w.provider.calls.length, 0)
})

test("the registry and page provider never call prepare, approve or submit and never read window.ethereum", () => {
  for (const file of ["registry.ts", "StocksExecutionProvider.tsx"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
    assert.doesNotMatch(source, /\.(prepare|approve|submit)\(/, file)
    assert.doesNotMatch(source, /window\.ethereum|eth_sendTransaction|localStorage|sessionStorage|setInterval|setTimeout/, file)
  }
})
