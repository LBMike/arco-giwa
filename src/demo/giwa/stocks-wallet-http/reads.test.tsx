import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { digest } from "../stocks-wallet/planner"
import { describeCode } from "../stocks-wallet-ui/messages"
import { createExecutionClock } from "./clock"
import { createStocksExecutionReads, type StocksExecutionReadsOptions } from "./reads"
import { EXECUTION_READ_CODES, StocksExecutionReadError, type ExecutionReadCode } from "./errors"
import { API, catalog, clocks, deferred, DIGEST, envelope, evidence, fakeFetch, json, manifest, ORDER_ID, orderRow, policy, read, START, TOKEN, WALLET, type Call } from "./test-support"

type Clocks = ReturnType<typeof clocks>

function setup(respond: (call: Call, index: number) => Response | Promise<Response>, options: Partial<StocksExecutionReadsOptions> = {}, clock: Clocks = clocks()) {
  const http = fakeFetch(respond)
  const rejected: string[] = []
  const reads = createStocksExecutionReads({ apiBase: API, fetch: http.fetch, now: clock.now, monotonicNow: clock.monotonicNow, onSessionRejected: (id) => rejected.push(id), ...options })
  return { reads, calls: http.calls, rejected, clock }
}

async function rejectsWith(promise: Promise<unknown>, code: ExecutionReadCode, extra: { reason?: string; status?: number | null } = {}) {
  const error = await promise.then(
    () => assert.fail(`expected ${code}`),
    (value: unknown) => value,
  )
  assert.ok(error instanceof StocksExecutionReadError, `expected StocksExecutionReadError, got ${String(error)}`)
  assert.equal(error.code, code, `reason ${error.reason}`)
  if (extra.reason !== undefined) assert.equal(error.reason, extra.reason)
  if (extra.status !== undefined) assert.equal(error.status, extra.status)
  return error
}

const route = (call: Call) => new URL(call.url).pathname

/** A server answering every read with the given DTOs (defaults are valid at START). */
function server(overrides: { deployment?: unknown; policy?: unknown; order?: unknown; catalog?: unknown } = {}) {
  return (call: Call) => {
    const path = route(call)
    if (path === "/api/v1/stocks/execution/deployment") return json(overrides.deployment ?? envelope(evidence()))
    if (path.startsWith("/api/v1/stocks/execution/")) {
      const side = path.split("/")[5] as "BUY" | "SELL"
      return json(overrides.policy ?? envelope(policy(side)))
    }
    if (path.startsWith("/api/v1/stocks/sell-orders/")) return json(overrides.order ?? envelope(orderRow("SELL")))
    if (path.startsWith("/api/v1/stocks/orders/")) return json(overrides.order ?? envelope(orderRow("BUY")))
    if (path === "/api/v1/stocks/catalog") return json(overrides.catalog ?? catalog())
    return json({ error: "NOT_FOUND" }, 404)
  }
}

test("creation performs no request and refuses an unusable API base or timeout", () => {
  const { calls } = setup(server())
  assert.equal(calls.length, 0)
  for (const apiBase of ["not a url", "ftp://stocks-api.test", "https://user:pass@stocks-api.test", "https://stocks-api.test/?q=1", "https://stocks-api.test/#h", "https://stocks-api.test?", "https://stocks-api.test/?", "https://stocks-api.test#", "https://stocks-api.test/api?"]) {
    assert.throws(() => createStocksExecutionReads({ apiBase }), (error: unknown) => error instanceof StocksExecutionReadError && error.code === "INVALID_CONTEXT", apiBase)
  }
  for (const timeoutMs of [0, -1, 15_001, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createStocksExecutionReads({ apiBase: API, timeoutMs }), StocksExecutionReadError, String(timeoutMs))
  }
})

test("each read sends exactly one bounded GET: captured bearer token, no cookies, no cache, no redirects, no body", async () => {
  const { reads, calls } = setup(server())
  const caller = new AbortController()
  await reads.readDeployment({ apiBase: API, token: TOKEN, sessionId: "session-a", signal: caller.signal })
  await reads.readExecutionPolicy(read("BUY", { signal: caller.signal }))
  await reads.readExecutionPolicy(read("SELL", { signal: caller.signal, orderId: "order:with:colons" })).catch(() => undefined)
  await reads.readOrder(read("BUY", { signal: caller.signal }))
  await reads.readOrder(read("SELL", { signal: caller.signal }))
  await reads.readCatalog(read("BUY", { signal: caller.signal }))
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      `${API}/api/v1/stocks/execution/deployment`,
      `${API}/api/v1/stocks/execution/BUY/${ORDER_ID}`,
      `${API}/api/v1/stocks/execution/SELL/order%3Awith%3Acolons`,
      `${API}/api/v1/stocks/orders/${ORDER_ID}`,
      `${API}/api/v1/stocks/sell-orders/${ORDER_ID}`,
      `${API}/api/v1/stocks/catalog`,
    ],
  )
  calls.forEach((call, index) => {
    const catalogRead = index === calls.length - 1
    assert.equal(call.init.method, "GET")
    assert.equal(call.init.body, undefined)
    assert.equal(call.init.credentials, "omit")
    assert.equal(call.init.cache, "no-store")
    assert.equal(call.init.redirect, "error")
    assert.deepEqual(call.init.headers, catalogRead ? { accept: "application/json" } : { accept: "application/json", authorization: `Bearer ${TOKEN}` }, "the public catalog never receives the token")
    assert.ok(call.init.signal instanceof AbortSignal && call.init.signal !== caller.signal, "an internal signal linked to the caller's")
  })
})

test("actual DTO shapes are accepted: evidence lease, policy, BUY and SELL order envelopes with PROFILE, top-level catalog", async () => {
  const { reads } = setup(server())
  const lease = await reads.readDeployment({ apiBase: API, token: TOKEN, sessionId: "session-a", signal: new AbortController().signal, deploymentDigest: DIGEST })
  assert.deepEqual(lease.deployment, evidence())
  assert.equal(lease.sessionId, "session-a")
  assert.equal(lease.apiBase, API)
  assert.ok(Object.isFrozen(lease) && Object.isFrozen(lease.deployment) && Object.isFrozen(lease.deployment.manifest))
  assert.equal(reads.currentDeployment(lease), lease.deployment)

  for (const side of ["BUY", "SELL"] as const) {
    const allowed = await reads.readExecutionPolicy(read(side))
    assert.deepEqual(allowed, policy(side), "server dates are kept exactly")
    assert.ok(Object.isFrozen(allowed))
    const order = (await reads.readOrder(read(side))) as Record<string, unknown>
    assert.deepEqual(order, envelope(orderRow(side)), "the original envelope, PROFILE fields included")
    assert.equal((order.data as Record<string, unknown>).side, side === "SELL" ? "SELL" : undefined)
    assert.ok(Object.isFrozen(order) && Object.isFrozen(order.data))
  }
  assert.deepEqual(await reads.readCatalog(read()), catalog())
})

test("the request is captured when the call starts: a later host change never alters token, scope or the 401 target", async () => {
  const held = deferred<Response>()
  const { reads, calls, rejected } = setup(() => held.promise)
  const request = { ...read("BUY") }
  const pending = reads.readExecutionPolicy(request)
  // The host moves to another account and order while the response is outstanding.
  Object.assign(request, { token: "other.token.value", sessionId: "session-b", orderId: "order-2", side: "SELL" })
  held.resolve(json({ error: "UNAUTHORIZED", ...envelope(null) }, 401))
  await rejectsWith(pending, "SESSION_REJECTED", { status: 401, reason: "UNAUTHENTICATED" })
  assert.deepEqual(rejected, ["session-a"], "only the captured session is invalidated")
  assert.equal(calls[0]!.url, `${API}/api/v1/stocks/execution/BUY/${ORDER_ID}`)
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`)
})

test("401 notifies once with the captured id even if the callback throws; the public catalog never invalidates", async () => {
  let calls = 0
  const reads = createStocksExecutionReads({ apiBase: API, fetch: async () => json({ error: "UNAUTHORIZED" }, 401), onSessionRejected: () => { calls++; throw new Error("host failure") } })
  await rejectsWith(reads.readOrder(read()), "SESSION_REJECTED", { status: 401 })
  await rejectsWith(reads.readDeployment({ apiBase: API, token: TOKEN, sessionId: "session-a", signal: new AbortController().signal }), "SESSION_REJECTED", { status: 401 })
  assert.equal(calls, 2)
  // No status 401 either: the wallet controller would otherwise treat it as a session rejection.
  await rejectsWith(reads.readCatalog(read()), "REQUEST_FAILED", { status: null })
  assert.equal(calls, 2)
})

test("invalid requests never reach the network: other API base, missing token/session/signal, bad side, id or digest", async () => {
  const { reads, calls } = setup(server())
  const bad: [string, Record<string, unknown>][] = [
    ["other api", { apiBase: "https://evil.test" }],
    ["api with path", { apiBase: `${API}/other` }],
    ["api with empty query", { apiBase: `${API}?` }],
    ["no token", { token: "" }],
    ["token with space", { token: "a b" }],
    ["no session", { sessionId: "" }],
    ["no signal", { signal: undefined }],
    ["side", { side: "HOLD" }],
    ["order id", { orderId: "../admin" }],
    ["digest", { deploymentDigest: "F".repeat(64) }],
  ]
  for (const [label, change] of bad) {
    const request = { ...read(), ...change } as never
    const error = await rejectsWith(reads.readExecutionPolicy(request), "INVALID_CONTEXT")
    assert.equal(error.reason, label === "other api" || label === "api with path" ? "API_BASE_MISMATCH" : "INVALID_REQUEST", label)
    if (!label.includes("token") && !label.includes("session")) await rejectsWith(reads.readOrder(request), "INVALID_CONTEXT")
  }
  await rejectsWith(reads.readDeployment({ apiBase: API, token: TOKEN, sessionId: "session-a", signal: new AbortController().signal, deploymentDigest: "not-a-digest" }), "INVALID_CONTEXT")
  await rejectsWith(reads.readCatalog({ ...read(), apiBase: "https://evil.test" }), "INVALID_CONTEXT", { reason: "API_BASE_MISMATCH" })
  assert.equal(calls.length, 0)
  // A trailing slash is the same base.
  await reads.readCatalog({ ...read(), apiBase: `${API}/` })
  assert.equal(calls.length, 1)
})

test("policy: wrong scope, allowed other than true, extra fields and non-integer times fail closed", async () => {
  const cases: [string, unknown, ExecutionReadCode][] = [
    ["other order", envelope(policy("BUY", { orderId: "order-2" })), "EXECUTION_NOT_ALLOWED"],
    ["other side", envelope(policy("SELL")), "EXECUTION_NOT_ALLOWED"],
    ["other deployment", envelope(policy("BUY", { deploymentDigest: "e".repeat(64) })), "EXECUTION_NOT_ALLOWED"],
    ["allowed false", envelope(policy("BUY", { allowed: false })), "EXECUTION_NOT_ALLOWED"],
    ["allowed string", envelope(policy("BUY", { allowed: "true" })), "EXECUTION_NOT_ALLOWED"],
    ["extra field", envelope({ ...policy("BUY"), wallet: WALLET }), "INVALID_RESPONSE"],
    ["missing field", envelope({ ...policy("BUY"), validUntil: undefined }), "INVALID_RESPONSE"],
    ["fractional ms", envelope(policy("BUY", { observedAt: START - 500.5 })), "INVALID_RESPONSE"],
    ["ISO times", envelope(policy("BUY", { validUntil: new Date(START + 14_000).toISOString() })), "INVALID_RESPONSE"],
    ["data null", envelope(null), "INVALID_RESPONSE"],
  ]
  for (const [label, body, code] of cases) {
    const { reads } = setup(server({ policy: body }))
    await rejectsWith(reads.readExecutionPolicy(read("BUY")), code).catch((error) => assert.fail(`${label}: ${error}`))
  }
})

test("policy and evidence leases: future, expired, longer than 15 s or older than their envelope are refused", async () => {
  const policyCases: [string, Record<string, unknown>, ExecutionReadCode, string][] = [
    ["future", { observedAt: START + 1, validUntil: START + 10_000 }, "STALE_RESPONSE", "FUTURE"],
    ["expired", { observedAt: START - 15_000, validUntil: START }, "EXECUTION_POLICY_EXPIRED", "EXPIRED"],
    ["long-lived", { observedAt: START - 1, validUntil: START + 15_000 }, "EXECUTION_NOT_ALLOWED", "LEASE_TOO_LONG"],
    ["inverted", { observedAt: START, validUntil: START }, "EXECUTION_NOT_ALLOWED", "LEASE_TOO_LONG"],
  ]
  for (const [label, times, code, reason] of policyCases) {
    const { reads } = setup(server({ policy: envelope(policy("BUY", times)) }))
    await rejectsWith(reads.readExecutionPolicy(read("BUY")), code, { reason }).catch((error) => assert.fail(`policy ${label}: ${error}`))
  }
  // The lease may not start after the envelope that carries it.
  const { reads: late } = setup(server({ policy: envelope(policy("BUY", { observedAt: START - 10, validUntil: START + 5_000 }), START - 20) }))
  await rejectsWith(late.readExecutionPolicy(read("BUY")), "STALE_RESPONSE", { reason: "FUTURE" })

  const deploymentCases: [string, Record<string, unknown>, ExecutionReadCode][] = [
    ["future", { verifiedAt: START + 1, validUntil: START + 5_000 }, "DEPLOYMENT_EVIDENCE_EXPIRED"],
    ["expired", { verifiedAt: START - 15_000, validUntil: START }, "DEPLOYMENT_EVIDENCE_EXPIRED"],
    ["day-long fixture lease", { verifiedAt: START - 1_000, validUntil: START + 86_400_000 }, "DEPLOYMENT_NOT_REVIEWED"],
    ["just over 15 s", { verifiedAt: START - 1_000, validUntil: START + 14_001 }, "DEPLOYMENT_NOT_REVIEWED"],
  ]
  for (const [label, times, code] of deploymentCases) {
    const { reads } = setup(server({ deployment: envelope(evidence(times)) }))
    await rejectsWith(reads.readDeployment({ apiBase: API, token: TOKEN, sessionId: "session-a", signal: new AbortController().signal }), code).catch((error) => assert.fail(`evidence ${label}: ${error}`))
  }
})

test("evidence: only VERIFIED, exact public manifest, five code hashes, matching digest and expected scope", async () => {
  const altered = { ...manifest(), deploymentId: "other-deployment-1" }
  const sixHashes = { ...manifest(), codeHashes: { ...manifest().codeHashes, [`0x${"9".repeat(40)}`]: `0x${"b".repeat(64)}` } }
  const cases: [string, unknown, ExecutionReadCode, string?][] = [
    ["status", envelope(evidence({ status: "PENDING" })), "DEPLOYMENT_NOT_REVIEWED"],
    ["extra data field", envelope({ ...evidence(), rpcUrl: "https://private.example" }), "INVALID_RESPONSE"],
    ["extra manifest field", envelope(evidence({ manifest: { ...manifest(), privateNote: "x" } })), "INVALID_RESPONSE"],
    ["six code hashes", envelope(evidence({ manifest: sixHashes })), "INVALID_RESPONSE"],
    ["manifest changed under the same digest", envelope(evidence({ manifest: altered })), "MANIFEST_DIGEST_MISMATCH"],
    ...(["abiDigest", "finalityPolicy", "nonUpgradeable"] as const).map((field): [string, unknown, ExecutionReadCode] => {
      // Correctly digested, so only the planner's supported-deployment check can refuse it.
      const unsupported = { ...manifest(), [field]: field === "abiDigest" ? "0".repeat(64) : field === "finalityPolicy" ? "LATEST" : false }
      return [`unsupported ${field}`, envelope(evidence({ manifest: unsupported, manifestDigest: digest(unsupported) })), "UNSUPPORTED_DEPLOYMENT"]
    }),
    ["expected digest", envelope(evidence()), "MANIFEST_DIGEST_MISMATCH", "e".repeat(64)],
  ]
  for (const [label, body, code, expected] of cases) {
    const { reads } = setup(server({ deployment: body }))
    const request = { apiBase: API, token: TOKEN, sessionId: "session-a", signal: new AbortController().signal, ...(expected ? { deploymentDigest: expected } : {}) }
    await rejectsWith(reads.readDeployment(request), code).catch((error) => assert.fail(`${label}: ${error}`))
  }
})

test("order envelope: PROFILE, other order or deployment, investor and planner validation all fail closed", async () => {
  const cases: [string, "BUY" | "SELL", unknown, ExecutionReadCode][] = [
    ["profile dropped (investor getOrder shape)", "BUY", { observedAt: new Date(START).toISOString(), data: orderRow("BUY") }, "INVALID_RESPONSE"],
    ["other profile", "BUY", { ...envelope(orderRow("BUY")), valuePolicy: "REAL_VALUE" }, "INVALID_RESPONSE"],
    ["extra envelope field", "BUY", { ...envelope(orderRow("BUY")), wallet: WALLET }, "INVALID_RESPONSE"],
    // A wrong row is a wrong answer, not evidence that the order moved on.
    ["other order", "BUY", envelope(orderRow("BUY", { id: "order-2" })), "INVALID_RESPONSE"],
    ["other deployment", "BUY", envelope(orderRow("BUY", { deploymentDigest: "e".repeat(64) })), "INVALID_RESPONSE"],
    ["SELL row without side", "SELL", envelope({ ...orderRow("SELL"), side: undefined }), "INVALID_RESPONSE"],
    ["BUY row labelled SELL", "BUY", envelope(orderRow("BUY", { side: "SELL" })), "INVALID_RESPONSE"],
    ["numeric quantity", "BUY", envelope(orderRow("BUY", { quantity: 1000000000 })), "INVALID_RESPONSE"],
    ["decimal quantity", "BUY", envelope(orderRow("BUY", { quantity: "1.5" })), "INVALID_RESPONSE"],
    ["actor not the wallet", "BUY", envelope(orderRow("BUY", { actorId: "evm:0x2222222222222222222222222222222222222222" })), "INVALID_RESPONSE"],
    ["unknown state", "BUY", envelope(orderRow("BUY", { state: "SETTLED" })), "INVALID_RESPONSE"],
    ["non-canonical observedAt", "BUY", { ...envelope(orderRow("BUY")), observedAt: "2026-09-17T00:00:00Z" }, "INVALID_RESPONSE"],
  ]
  for (const [label, side, body, code] of cases) {
    const { reads } = setup(server({ order: body }))
    await rejectsWith(reads.readOrder(read(side)), code).catch((error) => assert.fail(`${label}: ${error}`))
  }
})

const CONTRACTS = { cashToken: `0x${"11".repeat(20)}`, fundingVault: `0x${"22".repeat(20)}`, stockToken: `0x${"33".repeat(20)}`, redemptionEscrow: `0x${"44".repeat(20)}` }

test("catalog: exact public shape; it is never deployment evidence or permission", async () => {
  const cases: [string, unknown][] = [
    ["data envelope", envelope(catalog())],
    ["extra field", { ...catalog(), verified: true }],
    ["extra instrument field", { ...catalog(), instruments: [{ ...catalog().instruments[0], allowed: true }] }],
    ["profile", { ...catalog(), chainId: 1 }],
    ["price as number", { ...catalog(), instruments: [{ ...catalog().instruments[0], price: 120 }] }],
    ["token address not lower-case", { ...catalog(), instruments: [{ ...catalog().instruments[0], tokenAddress: `0x${"AB".repeat(20)}` }] }],
    ["token address malformed", { ...catalog(), instruments: [{ ...catalog().instruments[0], tokenAddress: "0x1234" }] }],
    ["contracts with an extra key", { ...catalog(), contracts: { ...CONTRACTS, mintController: `0x${"55".repeat(20)}` } }],
    ["contracts not lower-case", { ...catalog(), contracts: { ...CONTRACTS, fundingVault: `0x${"AA".repeat(20)}` } }],
    ["contracts overlapping", { ...catalog(), contracts: { ...CONTRACTS, redemptionEscrow: CONTRACTS.fundingVault } }],
    ["contracts' stock token not the published NVDA token", { ...catalog(), instruments: [{ ...catalog().instruments[0], tokenAddress: `0x${"ab".repeat(20)}` }], contracts: CONTRACTS }],
  ]
  for (const [label, body] of cases) {
    const { reads } = setup(server({ catalog: body }))
    await rejectsWith(reads.readCatalog(read()), "INVALID_RESPONSE").catch((error) => assert.fail(`${label}: ${error}`))
  }
  // The server publishes the verified NVDA token for read-only balance display, and the deployment's contracts for
  // direct trades; they are the only optional keys.
  const published = { ...catalog(), instruments: [{ ...catalog().instruments[0], tokenAddress: `0x${"ab".repeat(20)}` }] }
  assert.deepEqual(await setup(server({ catalog: published })).reads.readCatalog(read()), published)
  const direct = { ...catalog(), instruments: [{ ...catalog().instruments[0], tokenAddress: CONTRACTS.stockToken }], contracts: CONTRACTS }
  assert.deepEqual(await setup(server({ catalog: direct })).reads.readCatalog(read()), direct)
  const reads = setup(server()).reads
  const value = (await reads.readCatalog(read())) as Record<string, unknown>
  assert.equal("status" in value || "allowed" in value || "manifestDigest" in value, false)
})

test("envelope freshness: future or 15 s old responses are refused, including stale catalogs", async () => {
  for (const [label, at, code] of [["future", START + 1, "STALE_RESPONSE"], ["old", START - 15_000, "STALE_RESPONSE"]] as const) {
    const { reads } = setup(server({ order: envelope(orderRow("BUY"), at), catalog: catalog(at), policy: envelope(policy("BUY"), at) }))
    await rejectsWith(reads.readOrder(read()), code).catch((error) => assert.fail(`order ${label}: ${error}`))
    await rejectsWith(reads.readCatalog(read()), code).catch((error) => assert.fail(`catalog ${label}: ${error}`))
  }
})

test("request delay counts by monotonic time: a stalled wall clock cannot keep a lease alive, a stepped-back one fails", async () => {
  // The wall clock does not move while 14.6 s pass on the monotonic clock during the request.
  const frozen = clocks()
  const slow = setup(async () => {
    frozen.advanceMonotonic(14_600)
    return json(envelope(policy("BUY")))
  }, { timeoutMs: 15_000 }, frozen)
  await rejectsWith(slow.reads.readExecutionPolicy(read("BUY")), "EXECUTION_POLICY_EXPIRED", { reason: "EXPIRED" })

  const rolled = clocks()
  const back = setup(async () => {
    rolled.setWall(START - 10_000)
    return json(envelope(evidence({ verifiedAt: START - 12_000, validUntil: START + 2_000 }), START - 10_000))
  }, {}, rolled)
  await rejectsWith(back.reads.readDeployment({ apiBase: API, token: TOKEN, sessionId: "session-a", signal: new AbortController().signal }), "READ_TIMEOUT", { reason: "CLOCK" })

  const elapsed = clocks()
  const tooSlow = setup(async () => {
    elapsed.advance(10_000)
    return json(envelope(policy("BUY", { observedAt: START + 9_000, validUntil: START + 20_000 }), START + 9_500))
  }, {}, elapsed)
  await rejectsWith(tooSlow.reads.readExecutionPolicy(read("BUY")), "READ_TIMEOUT", { reason: "TIMEOUT" })
})

test("currentDeployment: wall expiry, monotonic deadline, stepped-back wall clock and forged leases all return null", async () => {
  const clock = clocks()
  const { reads } = setup(server(), {}, clock)
  const request = { apiBase: API, token: TOKEN, sessionId: "session-a", signal: new AbortController().signal }
  const lease = await reads.readDeployment(request)
  assert.equal(lease.receivedAt, START)
  assert.equal(lease.monotonicDeadline - clock.monotonicNow(), 14_000)
  assert.ok(reads.currentDeployment(lease))
  assert.equal(reads.currentDeployment({ ...lease }), null, "a copied or forged lease is not evidence")
  assert.equal(reads.currentDeployment(null), null)

  clock.advance(13_999)
  assert.ok(reads.currentDeployment(lease))
  clock.advance(1)
  assert.equal(reads.currentDeployment(lease), null, "both bounds reached together")

  const rollback = clocks()
  const second = setup(server(), {}, rollback)
  const again = await second.reads.readDeployment(request)
  rollback.advanceMonotonic(14_000)
  assert.equal(second.reads.currentDeployment(again), null, "monotonic deadline passed while the wall clock stood still")
  const stepped = clocks()
  const third = setup(server(), {}, stepped)
  const other = await third.reads.readDeployment(request)
  stepped.setWall(START - 1)
  assert.equal(third.reads.currentDeployment(other), null, "wall clock stepped back behind the acceptance time")
  // A different adapter instance does not accept this adapter's lease.
  assert.equal(third.reads.currentDeployment(lease), null)
})

test("transport: fetch ignoring abort and a stalled body time out once; the reader is cancelled", async () => {
  let fetches = 0
  const hang = createStocksExecutionReads({ apiBase: API, timeoutMs: 20, fetch: () => { fetches++; return new Promise<Response>(() => undefined) } })
  await rejectsWith(hang.readOrder(read()), "READ_TIMEOUT", { reason: "TIMEOUT" })
  assert.equal(fetches, 1, "no retry")

  let cancelled = false
  const stalled = createStocksExecutionReads({
    apiBase: API,
    timeoutMs: 20,
    fetch: async () => new Response(new ReadableStream({ pull: () => new Promise(() => undefined), cancel() { cancelled = true } }), { status: 200 }),
  })
  await rejectsWith(stalled.readExecutionPolicy(read()), "READ_TIMEOUT")
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(cancelled, true)
})

test("transport: caller abort before or during the request ends it without a result", async () => {
  const before = new AbortController()
  before.abort()
  const idle = setup(server())
  await rejectsWith(idle.reads.readOrder(read("BUY", { signal: before.signal })), "CONTEXT_CHANGED", { reason: "ABORTED" })
  assert.equal(idle.calls.length, 0)

  const during = new AbortController()
  let internal: AbortSignal | undefined
  const held = setup((call) => {
    internal = call.init.signal ?? undefined
    return new Promise<Response>(() => undefined)
  })
  const pending = held.reads.readExecutionPolicy(read("BUY", { signal: during.signal }))
  await Promise.resolve()
  during.abort()
  await rejectsWith(pending, "CONTEXT_CHANGED", { reason: "ABORTED" })
  assert.equal(internal?.aborted, true, "the in-flight fetch is aborted too")
})

test("transport: network errors, refused or followed redirects, oversize, malformed JSON and invalid UTF-8", async () => {
  const cases: [string, () => Response | Promise<Response>, ExecutionReadCode, string][] = [
    ["network", () => Promise.reject(new TypeError("Failed to fetch https://secret-host.example")), "REQUEST_FAILED", "NETWORK"],
    ["3xx", () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }), "INVALID_RESPONSE", "REDIRECT"],
    ["followed redirect", () => Object.defineProperty(json(envelope(orderRow("BUY"))), "redirected", { value: true }), "INVALID_RESPONSE", "REDIRECT"],
    ["other final URL", () => Object.defineProperty(json(envelope(orderRow("BUY"))), "url", { value: "https://evil.test/api/v1/stocks/orders/order-1" }), "INVALID_RESPONSE", "REDIRECT"],
    ["declared oversize", () => new Response("{}", { status: 200, headers: { "content-length": "40000" } }), "INVALID_RESPONSE", "BODY_TOO_LARGE"],
    ["streamed oversize", () => new Response(`"${"x".repeat(40_000)}"`, { status: 200 }), "INVALID_RESPONSE", "BODY_TOO_LARGE"],
    ["not JSON", () => new Response("<html>login</html>", { status: 200 }), "INVALID_RESPONSE", "NOT_JSON"],
    ["invalid UTF-8", () => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200 }), "INVALID_RESPONSE", "NOT_JSON"],
    ["204", () => new Response(null, { status: 204 }), "INVALID_RESPONSE", "HTTP_STATUS"],
  ]
  for (const [label, respond, code, reason] of cases) {
    const { reads, calls } = setup(respond)
    await rejectsWith(reads.readOrder(read()), code, { reason }).catch((error) => assert.fail(`${label}: ${error}`))
    assert.equal(calls.length, 1, `${label}: exactly one request, no retry`)
  }
})

test("non-2xx answers map to fixed codes per endpoint and keep only the status", async () => {
  const body = { error: "EXECUTION_DATABASE_TIMEOUT", detail: "password=hunter2 host=db.internal", ...envelope(null) }
  for (const status of [401, 403, 404, 409, 500, 503]) {
    const { reads, calls } = setup(() => json(body, status))
    const authenticated = status === 401 ? "SESSION_REJECTED" : null
    await rejectsWith(reads.readExecutionPolicy(read()), authenticated ?? "EXECUTION_NOT_ALLOWED", { status })
    assert.equal(calls.length, 1)
    await rejectsWith(reads.readDeployment({ apiBase: API, token: TOKEN, sessionId: "session-a", signal: new AbortController().signal }), authenticated ?? "DEPLOYMENT_NOT_REVIEWED", { status })
    assert.equal(calls.length, 2)
    // A 404 for the order means "not found for this actor/deployment" (or no route), never "moved on".
    await rejectsWith(reads.readOrder(read()), authenticated ?? "REQUEST_FAILED", { status })
    assert.equal(calls.length, 3)
    await rejectsWith(reads.readCatalog(read()), "REQUEST_FAILED", { status: status === 401 ? null : status })
    assert.equal(calls.length, 4, `${status}: one request per read, no retry`)
  }
  // A network failure is not retried either, for any read.
  const offline = setup(() => Promise.reject(new TypeError("offline")))
  await rejectsWith(offline.reads.readExecutionPolicy(read()), "REQUEST_FAILED")
  await rejectsWith(offline.reads.readDeployment({ apiBase: API, token: TOKEN, sessionId: "session-a", signal: new AbortController().signal }), "REQUEST_FAILED")
  await rejectsWith(offline.reads.readOrder(read()), "REQUEST_FAILED")
  await rejectsWith(offline.reads.readCatalog(read()), "REQUEST_FAILED")
  assert.equal(offline.calls.length, 4)
})

test("no token, URL, header or server text appears in any error, and nothing is logged", async () => {
  const printed: unknown[] = []
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
  for (const name of Object.keys(original) as (keyof typeof original)[]) console[name] = (...args: unknown[]) => printed.push(args)
  try {
    const secretBody = { error: "UNAUTHORIZED", message: `token ${TOKEN} rejected by https://private-auth.example`, ...envelope(null) }
    const responses = [() => json(secretBody, 401), () => json(secretBody, 503), () => Promise.reject(new Error(`connect ECONNREFUSED ${API} ${TOKEN}`)), () => new Response(`{"leak":"${TOKEN}"`, { status: 200 })]
    for (const respond of responses) {
      const { reads } = setup(respond)
      for (const run of [() => reads.readOrder(read()), () => reads.readExecutionPolicy(read()), () => reads.readDeployment({ apiBase: API, token: TOKEN, sessionId: "session-a", signal: new AbortController().signal })]) {
        const error = (await run().then(() => assert.fail("expected failure"), (value: unknown) => value)) as StocksExecutionReadError
        const shown = [String(error), error.message, error.stack ?? "", JSON.stringify(error), JSON.stringify({ ...error })].join(" ")
        for (const secret of [TOKEN, "private-auth", "stocks-api.test", "ECONNREFUSED", "rejected by", "leak"]) assert.ok(!shown.includes(secret), `${error.code} leaks ${secret}`)
        assert.equal(error.message, error.code)
      }
    }
  } finally {
    Object.assign(console, original)
  }
  assert.deepEqual(printed, [])
})

test("every adapter failure code has fixed panel copy (INVALID_CONTEXT deliberately shares the generic text)", () => {
  const generic = describeCode("SOMETHING_NEW", "BUY")
  for (const code of EXECUTION_READ_CODES) {
    if (code === "INVALID_CONTEXT") assert.deepEqual(describeCode(code, "BUY"), generic)
    else assert.notDeepEqual(describeCode(code, "BUY"), generic, `${code} needs panel copy`)
  }
  const dir = fileURLToPath(new URL(".", import.meta.url))
  const source = readdirSync(dir)
    .filter((name) => /\.ts$/.test(name) && name !== "test-support.ts")
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n")
  // First argument of every fail()/constructor call (ternaries included) and every endpoint's denied mapping.
  const firstArguments = [...source.matchAll(/(?:\bfail|new StocksExecutionReadError)\(([^,)]+)[,)]/g), ...source.matchAll(/=> \(?((?:status === \d+ \? )?"[A-Z_]+"(?: : "[A-Z_]+")?)\)?/g)].map((match) => match[1]!)
  const thrown = new Set(firstArguments.flatMap((argument) => [...argument.matchAll(/"([A-Z_]+)"/g)].map((match) => match[1]!)))
  assert.ok(thrown.size >= 10, `found ${thrown.size} thrown codes`)
  for (const code of thrown) assert.ok((EXECUTION_READ_CODES as readonly string[]).includes(code), `${code} is listed`)
})

test("module source: no storage, console output, retries, floating-point money or hidden defaults", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url))
  const files = readdirSync(dir).filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.tsx"))
  assert.ok(files.includes("reads.ts") && files.includes("transport.ts") && files.includes("validate.ts"))
  for (const name of files) {
    const text = readFileSync(join(dir, name), "utf8")
    assert.doesNotMatch(text, /\b(localStorage|sessionStorage|indexedDB|document\.cookie|caches\.)/, name)
    assert.doesNotMatch(text, /console\./, name)
    assert.doesNotMatch(text, /\bparseFloat\b|\.toFixed\(|\bNumber\(|\bMath\.round\(/, name)
    if (name !== "test-support.ts") {
      assert.doesNotMatch(text, /\bretry\b|while \(true\)|setInterval/i, name)
      assert.doesNotMatch(text, /status: "VERIFIED"|allowed: true, deploymentDigest: (?!scope)/, `${name}: no fabricated evidence or permission`)
    }
  }
  const index = readFileSync(join(dir, "index.ts"), "utf8")
  assert.doesNotMatch(index, /test-support/)
})

test("deployment lease: request delay shortens the monotonic deadline, and each bound ends the lease on its own", async () => {
  // Only the monotonic clock moves during the request (the wall clock stalls): 5 s of the 15 s lease are gone.
  const stalled = clocks()
  const request = { apiBase: API, token: TOKEN, sessionId: "session-a", signal: new AbortController().signal }
  const slow = setup(async () => {
    stalled.advanceMonotonic(5_000)
    return json(envelope(evidence({ verifiedAt: START, validUntil: START + 15_000 })))
  }, { timeoutMs: 15_000 }, stalled)
  const lease = await slow.reads.readDeployment(request)
  assert.equal(lease.monotonicDeadline - stalled.monotonicNow(), 10_000, "measured from the effective clock, not the stalled wall clock")
  stalled.advance(9_999)
  assert.ok(slow.reads.currentDeployment(lease))
  stalled.advance(1)
  assert.equal(stalled.now(), START + 10_000)
  assert.equal(slow.reads.currentDeployment(lease), null, "the monotonic deadline ends it while the wall clock is still before validUntil")

  // Only the wall clock reaches validUntil: the lease ends although the monotonic deadline is still ahead.
  const wallOnly = clocks()
  const second = setup(server(), {}, wallOnly)
  const other = await second.reads.readDeployment(request)
  wallOnly.setWall(START + 14_000)
  assert.equal(second.reads.currentDeployment(other), null)
})

test("createExecutionClock never runs behind monotonic time since creation and follows forward corrections", () => {
  const clock = clocks()
  const now = createExecutionClock({ now: clock.now, monotonicNow: clock.monotonicNow })
  assert.equal(now(), START)
  clock.advance(1_000)
  assert.equal(now(), START + 1_000)
  // Stepped back 5 s while 6 s pass: the clock reports the monotonic floor, never the earlier wall time.
  clock.advanceMonotonic(6_000)
  clock.setWall(START - 4_000)
  assert.equal(now(), START + 7_000)
  // A forward correction is followed and becomes the new floor.
  clock.setWall(START + 60_000)
  assert.equal(now(), START + 60_000)
  // Fractional monotonic readings still give integer milliseconds.
  clock.setWall(START)
  clock.advanceMonotonic(0.75)
  assert.ok(Number.isInteger(now()))
  assert.throws(() => createExecutionClock({ now: () => Number.NaN, monotonicNow: () => 0 }), StocksExecutionReadError)
})

test("createExecutionClock remembers every forward correction with the time elapsed since, through repeated corrections", () => {
  // Created 60 s slow (independent review R1), then corrected before any lease is read.
  const clock = clocks(START - 60_000)
  const now = createExecutionClock({ now: clock.now, monotonicNow: clock.monotonicNow })
  const readings: number[] = []
  const read = () => {
    const value = now()
    readings.push(value)
    return value
  }
  assert.equal(read(), START - 60_000)
  clock.setWall(START)
  assert.equal(read(), START, "the forward correction is observed")
  // 6 s pass while the wall clock is stepped back to +1 s: the floor keeps the corrected time plus elapsed time.
  clock.advanceMonotonic(6_000)
  clock.setWall(START + 1_000)
  assert.equal(read(), START + 6_000)
  // The wall clock stalls: time keeps advancing with monotonic time, it does not freeze at the last value.
  clock.advanceMonotonic(2_000)
  assert.equal(read(), START + 8_000)
  // A second forward correction beyond the floor is remembered too, and survives a second rollback.
  clock.setWall(START + 30_000)
  assert.equal(read(), START + 30_000)
  clock.advanceMonotonic(1_000)
  clock.setWall(START - 90_000)
  assert.equal(read(), START + 31_000)
  // Normal progress after the rollback is followed once the wall clock is ahead again.
  clock.advanceMonotonic(500)
  clock.setWall(START + 40_000)
  assert.equal(read(), START + 40_000)
  for (let i = 1; i < readings.length; i++) assert.ok(readings[i]! >= readings[i - 1]!, "readings never decrease")
})

test("createExecutionClock fails closed for good after a non-finite or regressing reading", () => {
  for (const fault of ["wall-nan", "wall-infinity", "wall-negative-infinity", "monotonic-nan", "monotonic-infinity", "monotonic-regression"] as const) {
    const clock = clocks()
    const now = createExecutionClock({ now: clock.now, monotonicNow: clock.monotonicNow })
    clock.advance(1_000)
    assert.equal(now(), START + 1_000, fault)
    if (fault === "wall-nan") clock.setWall(Number.NaN)
    if (fault === "wall-infinity") clock.setWall(Number.POSITIVE_INFINITY)
    if (fault === "wall-negative-infinity") clock.setWall(Number.NEGATIVE_INFINITY)
    if (fault === "monotonic-nan") clock.setMonotonic(Number.NaN)
    if (fault === "monotonic-infinity") clock.setMonotonic(Number.POSITIVE_INFINITY)
    if (fault === "monotonic-regression") clock.setMonotonic(clock.monotonicNow() - 1)
    assert.ok(Number.isNaN(now()), `${fault}: abnormal reading`)
    // Even after the readings look normal again, no new lifetime can be derived from this clock.
    clock.setWall(START + 2_000)
    clock.setMonotonic(1_000_000)
    assert.ok(Number.isNaN(now()), `${fault}: latched`)
    assert.equal(START + 2_000 < Number.NaN, false, "every lifetime check against NaN fails")
  }
})
