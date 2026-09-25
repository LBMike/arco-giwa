// VERIFICATION FIXTURE ONLY. Never import this module from product code, and never run it as a deployment.
//
// Offline loopback server for the /stocks wallet execution verification page:
//   - the REAL in-process Stocks server harness (testing/in-process-stocks.ts) answers /api/v1/*,
//   - one fake EIP-1193 wallet per fixture account (A, B) over the harness's fake chain answers /__fixture/wallet,
//   - /__fixture/control scripts the fake wallets, chain and server, /__fixture/state reports counters,
//   - a Vite dev server (JS API, repo vite.config.ts with the port/host overridden inline) serves the page.
// Binds 127.0.0.1 only. Default: offline, no database/key/signature/real asset.
// Explicit --live-market enables server-only Alpaca IEX display reads; execution stays simulated.
//
// Run: TMPDIR=/private/tmp node --import tsx src/demo/giwa/stocks-execution-host/verification/serve.ts --port 4327

import type { IncomingMessage, ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

import { getAddress } from "viem"
import { customerGateway } from "../../../../../scripts/customer-demo/gateway"
import { customerDynamicEnvironment, customerUiFileSystem, customerUiRedirect } from "../../../../../scripts/customer-demo/ui-config"
import { createSnapshotStreamHub } from "../../../../../server/src/stocks-market-data/live-stream"

import type { Side } from "../../stocks-wallet/types"
import type { NetworkVariant } from "../testing/fake-chain"
import { createFakeEip1193Wallet, providerError, type FakeEip1193Wallet, type HeldRequest } from "../testing/fake-wallet"
import { createInProcessStocks } from "../testing/in-process-stocks"

type AnyValue = any // eslint-disable-line @typescript-eslint/no-explicit-any
type Json = Record<string, unknown>
type Account = "A" | "B"

const HOST = "127.0.0.1"
const FORBIDDEN_PORTS = new Set([5173, 8788])
const PAGE_PATH = "/src/demo/giwa/stocks-execution-host/verification/index.html"
const ACCOUNTS: Readonly<Record<Account, string>> = Object.freeze({
  A: getAddress("0x1111111111111111111111111111111111111111"),
  B: getAddress("0x2222222222222222222222222222222222222222"),
})
/** 1,000,000 ARCO_TEST_USDC (cashScale 6) for each account at start. */
const START_CASH = 1_000_000_000_000n
const NETWORKS: readonly NetworkVariant[] = ["reviewed", "other-checkpoint", "other-chain", "missing-checkpoint"]
const BUY_STATES = ["AWAITING_FUNDING", "FUNDED_QUOTE_EXPIRED", "FUNDING_REVIEW_REQUIRED", "BROKER_PENDING", "BROKER_UNKNOWN", "MINT_QUEUED", "MINT_SUBMITTED", "MINT_FINALITY_PENDING", "MINT_UNKNOWN", "COMPLETED", "REFUNDED", "REVIEW_REQUIRED"]
const SELL_STATES = ["AWAITING_ESCROW", "EXPIRED", "ESCROW_HELD", "ESCROW_REVIEW_REQUIRED", "LIQUIDITY_PENDING", "SELL_BROKER_PENDING", "SELL_BROKER_UNKNOWN", "SELL_PARTIAL_HELD", "REDEEM_QUEUED", "RETURN_QUEUED", "SETTLEMENT_PENDING", "SETTLEMENT_UNKNOWN", "COMPLETED", "RETURNED", "REVIEW_REQUIRED"]
const MAX_BODY = 64 * 1024
const FORWARDED_HEADERS = ["authorization", "accept", "content-type"]

class FixtureError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code) }
}

function parsePort(argv: readonly string[]): number {
  const index = argv.indexOf("--port")
  const raw = index >= 0 ? argv[index + 1] : "4327"
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new FixtureError("FIXTURE_INVALID_PORT")
  if (FORBIDDEN_PORTS.has(port)) throw new FixtureError("FIXTURE_PORT_RESERVED")
  return port
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) { reject(new FixtureError("FIXTURE_BODY_TOO_LARGE", 413)); request.destroy(); return }
      chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks)))
    request.on("error", reject)
  })
}

async function readJson(request: IncomingMessage): Promise<Json> {
  const text = (await readBody(request)).toString("utf8")
  try {
    const value = JSON.parse(text) as unknown
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object")
    return value as Json
  } catch {
    throw new FixtureError("FIXTURE_INVALID_JSON")
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length), "cache-control": "no-store" })
  response.end(body)
}

function account(value: unknown): Account {
  if (value === "A" || value === "B") return value
  throw new FixtureError("FIXTURE_INVALID_ACCOUNT")
}

function side(value: unknown): Side {
  if (value === "BUY" || value === "SELL") return value
  throw new FixtureError("FIXTURE_INVALID_SIDE")
}

/** Route key with identifiers folded, e.g. "GET /api/v1/stocks/execution/:side/:id". */
function routeKey(method: string, path: string): string {
  const pathname = path.split("?")[0]!
  const folded = pathname
    .replace(/\/(BUY|SELL)(?=\/|$)/g, "/:side")
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, "/:id")
  return `${method} ${folded}`
}

function walletErrorCode(error: unknown): number | string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "number" && Number.isInteger(code) ? code : "FIXTURE_WALLET_ERROR"
}

async function main() {
  const port = parsePort(process.argv.slice(2))
  const origin = `http://${HOST}:${port}`
  const customerReads = process.argv.includes("--customer-reads")
  const customerAuth = process.argv.includes("--customer-auth")
  const customerTrades = process.argv.includes("--customer-trades")
  const localCustomer = process.argv.includes("--local-customer")
  const dynamicEnvironmentId = customerDynamicEnvironment(process.argv.slice(2), customerReads, localCustomer)
  if (customerAuth && !customerReads) throw new FixtureError("CUSTOMER_READS_REQUIRED")
  if (customerTrades && !customerAuth) throw new FixtureError("CUSTOMER_AUTH_REQUIRED")
  if (localCustomer && (!customerReads || !customerAuth || !customerTrades || port !== 4392)) throw new FixtureError("INVALID_LOCAL_CUSTOMER_MODE")
  const customer = customerReads ? customerGateway({ origin, authEnabled: customerAuth, tradesEnabled: customerTrades, localCustomer }) : null
  const liveMarket = process.argv.includes("--live-market")
    ? await (await import("../../../../../scripts/stocks-local/live-market")).createLiveMarket() : null
  // Fastify.inject() buffers until a response ends, so the preview relays finite
  // snapshots through its own bounded SSE hub instead of injecting the SSE route.
  const previewLiveHub = liveMarket ? createSnapshotStreamHub({
    intervalMs: 60_000,
    read: async () => {
      const answer = await liveMarket.inject({ method: "GET", url: "/api/v1/stocks/market/NVDA/live" })
      if (answer.statusCode !== 200) throw new Error("PREVIEW_LIVE_SNAPSHOT_UNAVAILABLE")
      return answer.json() as Json
    },
  }) : null
  const previewLiveClients = new Set<ServerResponse>()
  const harness = await createInProcessStocks({ frontendOrigin: origin })
  const wallets: Record<Account, FakeEip1193Wallet> = {
    A: createFakeEip1193Wallet(harness.chain, { account: ACCOUNTS.A }),
    B: createFakeEip1193Wallet(harness.chain, { account: ACCOUNTS.B }),
  }
  harness.seedCash(ACCOUNTS.A, START_CASH)
  harness.seedCash(ACCOUNTS.B, START_CASH)
  let network: NetworkVariant = "reviewed"
  let finalizeImmediately = true
  let paused = false
  let evidenceAvailable = true
  const disconnectedCalls = new Map<string, number>()
  const holds: Record<Account, { hold: HeldRequest; arrived: boolean; settled: boolean }[]> = { A: [], B: [] }

  async function walletCall(body: Json): Promise<Json> {
    const method = typeof body.method === "string" ? body.method : ""
    const params = body.params
    if (!method) throw new FixtureError("FIXTURE_INVALID_WALLET_REQUEST")
    if (body.account === null) {
      // Disconnected wallet: no account, the network still answers its chain id.
      disconnectedCalls.set(method, (disconnectedCalls.get(method) ?? 0) + 1)
      if (method === "eth_accounts") return { result: [] }
      if (method === "eth_chainId") return { result: harness.chain.answer(network, "eth_chainId") }
      return { error: { code: 4100 } }
    }
    const wallet = wallets[account(body.account)]
    try {
      return { result: await wallet.request({ method, params }) }
    } catch (error) {
      return { error: { code: walletErrorCode(error) } }
    }
  }

  async function control(body: Json): Promise<Json> {
    switch (body.action) {
      case "setNetwork": {
        const variant = body.variant as NetworkVariant
        if (!NETWORKS.includes(variant)) throw new FixtureError("FIXTURE_INVALID_NETWORK")
        network = variant
        wallets.A.setNetwork(variant)
        wallets.B.setNetwork(variant)
        return { network, chainId: harness.chain.answer(variant, "eth_chainId") }
      }
      case "holdNextSend": {
        const owner = account(body.account)
        const entry = { hold: wallets[owner].holdNext("eth_sendTransaction"), arrived: false, settled: false }
        void entry.hold.arrived.then(() => { entry.arrived = true })
        holds[owner].push(entry)
        return { held: true }
      }
      case "releaseHeld": {
        const owner = account(body.account)
        const entry = holds[owner].find((candidate) => candidate.arrived && !candidate.settled)
        if (!entry) throw new FixtureError("FIXTURE_NO_HELD_REQUEST")
        entry.settled = true
        entry.hold.release()
        return { released: true }
      }
      case "rejectNextSend": {
        const owner = account(body.account)
        if (body.code !== 4001 && body.code !== -32603) throw new FixtureError("FIXTURE_INVALID_CODE")
        wallets[owner].failNext("eth_sendTransaction", providerError(body.code, body.code === 4001 ? "User rejected the request" : "Internal error"))
        return { armed: true }
      }
      case "revertNextTransaction":
        harness.chain.revertNextTransaction()
        return { armed: true }
      case "setFinalize":
        if (typeof body.value !== "boolean") throw new FixtureError("FIXTURE_INVALID_VALUE")
        finalizeImmediately = body.value
        harness.chain.setFinalizeImmediately(body.value)
        return { finalizeImmediately }
      case "finalizeNow":
        harness.chain.finalize()
        return { finalized: harness.chain.finalizedBlock.toString() }
      case "setOrderState": {
        if (typeof body.id !== "string" || typeof body.state !== "string") throw new FixtureError("FIXTURE_INVALID_ORDER")
        const orderSide = side(body.side)
        if (!(orderSide === "BUY" ? BUY_STATES : SELL_STATES).includes(body.state)) throw new FixtureError("FIXTURE_INVALID_STATE")
        try {
          const order = await harness.setOrderState(orderSide, body.id, body.state)
          return { id: order.id, state: order.state, version: order.version }
        } catch {
          throw new FixtureError("FIXTURE_ORDER_STATE_REJECTED")
        }
      }
      case "seedStock": {
        const owner = account(body.account)
        if (typeof body.units !== "string" || !/^[1-9][0-9]{0,20}$/.test(body.units)) throw new FixtureError("FIXTURE_INVALID_UNITS")
        harness.seedStock(ACCOUNTS[owner], body.units)
        return { seeded: body.units }
      }
      case "setPaused":
        if (typeof body.value !== "boolean") throw new FixtureError("FIXTURE_INVALID_VALUE")
        paused = body.value
        harness.setPaused(body.value)
        return { paused }
      case "setEvidenceAvailable":
        if (typeof body.value !== "boolean") throw new FixtureError("FIXTURE_INVALID_VALUE")
        evidenceAvailable = body.value
        harness.setEvidenceAvailable(body.value)
        return { evidenceAvailable }
      default:
        throw new FixtureError("FIXTURE_UNKNOWN_ACTION")
    }
  }

  function state(): Json {
    const count = (calls: readonly { method: string }[]) => {
      const counts: Record<string, number> = {}
      for (const call of calls) counts[call.method] = (counts[call.method] ?? 0) + 1
      return counts
    }
    const routes: Record<string, number> = {}
    for (const request of harness.requests) {
      const key = routeKey(request.method, request.path)
      routes[key] = (routes[key] ?? 0) + 1
    }
    // Committed-table view for the order selector. A transaction open at this instant may be included.
    const tables = harness.sql.snapshot()
    const orders = [
      ...tables.StocksOrder.map((row) => ({ side: "BUY", id: row.id, state: row.state, wallet: row.wallet, createdAt: row.createdAt })),
      ...tables.StocksSellOrder.map((row) => ({ side: "SELL", id: row.id, state: row.state, wallet: row.wallet, createdAt: row.createdAt })),
    ]
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .map(({ createdAt, ...order }) => ({ ...order, createdAt: new Date(createdAt).toISOString() }))
    const held = (owner: Account) => ({
      armed: holds[owner].some((entry) => !entry.arrived && !entry.settled),
      waiting: holds[owner].some((entry) => entry.arrived && !entry.settled),
    })
    return {
      fixture: true,
      accounts: ACCOUNTS,
      network,
      finalizeImmediately,
      paused,
      evidenceAvailable,
      wallet: { A: count(wallets.A.calls), B: count(wallets.B.calls), disconnected: Object.fromEntries(disconnectedCalls) },
      routes,
      held: { A: held("A"), B: held("B") },
      orders,
      orderStates: { BUY: BUY_STATES, SELL: SELL_STATES },
      chain: { transactions: harness.chain.transactions.length, latestBlock: harness.chain.latestBlock.toString(), finalizedBlock: harness.chain.finalizedBlock.toString() },
    }
  }

  async function api(request: IncomingMessage, response: ServerResponse, url: string) {
    const method = (request.method ?? "GET").toUpperCase()
    const body = await readBody(request)
    const headers: Record<string, string> = {}
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers[name]
      if (typeof value === "string") headers[name] = value
    }
    const answer = await harness.fetch(`${harness.apiBase}${url}`, { method, headers, ...(body.length > 0 ? { body: body.toString("utf8") } : {}) })
    const payload = Buffer.from(await answer.arrayBuffer())
    const out: Record<string, string> = { "cache-control": "no-store" }
    answer.headers.forEach((value, name) => {
      if (!["content-length", "transfer-encoding", "connection", "content-encoding", "keep-alive"].includes(name)) out[name] = value
    })
    if (answer.status !== 204 && answer.status !== 304) out["content-length"] = String(payload.length)
    response.writeHead(answer.status, out)
    response.end(answer.status === 204 || answer.status === 304 ? undefined : payload)
  }

  const fixturePlugin = {
    name: "giwa-stocks-verification-fixture",
    transformIndexHtml() {
      return [
        ...(liveMarket ? [{ tag: "meta", attrs: { name: "giwa-live-market", content: "iex" }, injectTo: "head" as const }] : []),
        ...(customerReads ? [{ tag: "meta", attrs: { name: "giwa-customer-reads", content: "true" }, injectTo: "head" as const }] : []),
      ]
    },
    configureServer(server: AnyValue) {
      server.middlewares.use((request: IncomingMessage, response: ServerResponse, next: () => void) => {
        const url = request.url ?? "/"
        const method = (request.method ?? "GET").toUpperCase()
        const route = url.split("?")[0]!
        const handle = async () => {
          // Never serve server-only credential files through Vite.
          const decoded = decodeURIComponent(route)
          if (decoded.includes(".secrets") || /(?:^|[/.])\.env(?:[./]|$)/.test(decoded)) return sendJson(response, 403, { error: "FORBIDDEN" })
          const customerEntry = customerUiRedirect(method, url, localCustomer)
          if (customerEntry) {
            response.writeHead(302, { location: customerEntry, "cache-control": "no-store" })
            response.end()
            return
          }
          if (liveMarket && route.startsWith("/api/v1/stocks/market/")) {
            if (request.headers.host !== `${HOST}:${port}` || (request.headers.origin && request.headers.origin !== origin) || request.headers["sec-fetch-site"] === "cross-site") return sendJson(response, 403, { error: "FORBIDDEN" })
            if (method !== "GET") return sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" })
            if (route === "/api/v1/stocks/market/NVDA/live/stream") {
              if (url !== route) return sendJson(response, 400, { error: "INVALID_QUERY" })
              if (!previewLiveHub || previewLiveHub.subscriberCount() >= 64) return sendJson(response, 503, { error: "STREAM_CAPACITY" })
              response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-content-type-options": "nosniff", "x-accel-buffering": "no" })
              previewLiveClients.add(response)
              let active = true
              let unsubscribe = () => {}
              let heartbeat: ReturnType<typeof setInterval> | undefined
              const close = () => {
                if (!active) return
                active = false
                clearInterval(heartbeat)
                unsubscribe()
                previewLiveClients.delete(response)
                if (!response.writableEnded) response.end()
              }
              response.on("close", close)
              try { if (!response.write(": connected\n\n")) { close(); return } }
              catch { close(); return }
              try {
                unsubscribe = previewLiveHub.subscribe(snapshot => {
                  if (!active || response.writableEnded || !response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)) close()
                })
              } catch { close(); return }
              // A late subscriber receives the cached snapshot synchronously.
              // If that write closes the client, release its hub slot now.
              if (!active) { unsubscribe(); return }
              heartbeat = setInterval(() => {
                if (!active || response.writableEnded || !response.write(": keepalive\n\n")) close()
              }, 15_000)
              heartbeat.unref()
              return
            }
            const answer = await liveMarket.inject({ method: "GET", url })
            response.writeHead(answer.statusCode, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" })
            response.end(answer.body); return
          }
          if (customer && (route.startsWith("/api/") || route.startsWith("/__fixture/") || route.startsWith("/__giwa/"))) return customer(request, response, next)
          if (route.startsWith("/api/v1/")) return api(request, response, url)
          if (route === "/__fixture/wallet" && method === "POST") return sendJson(response, 200, await walletCall(await readJson(request)))
          if (route === "/__fixture/control" && method === "POST") return sendJson(response, 200, await control(await readJson(request)))
          if (route === "/__fixture/state" && method === "GET") return sendJson(response, 200, state())
          if (route.startsWith("/__fixture/")) throw new FixtureError("FIXTURE_NOT_FOUND", 404)
          next()
        }
        handle().catch((error: unknown) => {
          if (response.headersSent) { response.destroy(); return }
          if (error instanceof FixtureError) sendJson(response, error.status, { error: { code: error.code } })
          else sendJson(response, 500, { error: { code: "FIXTURE_INTERNAL_ERROR" } })
        })
      })
    },
  }

  const vite = (await import("vite")) as AnyValue
  const root = fileURLToPath(new URL("../../../../../", import.meta.url))
  const server = await vite.createServer({
    root,
    configFile: `${root}vite.config.ts`,
    // No .env file is read. The customer wallet receives only its explicit public project ID.
    envDir: fileURLToPath(new URL("./", import.meta.url)),
    // Keep Vite's dependency cache out of the shared node_modules symlink target.
    cacheDir: `${tmpdir()}/arco-giwa-stocks-verification-vite-cache`,
    appType: "mpa",
    clearScreen: false,
    logLevel: "warn",
    ...(customerReads ? { define: {
      "import.meta.env.VITE_ARCO_API_BASE": JSON.stringify(origin),
      "import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID": JSON.stringify(dynamicEnvironmentId),
    } } : {}),
    server: { host: HOST, port, strictPort: true, open: false, hmr: { host: HOST, port }, fs: customerUiFileSystem(root) },
    plugins: [fixturePlugin],
  })
  await server.listen()

  let closing = false
  const shutdown = () => {
    if (closing) return
    closing = true
    previewLiveHub?.close()
    for (const client of previewLiveClients) client.end()
    previewLiveClients.clear()
    Promise.allSettled([server.close(), harness.close(), liveMarket?.close()]).then(() => process.exit(0), () => process.exit(1))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  const pagePath = customerReads ? "/src/demo/giwa/investor-shell/verification/index.html#/" : PAGE_PATH
  process.stdout.write(`GIWA Stocks preview (${customerReads ? `real GIWA reads; authentication ${customerAuth ? "connected" : "disconnected"}; investor requests ${customerTrades ? "connected; backend readiness required" : "disconnected"}` : liveMarket ? "Alpaca IEX display; simulated execution" : "offline"}): ${origin}${pagePath}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`verification fixture failed to start: ${error instanceof FixtureError ? error.code : error instanceof Error ? error.message : "unknown"}\n`)
  process.exit(1)
})
