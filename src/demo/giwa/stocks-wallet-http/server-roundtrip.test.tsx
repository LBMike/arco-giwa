// In-process roundtrip against the ACTUAL server code: the Fastify execution and Stocks plugins with the real
// StocksService and StocksExecutionService over an in-memory SQL fake (the same technique as
// server/src/stocks-execution/service.test.ts). Requests go through app.inject: no socket, network, database,
// RPC or wallet. This pins the adapter to the DTOs the server really produces.

import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { createStocksWalletController } from "../stocks-wallet/controller"
import { planOrder } from "../stocks-wallet/planner"
import type { AttemptRecord, ExecutionContext, Side, SubmissionGate, WalletPorts } from "../stocks-wallet/types"
import { createStocksExecutionReads } from "./reads"
import { StocksExecutionReadError } from "./errors"

const repo = fileURLToPath(new URL("../../../../", import.meta.url))
type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

async function load() {
  const server = (path: string): Promise<AnyModule> => import(`${repo}server/src/${path}`)
  const [fastify, executionPlugin, executionService, stocksPlugin, stocksService, repository, chain, contracts, fixtures, submissions, enrollment] = await Promise.all([
    import("fastify") as Promise<AnyModule>,
    server("stocks-execution/plugin.ts"),
    server("stocks-execution/service.ts"),
    server("stocks/plugin.ts"),
    server("stocks/service.ts"),
    server("stocks/repository.ts"),
    server("stocks/chain.ts"),
    server("stocks/contracts.ts"),
    server("stocks/test-fixtures.ts"),
    server("stocks-submissions/contracts.ts"),
    server("stocks-submissions/enrollment.ts"),
  ])
  return { Fastify: fastify.default, stocksExecutionPlugin: executionPlugin.stocksExecutionPlugin, StocksExecutionService: executionService.StocksExecutionService, stocksPlugin: stocksPlugin.stocksPlugin, StocksService: stocksService.StocksService, StocksRepository: repository.StocksRepository, ReceiptVerifier: chain.ReceiptVerifier, manifestDigest: contracts.manifestDigest, operationKey: contracts.operationKey, testManifest: fixtures.testManifest, TestChain: fixtures.TestChain, a: fixtures.a, deriveOrder: submissions.deriveOrder, orderBinding: enrollment.orderBinding }
}

const TOKEN = "roundtrip-header.roundtrip-payload.roundtrip-signature"
const API = "https://stocks-roundtrip.test"

async function serverApp(side: Side, options: { paused?: boolean; evidenceFails?: boolean } = {}) {
  const s = await load()
  const manifest = s.testManifest()
  const digest: string = s.manifestDigest(manifest)
  const wallet: string = s.a(42)
  const actor = { actorId: `evm:${wallet}`, wallet, chainId: 91342, scope: "STOCKS_TESTNET", verified: true }
  const now = Date.now()
  // Row values as node-postgres returns them: numeric → string, timestamptz → Date.
  const row = {
    id: "roundtrip-order-1",
    orderKey: s.operationKey(`${side === "SELL" ? "sell:" : ""}${manifest.networkInstance}:roundtrip-order-1`),
    quoteId: "roundtrip-quote-1",
    actorId: actor.actorId,
    wallet,
    symbol: "NVDA",
    quantity: "1000000000",
    cashAmount: "120000000",
    idempotencyKey: "roundtrip-request-1",
    deploymentId: manifest.deploymentId,
    deploymentDigest: digest,
    quoteExpiresAt: new Date(now + 600_000),
    state: side === "BUY" ? "AWAITING_FUNDING" : "AWAITING_ESCROW",
    version: 0,
    createdAt: new Date(now - 5_000),
    updatedAt: new Date(now - 5_000),
  }
  const enrollment = { side, orderId: row.id, intentKey: s.deriveOrder(manifest, row, side).intentKey, actorId: actor.actorId, wallet, deploymentDigest: digest, orderBinding: s.orderBinding(row, side) }
  const table = side === "BUY" ? '"StocksOrder"' : '"StocksSellOrder"'
  const sql: string[] = []
  const query = async (text: string, params: unknown[] = []) => {
    sql.push(text)
    let rows: unknown[] = []
    if (text.includes(`arco_evm.${table}`) && text.includes('"actorId"=$2 AND wallet=$3')) rows = params[0] === row.id && params[1] === actor.actorId && params[2] === wallet && params[3] === digest ? [row] : []
    else if (text.startsWith('SELECT * FROM arco_evm."StocksOrder"') && side === "BUY") rows = params[0] === actor.actorId && params[1] === row.id && params[2] === digest ? [row] : []
    else if (text.startsWith("SELECT *,'SELL' AS side FROM arco_evm.\"StocksSellOrder\"") && side === "SELL") rows = params[0] === actor.actorId && params[1] === digest && params[2] === row.id ? [{ ...row, side: "SELL" }] : []
    else if (text.includes('"StocksLiquidityBinding"')) rows = [{ deploymentDigest: digest }]
    else if (text.includes('"StocksWalletSubmissionEnrollment"')) rows = [enrollment]
    else if (text.includes("remainingMs")) rows = [{ remainingMs: 600_000 }]
    return { rows, rowCount: rows.length }
  }
  const pool = { query, connect: async () => ({ query, release: () => undefined }) }
  const stocks = new s.StocksService(new s.StocksRepository(pool, digest), manifest, new s.ReceiptVerifier(manifest, new s.TestChain(manifest)), { manifestDigest: digest, contractPolicyVerified: true }, async () => options.paused === true)
  const evidence = {
    async get() {
      if (options.evidenceFails) throw new Error("rpc https://private-rpc.example password=secret")
      const verifiedAt = Date.now() - 100
      return { status: "VERIFIED", evidenceId: "roundtrip-evidence-1", manifestDigest: digest, manifest, verifiedAt, validUntil: verifiedAt + 15_000 }
    },
  }
  const resolveActor = async (request: { headers: Record<string, unknown> }) => (request.headers.authorization === `Bearer ${TOKEN}` ? actor : null)
  const app = s.Fastify({ logger: false })
  await app.register(s.stocksExecutionPlugin, { service: new s.StocksExecutionService(stocks, evidence), resolveActor })
  await app.register(s.stocksPlugin, { service: stocks, resolveActor })
  await app.ready()
  const statuses: number[] = []
  const fetch = async (url: string, init: RequestInit) => {
    const target = new URL(url)
    assert.equal(target.origin, API, "requests stay on the bound API base")
    const result = await app.inject({ method: init.method, url: `${target.pathname}${target.search}`, headers: init.headers as Record<string, string> })
    statuses.push(result.statusCode)
    const headers = Object.entries(result.headers as Record<string, unknown>).map(([name, value]) => [name, String(value)] as [string, string])
    return new Response(result.body, { status: result.statusCode, headers })
  }
  return { s, app, manifest, digest, wallet, row, enrollment, sql, fetch, statuses }
}

function sessionFor(wallet: string) {
  const now = Date.now()
  return Object.freeze({ id: "roundtrip-session-a", walletAddress: wallet as `0x${string}`, chainId: 91342 as const, accessToken: TOKEN, createdAt: now - 1_000, expiresAt: now + 600_000 })
}

for (const side of ["BUY", "SELL"] as const) {
  test(`${side}: actual server DTOs pass the adapter unchanged and feed the planner exactly as the server derives the order`, async () => {
    const w = await serverApp(side)
    try {
      const rejected: string[] = []
      const reads = createStocksExecutionReads({ apiBase: API, fetch: w.fetch, onSessionRejected: (id) => rejected.push(id) })
      const signal = new AbortController().signal
      const request = { apiBase: API, token: TOKEN, sessionId: "roundtrip-session-a", side, orderId: w.row.id, deploymentDigest: w.digest, signal }

      const lease = await reads.readDeployment({ apiBase: API, token: TOKEN, sessionId: "roundtrip-session-a", signal, deploymentDigest: w.digest })
      assert.equal(lease.deployment.manifestDigest, w.digest, "browser digest of the public manifest equals the server digest")
      assert.equal(lease.deployment.evidenceId, "roundtrip-evidence-1")
      assert.equal(lease.deployment.validUntil - lease.deployment.verifiedAt, 15_000)
      assert.ok(reads.currentDeployment(lease))

      const allowed = await reads.readExecutionPolicy(request)
      assert.deepEqual(Object.keys(allowed).sort(), ["allowed", "deploymentDigest", "observedAt", "orderId", "side", "validUntil"])
      assert.equal(allowed.side, side)
      assert.ok(Number.isSafeInteger(allowed.observedAt) && allowed.validUntil - allowed.observedAt <= 15_000)

      const order = (await reads.readOrder(request)) as Record<string, unknown>
      assert.deepEqual(Object.keys(order).sort(), ["brokerMode", "chainId", "data", "observedAt", "priceSource", "profile", "valuePolicy"])
      const data = order.data as Record<string, unknown>
      assert.equal(data.side, side === "SELL" ? "SELL" : undefined, "SELL GET rows carry side; BUY rows do not")
      assert.equal(data.quoteExpiresAt, w.row.quoteExpiresAt.toISOString())

      const catalog = (await reads.readCatalog(request)) as Record<string, unknown>
      assert.equal(catalog.deploymentId, w.manifest.deploymentId)

      const context: ExecutionContext = { session: sessionFor(w.wallet), walletAddress: w.wallet, chainId: 91342, walletEpoch: "roundtrip:1", apiBase: API, deployment: lease.deployment }
      const plan = planOrder({ side, order: data }, context, Date.now())
      const derived = w.s.deriveOrder(w.manifest, w.row, side)
      assert.equal(plan.intentKey, derived.intentKey)
      assert.deepEqual([plan.approval.data, plan.transfer.data], [derived.approval.data, derived.transfer.data])
      assert.deepEqual(rejected, [])
      assert.ok(w.sql.every((text) => !/INSERT|UPDATE|DELETE/.test(text)), "reads issue no writes")
    } finally {
      await w.app.close()
    }
  })

  test(`${side}: the real controller completes a read-only check over the actual server reads without any wallet request`, async () => {
    const w = await serverApp(side)
    try {
      const reads = createStocksExecutionReads({ apiBase: API, fetch: w.fetch })
      const lease = await reads.readDeployment({ apiBase: API, token: TOKEN, sessionId: "roundtrip-session-a", signal: new AbortController().signal })
      const journal: { approval: AttemptRecord | null; transfer: AttemptRecord | null } = { approval: null, transfer: null }
      const submissions: SubmissionGate = { inspect: async () => journal, claim: async () => assert.fail("a check never claims"), record: async () => assert.fail("a check never records"), reconcile: async () => assert.fail("nothing to reconcile") }
      let walletRequests = 0
      const session = sessionFor(w.wallet)
      const ports: WalletPorts = {
        context: () => ({ session, walletAddress: w.wallet, chainId: 91342, walletEpoch: "roundtrip:1", apiBase: API, deployment: reads.currentDeployment(lease) }),
        readWallet: async () => ({ address: w.wallet, chainId: 91342, connectionEpoch: "roundtrip:1", deploymentDigest: w.digest, networkInstance: w.manifest.networkInstance, checkpointHash: w.manifest.checkpointHash }),
        readOrder: reads.readOrder,
        readCatalog: reads.readCatalog,
        readExecutionPolicy: reads.readExecutionPolicy,
        readAllowance: async () => "0",
        requestTransaction: async () => {
          walletRequests++
          throw new Error("no wallet in this test")
        },
        waitApprovalReceipt: async () => null,
        submissions,
      }
      const controller = createStocksWalletController(ports)
      controller.select({ side, order: JSON.parse(JSON.stringify(w.row)) })
      try {
        await controller.prepare()
        assert.deepEqual([controller.getSnapshot().status, controller.getSnapshot().error], ["APPROVAL_REQUIRED", null])
        assert.equal(walletRequests, 0)
        assert.ok(w.statuses.every((status) => status === 200))
      } finally {
        controller.dispose()
      }
    } finally {
      await w.app.close()
    }
  })
}

test("actual server denials: bad token, unknown order, paused trading and failed evidence map to fixed codes without server text", async () => {
  const expectCode = async (promise: Promise<unknown>, code: string, status: number) => {
    const error = await promise.then(() => assert.fail(`expected ${code}`), (value: unknown) => value)
    assert.ok(error instanceof StocksExecutionReadError)
    assert.deepEqual([error.code, error.status], [code, status])
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /private-rpc|password|UNAUTHORIZED|ORDER_NOT_FOUND|STOCKS_PAUSED|EXECUTION_UNAVAILABLE|EXECUTION_DEPLOYMENT_UNVERIFIED|roundtrip\.test|roundtrip-signature/)
  }
  const w = await serverApp("BUY")
  const rejected: string[] = []
  try {
    const reads = createStocksExecutionReads({ apiBase: API, fetch: w.fetch, onSessionRejected: (id) => rejected.push(id) })
    const signal = new AbortController().signal
    const base = { apiBase: API, token: TOKEN, sessionId: "roundtrip-session-a", side: "BUY" as const, orderId: w.row.id, deploymentDigest: w.digest, signal }
    await expectCode(reads.readExecutionPolicy({ ...base, token: "forged.token.value" }), "SESSION_REJECTED", 401)
    await expectCode(reads.readOrder({ ...base, token: "forged.token.value", sessionId: "roundtrip-session-old" }), "SESSION_REJECTED", 401)
    assert.deepEqual(rejected, ["roundtrip-session-a", "roundtrip-session-old"])
    await expectCode(reads.readExecutionPolicy({ ...base, orderId: "missing-order" }), "EXECUTION_NOT_ALLOWED", 404)
    await expectCode(reads.readOrder({ ...base, orderId: "missing-order" }), "ORDER_CHANGED", 404)
  } finally {
    await w.app.close()
  }
  const paused = await serverApp("SELL", { paused: true })
  try {
    const reads = createStocksExecutionReads({ apiBase: API, fetch: paused.fetch })
    await expectCode(reads.readExecutionPolicy({ apiBase: API, token: TOKEN, sessionId: "roundtrip-session-a", side: "SELL", orderId: paused.row.id, deploymentDigest: paused.digest, signal: new AbortController().signal }), "EXECUTION_NOT_ALLOWED", 503)
    // Trading pause does not invalidate verified deployment identity.
    assert.ok(await reads.readDeployment({ apiBase: API, token: TOKEN, sessionId: "roundtrip-session-a", signal: new AbortController().signal }))
  } finally {
    await paused.app.close()
  }
  const unverified = await serverApp("BUY", { evidenceFails: true })
  try {
    const reads = createStocksExecutionReads({ apiBase: API, fetch: unverified.fetch })
    await expectCode(reads.readDeployment({ apiBase: API, token: TOKEN, sessionId: "roundtrip-session-a", signal: new AbortController().signal }), "DEPLOYMENT_NOT_REVIEWED", 503)
  } finally {
    await unverified.app.close()
  }
})
