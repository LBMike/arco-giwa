import assert from "node:assert/strict"
import test from "node:test"
import { STOCKS_ADMIN_PATHS, orderDetailPath, stocksAdminGet } from "./client"
import {
  FIXTURE_BUY_COMPLETED_DETAIL,
  FIXTURE_BUY_DETAIL,
  FIXTURE_IDS,
  FIXTURE_ORDERS,
  FIXTURE_OVERVIEW,
  FIXTURE_PROFILE,
  FIXTURE_RECONCILIATIONS,
  FIXTURE_SELL_DETAIL,
  createFixtureTransport,
  fixtureEnvelope,
  type FixtureReply,
} from "./fixtures"
import { StocksContractError, parseAudit, parseEnvelope, parseOrderDetail, parseOrders, parseOverview, parseReconciliation } from "./parse"

const API = "https://api.example.test/"

function get(reply: FixtureReply | (() => Promise<FixtureReply>), options: { token?: string | null; path?: string; signal?: AbortSignal } = {}) {
  const transport = createFixtureTransport(() => (typeof reply === "function" ? reply() : reply))
  const result = stocksAdminGet({
    apiBase: API,
    path: options.path ?? STOCKS_ADMIN_PATHS.overview,
    accessToken: options.token === undefined ? "session.jwt" : options.token,
    signal: options.signal ?? new AbortController().signal,
    parse: parseOverview,
    fetch: transport.fetch,
  })
  return { result, calls: transport.calls }
}

test("client sends a read-only GET with only the SIWE Bearer session — no operator token, cookies or cache", async () => {
  const { result, calls } = get({ status: 200, body: fixtureEnvelope(FIXTURE_OVERVIEW) })
  const outcome = await result
  assert.equal(outcome.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://api.example.test/api/v1/admin/stocks/overview")
  assert.equal(calls[0].init.method, "GET")
  assert.equal(calls[0].init.credentials, "omit")
  assert.equal(calls[0].init.cache, "no-store")
  assert.deepEqual(calls[0].init.headers, { accept: "application/json", authorization: "Bearer session.jwt" })
  assert.ok(!JSON.stringify(calls[0].init).toLowerCase().includes("x-operator-token"))
  assert.equal(orderDetailPath("a/b?c"), "/api/v1/admin/stocks/orders/a%2Fb%3Fc")
})

test("client does not send anything without a session token", async () => {
  for (const token of [null, ""]) {
    const { result, calls } = get({ status: 200, body: fixtureEnvelope([]) }, { token })
    assert.deepEqual(await result, { ok: false, error: { kind: "unauthenticated", status: null, code: null } })
    assert.equal(calls.length, 0)
  }
})

test("client distinguishes 401, 403, disabled routes, missing orders, server and request errors without echoing bodies", async () => {
  const cases: [FixtureReply, string, string | null][] = [
    [{ status: 401, body: { error: "Missing bearer session token" } }, "unauthorized", null],
    [{ status: 403, body: { error: "OPERATOR_FORBIDDEN", ...FIXTURE_PROFILE } }, "forbidden", "OPERATOR_FORBIDDEN"],
    [{ status: 404, body: { message: "Route GET:/api/v1/admin/stocks/overview not found", error: "Not Found", statusCode: 404 } }, "disabled", null],
    [{ status: 404, raw: "" }, "disabled", null],
    [{ status: 404, body: { error: "ORDER_NOT_FOUND", ...FIXTURE_PROFILE } }, "not_found", "ORDER_NOT_FOUND"],
    [{ status: 500, body: { error: "INTERNAL_ERROR", ...FIXTURE_PROFILE } }, "server", "INTERNAL_ERROR"],
    [{ status: 502, raw: "<html>bad gateway postgres://user:secret@db</html>" }, "server", null],
    [{ status: 409, body: { error: "stale; secret detail" } }, "request", null],
  ]
  for (const [reply, kind, code] of cases) {
    const outcome = await get(reply).result
    assert.equal(outcome.ok, false)
    if (outcome.ok) continue
    assert.equal(outcome.error.kind, kind, JSON.stringify(reply))
    assert.equal(outcome.error.status, reply.status)
    assert.equal(outcome.error.code, code)
    assert.ok(!JSON.stringify(outcome).includes("secret"))
  }
})

test("client rejects malformed 2xx bodies, unsupported profiles and network failures", async () => {
  const invalid: FixtureReply[] = [
    { status: 200, raw: "not json" },
    { status: 200, body: { data: FIXTURE_OVERVIEW } },
    { status: 200, body: { ...fixtureEnvelope(FIXTURE_OVERVIEW), profile: "PRODUCTION" } },
    { status: 200, body: { ...fixtureEnvelope(FIXTURE_OVERVIEW), chainId: 1 } },
    { status: 200, body: { ...fixtureEnvelope(FIXTURE_OVERVIEW), brokerMode: "LIVE_BROKER" } },
    { status: 200, body: { ...fixtureEnvelope(FIXTURE_OVERVIEW), observedAt: "yesterday" } },
    { status: 200, body: { ...FIXTURE_PROFILE, observedAt: "2026-09-17T03:00:00.000Z" } },
    { status: 200, body: fixtureEnvelope([{ side: "BUY", state: "COMPLETED", count: 3, cashAmount: "1" }]) },
  ]
  for (const reply of invalid) {
    const outcome = await get(reply).result
    assert.deepEqual(outcome, { ok: false, error: { kind: "invalid", status: 200, code: null } }, JSON.stringify(reply).slice(0, 120))
  }

  const network = await get(() => Promise.reject(new TypeError("fetch failed"))).result
  assert.deepEqual(network, { ok: false, error: { kind: "network", status: null, code: null } })

  const controller = new AbortController()
  const pending = get(() => new Promise<FixtureReply>(() => {}), { signal: controller.signal }).result
  controller.abort()
  assert.deepEqual(await pending, { ok: false, error: { kind: "aborted", status: null, code: null } })
})

test("parseEnvelope keeps the server's environment values", () => {
  const { meta } = parseEnvelope(fixtureEnvelope([]))
  assert.deepEqual(meta, { ...FIXTURE_PROFILE, observedAt: "2026-09-17T03:00:00.000Z" })
})

test("order detail parsing separates BUY funding/holdings from SELL custody/reservations", () => {
  const buy = parseOrderDetail(FIXTURE_BUY_DETAIL)
  assert.equal(buy.side, "BUY")
  if (buy.side !== "BUY") return
  assert.equal(buy.funding[0].amount, "120000000")
  assert.equal(buy.funding[0].proof.blockNumber, "19834100")
  assert.equal(buy.operations[1].leaseUntil, "2026-09-17T03:00:20.000Z")
  assert.deepEqual(buy.holdings, [])
  assert.deepEqual(buy.audit.map((row) => row.action).slice(0, 2), ["ORDER_CREATED", "FUNDING_RECORDED"])
  assert.equal(parseOrderDetail(FIXTURE_BUY_COMPLETED_DETAIL).side, "BUY")

  const sell = parseOrderDetail(FIXTURE_SELL_DETAIL)
  assert.equal(sell.side, "SELL")
  if (sell.side !== "SELL") return
  assert.equal(sell.custody[0].status, "REDEEM_PENDING")
  assert.equal(sell.reservations[0].amount, "120000000")
  assert.equal(sell.operations[0].leaseUntil, null)
  assert.ok(!("funding" in sell))
})

test("order detail parsing fails closed on missing sections or rows that belong to another order", () => {
  const other = FIXTURE_IDS.buyUnknown
  const broken: [string, unknown][] = [
    ["BUY without funding", { ...FIXTURE_BUY_DETAIL, funding: undefined }],
    ["BUY without holdings", { ...FIXTURE_BUY_DETAIL, holdings: undefined }],
    ["SELL without reservations", { ...FIXTURE_SELL_DETAIL, reservations: undefined }],
    ["SELL shaped as BUY", { ...FIXTURE_BUY_DETAIL, order: FIXTURE_SELL_DETAIL.order }],
    ["funding of another order", { ...FIXTURE_BUY_DETAIL, funding: [{ ...FIXTURE_BUY_DETAIL.funding[0], orderId: other }] }],
    ["audit of another order", { ...FIXTURE_BUY_DETAIL, audit: [{ ...FIXTURE_BUY_DETAIL.audit[0], subject: other }] }],
    ["custody of another order", { ...FIXTURE_SELL_DETAIL, custody: [{ ...FIXTURE_SELL_DETAIL.custody[0], orderId: null }] }],
    ["fractional amount", { ...FIXTURE_BUY_DETAIL, funding: [{ ...FIXTURE_BUY_DETAIL.funding[0], amount: "120.5" }] }],
    ["numeric amount", { ...FIXTURE_BUY_DETAIL, order: { ...FIXTURE_BUY_DETAIL.order, quantity: 1000000000 } }],
    ["unknown side", { ...FIXTURE_BUY_DETAIL, order: { ...FIXTURE_BUY_DETAIL.order, side: "SWAP" } }],
  ]
  for (const [name, data] of broken) assert.throws(() => parseOrderDetail(data), StocksContractError, name)
})

test("list parsing enforces exact integer strings and the server's 200-row limit", () => {
  assert.equal(parseOverview(FIXTURE_OVERVIEW).length, FIXTURE_OVERVIEW.length)
  assert.equal(parseOrders(FIXTURE_ORDERS).length, FIXTURE_ORDERS.length)
  assert.throws(() => parseOverview([{ side: "BUY", state: "COMPLETED", count: "-1", cashAmount: "1" }]))
  assert.throws(() => parseOrders(Array.from({ length: 201 }, () => FIXTURE_ORDERS[0])))
  assert.throws(() => parseAudit(Array.from({ length: 201 }, () => FIXTURE_BUY_DETAIL.audit[0])))
  assert.throws(() => parseOrders({}))
})

test("reconciliation parsing accepts the four statuses and rejects contradictions", () => {
  const matched = parseReconciliation(FIXTURE_RECONCILIATIONS.MATCHED_AT_CUTOFF)
  assert.equal(matched.status, "MATCHED_AT_CUTOFF")
  assert.equal(matched.snapshot?.blockNumber, "19834211")
  assert.equal(parseReconciliation(FIXTURE_RECONCILIATIONS.MISMATCH).differences.length, 2)
  const unavailable = parseReconciliation(FIXTURE_RECONCILIATIONS.UNAVAILABLE)
  assert.equal(unavailable.reason, "NO_FINALIZED_OBSERVER_COVERAGE")
  assert.equal(unavailable.snapshot, null)
  const incomplete = parseReconciliation(FIXTURE_RECONCILIATIONS.INCOMPLETE)
  assert.equal(incomplete.cutoff?.observedAt, "2026-09-17T02:57:40.000Z")
  assert.equal(incomplete.currentLiabilities, null)

  const matchedData = FIXTURE_RECONCILIATIONS.MATCHED_AT_CUTOFF as Record<string, unknown>
  const mismatchData = FIXTURE_RECONCILIATIONS.MISMATCH as Record<string, unknown>
  const rejects: [string, unknown][] = [
    ["unknown status", { ...matchedData, status: "OK" }],
    ["match with differences", { ...matchedData, differences: mismatchData.differences }],
    ["mismatch without differences", { ...mismatchData, differences: [] }],
    ["match without snapshot", { ...matchedData, snapshot: undefined }],
    ["match without cutoff", { ...matchedData, cutoff: undefined }],
    ["snapshot for another block", { ...matchedData, snapshot: { ...(matchedData.snapshot as object), blockNumber: "19834210" } }],
    ["match without liabilities", { ...matchedData, currentLiabilities: undefined }],
    ["unavailable without reason", { status: "UNAVAILABLE", pending: [] }],
    ["missing pending", { status: "UNAVAILABLE", reason: "NO_FINALIZED_OBSERVER_COVERAGE" }],
  ]
  for (const [name, data] of rejects) assert.throws(() => parseReconciliation(data), StocksContractError, name)

  // Comparison fields on a non-comparison status are dropped, never displayable.
  const smuggled = parseReconciliation({ ...(FIXTURE_RECONCILIATIONS.UNAVAILABLE as object), snapshot: matchedData.snapshot, differences: [], currentLiabilities: matchedData.currentLiabilities })
  assert.equal(smuggled.snapshot, null)
  assert.equal(smuggled.currentLiabilities, null)
})
