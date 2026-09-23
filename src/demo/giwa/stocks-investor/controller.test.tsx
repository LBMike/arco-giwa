import assert from "node:assert/strict"
import test from "node:test"

import { tradeBlock } from "./controller"
import { createHarness, flush, WALLET_A, WALLET_B } from "./fixtures/controller-harness"

const PROFILE = { profile: "DEMO_TESTNET", valuePolicy: "TEST_VALUE_ONLY", brokerMode: "MOCK_BROKER", chainId: 91342, priceSource: "FIXED_MOCK_PRICE" }

test("without a verified session only the public catalog is requested", async () => {
  const h = createHarness()
  await h.enter(null)
  assert.equal(h.controller.getState().catalog.status, "ready")
  assert.equal(tradeBlock(h.controller.getState()), "SIGNED_OUT")
  await h.controller.loadPortfolio()
  await h.controller.loadOrders()
  h.controller.setQuantity("1")
  await h.controller.requestQuote()
  assert.deepEqual(
    h.controls.requests.map((request) => [request.method, request.path, request.authorization]),
    [["GET", "/api/v1/stocks/catalog", null]],
  )
})

test("a connected wallet that differs from the verified session is treated as signed out", async () => {
  const h = createHarness()
  h.enterWith(h.session(WALLET_A), { address: WALLET_B, chainId: 91342 })
  await flush()
  assert.deepEqual(h.controller.getState().session, { status: "signed-out", reason: "WALLET_MISMATCH" })
  h.enterWith(h.session(WALLET_A), { address: WALLET_A.toUpperCase().replace("0X", "0x"), chainId: 1 })
  assert.deepEqual(h.controller.getState().session, { status: "signed-out", reason: "CHAIN_MISMATCH" })
  h.enterWith(h.session(WALLET_A), null)
  assert.deepEqual(h.controller.getState().session, { status: "signed-out", reason: "WALLET_MISMATCH" })
  const tokenA = h.session(WALLET_A)
  assert.equal(tokenA.status, "verified")
  h.enterWith({ status: "verified", walletAddress: WALLET_B, chainId: 91342, token: tokenA.status === "verified" ? tokenA.token : "" })
  assert.deepEqual(h.controller.getState().session, { status: "signed-out", reason: "INVALID_SESSION" }, "a token for A is not a session for B")
  await h.controller.loadPortfolio()
  assert.equal(h.requests("GET", "/portfolio").length, 0)
})

test("A→B: a late portfolio answer for A is aborted and ignored; B sees only B", async () => {
  for (const ignoreAbort of [false, true]) {
    const h = createHarness()
    h.controls.setHolding(WALLET_A, "111000000000")
    h.controls.setHolding(WALLET_B, "999000000000")
    h.controls.setIgnoreAbort(ignoreAbort)
    await h.enter(WALLET_A)
    h.controls.holdNext("portfolio")
    const lateA = h.controller.loadPortfolio()
    await flush()
    assert.equal(h.controls.heldCount(), 1)
    await h.enter(WALLET_B)
    assert.deepEqual(h.controller.getState().portfolio, { status: "idle" }, "nothing of A remains visible")
    await h.controller.loadPortfolio()
    h.controls.releaseHeld()
    await lateA
    await flush()
    const portfolio = h.controller.getState().portfolio
    assert.equal(portfolio.status, "ready", `ignoreAbort=${ignoreAbort}`)
    if (portfolio.status === "ready") assert.deepEqual(portfolio.portfolio.holdings.map((row) => [row.wallet, row.quantity]), [[WALLET_B, "999000000000"]])
    const session = h.controller.getState().session
    assert.equal(session.status === "verified" ? session.wallet : null, WALLET_B)
  }
})

test("A→B: late quote, orders list and 401 answers for A never reach B", async () => {
  const h = createHarness()
  h.controls.setIgnoreAbort(true)
  await h.enter(WALLET_A)
  h.controls.holdNext("quote")
  h.controls.holdNext("orders")
  h.controller.setQuantity("1")
  const quote = h.controller.requestQuote()
  const orders = h.controller.loadOrders()
  await flush()
  h.controls.revokeToken(h.tokenOf(WALLET_A) as string)
  h.controls.holdNext("portfolio")
  const unauthorized = h.controller.loadPortfolio()
  await flush()
  await h.enter(WALLET_B)
  h.controls.releaseHeld()
  await Promise.all([quote, orders, unauthorized])
  await flush()
  const state = h.controller.getState()
  assert.deepEqual(state.quote, { status: "idle" })
  assert.deepEqual(state.orders, { status: "idle" })
  assert.deepEqual(state.portfolio, { status: "idle" })
  assert.equal(state.authRejected, false, "A's 401 is not B's session rejection")
  assert.deepEqual(h.rejected, [])
})

test("A→B→A: a late order answer is ignored, A's attempt comes back unconfirmed with the same body, B never sees it", async () => {
  const h = createHarness()
  h.controls.setIgnoreAbort(true)
  await h.enter(WALLET_A)
  await h.quote("1")
  assert.equal(h.controller.getState().quote.status, "ready")
  h.controls.holdNext("order")
  const placing = h.controller.placeOrder()
  await flush()
  const submitted = h.controller.getState().attempt
  assert.equal(submitted?.status, "SUBMITTING")
  assert.equal(h.controls.orders().length, 1, "the server applied the request")

  await h.enter(WALLET_B)
  assert.equal(h.controller.getState().attempt, null)
  assert.equal(tradeBlock(h.controller.getState()), null, "B can trade independently")

  await h.enter(WALLET_A)
  h.controls.releaseHeld()
  await placing
  await flush()
  const restored = h.controller.getState().attempt
  assert.equal(restored?.status, "UNCONFIRMED", "an unobservable answer is unconfirmed, not failed or accepted")
  assert.deepEqual(restored?.body, submitted?.body)
  assert.equal(tradeBlock(h.controller.getState()), "ATTEMPT_UNRESOLVED")

  await h.controller.retryOrder()
  await flush()
  const accepted = h.controller.getState().attempt
  assert.equal(accepted?.status, "ACCEPTED")
  assert.equal(accepted?.order?.state, "AWAITING_FUNDING")
  const posts = h.requests("POST", "/api/v1/stocks/orders")
  assert.equal(posts.length, 2)
  assert.deepEqual(posts[1].body, posts[0].body, "retry resends the identical body and key")
  assert.equal(h.controls.orders().length, 1, "no second order")

  await h.enter(WALLET_B)
  assert.equal(h.controller.getState().attempt, null)
})

test("a double click submits once", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("0.25")
  h.controls.holdNext("order")
  const first = h.controller.placeOrder()
  const second = h.controller.placeOrder()
  await flush()
  void h.controller.retryOrder()
  h.controls.releaseHeld()
  await Promise.all([first, second])
  await flush()
  assert.equal(h.requests("POST", "/api/v1/stocks/orders").length, 1)
  assert.equal(h.controller.getState().attempt?.status, "ACCEPTED")
})

test("a lost order response keeps the same request; retry and order lookup both resolve to the one order", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("2")
  h.controls.dropNext("order")
  await h.controller.placeOrder()
  await flush()
  const lost = h.controller.getState().attempt
  assert.equal(lost?.status, "UNCONFIRMED")
  assert.equal(lost?.error?.kind, "NETWORK")
  // Inputs and new quotes are locked while the outcome is unknown.
  h.controller.setQuantity("3")
  h.controller.setSide("SELL")
  await h.controller.requestQuote()
  assert.equal(h.requests("POST", "/quotes").length, 1)
  assert.equal(h.controller.getState().quantityInput, "2")

  await h.controller.checkOrder()
  await flush()
  const found = h.controller.getState().attempt
  assert.equal(found?.status, "ACCEPTED")
  assert.equal(found?.order?.idempotencyKey, lost?.body.idempotencyKey)
  assert.equal(h.controls.orders().length, 1)

  // A 500 with an unrecognised body and a 500 INTERNAL_ERROR are both unknown outcomes.
  h.controller.startNewOrder()
  await h.quote("1")
  h.controls.failNext("order", 500, "<html>oops</html>")
  await h.controller.placeOrder()
  assert.equal(h.controller.getState().attempt?.status, "UNCONFIRMED")
  const key = h.controller.getState().attempt?.body.idempotencyKey
  h.controls.failNext("order", 500, { error: "INTERNAL_ERROR", ...PROFILE })
  await h.controller.retryOrder()
  assert.equal(h.controller.getState().attempt?.status, "UNCONFIRMED")
  assert.equal(h.controller.getState().attempt?.body.idempotencyKey, key)
  h.controls.corruptNext("order", (body) => ({ ...body, data: { ...(body.data as object), quantity: "5" } }))
  await h.controller.retryOrder()
  assert.equal(h.controller.getState().attempt?.status, "UNCONFIRMED", "an order that does not answer this request is not accepted")
  assert.equal(h.controller.getState().attempt?.error?.kind, "MISMATCH")
  await h.controller.retryOrder()
  assert.equal(h.controller.getState().attempt?.status, "ACCEPTED")
  assert.equal(new Set(h.requests("POST", "/api/v1/stocks/orders").slice(-4).map((request) => JSON.stringify(request.body))).size, 1)
})

test("lookup that does not find the request stays unconfirmed; it is not proof of non-submission", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("1")
  h.controls.failNext("order", 504, "gateway timeout")
  await h.controller.placeOrder()
  await h.controller.checkOrder()
  await flush()
  const attempt = h.controller.getState().attempt
  assert.equal(attempt?.status, "UNCONFIRMED")
  assert.equal(attempt?.lookup, "NOT_FOUND")
})

test("an expired quote blocks the order, is never replaced automatically, and a new quote is a user action", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("1")
  const initial = h.controller.getState()
  assert.equal(initial.quote.status, "ready")
  if (initial.quote.status !== "ready") return
  // The controller charges request transit time against the 60-second quote.
  // Test the computed deadline, rather than assuming that transit cost 0 ms.
  const beforeDeadline = initial.quote.deadlineMs - initial.nowMs - 1
  assert.ok(beforeDeadline >= 0)
  h.advanceDevice(beforeDeadline)
  h.controller.tick()
  assert.equal(h.controller.getState().quote.status, "ready")
  h.advanceDevice(1)
  h.controller.tick()
  assert.equal(h.controller.getState().quote.status, "expired")
  await h.controller.placeOrder()
  for (let index = 0; index < 5; index += 1) h.controller.tick()
  await flush()
  assert.equal(h.requests("POST", "/api/v1/stocks/orders").length, 0)
  assert.equal(h.requests("POST", "/quotes").length, 1, "no automatic re-quote")
  await h.controller.requestQuote()
  await flush()
  assert.equal(h.requests("POST", "/quotes").length, 2)
  assert.equal(h.controller.getState().quote.status, "ready")

  // The device deadline is still open but the server's quote has expired: the server's refusal wins.
  h.controls.advanceTime(61_000)
  await h.controller.placeOrder()
  const attempt = h.controller.getState().attempt
  assert.equal(attempt?.status, "REJECTED")
  assert.equal(attempt?.error?.code, "QUOTE_EXPIRED_OR_DEPLOYMENT_CHANGED")
  assert.equal(h.controller.getState().quote.status, "expired")
  assert.equal(h.controls.orders().length, 0)
})

test("401 marks this session rejected once, stops authenticated reads, and a fresh token recovers", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  h.controls.revokeToken(h.tokenOf(WALLET_A) as string)
  await h.controller.loadPortfolio()
  await h.controller.loadOrders()
  const state = h.controller.getState()
  assert.equal(state.authRejected, true)
  assert.deepEqual(h.rejected, [WALLET_A])
  assert.equal(tradeBlock(state), "AUTH_REJECTED")
  assert.equal(h.requests("GET", "/api/v1/stocks/orders").length, 0, "no further authenticated reads with a rejected token")

  // Order placed with the stale token: 401 means not processed; the same request is retried after re-auth.
  h.enterWith(h.session(WALLET_A, true))
  await flush()
  assert.equal(h.controller.getState().authRejected, false)
  await h.quote("1")
  h.controls.revokeToken(h.tokenOf(WALLET_A) as string)
  await h.controller.placeOrder()
  const attempt = h.controller.getState().attempt
  assert.equal(attempt?.status, "AUTH_REQUIRED")
  h.enterWith(h.session(WALLET_A, true))
  await flush()
  assert.equal(h.controller.getState().attempt?.status, "AUTH_REQUIRED", "kept for the same wallet across a token refresh")
  await h.controller.retryOrder()
  assert.equal(h.controller.getState().attempt?.status, "ACCEPTED")
  assert.equal(h.controller.getState().attempt?.body.idempotencyKey, attempt?.body.idempotencyKey)
  assert.deepEqual(h.rejected, [WALLET_A, WALLET_A], "reported once per session")
})

test("API disabled: unregistered routes, not activated, paused, and no client", async () => {
  const unregistered = createHarness()
  unregistered.controls.setCatalogMode("not-registered")
  await unregistered.enter(WALLET_A)
  assert.equal(unregistered.controller.getState().catalog.status, "unavailable")
  assert.equal(tradeBlock(unregistered.controller.getState()), "CATALOG_NOT_READY")

  const inactive = createHarness()
  inactive.controls.setCatalogMode("not-activated")
  await inactive.enter(WALLET_A)
  assert.equal(tradeBlock(inactive.controller.getState()), "NOT_ACTIVATED")
  inactive.controller.setQuantity("1")
  await inactive.controller.requestQuote()
  assert.equal(inactive.requests("POST", "/quotes").length, 0)

  const paused = createHarness()
  await paused.enter(WALLET_A)
  paused.controls.setPaused(true)
  await paused.quote("1")
  const quote = paused.controller.getState().quote
  assert.equal(quote.status, "error")
  if (quote.status === "error") assert.deepEqual([quote.error.kind, quote.error.code], ["REFUSED", "STOCKS_PAUSED"])

  const none = createHarness()
  none.controller.setContext({ client: null, session: none.session(WALLET_A) })
  await flush()
  assert.equal(none.controller.getState().catalog.status, "idle")
  assert.equal(tradeBlock(none.controller.getState()), "NO_CLIENT")
  assert.equal(none.controls.requests.length, 0, "no fixture or fallback data is used")
})

test("invalid catalog and mismatched quote are refused, not rendered", async () => {
  const h = createHarness()
  h.controls.setCatalogMode("invalid")
  await h.enter(WALLET_A)
  const catalog = h.controller.getState().catalog
  assert.equal(catalog.status, "error")
  if (catalog.status === "error") assert.equal(catalog.error.kind, "INVALID_RESPONSE")
  h.controls.setCatalogMode("registered")
  await h.controller.loadCatalog()
  h.controls.corruptNext("quote", (body) => ({ ...body, data: { ...(body.data as object), quantity: "2000000000" } }))
  await h.quote("1")
  const quote = h.controller.getState().quote
  assert.equal(quote.status, "error")
  if (quote.status === "error") assert.equal(quote.error.code, "QUOTE_DOES_NOT_MATCH_REQUEST")
  h.controls.corruptNext("portfolio", (body) => ({ ...body, data: { ...(body.data as object), holdings: [{ wallet: WALLET_B, symbol: "NVDA", walletQuantity: "1", escrowedQuantity: "0", reservedQuantity: "0", availableQuantity: "1", quantity: "1" }] } }))
  await h.controller.loadPortfolio()
  const portfolio = h.controller.getState().portfolio
  assert.equal(portfolio.status, "error")
  if (portfolio.status === "error") assert.equal(portfolio.error.code, "HOLDING_WALLET_MISMATCH")
})

test("a deployment change starts a new generation and hides the previous deployment's attempt", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("1")
  h.controls.failNext("order", 502, "bad gateway")
  await h.controller.placeOrder()
  const before = h.controller.getState()
  assert.equal(before.attempt?.status, "UNCONFIRMED")
  h.controls.setDeploymentId("fixture-stocks-deployment-b")
  await h.controller.loadCatalog()
  await flush()
  const after = h.controller.getState()
  assert.ok(after.generation > before.generation)
  assert.equal(after.attempt, null)
  assert.deepEqual(after.quote, { status: "idle" })
  h.controls.setDeploymentId("fixture-stocks-deployment-a")
  await h.controller.loadCatalog()
  await flush()
  assert.equal(h.controller.getState().attempt?.status, "UNCONFIRMED", "the original deployment's attempt is still its own")
})

test("large and minimum-unit orders keep exact server amounts; a zero sell payout is refused", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("1000000000000000000000")
  const large = h.controller.getState().quote
  assert.equal(large.status, "ready")
  if (large.status === "ready") {
    assert.equal(large.quote.quantity, `1${"0".repeat(30)}`)
    assert.equal(large.quote.cashAmount, `12${"0".repeat(28)}`)
  }
  await h.quote("0.000000001")
  const small = h.controller.getState().quote
  if (small.status === "ready") assert.equal(small.quote.cashAmount, "1", "BUY rounds up to one cash base unit")
  h.controls.setHolding(WALLET_A, "1")
  await h.quote("0.000000001", "SELL")
  const zero = h.controller.getState().quote
  assert.equal(zero.status, "error")
  if (zero.status === "error") assert.equal(zero.error.code, "ZERO_SELL_PAYOUT")
})

test("SELL guides escrow; accepted orders are re-read by id without changing anything", async () => {
  const h = createHarness()
  h.controls.setHolding(WALLET_A, "3000000000")
  await h.enter(WALLET_A)
  await h.quote("1", "SELL")
  await h.controller.placeOrder()
  const attempt = h.controller.getState().attempt
  assert.equal(attempt?.order?.side, "SELL")
  assert.equal(attempt?.order?.state, "AWAITING_ESCROW")
  h.controls.advanceOrder(attempt?.order?.id as string, "SELL_BROKER_UNKNOWN")
  await h.controller.refreshAttemptOrder()
  assert.equal(h.controller.getState().attempt?.order?.state, "SELL_BROKER_UNKNOWN")
  assert.equal(h.requests("POST", "/api/v1/stocks/sell-orders").length, 1)
})

test("after an unknown outcome, a retry refused before the idempotency lookup stays unresolved; no second order", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("1")
  h.controls.dropNext("order")
  await h.controller.placeOrder()
  assert.equal(h.controls.orders().length, 1, "the first send created the order")
  for (const [setup, code] of [
    [() => h.controls.setPaused(true), "STOCKS_PAUSED"],
    [() => { h.controls.setPaused(false); h.controls.failNext("order", 404, { message: "Route POST:/api/v1/stocks/orders not found", error: "Not Found", statusCode: 404 }) }, null],
    [() => h.controls.failNext("order", 409, { error: "IDEMPOTENCY_CONFLICT", ...PROFILE }), "IDEMPOTENCY_CONFLICT"],
    // plugin.ts body() and createOrder's key check run before the idempotency lookup as well.
    [() => h.controls.failNext("order", 400, { error: "INVALID_BODY", ...PROFILE }), "INVALID_BODY"],
    [() => h.controls.failNext("order", 400, { error: "UNEXPECTED_FIELDS", ...PROFILE }), "UNEXPECTED_FIELDS"],
    [() => h.controls.failNext("order", 400, { error: "INVALID_ORDER_REQUEST", ...PROFILE }), "INVALID_ORDER_REQUEST"],
  ] as const) {
    setup()
    await h.controller.retryOrder()
    const attempt = h.controller.getState().attempt
    assert.equal(attempt?.status, "UNCONFIRMED", `retry refused with ${code ?? "unregistered route"}`)
    assert.equal(attempt?.outcomeUnknown, true)
    assert.equal(tradeBlock(h.controller.getState()), "ATTEMPT_UNRESOLVED")
    h.controller.startNewOrder()
    assert.notEqual(h.controller.getState().attempt, null, "an unresolved attempt cannot be dropped")
  }
  h.controls.setPaused(false)
  await h.controller.retryOrder()
  assert.equal(h.controller.getState().attempt?.status, "ACCEPTED")
  assert.equal(h.controls.orders().length, 1)
  assert.equal(new Set(h.requests("POST", "/api/v1/stocks/orders").map((request) => JSON.stringify(request.body))).size, 1)
})

test("after an unknown outcome, expiry refusal stays unresolved and only a positive same-key answer resolves it", async () => {
  // First send never reached the service (gateway error before handling): no order exists.
  const none = createHarness()
  await none.enter(WALLET_A)
  await none.quote("1")
  none.controls.failNext("order", 502, "bad gateway")
  await none.controller.placeOrder()
  none.controls.advanceTime(61_000)
  await none.controller.retryOrder()
  const refused = none.controller.getState().attempt
  assert.equal(refused?.status, "UNCONFIRMED")
  assert.equal(refused?.error?.code, "QUOTE_EXPIRED_OR_DEPLOYMENT_CHANGED")
  assert.equal(none.controls.orders().length, 0)
  none.controller.startNewOrder()
  assert.equal(none.controller.getState().attempt?.body, refused?.body, "a refusal does not prove durable key closure")

  // First send created the order: after expiry the same key still returns that order, not a refusal.
  const created = createHarness()
  await created.enter(WALLET_A)
  await created.quote("1")
  created.controls.dropNext("order")
  await created.controller.placeOrder()
  created.controls.advanceTime(61_000)
  await created.controller.retryOrder()
  assert.equal(created.controller.getState().attempt?.status, "ACCEPTED")
  assert.equal(created.controls.orders().length, 1)
})

test("a remount or a re-created client for the same API keeps an unresolved attempt; the in-flight POST is not aborted", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("1")
  h.controls.holdNext("order")
  const placing = h.controller.placeOrder()
  await flush()
  const key = h.controller.getState().attempt?.body.idempotencyKey
  h.controller.suspend()
  const remounted = h.makeController()
  const { createGiwaStocksHttpClient } = await import("./client")
  const recreatedClient = createGiwaStocksHttpClient({ baseUrl: "http://fixture.invalid/", fetch: (input, init) => h.server.fetch(input, init) })
  remounted.setContext({ ...h.context(h.session(WALLET_A)), client: recreatedClient })
  await flush()
  const restored = remounted.getState().attempt
  assert.equal(restored?.status, "UNCONFIRMED")
  assert.equal(restored?.body.idempotencyKey, key)
  assert.equal(tradeBlock(remounted.getState()), "ATTEMPT_UNRESOLVED")
  remounted.setQuantity("2")
  await remounted.requestQuote()
  await remounted.placeOrder()
  assert.equal(h.requests("POST", "/api/v1/stocks/orders").length, 1, "no new order while the first is unresolved")
  h.controls.releaseHeld()
  await placing
  await flush()
  assert.equal(remounted.getState().attempt?.status, "UNCONFIRMED", "the unmounted controller's late answer is not applied")
  await remounted.retryOrder()
  assert.equal(remounted.getState().attempt?.status, "ACCEPTED")
  assert.equal(h.controls.orders().length, 1)
})

test("retry is not possible while an order lookup is running, and the lookup result is applied", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("1")
  h.controls.dropNext("order")
  await h.controller.placeOrder()
  h.controls.holdNext("orders")
  const checking = h.controller.checkOrder()
  await flush()
  assert.equal(h.controller.getState().attempt?.lookup, "CHECKING")
  await h.controller.retryOrder()
  assert.equal(h.requests("POST", "/api/v1/stocks/orders").length, 1, "retry ignored during lookup")
  h.controls.releaseHeld()
  await checking
  await flush()
  assert.equal(h.controller.getState().attempt?.status, "ACCEPTED")
})

test("authenticated reads wait for the catalog's deployment; no false deployment change", async () => {
  const h = createHarness()
  h.controls.holdNext("catalog")
  h.enterNow(WALLET_A)
  await h.controller.loadOrders()
  await h.controller.loadPortfolio()
  assert.equal(h.requests("GET", "/api/v1/stocks/orders").length, 0)
  assert.equal(h.requests("GET", "/api/v1/stocks/portfolio").length, 0)
  h.controls.releaseHeld()
  await flush()
  await h.controller.loadOrders()
  const orders = h.controller.getState().orders
  assert.equal(orders.status, "ready")
  if (orders.status === "ready") assert.equal(orders.buy.status, "ready")
  assert.equal(h.requests("GET", "/api/v1/stocks/catalog").length, 1, "no catalog reload loop")
})
