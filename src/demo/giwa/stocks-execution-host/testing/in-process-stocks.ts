// TEST FIXTURE ONLY. Never import this module from product code.
//
// A stateful in-process Stocks server for browser-side integration tests. It composes the REAL server modules
// (loaded with tsx, like stocks-wallet-http/server-roundtrip.test.tsx): StocksService over the in-memory SQL
// store, the Stocks, execution and wallet-submission Fastify plugins, the real deployment evidence and the real
// submission receipt verifier over the real RPC port, all reading the fake chain. Requests go through
// app.inject: no socket, database, public network, key or signature. The auth nonce/verify routes are a labelled
// fixture that does NOT verify SIWE signatures.

import { createHash, randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

import { getAddress, isAddress } from "viem"
import { parseSiweMessage } from "viem/siwe"

import type { HostDependencies, HostSession, MessageRequest } from "../../stocks-host/session"
import type { ManifestV2, Side } from "../../stocks-wallet/types"
import { createFakeChain, type FakeChain } from "./fake-chain"
import { createMemorySql, type MemorySql } from "./memory-sql"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export const HARNESS_API_BASE = "https://stocks-host-integration.test"
export const HARNESS_FRONTEND_ORIGIN = "https://app-host-integration.test"
/** TEST-ONLY HS256 secret. Never a deployment value. */
const TEST_ONLY_JWT_SECRET = "TEST_ONLY_in_process_stocks_harness_secret_never_deployed"
/** TEST-ONLY fixed "signature". The fixture verify route does not check signatures; there is no key. */
const FIXTURE_SIGNATURE = `0x${"ab".repeat(65)}`
const MAX_SESSION_MS = 900_000

const repo = fileURLToPath(new URL("../../../../../", import.meta.url))

async function loadServer() {
  const server = (path: string): Promise<AnyModule> => import(`${repo}server/src/${path}`)
  const [fastify, jwt, contracts, fixtures, chain, rpc, repository, service, plugin, executionService, executionPlugin, deployment, submissionsService, submissionsPlugin, receipts, session] = await Promise.all([
    import("fastify") as Promise<AnyModule>,
    import("jsonwebtoken") as Promise<AnyModule>,
    server("stocks/contracts.ts"),
    server("stocks/test-fixtures.ts"),
    server("stocks/chain.ts"),
    server("stocks/rpc.ts"),
    server("stocks/repository.ts"),
    server("stocks/service.ts"),
    server("stocks/plugin.ts"),
    server("stocks-execution/service.ts"),
    server("stocks-execution/plugin.ts"),
    server("stocks-execution/deployment.ts"),
    server("stocks-submissions/service.ts"),
    server("stocks-submissions/plugin.ts"),
    server("stocks-submissions/receipts.ts"),
    server("stocks-runtime/session.ts"),
  ])
  return {
    Fastify: fastify.default, sign: (jwt.default ?? jwt).sign, manifestDigest: contracts.manifestDigest, testManifest: fixtures.testManifest,
    ReceiptVerifier: chain.ReceiptVerifier, createStocksRpcPort: rpc.createStocksRpcPort, StocksRepository: repository.StocksRepository,
    StocksService: service.StocksService, stocksPlugin: plugin.stocksPlugin, StocksExecutionService: executionService.StocksExecutionService,
    stocksExecutionPlugin: executionPlugin.stocksExecutionPlugin, createDeploymentEvidence: deployment.createDeploymentEvidence,
    StocksSubmissionsService: submissionsService.StocksSubmissionsService, stocksSubmissionsPlugin: submissionsPlugin.stocksSubmissionsPlugin,
    createSubmissionReceiptVerifier: receipts.createSubmissionReceiptVerifier, stocksSessionResolvers: session.stocksSessionResolvers,
  }
}

/**
 * `bearer` is a fingerprint (first 16 hex of SHA-256) of the Bearer token, never the token itself: tests compare it with
 * bearerFingerprint(session.accessToken) to tell which session made a request.
 */
export type RecordedRequest = Readonly<{ method: string; path: string; status: number | null; authorization: boolean; bearer: string | null; body: string | undefined }>

export function bearerFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16)
}
export type HarnessFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export type AcceptedOrder = Readonly<{ order: Record<string, unknown>; envelope: Record<string, unknown> }>
export type SignInDependencies = Required<Pick<HostDependencies, "fetch" | "signMessage" | "now">> & { readonly messages: readonly MessageRequest[] }

export type InProcessStocks = Readonly<{
  apiBase: string
  frontendOrigin: string
  manifest: ManifestV2
  digest: string
  chain: FakeChain
  sql: MemorySql
  /** Integer wall clock shared by the SQL clock, chain timestamps, evidence and execution service. */
  wall: () => number
  fetch: HarnessFetch
  readonly requests: readonly RecordedRequest[]
  clearRequests(): void
  session(wallet: string, options?: { lifetimeMs?: number }): HostSession
  signInDependencies(): SignInDependencies
  createOrder(side: Side, session: HostSession, quantity?: string): Promise<AcceptedOrder>
  seedStock(wallet: string, quantity: bigint | string): void
  seedCash(wallet: string, amount: bigint | string): void
  setOrderState(side: Side, orderId: string, state: string): Promise<Record<string, unknown>>
  setPaused(value: boolean): void
  setEvidenceAvailable(value: boolean): void
  close(): Promise<void>
}>

function abortError(): Error {
  return typeof DOMException === "function" ? new DOMException("The operation was aborted.", "AbortError") : Object.assign(new Error("The operation was aborted."), { name: "AbortError" })
}

function bodyText(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
  throw new Error("HARNESS_UNSUPPORTED_BODY")
}

/**
 * Wall clock contract: `wall` must stay near real time when sessions are used, because the real JWT resolver
 * checks iat/exp against Date.now(). The monotonic clock is `wall` when injected, else performance.now().
 */
export async function createInProcessStocks(options: {
  wall?: () => number
  paused?: boolean
  /**
   * The frontend origin whose host becomes the JWT domain the session resolver accepts. Default HARNESS_FRONTEND_ORIGIN.
   * The offline verification page passes its loopback origin (http://127.0.0.1:<port>).
   */
  frontendOrigin?: string
} = {}): Promise<InProcessStocks> {
  const s = await loadServer()
  const wall = () => Math.floor(options.wall ? options.wall() : Date.now())
  const monotonicNow = options.wall ? wall : () => performance.now()
  const manifest = s.testManifest() as ManifestV2
  const digest: string = s.manifestDigest(manifest)
  const chain = createFakeChain(manifest, { now: wall })
  const sql = createMemorySql({ clock: wall })
  let paused = options.paused === true
  let evidenceAvailable = true

  const rpcPort = s.createStocksRpcPort(chain.rpc, manifest)
  const stocks = new s.StocksService(new s.StocksRepository(sql.pool, digest), manifest, new s.ReceiptVerifier(manifest, rpcPort), { manifestDigest: digest, contractPolicyVerified: true }, async () => paused)
  const evidence = s.createDeploymentEvidence(manifest, chain.rpc, { now: wall, monotonicNow, available: () => evidenceAvailable })
  const execution = new s.StocksExecutionService(stocks, evidence, { wallNow: wall, monotonicNow })
  const submissions = new s.StocksSubmissionsService(stocks, s.createSubmissionReceiptVerifier(manifest, s.createStocksRpcPort(chain.rpc, manifest)))
  const frontendOrigin = new URL(options.frontendOrigin ?? HARNESS_FRONTEND_ORIGIN).origin
  const frontendHost = new URL(frontendOrigin).host
  const { resolveActor, resolveOperator } = s.stocksSessionResolvers(TEST_ONLY_JWT_SECRET, [frontendHost], [])

  const app = s.Fastify({ logger: false })
  await app.register(s.stocksPlugin, { service: stocks, resolveActor, resolveOperator })
  await app.register(s.stocksExecutionPlugin, { service: execution, resolveActor })
  await app.register(s.stocksSubmissionsPlugin, { service: submissions, resolveActor })
  await app.register(authFixture)
  await app.ready()

  function mint(wallet: string, lifetimeSeconds = 900): string {
    const iat = Math.floor(Date.now() / 1000)
    return s.sign({ sub: wallet.toLowerCase(), domain: frontendHost, chainId: 91342, iat, exp: iat + lifetimeSeconds }, TEST_ONLY_JWT_SECRET, { algorithm: "HS256" })
  }

  // FIXTURE auth routes, shaped like server/src/app.ts. The signature is NOT verified.
  async function authFixture(instance: AnyModule) {
    const nonces = new Map<string, { wallet: string; domain: string; expiresAt: number }>()
    instance.post("/api/v1/auth/nonce", async (request: AnyModule, reply: AnyModule) => {
      const body = request.body ?? {}
      if (typeof body.walletAddress !== "string" || !isAddress(body.walletAddress) || typeof body.domain !== "string" || !body.domain) return reply.code(400).send({ error: "invalid nonce request" })
      const nonce = randomUUID().replace(/-/g, "")
      const expiresAt = wall() + 300_000
      nonces.set(nonce, { wallet: body.walletAddress.toLowerCase(), domain: body.domain, expiresAt })
      return { walletAddress: body.walletAddress.toLowerCase(), domain: body.domain, nonce, expiresAt: new Date(expiresAt).toISOString() }
    })
    instance.post("/api/v1/auth/verify", async (request: AnyModule, reply: AnyModule) => {
      const body = request.body ?? {}
      if (typeof body.message !== "string" || typeof body.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) return reply.code(400).send({ error: "message and signature are required" })
      const message = parseSiweMessage(body.message)
      const issued = message.nonce ? nonces.get(message.nonce) : undefined
      if (message.nonce) nonces.delete(message.nonce)
      const valid = message.chainId === 91342 && message.address && issued && issued.wallet === message.address.toLowerCase() && issued.domain === message.domain && issued.expiresAt > wall()
      if (!valid) return reply.code(401).send({ error: "SIWE nonce is expired, unknown, or already used" })
      const walletAddress = message.address!.toLowerCase()
      return { token: mint(walletAddress), walletAddress, chainId: 91342, expiresIn: 900 }
    })
  }

  const requests: RecordedRequest[] = []

  const fetch: HarnessFetch = async (input, init = {}) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (target.origin !== HARNESS_API_BASE) throw new Error(`HARNESS_ORIGIN_MISMATCH: ${target.origin}`)
    const signal = init.signal ?? undefined
    if (signal?.aborted) throw abortError()
    const method = (init.method ?? "GET").toUpperCase()
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const body = bodyText(init.body)
    if (body !== undefined && headers["content-type"] === undefined) headers["content-type"] = "text/plain;charset=UTF-8"
    const path = `${target.pathname}${target.search}`
    const bearer = typeof headers.authorization === "string" && headers.authorization.startsWith("Bearer ") ? bearerFingerprint(headers.authorization.slice(7)) : null
    const entry = { method, path, status: null as number | null, authorization: headers.authorization !== undefined, bearer, body }
    requests.push(entry)
    const injected = app.inject({ method, url: path, headers, ...(body === undefined ? {} : { payload: body }) })
    let onAbort = () => {}
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError())
      signal?.addEventListener("abort", onAbort, { once: true })
    })
    try {
      const response = await Promise.race([injected, aborted])
      entry.status = response.statusCode
      const responseHeaders = new Headers()
      for (const [name, value] of Object.entries(response.headers as Record<string, unknown>)) {
        if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : String(value))
      }
      const empty = response.statusCode === 204 || response.statusCode === 304
      return new Response(empty ? null : response.body, { status: response.statusCode, headers: responseHeaders })
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }
  }

  async function json(method: string, path: string, session: HostSession, body: unknown) {
    const response = await fetch(`${HARNESS_API_BASE}${path}`, { method, headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" }, body: JSON.stringify(body) })
    const parsed = await response.json() as Record<string, unknown>
    if (response.status !== 200) throw new Error(`HARNESS_REQUEST_FAILED:${response.status}:${String(parsed.error)}`)
    return parsed
  }

  let sessions = 0

  return Object.freeze({
    apiBase: HARNESS_API_BASE,
    frontendOrigin,
    manifest,
    digest,
    chain,
    sql,
    wall,
    fetch,
    get requests(): readonly RecordedRequest[] { return requests },
    clearRequests() { requests.length = 0 },
    session(wallet: string, sessionOptions: { lifetimeMs?: number } = {}): HostSession {
      const lifetime = sessionOptions.lifetimeMs ?? MAX_SESSION_MS
      if (!Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > MAX_SESSION_MS) throw new Error("HARNESS_INVALID_SESSION_LIFETIME")
      const createdAt = wall()
      sessions++
      return Object.freeze({ id: `in-process-session-${sessions}`, walletAddress: getAddress(wallet), chainId: 91342 as const, accessToken: mint(wallet, Math.ceil(lifetime / 1000)), createdAt, expiresAt: createdAt + lifetime })
    },
    signInDependencies(): SignInDependencies {
      const messages: MessageRequest[] = []
      return {
        fetch,
        // FIXTURE: no key and no signature; the fixture verify route accepts any 65-byte hex.
        async signMessage(request: MessageRequest) { messages.push(request); return FIXTURE_SIGNATURE },
        now: wall,
        get messages() { return messages },
      }
    },
    async createOrder(side: Side, session: HostSession, quantity = "1"): Promise<AcceptedOrder> {
      const sell = side === "SELL"
      const quote = await json("POST", sell ? "/api/v1/stocks/sell-quotes" : "/api/v1/stocks/quotes", session, { symbol: "NVDA", quantity })
      const quoteId = (quote.data as Record<string, unknown>).id
      const envelope = await json("POST", sell ? "/api/v1/stocks/sell-orders" : "/api/v1/stocks/orders", session, { quoteId, idempotencyKey: `harness:${randomUUID()}` })
      return Object.freeze({ order: envelope.data as Record<string, unknown>, envelope })
    },
    seedStock(wallet: string, quantity: bigint | string) {
      const value = BigInt(quantity)
      // The same finalized-movement projection the sell service sums (see the Postgres fixture in stocks-submissions).
      sql.seed("StocksQuantityMovement", { id: randomUUID(), deploymentDigest: digest, wallet: wallet.toLowerCase(), custodyId: null, walletDelta: value.toString(), escrowDelta: "0", supplyDelta: value.toString(), blockNumber: "1", blockHash: "harness-seed-block", txHash: "harness-seed-tx" })
      chain.mintStock(wallet, value)
    },
    seedCash(wallet: string, amount: bigint | string) {
      chain.mintCash(wallet, amount)
    },
    async setOrderState(side: Side, orderId: string, state: string) {
      // Observer emulation through the real repository/sell-service state transition (version+1, audit row).
      return stocks.repo.tx(async (db: AnyModule) => {
        const owner = side === "BUY" ? stocks.repo : stocks.sell
        const order = await owner.order(db, orderId)
        await owner.state(db, order, state)
        return owner.order(db, orderId)
      })
    },
    setPaused(value: boolean) { paused = value },
    setEvidenceAvailable(value: boolean) { evidenceAvailable = value },
    async close() { await app.close() },
  })
}
