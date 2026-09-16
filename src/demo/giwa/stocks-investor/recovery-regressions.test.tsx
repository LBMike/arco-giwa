import assert from "node:assert/strict"
import test from "node:test"
import { createHarness, flush, WALLET_A, WALLET_B } from "./fixtures/controller-harness"
import { tradeBlock } from "./controller"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

for (const returnToA of [false, true]) test(`send continuation keeps its retired owner isolated, A–B${returnToA ? '–A' : ''}`, async () => {
  const h = createHarness()
  const delayed = deferred<Awaited<ReturnType<typeof h.client.createOrder>>>()
  const client = { ...h.client, createOrder: () => delayed.promise }
  try {
    h.controller.setContext({ ...h.context(h.session(WALLET_A)), client }); await flush(); await h.quote("1")
    const pending = h.controller.placeOrder(); await flush()
    const attempt = h.controller.getState().attempt; assert.ok(attempt)
    const wire = await h.client.createOrder("BUY", attempt.body, h.tokenOf(WALLET_A)!, new AbortController().signal)
    delayed.resolve(wire)
    queueMicrotask(() => {
      h.controller.setContext({ ...h.context(h.session(WALLET_B)), client })
      if (returnToA) h.controller.setContext({ ...h.context(h.session(WALLET_A)), client })
    })
    await pending; await flush()
    const state = h.controller.getState()
    if (returnToA) {
      assert.equal(state.attempt?.status, "UNCONFIRMED")
      assert.equal(state.attempt?.error, null, "late old completion must not overwrite the retired registry record")
      assert.equal(state.attempt?.body, attempt.body)
    } else assert.equal(state.attempt, null)
    assert.equal([...h.registry.values()][0].status, "UNCONFIRMED")
  } finally { h.controller.suspend() }
})

test("accepted refresh cannot cross the outer await owner boundary", async () => {
  const h = createHarness()
  const delayed = deferred<Awaited<ReturnType<typeof h.client.getOrder>>>()
  const client = { ...h.client, getOrder: () => delayed.promise }
  try {
    h.controller.setContext({ ...h.context(h.session(WALLET_A)), client }); await flush(); await h.quote("1"); await h.controller.placeOrder()
    const order = h.controller.getState().attempt?.order; assert.ok(order)
    const wire = await h.client.getOrder("BUY", order.id, h.tokenOf(WALLET_A)!, new AbortController().signal)
    const pending = h.controller.refreshAttemptOrder(); await flush(); delayed.resolve(wire)
    queueMicrotask(() => h.controller.setContext({ ...h.context(h.session(WALLET_B)), client }))
    await pending; await flush()
    assert.equal(h.controller.getState().attempt, null)
    assert.equal([...h.registry.values()][0].refresh, "IDLE")
  } finally { h.controller.suspend() }
})

for (const switchFrom of ["callback", "subscriber"] as const) test(`reentrant401 ${switchFrom} cannot publish or invalidate the replacement session`, async () => {
  const h = createHarness(); let callbackCount = 0
  let off = () => {}
  try {
    h.controller.setContext({ ...h.context(h.session(WALLET_A)), onSessionRejected: () => {
      callbackCount++
      if (switchFrom === "callback") h.controller.setContext(h.context(h.session(WALLET_B)))
    } }); await flush(); await h.quote("1")
    if (switchFrom === "subscriber") off = h.controller.subscribe(() => {
      if (h.controller.getState().authRejected) h.controller.setContext(h.context(h.session(WALLET_B)))
    })
    h.controls.revokeToken(h.tokenOf(WALLET_A)!); await h.controller.placeOrder()
    assert.equal(callbackCount, switchFrom === "callback" ? 1 : 0)
    assert.equal(h.controller.getState().attempt, null)
    assert.equal(h.controller.getState().authRejected, false)
    assert.equal([...h.registry.values()][0].status, "UNCONFIRMED")
  } finally { off(); h.controller.suspend() }
})

test("subscriber switching on SUBMITTING cannot send A's order using B's credentials", async () => {
  const h = createHarness(); let off = () => {}
  try {
    await h.enter(WALLET_A); await h.quote("1")
    off = h.controller.subscribe(() => {
      if (h.controller.getState().attempt?.status === "SUBMITTING") h.enterNow(WALLET_B)
    })
    await h.controller.placeOrder()
    assert.equal(h.requests("POST", "/orders").length, 0)
    assert.equal(h.controller.getState().attempt, null)
    assert.equal([...h.registry.values()][0].status, "UNCONFIRMED")
  } finally { off(); h.controller.suspend() }
})

for (const committed of [false, true]) test(`unknown SELL with mutable refusal keeps exact key, original ${committed ? 'committed' : 'never reached service'}`, async () => {
  const h = createHarness()
  try {
    await h.enter(WALLET_A); h.controls.setHolding(WALLET_A, "3000000000"); await h.quote("1", "SELL")
    if (committed) h.controls.dropNext("sell-order")
    else h.controls.failNext("sell-order", 502, "bad gateway")
    await h.controller.placeOrder()
    const body = h.controller.getState().attempt?.body; assert.ok(body)
    h.controls.failNext("sell-order", 409, { error: "INSUFFICIENT_AVAILABLE_STOCK", profile: "DEMO_TESTNET", valuePolicy: "TEST_VALUE_ONLY", brokerMode: "MOCK_BROKER", chainId: 91342, priceSource: "FIXED_MOCK_PRICE" })
    await h.controller.retryOrder()
    assert.equal(h.controller.getState().attempt?.status, "UNCONFIRMED")
    assert.equal(tradeBlock(h.controller.getState()), "ATTEMPT_UNRESOLVED")
    h.controller.startNewOrder(); await h.quote("2", "SELL"); await h.controller.placeOrder()
    assert.equal(h.controller.getState().attempt?.body, body)
    await h.controller.retryOrder()
    assert.equal(h.controller.getState().attempt?.status, "ACCEPTED")
    assert.equal(h.controls.orders().length, 1)
    assert.equal(new Set(h.requests("POST", "/sell-orders").map(request => JSON.stringify(request.body))).size, 1)
  } finally { h.controller.suspend() }
})

for (const delay of [10_000, 60_000, 61_000]) test(`quote deadline subtracts ${delay}ms transit and never restarts on receipt`, async () => {
  const h = createHarness()
  try {
    await h.enter(WALLET_A); h.controls.holdNext("quote")
    h.controller.setQuantity("1"); const pending = h.controller.requestQuote(); await flush()
    h.advanceDevice(delay); h.controls.advanceTime(delay); h.controls.releaseHeld("quote"); await pending
    const quote = h.controller.getState().quote
    assert.ok(quote.status === "ready" || quote.status === "expired")
    assert.equal(quote.deadlineMs - h.controller.getState().nowMs, 60_000 - delay)
    if (delay < 60_000) { h.advanceDevice(60_000 - delay); h.controller.tick() }
    assert.equal(h.controller.getState().quote.status, "expired")
    await h.controller.placeOrder()
    assert.equal(h.requests("POST", "/orders").length, 0)
  } finally { h.controller.suspend() }
})

test("server observedAt bounds cached quotes and already expired replies without local wall time", async () => {
  for (const remaining of [5_000, 0, -1_000]) {
    const h = createHarness()
    try {
      await h.enter(WALLET_A)
      h.controls.corruptNext("quote", body => ({ ...body, observedAt: new Date(Date.parse((body.data as { expiresAt: string }).expiresAt) - remaining).toISOString() }))
      await h.quote("1")
      const quote = h.controller.getState().quote
      assert.ok(quote.status === "ready" || quote.status === "expired")
      assert.equal(quote.deadlineMs - h.controller.getState().nowMs, Math.max(0, remaining))
      assert.equal(quote.status, remaining > 0 ? "ready" : "expired")
    } finally { h.controller.suspend() }
  }
})

for (const code of ["QUOTE_NOT_FOUND", "QUOTE_EXPIRED_OR_DEPLOYMENT_CHANGED", "QUOTE_ALREADY_USED"]) test(`unknown outcome cannot be closed by ${code} without durable evidence`, async () => {
  const h = createHarness()
  try {
    await h.enter(WALLET_A); await h.quote("1")
    h.controls.failNext("order", 502, "bad gateway"); await h.controller.placeOrder()
    const body = h.controller.getState().attempt?.body; assert.ok(body)
    h.controls.failNext("order", code === "QUOTE_NOT_FOUND" ? 404 : 409, { error: code, profile: "DEMO_TESTNET", valuePolicy: "TEST_VALUE_ONLY", brokerMode: "MOCK_BROKER", chainId: 91342, priceSource: "FIXED_MOCK_PRICE" })
    await h.controller.retryOrder()
    assert.equal(h.controller.getState().attempt?.status, "UNCONFIRMED")
    h.controller.startNewOrder(); await h.quote("2"); await h.controller.placeOrder()
    assert.equal(h.controller.getState().attempt?.body, body)
    await h.controller.retryOrder()
    assert.equal(h.controller.getState().attempt?.status, "ACCEPTED")
    assert.equal(h.controls.orders().length, 1)
    assert.equal(new Set(h.requests("POST", "/orders").map(request => JSON.stringify(request.body))).size, 1)
  } finally { h.controller.suspend() }
})
