import assert from "node:assert/strict"
import { createServer, request as httpRequest } from "node:http"
import test from "node:test"
import { CUSTOMER_API, CUSTOMER_RPC, customerGateway } from "./gateway"

async function fixture(fetcher: typeof fetch = async () => Response.json({ original: true }), timeoutMs = 1000) {
  let handler: ReturnType<typeof customerGateway>
  let fallthrough = 0
  const server = createServer((req, res) => { void handler(req, res, () => { fallthrough++; res.writeHead(418); res.end("fixture must not answer") }) })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const origin = `http://127.0.0.1:${address.port}`
  handler = customerGateway({ origin, fetcher, timeoutMs })
  return {
    origin, get fallthrough() { return fallthrough },
    request: (path: string, init: RequestInit = {}) => fetch(origin + path, { ...init, headers: { origin, ...init.headers } }),
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) },
  }
}
const json = (value: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) })
const rpc = (method = "eth_chainId") => ({ jsonrpc: "2.0", id: 1, method, params: [] })

test("native HTTP public reads use only the fixed API, strip credentials and preserve 404 without fixture fallback", async t => {
  const calls: { url: string; init?: RequestInit }[] = []
  const f = await fixture(async (url, init) => {
    calls.push({ url: String(url), init })
    return String(url).endsWith("/stocks/catalog") ? Response.json({ error: "not registered" }, { status: 404 }) : Response.json({ original: true })
  }); t.after(() => f.close())
  const good = await f.request("/api/v1/evm/catalog/91342", { headers: { authorization: "Bearer must-not-forward", cookie: "must-not-forward", "x-api-key": "must-not-forward" } })
  assert.equal(good.status, 200)
  assert.deepEqual(await good.json(), { original: true })
  assert.equal(calls[0]!.url, `${CUSTOMER_API}/api/v1/evm/catalog/91342`)
  assert.deepEqual(calls[0]!.init!.headers, { accept: "application/json" })
  assert.equal(calls[0]!.init!.redirect, "error")
  assert.equal(calls[0]!.init!.credentials, "omit")
  assert.equal(good.headers.get("cache-control"), "no-store")
  assert.equal((await f.request("/api/v1/stocks/catalog")).status, 404)
  assert.equal(f.fallthrough, 0)
})

test("auth, private balances, all writes, admin and fixture routes stay disconnected", async t => {
  let calls = 0
  const f = await fixture(async () => { calls++; return Response.json({}) }); t.after(() => f.close())
  for (const path of ["/api/v1/auth/nonce", "/api/v1/auth/verify", "/api/v1/stocks/orders", "/api/v1/admin/wallets/test/greenlist", "/__fixture/control", "/__fixture/wallet"]) {
    assert.equal((await f.request(path, json({}))).status, 503)
  }
  for (const path of ["/api/v1/stocks/portfolio", "/__fixture/state", "/api/v1/evm/catalog/91342?url=https://other.example", "/api/v1/evm/%63atalog/91342"]) assert.equal((await f.request(path)).status, 503)
  assert.equal(calls, 0); assert.equal(f.fallthrough, 0)
})

test("foreign origins, hosts and cross-site requests never reach the upstream", async t => {
  let calls = 0
  const f = await fixture(async () => { calls++; return Response.json({}) }); t.after(() => f.close())
  for (const headers of [{ origin: "https://other.example" }, { "sec-fetch-site": "cross-site" }]) {
    assert.equal((await f.request("/api/v1/evm/catalog/91342", { headers })).status, 403)
  }
  const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(f.origin + "/api/v1/evm/catalog/91342", { headers: { host: "other.example" } }, response => { response.resume(); resolve(response.statusCode) })
    request.on("error", reject); request.end()
  })
  assert.equal(wrongHost, 403)
  assert.equal(calls, 0)
})

test("RPC forwards bounded read batches to the fixed GIWA endpoint and rejects any signing or broadcasting method", async t => {
  const calls: { url: string; init?: RequestInit }[] = []
  const f = await fixture(async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ jsonrpc: "2.0", id: 1, result: "0x164ce" }) }); t.after(() => f.close())
  assert.equal((await f.request("/__giwa/read-rpc", json([rpc(), rpc("eth_call")]))).status, 200)
  assert.equal(calls[0]!.url, CUSTOMER_RPC)
  for (const method of ["personal_sign", "eth_sendTransaction", "eth_sendRawTransaction", "wallet_switchEthereumChain", "hardhat_impersonateAccount"]) {
    assert.equal((await f.request("/__giwa/read-rpc", json([rpc(), rpc(method)]))).status, 403)
  }
  for (const body of [[], null, { jsonrpc: "2.0", method: "eth_call", params: "bad" }, Array.from({ length: 101 }, () => rpc())]) assert.equal((await f.request("/__giwa/read-rpc", json(body))).status, 403)
  assert.equal((await f.request("/__giwa/read-rpc", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status, 400)
  assert.equal((await f.request("/__giwa/read-rpc", { ...json(rpc()), body: " ".repeat(65537) })).status, 413)
  assert.equal((await fetch(f.origin + "/__giwa/read-rpc", json(rpc()))).status, 403)
  assert.equal(calls.length, 1); assert.equal(f.fallthrough, 0)
})

test("unavailable, redirect, invalid JSON and oversized upstream replies never become fake success", async t => {
  for (const fetcher of [
    async () => { throw new Error("private internal error") },
    async () => new Response("hidden", { status: 302, headers: { location: "https://elsewhere.example" } }),
    async () => new Response("hidden"),
    async () => new Response("hidden", { headers: { "content-type": "application/json" } }),
    async () => Response.json({ value: "x".repeat(4_000_000) }),
  ]) {
    const f = await fixture(fetcher); t.after(() => f.close())
    const answer = await f.request("/api/v1/evm/catalog/91342")
    assert.equal(answer.status, 502)
    assert.deepEqual(await answer.json(), { error: "CUSTOMER_API_UNAVAILABLE" })
    assert.equal(f.fallthrough, 0)
  }
})

test("timeout is bounded and a later refresh recovers without changing backend", async t => {
  let unavailable = true
  const f = await fixture(async (_url, init) => {
    if (!unavailable) return Response.json({ recovered: true })
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
  }, 25); t.after(() => f.close())
  assert.equal((await f.request("/api/v1/evm/catalog/91342")).status, 504)
  unavailable = false
  assert.deepEqual(await (await f.request("/api/v1/evm/catalog/91342")).json(), { recovered: true })
})
