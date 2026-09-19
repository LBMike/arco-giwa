// 003E: the client's wallet submission diagnostics contract, checked against the server's own publicSnapshot so the two
// cannot drift apart silently, plus every rejection the reviewed contract calls for.
import assert from "node:assert/strict"
import test from "node:test"
import { publicSnapshot } from "../../../../server/src/stocks-submission-diagnostics/public"
import { stocksAdminGet, submissionDiagnosticsPath } from "./client"
import { FIXTURE_IDS, FIXTURE_OBSERVED_AT, FIXTURE_PROFILE, createFixtureTransport, fixtureAttempt, fixtureDiagnostics, fixtureEnvelope, fixtureHash, type FixtureReply } from "./fixtures"
import { StocksContractError, parseSubmissionDiagnostics } from "./parse"

const STATUSES = ["REQUEST_MAY_START", "UNKNOWN", "SUBMITTED", "CONFIRMED", "REVERTED"] as const
const ORDERS = { BUY: FIXTURE_IDS.buyFinality, SELL: FIXTURE_IDS.sellSettlement } as const

function parse(data: unknown, side: "BUY" | "SELL" = "BUY", orderId: string = ORDERS[side], observedAt = FIXTURE_OBSERVED_AT) {
  return parseSubmissionDiagnostics(data, { side, orderId, observedAt })
}
function rejects(name: string, data: unknown, side: "BUY" | "SELL" = "BUY", orderId?: string, observedAt?: string) {
  assert.throws(() => parse(data, side, orderId ?? ORDERS[side], observedAt), StocksContractError, name)
}
function serverView(data: unknown, observedAt = FIXTURE_OBSERVED_AT) {
  return publicSnapshot({ observedAt, data })
}
/** The client keeps one intent key (checked equal on both stages) instead of repeating it per stage. */
function withoutStageIntent(data: ReturnType<typeof serverView>["data"]) {
  const strip = (row: typeof data.approval) => (row === null ? null : Object.fromEntries(Object.entries(row).filter(([key]) => key !== "intentKey")))
  return { ...data, approval: strip(data.approval), transfer: strip(data.transfer) }
}

test("every status of both stages for BUY and SELL is accepted, exactly as the server's publicSnapshot returns it", () => {
  let checked = 0
  for (const side of ["BUY", "SELL"] as const) {
    for (const approval of STATUSES) {
      for (const transfer of [null, ...STATUSES] as const) {
        const data = fixtureDiagnostics(ORDERS[side], { approval: fixtureAttempt("APPROVAL", approval), transfer: transfer === null ? null : fixtureAttempt("TRANSFER", transfer) })
        const server = serverView(data)
        assert.deepEqual(parse(server.data, side), withoutStageIntent(server.data), `${side} ${approval}/${transfer}`)
        checked++
      }
    }
    // Both stages absent, and a pre-journal order.
    for (const data of [fixtureDiagnostics(ORDERS[side], { approval: null, transfer: null }), fixtureDiagnostics(ORDERS[side], { enrollment: "NOT_ENROLLED" })]) {
      assert.deepEqual(parse(serverView(data).data, side), withoutStageIntent(serverView(data).data))
      checked++
    }
    // An UNKNOWN answer with a recorded hash is the server's too.
    const known = fixtureDiagnostics(ORDERS[side], { approval: fixtureAttempt("APPROVAL", "UNKNOWN", { txHash: fixtureHash("c9") }), transfer: null })
    assert.equal(parse(serverView(known).data, side).approval?.txHash, fixtureHash("c9"))
  }
  assert.equal(checked, 2 * (5 * 6 + 2))
})

test("expired quotes and paused-era orders stay readable; quoteExpired must agree with the snapshot time", () => {
  // Every fixture quote has passed at the fixture snapshot time: the record is still fully readable.
  const expired = fixtureDiagnostics(FIXTURE_IDS.buyLarge, { approval: fixtureAttempt("APPROVAL", "UNKNOWN"), transfer: null })
  assert.equal(expired.order.quoteExpired, true)
  assert.equal(parse(expired, "BUY", FIXTURE_IDS.buyLarge).approval?.status, "UNKNOWN")
  rejects("not expired after the deadline", { ...expired, order: { ...expired.order, quoteExpired: false } }, "BUY", FIXTURE_IDS.buyLarge)
  // Before the deadline (no rows yet, so nothing is later than the snapshot).
  const before = new Date(Date.parse(expired.order.quoteExpiresAt) - 1).toISOString()
  const open = fixtureDiagnostics(FIXTURE_IDS.buyLarge, { approval: null, transfer: null, observedAt: before })
  assert.equal(open.order.quoteExpired, false)
  assert.equal(parse(open, "BUY", FIXTURE_IDS.buyLarge, before).order.quoteExpired, false)
  rejects("expired flag before the deadline", { ...open, order: { ...open.order, quoteExpired: true } }, "BUY", FIXTURE_IDS.buyLarge, before)
  // Exactly at the deadline counts as passed, like the server.
  rejects("not expired at the deadline", { ...open, order: { ...open.order, quoteExpired: false } }, "BUY", FIXTURE_IDS.buyLarge, expired.order.quoteExpiresAt)
})

test("the permission flags must say read only, no execution authorization and no resubmission", () => {
  const base = fixtureDiagnostics(ORDERS.BUY)
  for (const [name, change] of [
    ["readOnly false", { readOnly: false }],
    ["readOnly missing", { readOnly: undefined }],
    ["readOnly as a string", { readOnly: "true" }],
    ["execution authorization", { executionAuthorization: true }],
    ["execution authorization as null", { executionAuthorization: null }],
    ["resubmission", { resubmissionAllowed: true }],
    ["resubmission as 0", { resubmissionAllowed: 0 }],
  ] as const) {
    rejects(name, JSON.parse(JSON.stringify({ ...base, ...change })))
  }
})

test("the answer must be for the requested side and order", () => {
  const buy = fixtureDiagnostics(ORDERS.BUY)
  rejects("asked SELL, got BUY", buy, "SELL", ORDERS.BUY)
  rejects("asked another order", buy, "BUY", FIXTURE_IDS.buyUnknown)
  const sell = fixtureDiagnostics(ORDERS.SELL)
  rejects("asked BUY, got SELL", sell, "BUY", ORDERS.SELL)
  rejects("BUY state on a SELL order", { ...sell, order: { ...sell.order, state: "MINT_QUEUED" } }, "SELL")
})

test("unexpected fields (raw proof JSON, calldata, internal errors) make the whole response invalid", () => {
  const base = fixtureDiagnostics(ORDERS.BUY, { approval: fixtureAttempt("APPROVAL", "CONFIRMED"), transfer: fixtureAttempt("TRANSFER", "REVERTED") })
  const approval = base.approval as Record<string, unknown>
  const transfer = base.transfer as Record<string, unknown>
  const cases: [string, unknown][] = [
    ["root proof", { ...base, proof: { raw: "{}" } }],
    ["root error", { ...base, error: "db timeout at host" }],
    ["order calldata", { ...base, order: { ...base.order, data: "0xa9059cbb" } }],
    ["stage calldata", { ...base, approval: { ...approval, transaction: { to: "0x1", data: "0x095ea7b3" } } }],
    ["stage evidence", { ...base, transfer: { ...transfer, evidence: { logs: [] } } }],
    ["receipt raw", { ...base, transfer: { ...transfer, receipt: { ...(transfer.receipt as object), raw: { logs: [] } } } }],
    ["missing receipt field", { ...base, approval: { ...approval, receipt: { status: "CONFIRMED", blockNumber: "1", blockHash: fixtureHash("b7") } } }],
    ["missing stage field", { ...base, approval: Object.fromEntries(Object.entries(approval).filter(([key]) => key !== "transactionDigest")) }],
  ]
  for (const [name, data] of cases) rejects(name, data)
})

test("journal invariants: hash, receipt, times, enrollment and claim identity", () => {
  const at = (stage: "APPROVAL" | "TRANSFER", status: (typeof STATUSES)[number], change: Record<string, unknown>) => ({ ...fixtureAttempt(stage, status), ...change })
  const buy = (approval: unknown, transfer: unknown = null) => fixtureDiagnostics(ORDERS.BUY, { approval, transfer })
  const cases: [string, unknown][] = [
    ["reserved request with a hash", buy(at("APPROVAL", "REQUEST_MAY_START", { txHash: fixtureHash("a7") }))],
    ["submitted without a hash", buy(at("APPROVAL", "SUBMITTED", { txHash: null }))],
    ["confirmed without a hash", buy(at("APPROVAL", "CONFIRMED", { txHash: null }))],
    ["confirmed without a receipt", buy(at("APPROVAL", "CONFIRMED", { receipt: null }))],
    ["receipt status differs", buy(at("APPROVAL", "CONFIRMED", { receipt: { ...fixtureAttempt("APPROVAL", "REVERTED").receipt } }))],
    ["receipt on a submitted row", buy(at("APPROVAL", "SUBMITTED", { receipt: fixtureAttempt("APPROVAL", "CONFIRMED").receipt }))],
    ["receipt on an unknown row", buy(at("APPROVAL", "UNKNOWN", { receipt: fixtureAttempt("APPROVAL", "CONFIRMED").receipt }))],
    ["verified before the claim", buy(at("APPROVAL", "CONFIRMED", { receipt: { ...fixtureAttempt("APPROVAL", "CONFIRMED").receipt, verifiedAt: "2026-09-17T02:00:00.000Z" } }))],
    ["verified after the last update", buy(at("APPROVAL", "CONFIRMED", { receipt: { ...fixtureAttempt("APPROVAL", "CONFIRMED").receipt, verifiedAt: "2026-09-17T02:11:41.000Z" } }))],
    ["updated before created", buy(at("APPROVAL", "UNKNOWN", { updatedAt: "2026-09-17T02:10:00.000Z" }))],
    ["updated after the snapshot", buy(at("APPROVAL", "UNKNOWN", { updatedAt: "2026-09-17T03:00:00.001Z" }))],
    ["non-canonical time", buy(at("APPROVAL", "UNKNOWN", { createdAt: "2026-09-17T02:10:30Z" }))],
    ["upper-case hash", buy(at("APPROVAL", "SUBMITTED", { txHash: `0x${"AB".repeat(32)}` }))],
    ["zero hash", buy(at("APPROVAL", "SUBMITTED", { txHash: `0x${"0".repeat(64)}` }))],
    ["short hash", buy(at("APPROVAL", "SUBMITTED", { txHash: "0x1234" }))],
    ["decimal-looking block with a sign", buy(at("APPROVAL", "CONFIRMED", { receipt: { ...fixtureAttempt("APPROVAL", "CONFIRMED").receipt, blockNumber: "-1" } }))],
    ["block number as a number", buy(at("APPROVAL", "CONFIRMED", { receipt: { ...fixtureAttempt("APPROVAL", "CONFIRMED").receipt, blockNumber: 19834090 } }))],
    ["unknown status", buy(at("APPROVAL", "FAILED" as never, {}))],
    ["approval row in the transfer slot", buy(null, fixtureAttempt("APPROVAL", "UNKNOWN"))],
    ["another intent", buy(at("APPROVAL", "UNKNOWN", { intentKey: "f".repeat(64) }))],
    ["same claim for both stages", buy(fixtureAttempt("APPROVAL", "CONFIRMED"), fixtureAttempt("TRANSFER", "SUBMITTED", { claimId: "claim-approval-1" }))],
    ["not enrolled but attempted", { ...buy(fixtureAttempt("APPROVAL", "UNKNOWN")), enrollment: "NOT_ENROLLED" }],
    ["unknown enrollment", { ...buy(null), enrollment: "MAYBE" }],
    ["intent key upper-case", { ...buy(null), intentKey: "A".repeat(64) }],
    ["negative version", { ...buy(null), order: { ...buy(null).order, version: -1 } }],
    ["fractional version", { ...buy(null), order: { ...buy(null).order, version: 1.5 } }],
    ["zero wallet", { ...buy(null), order: { ...buy(null).order, wallet: `0x${"0".repeat(40)}` } }],
    ["checksummed wallet", { ...buy(null), order: { ...buy(null).order, wallet: "0x8BA1f109551bD432803012645Ac136ddd64DBA72" } }],
  ]
  for (const [name, data] of cases) rejects(name, data)
})

test("the client and server agree on what is invalid: every rejected variant is also refused by publicSnapshot", () => {
  const base = fixtureDiagnostics(ORDERS.BUY, { approval: fixtureAttempt("APPROVAL", "REQUEST_MAY_START"), transfer: null })
  const variants: unknown[] = [
    { ...base, readOnly: false },
    { ...base, executionAuthorization: true },
    { ...base, resubmissionAllowed: true },
    { ...base, approval: { ...(base.approval as object), txHash: fixtureHash("a7") } },
    { ...base, enrollment: "NOT_ENROLLED" },
  ]
  for (const data of variants) {
    assert.throws(() => serverView(data))
    assert.throws(() => parse(data), StocksContractError)
  }
})

test("through the real client: the diagnostics GET checks the PROFILE envelope, the snapshot time and the scope", async () => {
  const data = fixtureDiagnostics(ORDERS.SELL, { approval: fixtureAttempt("APPROVAL", "CONFIRMED"), transfer: fixtureAttempt("TRANSFER", "UNKNOWN") })
  const run = async (reply: FixtureReply, side: "BUY" | "SELL" = "SELL") => {
    const transport = createFixtureTransport(() => reply)
    const outcome = await stocksAdminGet({
      apiBase: "https://api.example.test",
      path: submissionDiagnosticsPath(side, ORDERS.SELL),
      accessToken: "session.jwt",
      signal: new AbortController().signal,
      parse: (value) => value,
      fetch: transport.fetch,
    })
    const parsed = outcome.ok ? (() => { try { return parseSubmissionDiagnostics(outcome.data, { side, orderId: ORDERS.SELL, observedAt: outcome.meta.observedAt }) } catch { return "invalid" } })() : outcome.error.kind
    return { parsed, calls: transport.calls }
  }
  const good = await run({ status: 200, body: fixtureEnvelope(data) })
  assert.equal(good.calls.length, 1)
  assert.equal(good.calls[0].path, `/api/v1/admin/stocks/wallet-submissions/SELL/${ORDERS.SELL}`)
  assert.equal(good.calls[0].init.method, "GET")
  assert.equal(good.calls[0].init.body, undefined)
  assert.deepEqual(good.calls[0].init.headers, { accept: "application/json", authorization: "Bearer session.jwt" })
  assert.equal(typeof good.parsed === "object" && good.parsed.transfer?.status, "UNKNOWN")

  for (const change of [{ profile: "PRODUCTION" }, { valuePolicy: "REAL_VALUE" }, { brokerMode: "LIVE_BROKER" }, { chainId: 1 }, { priceSource: "ORACLE" }, { observedAt: "2026-09-17T03:00:00Z" }]) {
    assert.equal((await run({ status: 200, body: { ...fixtureEnvelope(data), ...change } })).parsed, "invalid", JSON.stringify(change))
  }
  // A snapshot time earlier than the rows' last update is refused.
  assert.equal((await run({ status: 200, body: fixtureEnvelope(data, "2026-09-17T02:13:00.000Z") })).parsed, "invalid")
  assert.equal((await run({ status: 200, body: fixtureEnvelope(data) }, "BUY")).parsed, "invalid", "asked BUY for a SELL order")
  assert.equal((await run({ status: 403, body: { error: "OPERATOR_FORBIDDEN", ...FIXTURE_PROFILE } })).parsed, "forbidden")
  assert.equal((await run({ status: 401, body: { error: "Invalid bearer session token" } })).parsed, "unauthorized")
  assert.equal((await run({ status: 404, body: { error: "ORDER_NOT_FOUND", ...FIXTURE_PROFILE } })).parsed, "not_found")
  assert.equal((await run({ status: 503, body: { error: "SUBMISSION_DIAGNOSTICS_UNAVAILABLE", ...FIXTURE_PROFILE } })).parsed, "server")
  assert.equal(submissionDiagnosticsPath("BUY", "a/b?c"), "/api/v1/admin/stocks/wallet-submissions/BUY/a%2Fb%3Fc")
})
