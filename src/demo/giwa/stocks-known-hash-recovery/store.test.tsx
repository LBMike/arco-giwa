import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createKnownHashStore, knownHashCandidate, type KnownHashScope } from "./store"

const WALLET = "0x000000000000000000000000000000000000A11C"
const OWNER: KnownHashScope = { wallet: WALLET, chainId: 91342, apiBase: "https://api.example.test", origin: "https://app.example.test" }
const DIGEST = "d".repeat(64)

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    claimId: "claim-1",
    intentKey: "a".repeat(64),
    stage: "APPROVAL",
    transactionDigest: "b".repeat(64),
    side: "BUY",
    orderId: "order-1",
    deploymentDigest: DIGEST,
    wallet: WALLET,
    chainId: 91342,
    apiBase: OWNER.apiBase,
    origin: OWNER.origin,
    txHash: `0x${"1".repeat(64)}`,
    ...overrides,
  }
}

test("a candidate is exactly the binding, order scope, owner scope and hash; nothing else is copied", () => {
  const value = knownHashCandidate({ ...candidate(), accessToken: "secret-token", session: { accessToken: "x" }, provider: {}, signature: "0x12" }, () => 1_000)
  assert.ok(value)
  assert.deepEqual(Object.keys(value).sort(), ["apiBase", "capturedAt", "chainId", "claimId", "deploymentDigest", "intentKey", "orderId", "origin", "side", "stage", "transactionDigest", "txHash", "wallet"])
  assert.equal(value.wallet, WALLET.toLowerCase())
  assert.ok(Object.isFrozen(value))
  assert.ok(!JSON.stringify(value).includes("secret-token"))
})

test("invalid candidates are refused", () => {
  const bad: Record<string, unknown>[] = [
    { claimId: "" },
    { claimId: "has space" },
    { intentKey: "A".repeat(64) },
    { transactionDigest: "b".repeat(63) },
    { stage: "CONFIRMED" },
    { side: "HOLD" },
    { orderId: "../x" },
    { deploymentDigest: "zz" },
    { wallet: "0x0000000000000000000000000000000000000000" },
    { wallet: "not-an-address" },
    { chainId: 1 },
    { apiBase: "https://api.example.test/?" },
    { apiBase: "https://user:pass@api.example.test" },
    { apiBase: "ftp://api.example.test" },
    { origin: "https://app.example.test/path" },
    { txHash: `0x${"0".repeat(64)}` },
    { txHash: `0x${"A".repeat(64)}` },
    { txHash: "0x1234" },
    { txHash: undefined },
  ]
  for (const change of bad) assert.equal(knownHashCandidate(candidate(change)), null, JSON.stringify(change))
  assert.equal(knownHashCandidate(null), null)
  assert.equal(knownHashCandidate("claim-1"), null)
})

test("entries are scoped by owner (wallet, chain, API base, origin) and by order (side, order, deployment)", () => {
  const store = createKnownHashStore()
  assert.ok(store.remember(candidate()))
  assert.equal(store.entries(OWNER).length, 1)
  assert.equal(store.entries({ ...OWNER, wallet: WALLET.toLowerCase() }).length, 1, "address case does not matter")
  for (const other of [{ wallet: "0x000000000000000000000000000000000000B0B0" }, { chainId: 1 }, { apiBase: "https://other.example.test" }, { origin: "https://other-app.example.test" }]) {
    assert.equal(store.entries({ ...OWNER, ...other }).length, 0, JSON.stringify(other))
  }
  assert.equal(store.forOrder(OWNER, "BUY", "order-1", DIGEST).length, 1)
  assert.equal(store.forOrder(OWNER, "SELL", "order-1", DIGEST).length, 0)
  assert.equal(store.forOrder(OWNER, "BUY", "order-2", DIGEST).length, 0)
  assert.equal(store.forOrder(OWNER, "BUY", "order-1", "e".repeat(64)).length, 0)
  // Stable snapshots for useSyncExternalStore: the same array until the store changes.
  assert.equal(store.entries(OWNER), store.entries(OWNER))
  const before = store.entries(OWNER)
  store.begin("claim-1")
  assert.notEqual(store.entries(OWNER), before)
})

test("the first hash of a claim is kept; another hash for it is never stored or swapped in", () => {
  const store = createKnownHashStore()
  assert.ok(store.remember(candidate()))
  assert.ok(store.remember(candidate()), "the same candidate again changes nothing")
  assert.equal(store.version(), 1)
  assert.equal(store.remember(candidate({ txHash: `0x${"2".repeat(64)}` })), false)
  assert.equal(store.get("claim-1")?.txHash, `0x${"1".repeat(64)}`)
})

test("states move only with the matching hash; a verified result is final; nothing expires with time", () => {
  let now = 1_000
  const store = createKnownHashStore({ now: () => now })
  store.remember(candidate())
  assert.equal(store.settle("claim-1", `0x${"2".repeat(64)}`, { kind: "RECORDED" }), false)
  assert.ok(store.settle("claim-1", `0x${"1".repeat(64)}`, { kind: "RECORDED" }))
  assert.ok(store.settle("claim-1", `0x${"1".repeat(64)}`, { kind: "VERIFIED", status: "CONFIRMED" }))
  assert.equal(store.settle("claim-1", `0x${"1".repeat(64)}`, { kind: "BLOCKED", reason: "CONFLICT" }), false)
  assert.equal(store.settle("claim-1", `0x${"1".repeat(64)}`, { kind: "RECORDED" }), false)
  assert.deepEqual(store.get("claim-1")?.state, { kind: "VERIFIED", status: "CONFIRMED" })
  now += 365 * 24 * 3_600_000
  assert.equal(store.entries(OWNER).length, 1, "no expiry")
  assert.ok(Object.isFrozen(store.get("claim-1")))
})

test("one explicit action per candidate at a time", () => {
  const store = createKnownHashStore()
  store.remember(candidate())
  assert.equal(store.begin("claim-1"), true)
  assert.equal(store.begin("claim-1"), false)
  assert.equal(store.get("claim-1")?.busy, true)
  store.end("claim-1")
  assert.equal(store.get("claim-1")?.busy, false)
  assert.equal(store.begin("missing"), false)
})

test("the store is bounded: finished entries go first, then the oldest; a running action is never evicted", () => {
  const store = createKnownHashStore({ limit: 3 })
  for (const id of ["c1", "c2", "c3"]) store.remember(candidate({ claimId: id }))
  store.settle("c2", `0x${"1".repeat(64)}`, { kind: "VERIFIED", status: "CONFIRMED" })
  store.remember(candidate({ claimId: "c4" }))
  assert.deepEqual(store.entries(OWNER).map((entry) => entry.claimId), ["c1", "c3", "c4"])
  store.begin("c1")
  store.remember(candidate({ claimId: "c5" }))
  assert.deepEqual(store.entries(OWNER).map((entry) => entry.claimId), ["c1", "c4", "c5"], "the oldest idle one (c3) goes; busy c1 stays")
  assert.equal(store.dropped(), 2)
  assert.throws(() => createKnownHashStore({ limit: 0 }))
})

test("product sources: memory only, no credentials kept, and recovery never claims, opens the wallet or reads policy", () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const product = readdirSync(dir).filter((name) => /\.(ts|tsx)$/.test(name) && !name.includes(".test."))
  assert.ok(product.includes("recover.ts") && product.includes("store.ts") && product.includes("capture.ts"))
  const code = (name: string) => readFileSync(join(dir, name), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
  for (const name of product) {
    const source = code(name)
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie|caches\.|BroadcastChannel/, name)
    assert.doesNotMatch(source, /testing\//, name)
    assert.doesNotMatch(source, /window\.ethereum|eth_sendTransaction|requestTransaction/, name)
  }
  const recover = code("recover.ts")
  assert.doesNotMatch(recover, /\.claim\(|\.approve\(|\.submit\(|readExecutionPolicy|refreshEvidence|deadline/)
  assert.match(recover, /createSubmissionGate/)
  const store = code("store.ts")
  assert.doesNotMatch(store, /accessToken|HostSession/)
})
