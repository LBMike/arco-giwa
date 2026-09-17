import assert from "node:assert/strict"
import test from "node:test"

import { createGiwaStocksHttpClient, GiwaStocksRequestError } from "./client"
import { WALLET_A } from "./fixtures/controller-harness"
import { createFakeStocksServer } from "./fixtures/fake-stocks-server"

const PROFILE = { profile: "DEMO_TESTNET", valuePolicy: "TEST_VALUE_ONLY", brokerMode: "MOCK_BROKER", chainId: 91342, priceSource: "FIXED_MOCK_PRICE" }

function setup() {
  const server = createFakeStocksServer()
  const calls: { url: string; init: RequestInit }[] = []
  const client = createGiwaStocksHttpClient({
    baseUrl: "http://fixture.invalid/",
    fetch: (url, init) => {
      calls.push({ url, init })
      return server.fetch(url, init)
    },
  })
  const token = server.controls.issueToken(WALLET_A)
  return { server, client, calls, token, signal: new AbortController().signal }
}

async function rejection(promise: Promise<unknown>): Promise<GiwaStocksRequestError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof GiwaStocksRequestError, String(error))
    return error
  }
  assert.fail("expected a rejection")
}

test("catalog is the top-level response and is requested without credentials or Authorization", async () => {
  const { client, calls, signal } = setup()
  const catalog = await client.getCatalog(signal)
  assert.equal(catalog.deploymentId, "fixture-stocks-deployment-a")
  assert.deepEqual(catalog.instruments, [{ symbol: "NVDA", quantityScale: 9, price: "120.000000", priceSource: "FIXED_MOCK_PRICE", orderCapability: "CHECK_PAUSE_AT_ORDER" }])
  assert.equal(calls[0].url, "http://fixture.invalid/api/v1/stocks/catalog")
  const headers = new Headers(calls[0].init.headers)
  assert.equal(headers.get("authorization"), null)
  assert.equal(calls[0].init.credentials, "omit")
  assert.equal(calls[0].init.cache, "no-store")
  assert.equal(calls[0].init.redirect, "error")
})

test("BUY and SELL use their own routes, exact bodies, Bearer auth, and the key travels in the order body", async () => {
  const { client, calls, token, signal, server } = setup()
  server.controls.setHolding(WALLET_A, "5000000000")
  const buyQuote = await client.createQuote("BUY", { symbol: "NVDA", quantity: "0.5" }, token, signal)
  const sellQuote = await client.createQuote("SELL", { symbol: "NVDA", quantity: "0.5" }, token, signal)
  assert.equal(buyQuote.data.side, "BUY")
  assert.equal(sellQuote.data.side, "SELL")
  // Rounding is the server's: BUY rounds up, SELL rounds down. The client passes them through.
  assert.equal(buyQuote.data.cashAmount, "60000000")
  await client.createOrder("BUY", { quoteId: buyQuote.data.id, idempotencyKey: "buy-key-0001" }, token, signal)
  await client.createOrder("SELL", { quoteId: sellQuote.data.id, idempotencyKey: "sell-key-0001" }, token, signal)
  const posts = calls.filter((call) => call.init.method === "POST")
  assert.deepEqual(
    posts.map((call) => [call.url.replace("http://fixture.invalid", ""), JSON.parse(String(call.init.body))]),
    [
      ["/api/v1/stocks/quotes", { symbol: "NVDA", quantity: "0.5" }],
      ["/api/v1/stocks/sell-quotes", { symbol: "NVDA", quantity: "0.5" }],
      ["/api/v1/stocks/orders", { quoteId: buyQuote.data.id, idempotencyKey: "buy-key-0001" }],
      ["/api/v1/stocks/sell-orders", { quoteId: sellQuote.data.id, idempotencyKey: "sell-key-0001" }],
    ],
  )
  for (const call of posts) {
    const headers = new Headers(call.init.headers)
    assert.equal(headers.get("authorization"), `Bearer ${token}`)
    assert.equal(headers.get("idempotency-key"), null)
  }
  const buyList = await client.listOrders("BUY", token, signal)
  const sellList = await client.listOrders("SELL", token, signal)
  assert.deepEqual(buyList.data.map((order) => order.side), ["BUY"])
  assert.deepEqual(sellList.data.map((order) => [order.side, order.state]), [["SELL", "AWAITING_ESCROW"]])
  const detail = await client.getOrder("SELL", sellList.data[0].id, token, signal)
  assert.equal(calls[calls.length - 1]?.url, `http://fixture.invalid/api/v1/stocks/sell-orders/${encodeURIComponent(sellList.data[0].id)}`)
  assert.equal(detail.data.id, sellList.data[0].id)
  const portfolio = await client.getPortfolio(token, signal)
  assert.deepEqual(portfolio.data.holdings[0], {
    wallet: WALLET_A,
    symbol: "NVDA",
    walletQuantity: "5000000000",
    escrowedQuantity: "0",
    reservedQuantity: "500000000",
    availableQuantity: "4500000000",
    quantity: "5000000000",
  })
})

test("a BUY row that claims SELL, or a SELL row without side, is an invalid response", async () => {
  const { client, token, signal, server } = setup()
  server.controls.corruptNext("quote", (body) => ({ ...body, data: { ...(body.data as object), side: "SELL" } }))
  assert.equal((await rejection(client.createQuote("BUY", { symbol: "NVDA", quantity: "1" }, token, signal))).kind, "INVALID_RESPONSE")
  server.controls.corruptNext("sell-quote", (body) => {
    const data = { ...(body.data as Record<string, unknown>) }
    delete data.side
    return { ...body, data }
  })
  server.controls.setHolding(WALLET_A, "5000000000")
  assert.equal((await rejection(client.createQuote("SELL", { symbol: "NVDA", quantity: "1" }, token, signal))).kind, "INVALID_RESPONSE")
})

test("error classification separates refusals, unregistered routes, unknown bodies and transport loss", async () => {
  const { client, token, signal, server } = setup()
  server.controls.setPaused(true)
  const paused = await rejection(client.createQuote("BUY", { symbol: "NVDA", quantity: "1" }, token, signal))
  assert.deepEqual([paused.kind, paused.status, paused.code], ["HTTP", 503, "STOCKS_PAUSED"])
  server.controls.setPaused(false)

  const unauthorized = await rejection(client.getPortfolio(`${token}x`, signal))
  assert.deepEqual([unauthorized.kind, unauthorized.status, unauthorized.code], ["HTTP", 401, "UNAUTHORIZED"])

  server.controls.setCatalogMode("not-registered")
  const missing = await rejection(client.getCatalog(signal))
  assert.deepEqual([missing.kind, missing.status], ["NOT_REGISTERED", 404])
  server.controls.setCatalogMode("registered")

  server.controls.failNext("order", 502, "<html>Bad gateway</html>")
  assert.equal((await rejection(client.createOrder("BUY", { quoteId: "q", idempotencyKey: "key-00000001" }, token, signal))).kind, "INVALID_RESPONSE")
  server.controls.failNext("order", 500, { error: "INTERNAL_ERROR", ...PROFILE })
  const internal = await rejection(client.createOrder("BUY", { quoteId: "q", idempotencyKey: "key-00000001" }, token, signal))
  assert.deepEqual([internal.kind, internal.status, internal.code], ["HTTP", 500, "INTERNAL_ERROR"])
  server.controls.failNext("portfolio", 404, { error: "ORDER_NOT_FOUND" })
  assert.equal((await rejection(client.getPortfolio(token, signal))).kind, "INVALID_RESPONSE", "an error without the Stocks profile is not trusted")

  server.controls.dropNext("portfolio")
  assert.equal((await rejection(client.getPortfolio(token, signal))).kind, "NETWORK")

  const controller = new AbortController()
  controller.abort()
  assert.equal((await rejection(client.getPortfolio(token, controller.signal))).kind, "ABORTED")
})

test("invalid DTOs are refused: numbers for amounts, wrong profile, unknown state, inconsistent portfolio", async () => {
  const { client, token, signal, server } = setup()
  server.controls.setCatalogMode("invalid")
  const catalog = await rejection(client.getCatalog(signal))
  assert.deepEqual([catalog.kind, catalog.code], ["INVALID_RESPONSE", "catalog.instruments[0].price"])
  server.controls.setCatalogMode("registered")

  server.controls.corruptNext("quote", (body) => ({ ...body, data: { ...(body.data as object), cashAmount: 60000000 } }))
  assert.equal((await rejection(client.createQuote("BUY", { symbol: "NVDA", quantity: "0.5" }, token, signal))).code, "quote.cashAmount")
  server.controls.corruptNext("quote", (body) => ({ ...body, profile: "PRODUCTION" }))
  assert.equal((await rejection(client.createQuote("BUY", { symbol: "NVDA", quantity: "0.5" }, token, signal))).code, "envelope.profile")

  const quote = await client.createQuote("BUY", { symbol: "NVDA", quantity: "0.5" }, token, signal)
  server.controls.corruptNext("order", (body) => ({ ...body, data: { ...(body.data as object), state: "FAILED" } }))
  assert.equal((await rejection(client.createOrder("BUY", { quoteId: quote.data.id, idempotencyKey: "key-00000002" }, token, signal))).code, "order.state")

  server.controls.setHolding(WALLET_A, "3000000000", "500000000")
  server.controls.corruptNext("portfolio", (body) => {
    const data = body.data as { holdings: Record<string, unknown>[] }
    return { ...body, data: { ...data, holdings: [{ ...data.holdings[0], quantity: "3500000001" }] } }
  })
  assert.equal((await rejection(client.getPortfolio(token, signal))).code, "portfolio.holdings[0].quantity")
  server.controls.corruptNext("portfolio", (body) => {
    const data = body.data as { holdings: Record<string, unknown>[] }
    return { ...body, data: { ...data, holdings: [{ ...data.holdings[0], availableQuantity: "3500000000" }] } }
  })
  assert.equal((await rejection(client.getPortfolio(token, signal))).code, "portfolio.holdings[0].availableQuantity")
})

test("the base URL must be a plain http(s) origin", () => {
  for (const bad of ["ftp://x", "http://user:pass@x", "http://x/?a=1", "not a url"]) {
    assert.throws(() => createGiwaStocksHttpClient({ baseUrl: bad }), /GIWA_STOCKS_INVALID_BASE_URL/, bad)
  }
})

test("portfolio accepts signed deficits that satisfy the server identities, and any number of pending orders", async () => {
  const { client, token, signal, server } = setup()
  server.controls.corruptNext("portfolio", (body) => ({
    ...body,
    data: {
      holdings: [{ wallet: WALLET_A, symbol: "NVDA", walletQuantity: "-1", escrowedQuantity: "1", reservedQuantity: "3", availableQuantity: "-4", quantity: "0" }],
      pending: Array.from({ length: 1500 }, (_, index) => ({ id: `order-${index}`, state: "AWAITING_FUNDING", quantity: "1", cashAmount: "1", side: "BUY" })),
      projectionPolicy: "FINALIZED_RESTRICTED_TRANSFER_MOVEMENTS",
    },
  }))
  const portfolio = await client.getPortfolio(token, signal)
  assert.equal(portfolio.data.holdings[0].availableQuantity, "-4")
  assert.equal(portfolio.data.pending.length, 1500)
  for (const bad of [{ availableQuantity: "-0" }, { escrowedQuantity: "-1", quantity: "-2" }, { reservedQuantity: "-3", availableQuantity: "2" }]) {
    server.controls.corruptNext("portfolio", (body) => ({
      ...body,
      data: { holdings: [{ wallet: WALLET_A, symbol: "NVDA", walletQuantity: "-1", escrowedQuantity: "1", reservedQuantity: "3", availableQuantity: "-4", quantity: "0", ...bad }], pending: [], projectionPolicy: "FINALIZED_RESTRICTED_TRANSFER_MOVEMENTS" },
    }))
    assert.equal((await rejection(client.getPortfolio(token, signal))).kind, "INVALID_RESPONSE", JSON.stringify(bad))
  }
})

test("a base with a bare query or fragment delimiter is refused before an authenticated quote is sent", () => {
  for (const baseUrl of ["https://api.test?", "https://api.test#", "https://api.test/prefix?", "https://api.test/prefix#"]) {
    const calls: string[] = []
    assert.throws(
      () => createGiwaStocksHttpClient({ baseUrl, fetch: async (url) => { calls.push(url); return Response.json({}) } }),
      (error: unknown) => error instanceof Error && error.message === "GIWA_STOCKS_INVALID_BASE_URL",
      baseUrl,
    )
    assert.equal(calls.length, 0)
  }
})

test("a path-prefixed base sends each route under the prefix, with Authorization only on authenticated calls", async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const client = createGiwaStocksHttpClient({
    baseUrl: "https://api.test/prefix//",
    fetch: async (url, init) => { calls.push({ url, init }); return Response.json({ error: "FIXTURE_REFUSED" }, { status: 403 }) },
  })
  assert.equal(client.baseUrl, "https://api.test/prefix")
  const signal = new AbortController().signal
  await client.getCatalog(signal).catch(() => {})
  await client.createQuote("BUY", { symbol: "NVDA", quantity: "1" }, "session.jwt", signal).catch(() => {})
  await client.getOrder("SELL", "a/b", "session.jwt", signal).catch(() => {})
  assert.deepEqual(calls.map(c => [c.init.method, c.url, new Headers(c.init.headers).get("authorization")]), [
    ["GET", "https://api.test/prefix/api/v1/stocks/catalog", null],
    ["POST", "https://api.test/prefix/api/v1/stocks/quotes", "Bearer session.jwt"],
    ["GET", "https://api.test/prefix/api/v1/stocks/sell-orders/a%2Fb", "Bearer session.jwt"],
  ])
})
