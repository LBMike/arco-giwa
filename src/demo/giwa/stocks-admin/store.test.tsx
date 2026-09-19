import assert from "node:assert/strict"
import test from "node:test"
import {
  FIXTURE_AUDIT,
  FIXTURE_BUY_DETAIL,
  FIXTURE_IDS,
  FIXTURE_ORDERS,
  FIXTURE_OVERVIEW,
  FIXTURE_PROFILE,
  FIXTURE_SELL_DETAIL,
  diagnosticsPathOf,
  fixtureAttempt,
  fixtureDiagnostics,
  fixtureEnvelope,
  fixtureResponse,
  type FixtureReply,
} from "./fixtures"
import { StocksAdminStore, type StocksAdminStoreConfig } from "./store"
import type { StocksAdminFetch, StocksAdminSnapshot } from "./types"

const API = "https://api.example.test"

type Pending = {
  readonly path: string
  readonly init: RequestInit
  readonly token: string
  respond(reply: FixtureReply): void
  fail(error: unknown): void
}

/** Transport whose responses the test releases in any order. It ignores abort, like a late server. */
function controlledTransport() {
  const pending: Pending[] = []
  const fetch: StocksAdminFetch = (url, init) =>
    new Promise((resolve, reject) => {
      const headers = init.headers as Record<string, string>
      pending.push({
        path: url.slice(API.length),
        init,
        token: headers.authorization,
        respond: (reply) => resolve(fixtureResponse(reply)),
        fail: reject,
      })
    })
  const take = (path: string): Pending => {
    const index = pending.findIndex((request) => request.path === path)
    assert.notEqual(index, -1, `no pending request for ${path}`)
    return pending.splice(index, 1)[0]
  }
  return { fetch, pending, take }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const ok = (data: unknown): FixtureReply => ({ status: 200, body: fixtureEnvelope(data) })
const OVERVIEW = "/api/v1/admin/stocks/overview"
const ORDERS = "/api/v1/admin/stocks/orders"
const AUDIT = "/api/v1/admin/stocks/audit"
const detailPath = (id: string) => `/api/v1/admin/stocks/orders/${id}`

function setup(overrides: Partial<StocksAdminStoreConfig> = {}) {
  const transport = controlledTransport()
  let clock = Date.parse("2026-09-17T03:00:30.000Z")
  const config: StocksAdminStoreConfig = {
    apiBase: API,
    session: { id: "operator-a", accessToken: "token-a" },
    deploymentKey: "deployment-1",
    fetch: transport.fetch,
    now: () => clock,
    ...overrides,
  }
  const store = new StocksAdminStore(config)
  return { store, transport, config, tick: (ms: number) => (clock += ms) }
}

function hasNoData(snapshot: StocksAdminSnapshot) {
  for (const key of ["overview", "orders", "reconciliation", "audit"] as const) {
    assert.equal(snapshot[key].value, null, `${key} value`)
    assert.equal(snapshot[key].phase, "idle", `${key} phase`)
  }
  assert.equal(snapshot.detail.value, null)
  assert.equal(snapshot.detail.orderId, null)
  assert.equal(snapshot.diagnostics.value, null)
  assert.equal(snapshot.diagnostics.orderId, null)
}

test("session change: a late response and a late error from the previous session never reach the new session", async () => {
  const { store, transport, config } = setup()
  store.load("overview")
  store.load("orders")
  const oldOverview = transport.take(OVERVIEW)
  const oldOrders = transport.take(ORDERS)
  assert.equal(oldOverview.token, "Bearer token-a")

  store.configure({ ...config, session: { id: "operator-b", accessToken: "token-b" } })
  hasNoData(store.getSnapshot())
  assert.equal(oldOverview.init.signal?.aborted, true)
  assert.equal(oldOrders.init.signal?.aborted, true)

  store.load("overview")
  const newOverview = transport.take(OVERVIEW)
  assert.equal(newOverview.token, "Bearer token-b")
  newOverview.respond(ok([FIXTURE_OVERVIEW[0]]))
  await flush()
  assert.equal(store.getSnapshot().overview.value?.data.length, 1)

  // Previous session answers late: data, then a 500 and a 403 for another old request.
  oldOverview.respond(ok(FIXTURE_OVERVIEW))
  oldOrders.respond({ status: 403, body: { error: "OPERATOR_FORBIDDEN", ...FIXTURE_PROFILE } })
  await flush()
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.access, "ok")
  assert.equal(snapshot.overview.value?.data.length, 1)
  assert.equal(snapshot.overview.error, null)
  assert.equal(snapshot.orders.phase, "idle")
})

test("deployment switch clears data and aborts in-flight requests; a token-only rotation keeps data", async () => {
  const { store, transport, config } = setup()
  store.load("orders")
  transport.take(ORDERS).respond(ok(FIXTURE_ORDERS))
  await flush()
  assert.equal(store.getSnapshot().orders.value?.data.length, FIXTURE_ORDERS.length)

  store.configure({ ...config, session: { id: "operator-a", accessToken: "token-a-rotated" } })
  assert.equal(store.getSnapshot().orders.value?.data.length, FIXTURE_ORDERS.length)
  store.load("audit")
  const audit = transport.take(AUDIT)
  assert.equal(audit.token, "Bearer token-a-rotated")

  store.configure({ ...config, session: { id: "operator-a", accessToken: "token-a-rotated" }, deploymentKey: "deployment-2" })
  hasNoData(store.getSnapshot())
  assert.equal(audit.init.signal?.aborted, true)
  audit.respond(ok(FIXTURE_AUDIT))
  await flush()
  assert.equal(store.getSnapshot().audit.value, null)
})

test("order selection: a slow detail for the previous order never replaces the selected order", async () => {
  const { store, transport } = setup()
  store.selectOrder(FIXTURE_IDS.buyFinality)
  const first = transport.take(detailPath(FIXTURE_IDS.buyFinality))
  store.selectOrder(FIXTURE_IDS.sellSettlement)
  assert.equal(first.init.signal?.aborted, true)
  let detail = store.getSnapshot().detail
  assert.equal(detail.orderId, FIXTURE_IDS.sellSettlement)
  assert.equal(detail.value, null)
  assert.equal(detail.phase, "loading")

  // The old order answers first, while the new one is still pending: nothing is shown.
  first.respond(ok(FIXTURE_BUY_DETAIL))
  await flush()
  detail = store.getSnapshot().detail
  assert.equal(detail.value, null)
  assert.equal(detail.phase, "loading")

  transport.take(detailPath(FIXTURE_IDS.sellSettlement)).respond(ok(FIXTURE_SELL_DETAIL))
  await flush()
  assert.equal(store.getSnapshot().detail.value?.data.order.id, FIXTURE_IDS.sellSettlement)

  // Reverse order: select A, select B, B answers, then A answers late.
  store.selectOrder(FIXTURE_IDS.buyFinality)
  detail = store.getSnapshot().detail
  assert.equal(detail.orderId, FIXTURE_IDS.buyFinality)
  assert.equal(detail.value, null, "the previously loaded SELL detail is cleared the moment another order is selected")
  const lateA = transport.take(detailPath(FIXTURE_IDS.buyFinality))
  store.selectOrder(FIXTURE_IDS.sellSettlement)
  transport.take(detailPath(FIXTURE_IDS.sellSettlement)).respond(ok(FIXTURE_SELL_DETAIL))
  await flush()
  lateA.respond({ status: 500, body: { error: "INTERNAL_ERROR" } })
  await flush()
  detail = store.getSnapshot().detail
  assert.equal(detail.phase, "ready")
  assert.equal(detail.error, null)
  assert.equal(detail.value?.data.side, "SELL")
})

test("order selection: a detail response for a different order id is rejected as invalid", async () => {
  const { store, transport } = setup()
  store.selectOrder(FIXTURE_IDS.buyUnknown)
  transport.take(detailPath(FIXTURE_IDS.buyUnknown)).respond(ok(FIXTURE_BUY_DETAIL))
  await flush()
  const detail = store.getSnapshot().detail
  assert.equal(detail.phase, "error")
  assert.equal(detail.error?.kind, "invalid")
  assert.equal(detail.value, null)
})

test("order selection: refreshing the same order keeps its value until the new response arrives", async () => {
  const { store, transport } = setup()
  store.selectOrder(FIXTURE_IDS.buyFinality)
  transport.take(detailPath(FIXTURE_IDS.buyFinality)).respond(ok(FIXTURE_BUY_DETAIL))
  await flush()
  // 003E: the first successful detail starts exactly one diagnostics read with the detail's side.
  transport.take(diagnosticsPathOf("BUY", FIXTURE_IDS.buyFinality)).respond(ok(fixtureDiagnostics(FIXTURE_IDS.buyFinality)))
  await flush()
  store.selectOrder(FIXTURE_IDS.buyFinality)
  assert.equal(transport.pending.length, 0, "re-selecting the loaded order does not refetch")
  store.refreshDetail()
  assert.equal(store.getSnapshot().detail.phase, "loading")
  assert.equal(store.getSnapshot().detail.value?.data.order.id, FIXTURE_IDS.buyFinality)
  transport.take(detailPath(FIXTURE_IDS.buyFinality)).respond({ status: 404, body: { error: "ORDER_NOT_FOUND", ...FIXTURE_PROFILE } })
  await flush()
  assert.equal(store.getSnapshot().detail.error?.kind, "not_found")
})

for (const [status, body, access] of [
  [401, { error: "Invalid bearer session token" }, "unauthorized"],
  [403, { error: "OPERATOR_FORBIDDEN", ...FIXTURE_PROFILE }, "forbidden"],
  [404, { message: "Route GET:/api/v1/admin/stocks/orders not found", error: "Not Found", statusCode: 404 }, "disabled"],
] as const) {
  test(`${status} clears every loaded value, aborts in-flight requests and blocks further loads (${access})`, async () => {
    const { store, transport } = setup()
    store.load("overview")
    store.load("orders")
    transport.take(OVERVIEW).respond(ok(FIXTURE_OVERVIEW))
    transport.take(ORDERS).respond(ok(FIXTURE_ORDERS))
    store.selectOrder(FIXTURE_IDS.buyFinality)
    transport.take(detailPath(FIXTURE_IDS.buyFinality)).respond(ok(FIXTURE_BUY_DETAIL))
    await flush()
    assert.ok(store.getSnapshot().detail.value)
    // 003E: the diagnostics read started by the detail is still in flight when access is denied.
    const diagnostics = transport.take(diagnosticsPathOf("BUY", FIXTURE_IDS.buyFinality))

    store.load("audit")
    const audit = transport.take(AUDIT)
    store.load("orders")
    transport.take(ORDERS).respond({ status, body })
    await flush()

    const snapshot = store.getSnapshot()
    assert.equal(snapshot.access, access)
    hasNoData(snapshot)
    assert.equal(audit.init.signal?.aborted, true)
    assert.equal(diagnostics.init.signal?.aborted, true, "the diagnostics read is aborted too")
    diagnostics.respond(ok(fixtureDiagnostics(FIXTURE_IDS.buyFinality)))
    await flush()
    assert.equal(store.getSnapshot().diagnostics.value, null, "a late diagnostics answer never lands after the denial")

    audit.respond(ok(FIXTURE_AUDIT))
    await flush()
    assert.equal(store.getSnapshot().audit.value, null)

    store.load("overview")
    store.selectOrder(FIXTURE_IDS.sellSettlement)
    assert.equal(transport.pending.length, 0, "no request while access is denied")

    store.retryAccess()
    assert.equal(store.getSnapshot().access, "ok")
    store.load("overview")
    assert.equal(transport.pending.length, 1)
  })
}

test("a failed refresh keeps the last value visibly paired with the error; a failed first load has no value", async () => {
  const { store, transport, tick } = setup()
  store.load("overview")
  transport.take(OVERVIEW).respond({ status: 503, body: { error: "INTERNAL_ERROR" } })
  await flush()
  let overview = store.getSnapshot().overview
  assert.equal(overview.phase, "error")
  assert.equal(overview.value, null)
  assert.equal(overview.error?.kind, "server")

  store.load("overview")
  transport.take(OVERVIEW).respond(ok(FIXTURE_OVERVIEW))
  await flush()
  const loadedAt = store.getSnapshot().overview.value?.loadedAt
  tick(90_000)
  store.load("overview")
  assert.equal(store.getSnapshot().overview.phase, "loading")
  transport.take(OVERVIEW).fail(new TypeError("fetch failed"))
  await flush()
  overview = store.getSnapshot().overview
  assert.equal(overview.phase, "error")
  assert.equal(overview.error?.kind, "network")
  assert.equal(overview.value?.loadedAt, loadedAt)
})

test("a newer request for the same resource wins even if the older one answers last", async () => {
  const { store, transport } = setup()
  store.load("orders")
  const older = transport.take(ORDERS)
  store.load("orders")
  const newer = transport.take(ORDERS)
  assert.equal(older.init.signal?.aborted, true)
  newer.respond(ok(FIXTURE_ORDERS.slice(0, 2)))
  await flush()
  older.respond(ok(FIXTURE_ORDERS))
  await flush()
  assert.equal(store.getSnapshot().orders.value?.data.length, 2)
})

test("signed out or empty token: nothing is requested", async () => {
  const signedOut = setup({ session: null })
  assert.equal(signedOut.store.getSnapshot().access, "signed_out")
  signedOut.store.load("overview")
  signedOut.store.selectOrder(FIXTURE_IDS.buyFinality)
  assert.equal(signedOut.transport.pending.length, 0)

  const empty = setup({ session: { id: "operator-a", accessToken: "" } })
  empty.store.load("overview")
  await flush()
  assert.equal(empty.transport.pending.length, 0)
  assert.equal(empty.store.getSnapshot().access, "signed_out")
})

test("deactivate (unmount) ignores in-flight answers; activate starts clean", async () => {
  const { store, transport } = setup()
  store.load("overview")
  const request = transport.take(OVERVIEW)
  store.deactivate()
  assert.equal(request.init.signal?.aborted, true)
  request.respond(ok(FIXTURE_OVERVIEW))
  await flush()
  assert.equal(store.getSnapshot().overview.value, null)
  store.load("overview")
  assert.equal(transport.pending.length, 0)
  store.activate()
  hasNoData(store.getSnapshot())
  store.load("overview")
  assert.equal(transport.pending.length, 1)
})

// ---------------------------------------------------------------- 003E wallet submission diagnostics

async function selectLoaded(store: StocksAdminStore, transport: ReturnType<typeof controlledTransport>, id: string, detail: unknown) {
  store.selectOrder(id)
  transport.take(detailPath(id)).respond(ok(detail))
  await flush()
}

test("diagnostics: no request before the detail; then exactly one GET with the detail's side, the Bearer only, and nothing else", async () => {
  const { store, transport } = setup()
  store.selectOrder(FIXTURE_IDS.sellSettlement)
  assert.deepEqual(transport.pending.map((request) => request.path), [detailPath(FIXTURE_IDS.sellSettlement)], "the side is not known before the detail")
  assert.equal(store.getSnapshot().diagnostics.side, null)
  transport.take(detailPath(FIXTURE_IDS.sellSettlement)).respond(ok(FIXTURE_SELL_DETAIL))
  await flush()
  const request = transport.take(diagnosticsPathOf("SELL", FIXTURE_IDS.sellSettlement))
  assert.equal(request.init.method, "GET")
  assert.equal(request.init.body, undefined)
  assert.deepEqual(Object.keys(request.init.headers as Record<string, string>).sort(), ["accept", "authorization"], "no operator token or role header")
  assert.equal(request.token, "Bearer token-a")
  assert.equal(store.getSnapshot().diagnostics.phase, "loading")
  request.respond(ok(fixtureDiagnostics(FIXTURE_IDS.sellSettlement, { approval: fixtureAttempt("APPROVAL", "CONFIRMED"), transfer: fixtureAttempt("TRANSFER", "REVERTED") })))
  await flush()
  const snapshot = store.getSnapshot().diagnostics
  assert.equal(snapshot.phase, "ready")
  assert.equal(snapshot.side, "SELL")
  assert.equal(snapshot.value?.data.order.side, "SELL")
  assert.equal(snapshot.value?.data.transfer?.receipt?.status, "REVERTED")
  assert.equal(snapshot.value?.meta.observedAt, "2026-09-17T03:00:00.000Z", "the server snapshot time as returned")
  assert.equal(transport.pending.length, 0, "no automatic second read")
  store.refreshDetail()
  transport.take(detailPath(FIXTURE_IDS.sellSettlement)).respond(ok(FIXTURE_SELL_DETAIL))
  await flush()
  assert.equal(transport.pending.length, 0, "a detail refresh does not re-read diagnostics")
})

test("diagnostics: selecting another order hides the previous record at once; its late answer never lands", async () => {
  const { store, transport } = setup()
  await selectLoaded(store, transport, FIXTURE_IDS.buyFinality, FIXTURE_BUY_DETAIL)
  const late = transport.take(diagnosticsPathOf("BUY", FIXTURE_IDS.buyFinality))
  store.selectOrder(FIXTURE_IDS.sellSettlement)
  const snapshot = store.getSnapshot().diagnostics
  assert.deepEqual([snapshot.orderId, snapshot.side, snapshot.phase, snapshot.value], [FIXTURE_IDS.sellSettlement, null, "idle", null])
  assert.equal(late.init.signal?.aborted, true)
  late.respond(ok(fixtureDiagnostics(FIXTURE_IDS.buyFinality)))
  await flush()
  assert.equal(store.getSnapshot().diagnostics.value, null)
  assert.equal(store.getSnapshot().diagnostics.orderId, FIXTURE_IDS.sellSettlement)
})

test("diagnostics: X → Y → X: the first read of X answers late (data or 403) and never replaces the new read of X", async () => {
  for (const lateReply of [ok(fixtureDiagnostics(FIXTURE_IDS.buyFinality)), { status: 403, body: { error: "OPERATOR_FORBIDDEN", ...FIXTURE_PROFILE } } as FixtureReply]) {
    const { store, transport } = setup()
    await selectLoaded(store, transport, FIXTURE_IDS.buyFinality, FIXTURE_BUY_DETAIL)
    const first = transport.take(diagnosticsPathOf("BUY", FIXTURE_IDS.buyFinality))
    store.selectOrder(FIXTURE_IDS.sellSettlement)
    await selectLoaded(store, transport, FIXTURE_IDS.buyFinality, FIXTURE_BUY_DETAIL)
    const second = transport.take(diagnosticsPathOf("BUY", FIXTURE_IDS.buyFinality))
    first.respond(lateReply)
    await flush()
    const during = store.getSnapshot()
    assert.equal(during.access, "ok", "the superseded request cannot deny access")
    assert.deepEqual([during.diagnostics.phase, during.diagnostics.error, during.diagnostics.value], ["loading", null, null], "the superseded request writes nothing")
    second.respond(ok(fixtureDiagnostics(FIXTURE_IDS.buyFinality, { approval: fixtureAttempt("APPROVAL", "REVERTED"), transfer: null })))
    await flush()
    assert.equal(store.getSnapshot().diagnostics.value?.data.approval?.status, "REVERTED", "only the latest read lands")
  }
})

test("diagnostics: token rotation keeps the record and the refresh uses the new token; a new session, API base or deployment clears it", async () => {
  for (const change of ["session", "apiBase", "deployment"] as const) {
    const { store, transport, config } = setup()
    await selectLoaded(store, transport, FIXTURE_IDS.buyFinality, FIXTURE_BUY_DETAIL)
    transport.take(diagnosticsPathOf("BUY", FIXTURE_IDS.buyFinality)).respond(ok(fixtureDiagnostics(FIXTURE_IDS.buyFinality)))
    await flush()
    store.configure({ ...config, session: { id: "operator-a", accessToken: "token-b" } })
    assert.ok(store.getSnapshot().diagnostics.value, "token-only change keeps data")
    store.refreshDiagnostics()
    const refresh = transport.take(diagnosticsPathOf("BUY", FIXTURE_IDS.buyFinality))
    assert.equal(refresh.token, "Bearer token-b")
    const next = change === "session" ? { session: { id: "operator-b", accessToken: "token-c" } } : change === "apiBase" ? { apiBase: "https://other.example.test" } : { deploymentKey: "deployment-2" }
    store.configure({ ...config, session: { id: "operator-a", accessToken: "token-b" }, ...next })
    assert.equal(store.getSnapshot().diagnostics.value, null, `${change}: cleared`)
    assert.equal(store.getSnapshot().diagnostics.orderId, null)
    assert.equal(refresh.init.signal?.aborted, true)
    refresh.respond(ok(fixtureDiagnostics(FIXTURE_IDS.buyFinality)))
    await flush()
    assert.equal(store.getSnapshot().diagnostics.value, null, `${change}: the old answer never lands`)
  }
})

test("diagnostics: 401 and 403 use the global denial; 404 (order or route), 503, network and invalid stay on the card", async () => {
  const cases: { reply?: FixtureReply; fail?: boolean; access: string; kind: string | null }[] = [
    { reply: { status: 401, body: { error: "Invalid bearer session token" } }, access: "unauthorized", kind: null },
    { reply: { status: 403, body: { error: "OPERATOR_FORBIDDEN", ...FIXTURE_PROFILE } }, access: "forbidden", kind: null },
    { reply: { status: 404, body: { error: "ORDER_NOT_FOUND", ...FIXTURE_PROFILE } }, access: "ok", kind: "not_found" },
    { reply: { status: 404, body: { message: "Route GET:/x not found", error: "Not Found", statusCode: 404 } }, access: "ok", kind: "disabled" },
    { reply: { status: 503, body: { error: "SUBMISSION_DIAGNOSTICS_UNAVAILABLE", ...FIXTURE_PROFILE } }, access: "ok", kind: "server" },
    { fail: true, access: "ok", kind: "network" },
    { reply: ok({ ...fixtureDiagnostics(FIXTURE_IDS.buyFinality), resubmissionAllowed: true }), access: "ok", kind: "invalid" },
  ]
  for (const item of cases) {
    const { store, transport } = setup()
    store.load("orders")
    transport.take(ORDERS).respond(ok(FIXTURE_ORDERS))
    await selectLoaded(store, transport, FIXTURE_IDS.buyFinality, FIXTURE_BUY_DETAIL)
    const request = transport.take(diagnosticsPathOf("BUY", FIXTURE_IDS.buyFinality))
    if (item.fail) request.fail(new TypeError("offline"))
    else request.respond(item.reply!)
    await flush()
    const snapshot = store.getSnapshot()
    assert.equal(snapshot.access, item.access, JSON.stringify(item.reply?.status))
    if (item.access === "ok") {
      assert.equal(snapshot.diagnostics.phase, "error")
      assert.equal(snapshot.diagnostics.error?.kind, item.kind)
      assert.equal(snapshot.diagnostics.value, null, "nothing from a failed or rejected answer")
      assert.ok(snapshot.orders.value && snapshot.detail.value, "the rest of the console stays usable")
    } else hasNoData(snapshot)
  }
})

test("diagnostics: a failed refresh keeps the earlier snapshot paired with the error; refresh while loading or without a side does nothing", async () => {
  const { store, transport } = setup()
  store.refreshDiagnostics()
  assert.equal(transport.pending.length, 0, "nothing selected")
  store.selectOrder(FIXTURE_IDS.buyFinality)
  store.refreshDiagnostics()
  assert.deepEqual(transport.pending.map((request) => request.path), [detailPath(FIXTURE_IDS.buyFinality)], "no side before the detail")
  transport.take(detailPath(FIXTURE_IDS.buyFinality)).respond(ok(FIXTURE_BUY_DETAIL))
  await flush()
  store.refreshDiagnostics()
  store.refreshDiagnostics()
  assert.equal(transport.pending.filter((request) => request.path.includes("/wallet-submissions/")).length, 1, "repeated clicks while loading add no request")
  transport.take(diagnosticsPathOf("BUY", FIXTURE_IDS.buyFinality)).respond(ok(fixtureDiagnostics(FIXTURE_IDS.buyFinality)))
  await flush()
  const first = store.getSnapshot().diagnostics.value
  store.refreshDiagnostics()
  transport.take(diagnosticsPathOf("BUY", FIXTURE_IDS.buyFinality)).respond({ status: 503, body: { error: "SUBMISSION_DIAGNOSTICS_UNAVAILABLE", ...FIXTURE_PROFILE } })
  await flush()
  const snapshot = store.getSnapshot().diagnostics
  assert.equal(snapshot.phase, "error")
  assert.equal(snapshot.error?.kind, "server")
  assert.equal(snapshot.value, first, "the earlier snapshot stays, labelled by the view as not current")
})

test("diagnostics: a response for another side, order, deployment or wallet, with wrong flags or extra fields is rejected", async () => {
  const base = fixtureDiagnostics(FIXTURE_IDS.buyFinality)
  const variants: [string, unknown][] = [
    ["other order", { ...base, order: { ...base.order, id: FIXTURE_IDS.buyUnknown } }],
    ["other side", { ...base, order: { ...base.order, side: "SELL", state: "SETTLEMENT_PENDING" } }],
    ["other deployment digest", { ...base, deploymentDigest: "f".repeat(64) }],
    ["other wallet", { ...base, order: { ...base.order, wallet: "0x2546bcd3c84621e976d8185a91a922ae77ecec30" } }],
    ["readOnly false", { ...base, readOnly: false }],
    ["execution authorization", { ...base, executionAuthorization: true }],
    ["resubmission allowed", { ...base, resubmissionAllowed: true }],
    ["raw proof field", { ...base, approval: { ...(base.approval as object), evidence: { raw: true } } }],
    ["calldata field", { ...base, transfer: { ...(base.transfer as object), transaction: { data: "0x1234" } } }],
  ]
  for (const [name, data] of variants) {
    const { store, transport } = setup()
    await selectLoaded(store, transport, FIXTURE_IDS.buyFinality, FIXTURE_BUY_DETAIL)
    transport.take(diagnosticsPathOf("BUY", FIXTURE_IDS.buyFinality)).respond(ok(data))
    await flush()
    const snapshot = store.getSnapshot().diagnostics
    assert.deepEqual([snapshot.phase, snapshot.error?.kind, snapshot.value], ["error", "invalid", null], name)
  }
  // A wrong profile is refused by the envelope check.
  const { store, transport } = setup()
  await selectLoaded(store, transport, FIXTURE_IDS.buyFinality, FIXTURE_BUY_DETAIL)
  transport.take(diagnosticsPathOf("BUY", FIXTURE_IDS.buyFinality)).respond({ status: 200, body: { ...fixtureEnvelope(base), profile: "PRODUCTION" } })
  await flush()
  assert.equal(store.getSnapshot().diagnostics.error?.kind, "invalid")
})

test("diagnostics: every request of the whole flow is a GET to a read route (no claim, outcome, reconcile or other mutation)", async () => {
  const { store, transport } = setup()
  const seen: { method: string; path: string }[] = []
  for (const id of [FIXTURE_IDS.buyFinality, FIXTURE_IDS.sellSettlement]) {
    store.selectOrder(id)
    const detail = transport.take(detailPath(id))
    seen.push({ method: String(detail.init.method), path: detail.path })
    detail.respond(ok(id === FIXTURE_IDS.buyFinality ? FIXTURE_BUY_DETAIL : FIXTURE_SELL_DETAIL))
    await flush()
    const side = id === FIXTURE_IDS.buyFinality ? "BUY" : "SELL"
    for (let i = 0; i < 2; i++) {
      const request = transport.take(diagnosticsPathOf(side, id))
      seen.push({ method: String(request.init.method), path: request.path })
      request.respond(ok(fixtureDiagnostics(id)))
      await flush()
      if (i === 0) store.refreshDiagnostics()
    }
  }
  assert.equal(transport.pending.length, 0)
  assert.ok(seen.length === 6 && seen.every((request) => request.method === "GET" && /^\/api\/v1\/admin\/stocks\/(orders|wallet-submissions)\//.test(request.path)), JSON.stringify(seen))
})

test("diagnostics (003E-1): a 404 refresh (order or route) after a successful read keeps the earlier value with its error kind", async () => {
  const replies: [FixtureReply, string, string | null][] = [
    [{ status: 404, body: { error: "ORDER_NOT_FOUND", ...FIXTURE_PROFILE } }, "not_found", "ORDER_NOT_FOUND"],
    [{ status: 404, body: { message: "Route GET:/x not found", error: "Not Found", statusCode: 404 } }, "disabled", null],
  ]
  for (const [reply, kind, code] of replies) {
    const { store, transport } = setup()
    await selectLoaded(store, transport, FIXTURE_IDS.buyFinality, FIXTURE_BUY_DETAIL)
    transport.take(diagnosticsPathOf("BUY", FIXTURE_IDS.buyFinality)).respond(ok(fixtureDiagnostics(FIXTURE_IDS.buyFinality)))
    await flush()
    const earlier = store.getSnapshot().diagnostics.value
    assert.ok(earlier)
    store.refreshDiagnostics()
    transport.take(diagnosticsPathOf("BUY", FIXTURE_IDS.buyFinality)).respond(reply)
    await flush()
    const snapshot = store.getSnapshot()
    assert.equal(snapshot.access, "ok", `${kind}: stays on the card`)
    assert.deepEqual([snapshot.diagnostics.phase, snapshot.diagnostics.error?.kind, snapshot.diagnostics.error?.code], ["error", kind, code])
    assert.equal(snapshot.diagnostics.value, earlier, `${kind}: the earlier record is kept, not cleared`)
  }
})
