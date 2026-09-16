// EXPLICIT FIXTURES — tests and the local screenshot harness only. The feature never imports
// this file and has no mock fallback: without an injected transport it calls the real API.
// Shapes mirror server/src/stocks/{plugin,repository,reconciliation}.ts responses.
import type { ReconciliationStatus, StocksAdminFetch, StocksAdminResponse } from "./types"

export const FIXTURE_OBSERVED_AT = "2026-09-17T03:00:00.000Z"
export const FIXTURE_NOW = Date.parse("2026-09-17T03:00:30.000Z")

export const FIXTURE_PROFILE = Object.freeze({
  profile: "DEMO_TESTNET",
  valuePolicy: "TEST_VALUE_ONLY",
  brokerMode: "MOCK_BROKER",
  chainId: 91342,
  priceSource: "FIXED_MOCK_PRICE",
})

const DEPLOYMENT_ID = "giwa-stocks-testnet-v2"
const DIGEST = "5f0c2b7d9e41a3c6b8d0f2e4a6c8b0d2f4e6a8c0b2d4f6e8a0c2e4b6d8f0a2c4"
export const FIXTURE_BUYER = "0x8ba1f109551bd432803012645ac136ddd64dba72"
export const FIXTURE_SELLER = "0x2546bcd3c84621e976d8185a91a922ae77ecec30"
const VAULT = "0x9f8e7d6c5b4a39281706f5e4d3c2b1a098f7e6d5"
const CASH = "0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"

export function fixtureHash(seed: string): string {
  return `0x${seed.repeat(64).slice(0, 64)}`
}

export const FIXTURE_IDS = {
  buyCompleted: "3f6c1d2e-8b4a-4c5e-9f10-2a3b4c5d6e7f",
  buyFinality: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  buyUnknown: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
  buyLarge: "c9d8e7f6-a5b4-4c3d-8e2f-1a0b9c8d7e6f",
  sellSettlement: "e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b",
  sellLiquidity: "f0e9d8c7-b6a5-4948-8372-6150a4b3c2d1",
  sellCompleted: "0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d",
} as const

/** 36-digit amounts: the server bound is 1e36, far beyond Number precision. */
export const FIXTURE_LARGE_QUANTITY = "123456789012345678901234567890123456"
export const FIXTURE_LARGE_CASH = "987654321098765432109876543210987654"

type OrderInput = {
  id: string
  side: "BUY" | "SELL"
  state: string
  wallet: string
  quantity: string
  cashAmount: string
  createdAt: string
  updatedAt: string
  version: number
}

function orderRow(input: OrderInput) {
  return {
    id: input.id,
    orderKey: fixtureHash(input.id.replace(/[^0-9a-f]/g, "")),
    quoteId: `quote-${input.id}`,
    actorId: `evm:${input.wallet}`,
    wallet: input.wallet,
    symbol: "NVDA",
    quantity: input.quantity,
    cashAmount: input.cashAmount,
    idempotencyKey: `idem-${input.id}`,
    deploymentId: DEPLOYMENT_ID,
    deploymentDigest: DIGEST,
    quoteExpiresAt: new Date(Date.parse(input.createdAt) + 60_000).toISOString(),
    state: input.state,
    version: input.version,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    side: input.side,
  }
}

export const FIXTURE_ORDERS = [
  orderRow({ id: FIXTURE_IDS.sellLiquidity, side: "SELL", state: "LIQUIDITY_PENDING", wallet: FIXTURE_SELLER, quantity: "500000000", cashAmount: "60000000", createdAt: "2026-09-17T02:58:10.000Z", updatedAt: "2026-09-17T02:58:40.000Z", version: 2 }),
  orderRow({ id: FIXTURE_IDS.buyLarge, side: "BUY", state: "AWAITING_FUNDING", wallet: FIXTURE_BUYER, quantity: FIXTURE_LARGE_QUANTITY, cashAmount: FIXTURE_LARGE_CASH, createdAt: "2026-09-17T02:55:00.000Z", updatedAt: "2026-09-17T02:55:00.000Z", version: 0 }),
  orderRow({ id: FIXTURE_IDS.sellSettlement, side: "SELL", state: "SETTLEMENT_PENDING", wallet: FIXTURE_SELLER, quantity: "1000000000", cashAmount: "120000000", createdAt: "2026-09-17T02:41:00.000Z", updatedAt: "2026-09-17T02:47:30.000Z", version: 6 }),
  orderRow({ id: FIXTURE_IDS.buyUnknown, side: "BUY", state: "BROKER_UNKNOWN", wallet: FIXTURE_BUYER, quantity: "2000000000", cashAmount: "240000000", createdAt: "2026-09-17T02:20:00.000Z", updatedAt: "2026-09-17T02:21:05.000Z", version: 3 }),
  orderRow({ id: FIXTURE_IDS.buyFinality, side: "BUY", state: "MINT_FINALITY_PENDING", wallet: FIXTURE_BUYER, quantity: "1000000000", cashAmount: "120000000", createdAt: "2026-09-17T02:10:00.000Z", updatedAt: "2026-09-17T02:16:40.000Z", version: 5 }),
  orderRow({ id: FIXTURE_IDS.sellCompleted, side: "SELL", state: "COMPLETED", wallet: FIXTURE_SELLER, quantity: "1000000000", cashAmount: "120000000", createdAt: "2026-09-16T23:30:00.000Z", updatedAt: "2026-09-16T23:41:12.000Z", version: 7 }),
  orderRow({ id: FIXTURE_IDS.buyCompleted, side: "BUY", state: "COMPLETED", wallet: FIXTURE_BUYER, quantity: "3000000000", cashAmount: "360000000", createdAt: "2026-09-16T22:00:00.000Z", updatedAt: "2026-09-16T22:09:30.000Z", version: 6 }),
]

export const FIXTURE_OVERVIEW = [
  { state: "COMPLETED", count: "1", cashAmount: "360000000", side: "BUY" },
  { state: "MINT_FINALITY_PENDING", count: "1", cashAmount: "120000000", side: "BUY" },
  { state: "BROKER_UNKNOWN", count: "1", cashAmount: "240000000", side: "BUY" },
  { state: "AWAITING_FUNDING", count: "1", cashAmount: FIXTURE_LARGE_CASH, side: "BUY" },
  { state: "SETTLEMENT_PENDING", count: "1", cashAmount: "120000000", side: "SELL" },
  { state: "LIQUIDITY_PENDING", count: "1", cashAmount: "60000000", side: "SELL" },
  { state: "COMPLETED", count: "1", cashAmount: "120000000", side: "SELL" },
]

function audit(subject: string, action: string, createdAt: string, detail: Record<string, unknown>, n: number) {
  return { id: `audit-${subject.slice(0, 8)}-${n}`, subject, action, detail, deploymentDigest: DIGEST, createdAt }
}

function orderById(id: string) {
  const row = FIXTURE_ORDERS.find((order) => order.id === id)
  if (!row) throw new Error(`fixture order ${id} missing`)
  return row
}

export const FIXTURE_BUY_DETAIL = {
  order: orderById(FIXTURE_IDS.buyFinality),
  funding: [
    {
      id: `giwa-sepolia:${fixtureHash("a1")}:3`,
      orderId: FIXTURE_IDS.buyFinality,
      payer: FIXTURE_BUYER,
      amount: "120000000",
      status: "ACCEPTED",
      reason: "EXACT_ORDER_FUNDING",
      txHash: fixtureHash("a1"),
      proof: { blockHash: fixtureHash("b1"), blockNumber: "19834100", evidenceDigest: "9c1e", deploymentDigest: DIGEST, orderKey: fixtureHash("7a1b") },
      deploymentDigest: DIGEST,
      createdAt: "2026-09-17T02:11:02.000Z",
    },
  ],
  operations: [
    { id: `broker:${FIXTURE_IDS.buyFinality}`, kind: "BROKER", status: "DONE", txHash: null, createdAt: "2026-09-17T02:11:03.000Z", leaseUntil: null },
    { id: `mint:${FIXTURE_IDS.buyFinality}`, kind: "MINT", status: "SUBMITTED", txHash: fixtureHash("c3"), createdAt: "2026-09-17T02:12:00.000Z", leaseUntil: "2026-09-17T03:00:20.000Z" },
  ],
  audit: [
    audit(FIXTURE_IDS.buyFinality, "ORDER_CREATED", "2026-09-17T02:10:00.000Z", { actorId: `evm:${FIXTURE_BUYER}`, deploymentDigest: DIGEST }, 1),
    audit(FIXTURE_IDS.buyFinality, "FUNDING_RECORDED", "2026-09-17T02:11:02.000Z", { fundingId: `giwa-sepolia:${fixtureHash("a1")}:3`, reason: "EXACT_ORDER_FUNDING" }, 2),
    audit(FIXTURE_IDS.buyFinality, "BROKER_PENDING", "2026-09-17T02:11:02.500Z", { previous: "AWAITING_FUNDING", version: 1 }, 3),
    audit(FIXTURE_IDS.buyFinality, "MINT_QUEUED", "2026-09-17T02:11:40.000Z", { previous: "BROKER_PENDING", version: 2 }, 4),
    audit(FIXTURE_IDS.buyFinality, "CHAIN_SUBMITTED", "2026-09-17T02:12:05.000Z", { operationId: `mint:${FIXTURE_IDS.buyFinality}`, txHash: fixtureHash("c3") }, 5),
    audit(FIXTURE_IDS.buyFinality, "MINT_SUBMITTED", "2026-09-17T02:12:05.100Z", { previous: "MINT_QUEUED", version: 3 }, 6),
    audit(FIXTURE_IDS.buyFinality, "MINT_FINALITY_PENDING", "2026-09-17T02:16:40.000Z", { previous: "MINT_SUBMITTED", version: 5 }, 7),
  ],
  holdings: [] as unknown[],
}

export const FIXTURE_BUY_COMPLETED_DETAIL = {
  order: orderById(FIXTURE_IDS.buyCompleted),
  funding: [
    {
      id: `giwa-sepolia:${fixtureHash("d4")}:1`,
      orderId: FIXTURE_IDS.buyCompleted,
      payer: FIXTURE_BUYER,
      amount: "360000000",
      status: "ACCEPTED",
      reason: "EXACT_ORDER_FUNDING",
      txHash: fixtureHash("d4"),
      proof: { blockHash: fixtureHash("e5"), blockNumber: "19830001", evidenceDigest: "41aa" },
      deploymentDigest: DIGEST,
      createdAt: "2026-09-16T22:01:00.000Z",
    },
  ],
  operations: [
    { id: `broker:${FIXTURE_IDS.buyCompleted}`, kind: "BROKER", status: "DONE", txHash: null, createdAt: "2026-09-16T22:01:01.000Z", leaseUntil: null },
    { id: `mint:${FIXTURE_IDS.buyCompleted}`, kind: "MINT", status: "DONE", txHash: fixtureHash("f6"), createdAt: "2026-09-16T22:02:00.000Z", leaseUntil: null },
  ],
  audit: [
    audit(FIXTURE_IDS.buyCompleted, "ORDER_CREATED", "2026-09-16T22:00:00.000Z", { actorId: `evm:${FIXTURE_BUYER}` }, 1),
    audit(FIXTURE_IDS.buyCompleted, "MINT_FINALIZED", "2026-09-16T22:09:29.000Z", { operationId: `mint:${FIXTURE_IDS.buyCompleted}`, txHash: fixtureHash("f6"), blockHash: fixtureHash("0a") }, 2),
    audit(FIXTURE_IDS.buyCompleted, "COMPLETED", "2026-09-16T22:09:30.000Z", { previous: "MINT_FINALITY_PENDING", version: 6 }, 3),
  ],
  holdings: [
    {
      orderId: FIXTURE_IDS.buyCompleted,
      actorId: `evm:${FIXTURE_BUYER}`,
      wallet: FIXTURE_BUYER,
      symbol: "NVDA",
      quantity: "3000000000",
      deploymentId: DEPLOYMENT_ID,
      deploymentDigest: DIGEST,
      txHash: fixtureHash("f6"),
      blockHash: fixtureHash("0a"),
      blockNumber: "19830042",
      createdAt: "2026-09-16T22:09:29.000Z",
    },
  ],
}

export const FIXTURE_SELL_DETAIL = {
  order: orderById(FIXTURE_IDS.sellSettlement),
  custody: [
    {
      id: `giwa-sepolia:${fixtureHash("5e")}:2`,
      escrowId: fixtureHash("6f"),
      orderId: FIXTURE_IDS.sellSettlement,
      deploymentDigest: DIGEST,
      payer: FIXTURE_SELLER,
      quantity: "1000000000",
      reason: "EXACT_ESCROW",
      status: "REDEEM_PENDING",
      txHash: fixtureHash("5e"),
      proof: { evidenceDigest: "77b0", blockNumber: "19834010", blockHash: fixtureHash("8d") },
      createdAt: "2026-09-17T02:42:10.000Z",
    },
  ],
  operations: [
    { id: `sell-broker:${FIXTURE_IDS.sellSettlement}`, kind: "SELL_BROKER", status: "DONE", txHash: null, createdAt: "2026-09-17T02:43:00.000Z" },
    { id: `redeem:${FIXTURE_IDS.sellSettlement}`, kind: "REDEEM", status: "SUBMITTED", txHash: fixtureHash("9e"), createdAt: "2026-09-17T02:45:00.000Z" },
  ],
  audit: [
    audit(FIXTURE_IDS.sellSettlement, "SELL_RESERVED", "2026-09-17T02:41:00.000Z", { quantity: "1000000000", wallet: FIXTURE_SELLER }, 1),
    audit(FIXTURE_IDS.sellSettlement, "ESCROW_RECORDED", "2026-09-17T02:42:10.000Z", { custodyId: `giwa-sepolia:${fixtureHash("5e")}:2`, reason: "EXACT_ESCROW" }, 2),
    audit(FIXTURE_IDS.sellSettlement, "ESCROW_HELD", "2026-09-17T02:42:10.100Z", { side: "SELL", previous: "AWAITING_ESCROW" }, 3),
    audit(FIXTURE_IDS.sellSettlement, "SELL_BROKER_PENDING", "2026-09-17T02:42:59.000Z", { side: "SELL", previous: "ESCROW_HELD" }, 4),
    audit(FIXTURE_IDS.sellSettlement, "SELL_BROKER_RESULT", "2026-09-17T02:44:00.000Z", { outcome: "FILLED", quantity: "1000000000", cashAmount: "120000000", operationId: `sell-broker:${FIXTURE_IDS.sellSettlement}` }, 5),
    audit(FIXTURE_IDS.sellSettlement, "REDEEM_QUEUED", "2026-09-17T02:44:00.100Z", { side: "SELL", previous: "SELL_BROKER_PENDING" }, 6),
    audit(FIXTURE_IDS.sellSettlement, "SELL_CHAIN_SUBMITTED", "2026-09-17T02:45:02.000Z", { operationId: `redeem:${FIXTURE_IDS.sellSettlement}`, txHash: fixtureHash("9e") }, 7),
    audit(FIXTURE_IDS.sellSettlement, "SETTLEMENT_PENDING", "2026-09-17T02:47:30.000Z", { side: "SELL", previous: "REDEEM_QUEUED" }, 8),
  ],
  reservations: [
    {
      orderId: FIXTURE_IDS.sellSettlement,
      deploymentDigest: DIGEST,
      scopeKey: `cash:91342:${VAULT}:${CASH}`,
      amount: "120000000",
      status: "RESERVED",
      proof: { blockNumber: "19834009", cashBalance: "480000000" },
      createdAt: "2026-09-17T02:42:58.000Z",
    },
  ],
}

/** A structurally valid detail with no child rows, derived from a list row. */
export function fixtureMinimalDetail(orderId: string) {
  const order = orderById(orderId)
  return order.side === "BUY"
    ? { order, funding: [], operations: [], audit: [], holdings: [] }
    : { order, custody: [], operations: [], audit: [], reservations: [] }
}

export const FIXTURE_AUDIT = [...FIXTURE_SELL_DETAIL.audit, ...FIXTURE_BUY_DETAIL.audit, ...FIXTURE_BUY_COMPLETED_DETAIL.audit]
  .concat([audit(`giwa-sepolia:${fixtureHash("44")}:0`, "UNALLOCATED_FUNDING_RECORDED", "2026-09-17T02:50:00.000Z", { txHash: fixtureHash("44") }, 1)])
  .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

const CUTOFF = { deploymentDigest: DIGEST, throughBlock: "19834211", blockHash: fixtureHash("ab"), observedAt: "2026-09-17T02:59:52.000Z" }
const PENDING = [
  { kind: "ORDER", id: FIXTURE_IDS.buyFinality, status: "MINT_FINALITY_PENDING" },
  { kind: "ORDER", id: FIXTURE_IDS.buyUnknown, status: "BROKER_UNKNOWN" },
  { kind: "OUTBOX", id: `mint:${FIXTURE_IDS.buyFinality}`, status: "SUBMITTED" },
  { kind: "SELL", id: FIXTURE_IDS.sellSettlement, status: "SETTLEMENT_PENDING" },
  { kind: "CUSTODY", id: `giwa-sepolia:${fixtureHash("5e")}:2`, status: "REDEEM_PENDING" },
]
const SNAPSHOT = {
  blockNumber: "19834211",
  blockHash: fixtureHash("ab"),
  blockTimestamp: "1789613990",
  cashBalance: "480000000",
  stockSupply: "5000000000",
  escrowBalance: "1000000000",
  walletBalances: { [FIXTURE_BUYER]: "3000000000", [FIXTURE_SELLER]: "1000000000" },
}
const LIABILITIES = { cashBalance: "480000000", liabilities: "240000000", sellReserved: "180000000" }

export const FIXTURE_RECONCILIATIONS: Record<ReconciliationStatus, unknown> = {
  MATCHED_AT_CUTOFF: { status: "MATCHED_AT_CUTOFF", cutoff: CUTOFF, snapshot: SNAPSHOT, differences: [], pending: PENDING, currentLiabilities: LIABILITIES },
  MISMATCH: {
    status: "MISMATCH",
    cutoff: CUTOFF,
    snapshot: { ...SNAPSHOT, cashBalance: "479000000", walletBalances: { [FIXTURE_BUYER]: "2000000000", [FIXTURE_SELLER]: "1000000000" } },
    differences: [
      { asset: "TEST_CASH", expected: "480000000", actual: "479000000" },
      { asset: "STOCK_WALLET", wallet: FIXTURE_BUYER, expected: "3000000000", actual: "2000000000" },
    ],
    pending: PENDING,
    currentLiabilities: LIABILITIES,
  },
  UNAVAILABLE: { status: "UNAVAILABLE", reason: "NO_FINALIZED_OBSERVER_COVERAGE", pending: PENDING },
  INCOMPLETE: {
    status: "INCOMPLETE",
    reason: "STALE_OR_INVALID_OBSERVER_COVERAGE",
    cutoff: { ...CUTOFF, observedAt: "2026-09-17T02:57:40.000Z" },
    pending: PENDING,
  },
}

export function fixtureEnvelope(data: unknown, observedAt: string = FIXTURE_OBSERVED_AT) {
  return { ...FIXTURE_PROFILE, observedAt, data }
}

export type FixtureReply = { readonly status: number; readonly body?: unknown; readonly raw?: string }
export type FixtureCall = { readonly url: string; readonly path: string; readonly init: RequestInit }

export function fixtureResponse(reply: FixtureReply): StocksAdminResponse {
  const body = reply.raw ?? JSON.stringify(reply.body ?? null)
  return { status: reply.status, text: async () => body }
}

/**
 * Transport that answers from `route(path)`. Like fetch it rejects with AbortError once the
 * request's signal aborts (unless `ignoreAbort`, which models a transport that answers late).
 */
export function createFixtureTransport(
  route: (path: string, call: FixtureCall) => FixtureReply | Promise<FixtureReply>,
  options: { ignoreAbort?: boolean } = {},
): { fetch: StocksAdminFetch; calls: FixtureCall[] } {
  const calls: FixtureCall[] = []
  const fetch: StocksAdminFetch = (url, init) => {
    const path = url.replace(/^[a-z]+:\/\/[^/]+/i, "")
    const call = { url, path, init }
    calls.push(call)
    const signal = init.signal
    const reply = Promise.resolve().then(() => route(path, call)).then(fixtureResponse)
    if (options.ignoreAbort || !signal) return reply
    return new Promise<StocksAdminResponse>((resolve, reject) => {
      const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"))
      if (signal.aborted) return abort()
      signal.addEventListener("abort", abort, { once: true })
      reply.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    })
  }
  return { fetch, calls }
}

export type FixtureScenario = {
  readonly reconciliation?: ReconciliationStatus
  readonly access?: "ok" | "unauthorized" | "forbidden" | "disabled"
  readonly orders?: "default" | "empty"
}

/** Default router used by the screenshot harness and view tests. */
export function fixtureRoute(scenario: FixtureScenario = {}) {
  return (path: string): FixtureReply => {
    if (scenario.access === "unauthorized") return { status: 401, body: { error: "Missing bearer session token" } }
    if (scenario.access === "forbidden") return { status: 403, body: { error: "OPERATOR_FORBIDDEN", ...FIXTURE_PROFILE } }
    if (scenario.access === "disabled") return { status: 404, body: { message: `Route GET:${path} not found`, error: "Not Found", statusCode: 404 } }
    const empty = scenario.orders === "empty"
    if (path === "/api/v1/admin/stocks/overview") return { status: 200, body: fixtureEnvelope(empty ? [] : FIXTURE_OVERVIEW) }
    if (path === "/api/v1/admin/stocks/orders") return { status: 200, body: fixtureEnvelope(empty ? [] : FIXTURE_ORDERS) }
    if (path === "/api/v1/admin/stocks/audit") return { status: 200, body: fixtureEnvelope(empty ? [] : FIXTURE_AUDIT) }
    if (path === "/api/v1/admin/stocks/reconciliations") {
      return { status: 200, body: fixtureEnvelope(FIXTURE_RECONCILIATIONS[scenario.reconciliation ?? "MATCHED_AT_CUTOFF"]) }
    }
    const match = /^\/api\/v1\/admin\/stocks\/orders\/([^/]+)$/.exec(path)
    if (match) {
      const id = decodeURIComponent(match[1])
      if (id === FIXTURE_IDS.buyFinality) return { status: 200, body: fixtureEnvelope(FIXTURE_BUY_DETAIL) }
      if (id === FIXTURE_IDS.buyCompleted) return { status: 200, body: fixtureEnvelope(FIXTURE_BUY_COMPLETED_DETAIL) }
      if (id === FIXTURE_IDS.sellSettlement) return { status: 200, body: fixtureEnvelope(FIXTURE_SELL_DETAIL) }
      if (FIXTURE_ORDERS.some((order) => order.id === id) && !empty) return { status: 200, body: fixtureEnvelope(fixtureMinimalDetail(id)) }
      return { status: 404, body: { error: "ORDER_NOT_FOUND", ...FIXTURE_PROFILE } }
    }
    return { status: 404, body: { message: `Route GET:${path} not found`, error: "Not Found", statusCode: 404 } }
  }
}
