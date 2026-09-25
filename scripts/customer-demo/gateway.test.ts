import assert from "node:assert/strict"
import { createServer, request as httpRequest } from "node:http"
import test from "node:test"
import { createSiweMessage } from "viem/siwe"
import { CUSTOMER_API, CUSTOMER_RPC, customerGateway } from "./gateway"

async function fixture(fetcher: typeof fetch = async () => Response.json({ original: true }), timeoutMs = 1000, authEnabled = false) {
  let handler: ReturnType<typeof customerGateway>
  let fallthrough = 0
  const server = createServer((req, res) => { void handler(req, res, () => { fallthrough++; res.writeHead(418); res.end("fixture must not answer") }) })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const origin = `http://127.0.0.1:${address.port}`
  handler = customerGateway({ origin, fetcher, timeoutMs, authEnabled })
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
  // viem sends parameterless reads without params (JSON-RPC 2.0 allows it); a write stays refused, and params must be an array.
  assert.equal((await f.request("/__giwa/read-rpc", json({ jsonrpc: "2.0", id: 2, method: "eth_chainId" }))).status, 200)
  assert.equal((await f.request("/__giwa/read-rpc", json({ jsonrpc: "2.0", id: 3, method: "eth_sendRawTransaction" }))).status, 403)
  assert.equal((await f.request("/__giwa/read-rpc", json({ jsonrpc: "2.0", id: 4, method: "eth_blockNumber", params: null }))).status, 403)
  assert.equal(calls.length, 2); assert.equal(f.fallthrough, 0)
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

test("opt-in authentication forwards only scoped SIWE to the fixed API, with no ambient credentials", async t => {
  const calls: { url: string; init?: RequestInit }[] = []
  const f = await fixture(async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ accepted: true }) }, 1000, true); t.after(() => f.close())
  const walletAddress = "0x1111111111111111111111111111111111111111"
  const domain = new URL(f.origin).host
  const message = createSiweMessage({ address: walletAddress, domain, uri: f.origin, chainId: 91342, version: "1", nonce: "abcdefgh12345678" })
  const signature = `0x${"ab".repeat(65)}`
  const nonce = json({ walletAddress, domain })
  assert.equal((await f.request("/api/v1/auth/nonce", { ...nonce, headers: { ...nonce.headers, cookie: "not-forwarded", authorization: "Bearer not-forwarded" } })).status, 200)
  assert.equal((await f.request("/api/v1/auth/verify", json({ message, signature }))).status, 200)
  assert.deepEqual(calls.map(call => call.url), [`${CUSTOMER_API}/api/v1/auth/nonce`, `${CUSTOMER_API}/api/v1/auth/verify`])
  assert.deepEqual(calls[0]!.init!.headers, { accept: "application/json", "content-type": "application/json" })
  assert.deepEqual(JSON.parse(String(calls[1]!.init!.body)), { message, signature })
  for (const change of [{ domain: "elsewhere.example" }, { uri: "https://elsewhere.example" }, { chainId: 1 }]) {
    const invalid = createSiweMessage({ address: walletAddress, domain, uri: f.origin, chainId: 91342, version: "1", nonce: "abcdefgh12345678", ...change })
    assert.equal((await f.request("/api/v1/auth/verify", json({ message: invalid, signature }))).status, 400)
  }
  assert.equal((await f.request("/api/v1/auth/nonce", json({ walletAddress, domain: "elsewhere.example" }))).status, 400)
  assert.equal((await f.request("/api/v1/auth/verify", json({ message, signature, extra: "must not leave" }))).status, 400)
  assert.equal((await f.request("/api/v1/auth/verify", { ...json({ message, signature }), headers: { origin: "https://elsewhere.example", "content-type": "application/json" } })).status, 403)
  assert.equal((await fetch(f.origin + "/api/v1/auth/nonce", nonce)).status, 403)
  assert.equal(calls.length, 2); assert.equal(f.fallthrough, 0)
})

test("bearer is confined to approved private GET routes; 401 and missing Stocks stay authoritative", async t => {
  const calls: { url: string; init?: RequestInit }[] = []
  const f = await fixture(async (url, init) => {
    calls.push({ url: String(url), init })
    return Response.json({ error: "expired session" }, { status: 401, headers: { "set-cookie": "must-not-forward=1" } })
  }, 1000, true); t.after(() => f.close())
  for (const token of [undefined, "Basic invalid", "Bearer malformed"]) {
    assert.equal((await f.request("/api/v1/stocks/portfolio", { headers: token ? { authorization: token } : {} })).status, 401)
  }
  assert.equal(calls.length, 0)
  const headers = { authorization: "Bearer header.payload.signature", cookie: "must-not-forward", "x-operator-token": "must-not-forward" }
  for (const path of ["/api/v1/stocks/portfolio", "/api/v1/stocks/orders", "/api/v1/stocks/sell-orders/12345678-1234-1234-1234-123456789abc"]) {
    const response = await f.request(path, { headers })
    assert.equal(response.status, 401); assert.equal(response.headers.get("set-cookie"), null)
    assert.deepEqual(calls.at(-1)!.init!.headers, { accept: "application/json", authorization: headers.authorization })
  }
  for (const path of ["/api/v1/stocks/orders", "/api/v1/stocks/sell-orders", "/api/v1/stocks/quotes", "/api/v1/attestations"]) assert.equal((await f.request(path, { ...json({}), headers: { ...headers, "content-type": "application/json" } })).status, 503)
  for (const path of ["/api/v1/stocks/portfolio?upstream=https://elsewhere.example", "/api/v1/admin/stocks/orders", "/__fixture/state"]) assert.equal((await f.request(path, { headers })).status, 503)
  assert.equal(calls.length, 3); assert.equal(f.fallthrough, 0)
})

test("native HTTP login uses the real backend SIWE verifier and rejects replay and a forged signature", async t => {
  const { randomBytes } = await import("node:crypto")
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts")
  const { buildApp } = await import("../../server/src/app")
  const { stocksSessionResolvers } = await import("../../server/src/stocks-runtime/session")
  const { createStocksHostSession } = await import("../../src/demo/giwa/stocks-host/session")
  let upstreamOrigin = ""
  let verifyPayload = ""
  const f = await fixture(async (url, init) => {
    assert.ok(String(url).startsWith(CUSTOMER_API + "/api/v1/"))
    if (String(url).endsWith("/auth/verify")) verifyPayload = String(init?.body)
    return fetch(upstreamOrigin + String(url).slice(CUSTOMER_API.length), init)
  }, 3000, true); t.after(() => f.close())
  const domain = new URL(f.origin).host
  const secret = randomBytes(32).toString("hex")
  const nonces = new Map<string, { walletAddress: string; domain: string; expires: number }>()
  const app = buildApp({ corsAllowedOrigins: [f.origin], authNonceTtlSeconds: 60, authJwtSecret: secret, adminOperatorToken: "unused-test-only", registryPath: "unused-test-only" }, {
    arco: {
      async issueAuthNonce(row: { nonce: string; walletAddress: string; domain: string; now: Date; ttlSeconds: number }) { nonces.set(row.nonce, { ...row, expires: row.now.getTime() + row.ttlSeconds * 1000 }) },
      async consumeAuthNonce(row: { nonce: string; walletAddress: string; domain: string }) {
        const found = nonces.get(row.nonce)
        if (!found || found.expires <= Date.now() || found.walletAddress !== row.walletAddress.toLowerCase() || found.domain !== row.domain) return false
        nonces.delete(row.nonce); return true
      },
    },
    registry: {}, portfolio: {}, readiness: { check: async () => ({ ok: true, checks: {} }) },
  } as unknown as Parameters<typeof buildApp>[1])
  const { resolveActor } = stocksSessionResolvers(secret, [domain], [])
  // Only this protected read is a fixture; nonce/verify/JWT verification are the actual server code.
  app.get("/api/v1/stocks/portfolio", async (request, reply) => {
    const actor = await resolveActor(request)
    return actor ? { wallet: actor.wallet } : reply.code(401).send({ error: "unauthorized" })
  })
  upstreamOrigin = await app.listen({ host: "127.0.0.1", port: 0 })
  t.after(() => app.close())
  const account = privateKeyToAccount(generatePrivateKey())
  let signatures = 0
  const host = createStocksHostSession({ walletAddress: account.address, chainId: 91342, frontendOrigin: f.origin, apiBase: f.origin }, {
    signMessage: async request => { signatures++; return account.signMessage({ message: request.message }) },
    fetch: (input, init) => fetch(input, { ...init, headers: { ...init?.headers, origin: f.origin } }),
  }); t.after(() => host.dispose())
  assert.equal(signatures, 0)
  const session = await host.signIn()
  assert.ok(session); assert.equal(signatures, 1)
  const balance = await f.request("/api/v1/stocks/portfolio", { headers: { authorization: `Bearer ${session.accessToken}` } })
  assert.equal(balance.status, 200); assert.equal((await balance.json()).wallet, account.address.toLowerCase())
  const replay = await f.request("/api/v1/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: verifyPayload })
  assert.equal(replay.status, 401)
  const nonce = await (await f.request("/api/v1/auth/nonce", json({ walletAddress: account.address, domain }))).json()
  const forged = createSiweMessage({ address: account.address, chainId: 91342, domain, uri: f.origin, version: "1", nonce: nonce.nonce })
  const other = privateKeyToAccount(generatePrivateKey())
  const forgedSignature = await other.signMessage({ message: forged })
  assert.equal((await f.request("/api/v1/auth/verify", json({ message: forged, signature: forgedSignature }))).status, 401)
  assert.equal((await f.request("/api/v1/stocks/catalog")).status, 404)
  assert.equal(f.fallthrough, 0)
})
