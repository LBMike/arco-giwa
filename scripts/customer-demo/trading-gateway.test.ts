import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { CUSTOMER_API, customerGateway } from "./gateway"
import { createGiwaStocksHttpClient, GiwaStocksRequestError } from "../../src/demo/giwa/stocks-investor/client"

const id = "11111111-1111-4111-8111-111111111111"
const digest = "a".repeat(64)
const txHash = `0x${"b".repeat(64)}`
const token = "header.payload.signature"
const record = { claimId: id, intentKey: digest, stage: "TRANSFER", transactionDigest: digest }
const claim = { side: "BUY", orderId: id, intentKey: digest, stage: "TRANSFER", transactionDigest: digest,
  deploymentDigest: digest, transaction: { chainId: 91342, from: `0x${"1".repeat(40)}`, to: `0x${"2".repeat(40)}`, value: "0", data: "0x12345678" } }
const order = { quoteId: id, idempotencyKey: "customer-order-original" }
const writes: [string, unknown][] = [
  ["quotes", { symbol: "NVDA", quantity: "2.000000001" }], ["quotes", { symbol: "NVDA", cashAmount: "60" }], ["quotes", { symbol: "NVDA", cashAmount: "0.000001" }],
  ["sell-quotes", { symbol: "NVDA", quantity: "0.5" }],
  ...["orders", "sell-orders", "orders/recover", "sell-orders/recover"].map(path => [path, order] as [string, unknown]),
  ["wallet-submissions/claims", claim], ["wallet-submissions/outcomes", { ...record, status: "SUBMITTED", txHash }],
  ["wallet-submissions/reconcile", { ...record, txHash }],
]
async function fixture(t: test.TestContext, fetcher: typeof fetch, tradesEnabled = true, timeoutMs = 1000) {
  let handler: ReturnType<typeof customerGateway>
  const server = createServer((req, res) => void handler(req, res, () => { res.writeHead(418); res.end() }))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address(); assert.ok(address && typeof address === "object")
  const origin = `http://127.0.0.1:${address.port}`
  handler = customerGateway({ origin, fetcher, authEnabled: true, tradesEnabled, timeoutMs })
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  const request = (path: string, body?: unknown, extra: Record<string, string> = {}) => fetch(origin + path, {
    method: body === undefined ? "GET" : "POST", headers: { origin, authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { origin, request }
}

test("all existing investor trade, execution and recovery routes cross native HTTP exactly once", async t => {
  const calls: { path: string; init: RequestInit }[] = []
  const f = await fixture(t, async (url, init) => {
    assert.ok(String(url).startsWith(CUSTOMER_API + "/api/v1/stocks/"))
    calls.push({ path: String(url), init: init! })
    return Response.json({ data: null }, { headers: { "set-cookie": "discard=1" } })
  })
  for (const [path, body] of writes) {
    const r = await f.request(`/api/v1/stocks/${path}`, body, { cookie: "discard=1", "x-operator-token": "discard", "idempotency-key": "must-not-change-body-key" })
    assert.equal(r.status, 200); assert.equal(r.headers.get("set-cookie"), null); assert.equal(r.headers.get("cache-control"), "no-store")
    const sent = calls.at(-1)!
    assert.equal(sent.path, `${CUSTOMER_API}/api/v1/stocks/${path}`)
    assert.equal(sent.init.method, "POST"); assert.equal(sent.init.redirect, "error"); assert.equal(sent.init.credentials, "omit")
    assert.deepEqual(JSON.parse(String(sent.init.body)), body)
    assert.deepEqual(sent.init.headers, { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}` })
  }
  for (const path of ["execution/deployment", `execution/BUY/${id}`, `execution/SELL/${id}`, `wallet-submissions/BUY/${id}`, `wallet-submissions/SELL/${id}`]) {
    assert.equal((await f.request(`/api/v1/stocks/${path}`)).status, 200)
    assert.deepEqual(calls.at(-1)!.init.headers, { accept: "application/json", authorization: `Bearer ${token}` })
  }
  assert.equal(calls.length, writes.length + 5)
})

test("trade opt-in requires auth and remains disabled in existing read/auth mode", async t => {
  assert.throws(() => customerGateway({ origin: "http://127.0.0.1:4392", tradesEnabled: true }), /CUSTOMER_AUTH_REQUIRED/)
  let calls = 0
  const f = await fixture(t, async () => { calls++; return Response.json({}) }, false)
  for (const [path, body] of writes) assert.equal((await f.request(`/api/v1/stocks/${path}`, body)).status, 503)
  assert.equal((await f.request("/api/v1/stocks/execution/deployment")).status, 503)
  assert.equal(calls, 0)
})

test("foreign origin, malformed auth, routes, methods and unexpected fields fail before egress", async t => {
  let calls = 0
  const f = await fixture(t, async () => { calls++; return Response.json({}) })
  const path = "/api/v1/stocks/orders"
  for (const extra of [{ origin: "https://elsewhere.example" }, { origin: "" }, { "sec-fetch-site": "cross-site" }]) assert.equal((await f.request(path, order, extra)).status, 403)
  assert.equal((await f.request(path, order, { authorization: "" })).status, 401)
  assert.equal((await f.request(path, order, { "content-type": "text/plain" })).status, 415)
  assert.equal((await fetch(f.origin + path, { method: "PUT", headers: { origin: f.origin } })).status, 503)
  for (const route of ["/api/v1/admin/stocks/orders", "/api/v1/stocks/mint", "/api/v1/faucet/request", "/__fixture/wallet", path + "?target=elsewhere", path + "/", "/api/v1/stocks/%6frders"]) assert.equal((await f.request(route, order)).status, 503)
  for (const body of [{ ...order, wallet: claim.transaction.from }, { ...order, secret: "must-not-leave" }, { ...order, idempotencyKey: "short" }, [], null]) assert.equal((await f.request(path, body)).status, 400)
  for (const quantity of [1, "1e3", "0.1234567891", "-1", "01"]) assert.equal((await f.request("/api/v1/stocks/quotes", { symbol: "NVDA", quantity })).status, 400)
  for (const cashAmount of [60, "1e3", "60.1234567", "-1", "01", ""]) assert.equal((await f.request("/api/v1/stocks/quotes", { symbol: "NVDA", cashAmount })).status, 400)
  for (const body of [{ symbol: "NVDA", quantity: "1", cashAmount: "60" }, { symbol: "AAPL", cashAmount: "60" }, { symbol: "NVDA", cashAmount: "60", wallet: claim.transaction.from }]) assert.equal((await f.request("/api/v1/stocks/quotes", body)).status, 400)
  assert.equal((await f.request("/api/v1/stocks/sell-quotes", { symbol: "NVDA", cashAmount: "60" })).status, 400, "a Sell names its NVDA quantity")
  for (const transaction of [{ ...claim.transaction, chainId: 1 }, { ...claim.transaction, value: "1" }, { ...claim.transaction, privateKey: "must-not-leave" }]) assert.equal((await f.request("/api/v1/stocks/wallet-submissions/claims", { ...claim, transaction })).status, 400)
  for (const body of [{ ...record, status: "CONFIRMED", txHash }, { ...record, status: "SUBMITTED" }, { ...record, status: "REVERTED" }]) assert.equal((await f.request("/api/v1/stocks/wallet-submissions/outcomes", body)).status, 400)
  assert.equal(calls, 0)
})

test("backend status remains authoritative and order response loss stays uncertain without retry", async t => {
  let calls = 0, upstreamStatus = 503, lost = false
  const f = await fixture(t, async () => {
    calls++
    if (lost) throw new Error("response lost after backend accepted")
    return Response.json({ error: "STOCKS_PAUSED" }, { status: upstreamStatus })
  })
  for (const status of [401, 404, 409, 503]) {
    upstreamStatus = status
    assert.equal((await f.request("/api/v1/stocks/orders", order)).status, status)
  }
  const client = createGiwaStocksHttpClient({ baseUrl: f.origin, fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, origin: f.origin } }) })
  lost = true
  await assert.rejects(client.createOrder("BUY", order, token, new AbortController().signal), error => error instanceof GiwaStocksRequestError && error.kind === "INVALID_RESPONSE")
  assert.equal(calls, 5, "no repeated order POST after losing its response")
})

test("deadline never retries an uncertain claim and recovery retains the original request identity", async t => {
  const calls: string[] = []
  const f = await fixture(t, async (url, init) => {
    calls.push(String(url))
    if (String(url).endsWith("/claims")) return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("late")), { once: true }))
    assert.deepEqual(JSON.parse(String(init!.body)), order)
    return Response.json({ data: { id } })
  }, true, 40)
  assert.equal((await f.request("/api/v1/stocks/wallet-submissions/claims", claim)).status, 504)
  assert.deepEqual(await (await f.request("/api/v1/stocks/orders/recover", order)).json(), { data: { id } })
  assert.equal(calls.length, 2)
})
