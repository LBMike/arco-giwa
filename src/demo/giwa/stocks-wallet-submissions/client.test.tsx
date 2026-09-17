import test from "node:test"
import assert from "node:assert/strict"
import type { HostSession } from "../stocks-host/session"
import type { AttemptRecord, Transaction } from "../stocks-wallet/types"
import { digest } from "../stocks-wallet/planner"
import { createSubmissionGate, type SubmissionClientOptions } from "./client"

const A = "0x1111111111111111111111111111111111111111", B = "0x2222222222222222222222222222222222222222"
const KEY = "a".repeat(64), DEPLOYMENT = "b".repeat(64), HASH = `0x${"c".repeat(64)}` as const
const TX: Transaction = { chainId: 91342, from: A, to: B, data: "0x12345678", value: "0" }
const CLAIM: AttemptRecord = { claimId: "claim-1", intentKey: KEY, stage: "TRANSFER", transactionDigest: digest(TX), status: "REQUEST_MAY_START" }
const INPUT = { intentKey: KEY, stage: "TRANSFER" as const, transactionDigest: digest(TX), transaction: TX, orderId: "order-1", deploymentDigest: DEPLOYMENT }
const SESSION: HostSession = { id: "session:A:1", walletAddress: A, chainId: 91342, accessToken: "original.token.A", createdAt: 1000, expiresAt: 900000 }
const envelope = (data: unknown) => ({ profile: "DEMO_TESTNET", valuePolicy: "TEST_VALUE_ONLY", brokerMode: "MOCK_BROKER", chainId: 91342, priceSource: "FIXED_MOCK_PRICE", observedAt: "2026-09-17T00:00:00.000Z", data })
const response = (data: unknown) => Response.json(envelope(data))
const empty = { intentKey: KEY, approval: null, transfer: null }
function fixture(overrides: Partial<SubmissionClientOptions> = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  let impl: typeof fetch = async url => response(String(url).endsWith("claims") ? CLAIM : empty)
  const options: SubmissionClientOptions = { session: { ...SESSION }, side: "BUY", orderId: "order-1", deploymentDigest: DEPLOYMENT, apiBase: "https://api.fixture/", now: () => 2000, ...overrides,
    fetch: overrides.fetch ?? (async (url, init) => { calls.push({ url: String(url), init: init! }); return impl(url, init) }) }
  return { options, calls, gate: createSubmissionGate(options), setFetch(value: typeof fetch) { impl = value } }
}
const reject = (fn: () => Promise<unknown>, code: string) => assert.rejects(fn, error => (error as { code?: string }).code === code)

test("inspect and sole new claim use fixed authenticated profile and exact route/body", async () => {
  const f = fixture(); assert.deepEqual(await f.gate.inspect(KEY), { approval: null, transfer: null })
  assert.deepEqual(await f.gate.claim(INPUT), CLAIM)
  assert.equal(f.calls[0].url, "https://api.fixture/api/v1/stocks/wallet-submissions/BUY/order-1")
  assert.deepEqual(JSON.parse(String(f.calls[1].init.body)), { side: "BUY", ...INPUT })
  for (const { init } of f.calls) { assert.equal(new Headers(init.headers).get("authorization"), "Bearer original.token.A"); assert.equal(init.credentials, "omit"); assert.equal(init.cache, "no-store"); assert.equal(init.redirect, "error") }
  assert.equal(Object.isFrozen(f.gate), true)
})
test("SELL has its own immutable path; caller wallet mismatch fails before transport", async () => {
  const f = fixture({ side: "SELL" }); await f.gate.inspect(KEY); assert.match(f.calls[0].url, /\/SELL\/order-1$/)
  assert.throws(() => fixture({ walletAddress: B }), /SUBMISSION_WALLET_MISMATCH/)
})
test("null claims stay null, including caller-driven retry after a lost response; never automatic resend", async () => {
  const f = fixture(); f.setFetch(async () => { throw new Error("secret transport detail") })
  await reject(() => f.gate.claim(INPUT), "SUBMISSION_REQUEST_FAILED"); assert.equal(f.calls.length, 1)
  f.setFetch(async () => response(null)); assert.equal(await f.gate.claim(INPUT), null); assert.equal(f.calls.length, 2)
})
test("inspect HTTP errors never become an empty journal", async () => {
  for (const status of [403,404,409,500]) { const f = fixture({ fetch: async () => new Response("private", { status }) }); await reject(() => f.gate.inspect(KEY), "SUBMISSION_HTTP_ERROR") }
})
test("late outcome stays bound to copied original session even if caller mutates options/session", async () => {
  const f = fixture(); const claim = (await f.gate.claim(INPUT))!
  Object.assign(f.options.session, { id: "session:B", accessToken: "tokenB", walletAddress: B })
  Object.assign(f.options, { apiBase: "https://b.fixture", orderId: "order-B", deploymentDigest: "d".repeat(64) })
  f.setFetch(async (_url, init) => response(JSON.parse(String(init?.body))))
  await f.gate.record({ ...claim, status: "SUBMITTED", txHash: HASH })
  const last = f.calls[f.calls.length - 1]!
  assert.match(last.url, /^https:\/\/api.fixture\//); assert.equal(new Headers(last.init.headers).get("authorization"), "Bearer original.token.A")
  assert.equal(JSON.parse(String(last.init.body)).txHash, HASH)
})
test("late401 invalidates only captured session id even with a reentrant replacement callback", async () => {
  let resolve!: (r: Response) => void; const invalidated: string[] = []
  const f = fixture({ onSessionRejected: id => { invalidated.push(id); Object.assign(f.options, { session: { ...SESSION, id: "B" } }); throw Error("callback-private") }, fetch: () => new Promise(r => { resolve = r }) })
  const pending = f.gate.inspect(KEY); Object.assign(f.options.session, { id: "B", accessToken: "B" }); resolve(new Response("private", { status: 401 }))
  await reject(() => pending, "SUBMISSION_AUTH_REJECTED"); assert.deepEqual(invalidated, [SESSION.id])
})
test("missing, expired and backward-clock sessions fail closed; expiry during body never grants claim", async () => {
  for (const session of [{ ...SESSION, expiresAt: 1500 }, { ...SESSION, accessToken: "" }, { ...SESSION, chainId: 1 }]) assert.throws(() => fixture({ session: session as HostSession }), /SUBMISSION_AUTH_REQUIRED/)
  let wall = 2000; const f = fixture({ now: () => wall }); wall = 1999; await reject(() => f.gate.inspect(KEY), "SUBMISSION_AUTH_REQUIRED"); assert.equal(f.calls.length, 0)
  let time = 2000; const g = fixture({ now: () => time, fetch: async () => { time = 900001; return response(CLAIM) } }); await reject(() => g.gate.claim(INPUT), "SUBMISSION_AUTH_REQUIRED")
})
test("monotonic session expiry still fails if local wall clock is frozen", async () => {
  let mono = 0; const f = fixture({ monotonicNow: () => mono }); mono = 900000; await reject(() => f.gate.inspect(KEY), "SUBMISSION_AUTH_REQUIRED")
})
test("strict profile, envelope timestamp and exact fields reject malformed success", async () => {
  const bad = [ { ...envelope(empty), chainId: 1 }, { ...envelope(empty), priceSource: "LIVE" }, { ...envelope(empty), secret: true }, { ...envelope(empty), observedAt: "2026-02-31T00:00:00.000Z" }, { ...envelope(empty), observedAt: "yesterday" } ]
  for (const payload of bad) { const f = fixture({ fetch: async () => Response.json(payload) }); await assert.rejects(() => f.gate.inspect(KEY)) }
})
test("inspect verifies expected intent, record stage and exact record fields", async () => {
  const bad = [ { ...empty, intentKey: "d".repeat(64) }, { ...empty, transfer: { ...CLAIM, stage: "APPROVAL" } }, { ...empty, transfer: { ...CLAIM, intentKey: "d".repeat(64) } }, { ...empty, transfer: { ...CLAIM, extra: 1 } }, { ...empty, transfer: { ...CLAIM, status: "CONFIRMED" } }, { ...empty, transfer: { ...CLAIM, status: "SUBMITTED" } }, { ...empty, transfer: { ...CLAIM, txHash: HASH } } ]
  for (const value of bad) { const f = fixture({ fetch: async () => response(value) }); await assert.rejects(() => f.gate.inspect(KEY)) }
})
test("local order/deployment/intent/from/chain/value/calldata/digest mismatches never reach HTTP", async () => {
  const bad = [ { ...INPUT, orderId: "another" }, { ...INPUT, deploymentDigest: "d".repeat(64) }, { ...INPUT, transactionDigest: "d".repeat(64) }, ...[{ ...TX, from: B }, { ...TX, chainId: 1 }, { ...TX, value: "1" }, { ...TX, data: "0x123" }, { ...TX, gas: "1" }].map(transaction => ({ ...INPUT, transaction })) ]
  for (const input of bad) { const f = fixture(); await assert.rejects(() => f.gate.claim(input as typeof INPUT)); assert.equal(f.calls.length, 0) }
  const f = fixture(); await f.gate.inspect(KEY); await reject(() => f.gate.inspect("d".repeat(64)), "SUBMISSION_SCOPE_MISMATCH"); assert.equal(f.calls.length, 1)
})
test("claim refuses recovered, mismatched and malformed permission records", async () => {
  for (const value of [{ ...CLAIM, status: "UNKNOWN" }, { ...CLAIM, status: "SUBMITTED", txHash: HASH }, { ...CLAIM, transactionDigest: "d".repeat(64) }, { ...CLAIM, stage: "APPROVAL" }, { ...CLAIM, claimId: "../bad" }]) {
    const f = fixture({ fetch: async () => response(value) }); await assert.rejects(() => f.gate.claim(INPUT))
  }
})
test("record requires observed immutable claim binding and prohibits client terminal reports", async () => {
  const f = fixture(); await reject(() => f.gate.record({ ...CLAIM, status: "UNKNOWN" }), "SUBMISSION_SCOPE_MISMATCH"); await f.gate.claim(INPUT)
  for (const input of [{ ...CLAIM, claimId: "different", status: "UNKNOWN" }, { ...CLAIM, status: "CONFIRMED" }, { ...CLAIM, status: "REVERTED" }, CLAIM, { ...CLAIM, status: "SUBMITTED", txHash: `0x${"0".repeat(64)}` }]) await assert.rejects(() => f.gate.record(input as AttemptRecord))
  assert.equal(f.calls.length, 1)
})
test("recovered claim can report UNKNOWN then SUBMITTED; UNKNOWN after submission preserves hash", async () => {
  const f = fixture(); f.setFetch(async () => response({ ...empty, transfer: CLAIM })); await f.gate.inspect(KEY)
  f.setFetch(async (_url, init) => response(JSON.parse(String(init?.body)))); await f.gate.record({ ...CLAIM, status: "UNKNOWN" }); await f.gate.record({ ...CLAIM, status: "SUBMITTED", txHash: HASH })
  f.setFetch(async () => response({ ...CLAIM, status: "SUBMITTED", txHash: HASH })); await f.gate.record({ ...CLAIM, status: "UNKNOWN" })
  await reject(() => f.gate.record({ ...CLAIM, status: "SUBMITTED", txHash: `0x${"d".repeat(64)}` }), "SUBMISSION_HASH_MISMATCH")
})
test("outcome responses cannot change claim, erase a submitted hash, or introduce a conflicting hash", async () => {
  for (const changed of [{ claimId: "other" }, { status: "UNKNOWN", txHash: undefined }, { txHash: `0x${"d".repeat(64)}` }]) {
    const f = fixture(); await f.gate.claim(INPUT); f.setFetch(async () => response({ ...CLAIM, status: "SUBMITTED", txHash: HASH, ...changed })); await assert.rejects(() => f.gate.record({ ...CLAIM, status: "SUBMITTED", txHash: HASH }))
  }
})
test("transport times out a fetch which ignores abort without retry", async () => {
  let calls = 0; const f = fixture({ timeoutMs: 10, fetch: () => { calls++; return new Promise(() => {}) } }); await reject(() => f.gate.inspect(KEY), "SUBMISSION_TIMEOUT"); assert.equal(calls, 1)
})
test("transport times out stalled body and cancels its reader", async () => {
  let cancelled = false; const f = fixture({ timeoutMs: 10, fetch: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel() { cancelled = true } })) });
  await reject(() => f.gate.inspect(KEY), "SUBMISSION_TIMEOUT"); assert.equal(cancelled, true)
})
test("body limit rejects declared and streamed excess, malformed JSON and invalid UTF8", async () => {
  for (const make of [() => new Response("", { headers: { "content-length": "40000" } }), () => new Response("x".repeat(40000)), () => new Response("not JSON"), () => new Response(new Uint8Array([255]))]) {
    const f = fixture({ fetch: async () => make() }); await assert.rejects(() => f.gate.inspect(KEY))
  }
})
test("elapsed checks reject delayed fetch/body despite timers not firing", async () => {
  let mono = 0; const f = fixture({ timeoutMs: 10, monotonicNow: () => mono, fetch: async () => { mono = 11; return response(empty) } }); await reject(() => f.gate.inspect(KEY), "SUBMISSION_TIMEOUT")
  mono = 0
  const parse = JSON.parse
  const g = fixture({ timeoutMs: 10, monotonicNow: () => mono })
  try {
    JSON.parse = (...args: Parameters<typeof JSON.parse>) => { const value = parse(...args); mono = 11; return value }
    await reject(() => g.gate.inspect(KEY), "SUBMISSION_TIMEOUT")
  } finally { JSON.parse = parse }

})
test("invalid API origins, unsafe IDs and invalid timeout are rejected before transport", () => {
  for (const apiBase of ["file:///tmp/data", "https://user:pass@api.fixture", "https://api.fixture/?token=x"]) assert.throws(() => fixture({ apiBase }))
  assert.throws(() => fixture({ orderId: "../order" })); assert.throws(() => fixture({ timeoutMs: NaN }))
})

test("an already observed claim is never returned twice as new signing permission", async () => {
  const f = fixture(); await f.gate.claim(INPUT)
  await reject(() => f.gate.claim(INPUT), "SUBMISSION_REPLAYED_PERMISSION")
  f.setFetch(async () => response(null)); assert.equal(await f.gate.claim(INPUT), null)
})
