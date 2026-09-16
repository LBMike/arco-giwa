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

    store.load("audit")
    const audit = transport.take(AUDIT)
    store.load("orders")
    transport.take(ORDERS).respond({ status, body })
    await flush()

    const snapshot = store.getSnapshot()
    assert.equal(snapshot.access, access)
    hasNoData(snapshot)
    assert.equal(audit.init.signal?.aborted, true)

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
