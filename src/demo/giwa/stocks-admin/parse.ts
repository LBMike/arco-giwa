// Strict validation of Stocks admin responses. Anything that does not match the reviewed
// contract throws, and the caller shows none of it: a partially valid response is never
// rendered as if it were complete.
import type {
  AuditRow,
  AuditValue,
  CashReservationRow,
  CustodyRow,
  CurrentLiabilities,
  FundingRow,
  HoldingRow,
  OperationRow,
  OrderDetail,
  OrderRow,
  OverviewRow,
  PendingItem,
  ProofSummary,
  Reconciliation,
  ReconciliationCutoff,
  ReconciliationDifference,
  ReconciliationSnapshot,
  ReconciliationStatus,
  StocksEnvelopeMeta,
} from "./types"

export class StocksContractError extends Error {
  constructor(readonly path: string) {
    super(`Stocks admin response does not match the contract at ${path}`)
  }
}

/** The only profile whose units (quantity scale 9, cash scale 6) this console has verified. */
export const SUPPORTED_PROFILE = Object.freeze({
  profile: "DEMO_TESTNET",
  valuePolicy: "TEST_VALUE_ONLY",
  brokerMode: "MOCK_BROKER",
  priceSource: "FIXED_MOCK_PRICE",
  chainId: 91342,
})

const UNSIGNED = /^(0|[1-9]\d*)$/
const SIGNED = /^-?(0|[1-9]\d*)$/
const HASH = /^0x[0-9a-fA-F]{64}$/

type Json = Record<string, unknown>

function fail(path: string): never {
  throw new StocksContractError(path)
}

function record(value: unknown, path: string): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : fail(path)
}

function list(value: unknown, path: string): unknown[] {
  return Array.isArray(value) ? value : fail(path)
}

function text(value: unknown, path: string): string {
  return typeof value === "string" && value.length > 0 ? value : fail(path)
}

function optionalText(value: unknown, path: string): string | null {
  return value === null || value === undefined ? null : text(value, path)
}

function unsigned(value: unknown, path: string): string {
  return typeof value === "string" && UNSIGNED.test(value) ? value : fail(path)
}

function signed(value: unknown, path: string): string {
  return typeof value === "string" && SIGNED.test(value) ? value : fail(path)
}

function time(value: unknown, path: string): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fail(path)
}

function side(value: unknown, path: string): "BUY" | "SELL" {
  return value === "BUY" || value === "SELL" ? value : fail(path)
}

export function parseEnvelope(body: unknown): { meta: StocksEnvelopeMeta; data: unknown } {
  const root = record(body, "$")
  for (const key of ["profile", "valuePolicy", "brokerMode", "priceSource", "chainId"] as const) {
    if (root[key] !== SUPPORTED_PROFILE[key]) fail(`$.${key}`)
  }
  if (!Object.prototype.hasOwnProperty.call(root, "data")) fail("$.data")
  return {
    meta: {
      profile: root.profile as string,
      valuePolicy: root.valuePolicy as string,
      brokerMode: root.brokerMode as string,
      priceSource: root.priceSource as string,
      chainId: root.chainId as number,
      observedAt: time(root.observedAt, "$.observedAt"),
    },
    data: root.data,
  }
}

export function parseOverview(data: unknown): OverviewRow[] {
  return list(data, "data").map((item, i) => {
    const row = record(item, `data[${i}]`)
    return {
      side: side(row.side, `data[${i}].side`),
      state: text(row.state, `data[${i}].state`),
      count: unsigned(row.count, `data[${i}].count`),
      cashAmount: unsigned(row.cashAmount, `data[${i}].cashAmount`),
    }
  })
}

function orderRow(value: unknown, path: string): OrderRow {
  const row = record(value, path)
  const version = row.version
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) fail(`${path}.version`)
  return {
    id: text(row.id, `${path}.id`),
    side: side(row.side, `${path}.side`),
    state: text(row.state, `${path}.state`),
    symbol: text(row.symbol, `${path}.symbol`),
    quantity: unsigned(row.quantity, `${path}.quantity`),
    cashAmount: unsigned(row.cashAmount, `${path}.cashAmount`),
    wallet: text(row.wallet, `${path}.wallet`),
    orderKey: text(row.orderKey, `${path}.orderKey`),
    deploymentId: text(row.deploymentId, `${path}.deploymentId`),
    deploymentDigest: text(row.deploymentDigest, `${path}.deploymentDigest`),
    version,
    quoteExpiresAt: time(row.quoteExpiresAt, `${path}.quoteExpiresAt`),
    createdAt: time(row.createdAt, `${path}.createdAt`),
    updatedAt: time(row.updatedAt, `${path}.updatedAt`),
  }
}

export function parseOrders(data: unknown): OrderRow[] {
  const rows = list(data, "data").map((item, i) => orderRow(item, `data[${i}]`))
  if (rows.length > 200) fail("data.length")
  return rows
}

function proof(value: unknown): ProofSummary {
  const source = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {}
  const field = (key: string) => {
    const raw = source[key]
    return typeof raw === "string" && raw.length > 0 ? raw : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : null
  }
  return { blockNumber: field("blockNumber"), blockHash: field("blockHash"), evidenceDigest: field("evidenceDigest") }
}

function auditValue(value: unknown): AuditValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
  try {
    return JSON.stringify(value) ?? null
  } catch {
    return null
  }
}

function auditRow(value: unknown, path: string): AuditRow {
  const row = record(value, path)
  const detail = row.detail !== null && typeof row.detail === "object" && !Array.isArray(row.detail) ? (row.detail as Json) : {}
  return {
    id: text(row.id, `${path}.id`),
    subject: text(row.subject, `${path}.subject`),
    action: text(row.action, `${path}.action`),
    detail: Object.entries(detail).map(([key, entry]) => [key, auditValue(entry)] as const),
    createdAt: time(row.createdAt, `${path}.createdAt`),
  }
}

export function parseAudit(data: unknown): AuditRow[] {
  const rows = list(data, "data").map((item, i) => auditRow(item, `data[${i}]`))
  if (rows.length > 200) fail("data.length")
  return rows
}

function operationRow(value: unknown, path: string): OperationRow {
  const row = record(value, path)
  return {
    id: text(row.id, `${path}.id`),
    kind: text(row.kind, `${path}.kind`),
    status: text(row.status, `${path}.status`),
    txHash: optionalText(row.txHash, `${path}.txHash`),
    createdAt: time(row.createdAt, `${path}.createdAt`),
    leaseUntil: row.leaseUntil === null || row.leaseUntil === undefined ? null : time(row.leaseUntil, `${path}.leaseUntil`),
  }
}

// Every child row of a detail must belong to the requested order: a row from another order
// is a contract violation, not something to display under this order.
function sameOrder(value: string | null, orderId: string, path: string) {
  if (value !== orderId) fail(path)
}

export function parseOrderDetail(data: unknown): OrderDetail {
  const root = record(data, "data")
  const order = orderRow(root.order, "data.order")
  const operations = list(root.operations, "data.operations").map((item, i) => operationRow(item, `data.operations[${i}]`))
  const audit = list(root.audit, "data.audit").map((item, i) => {
    const row = auditRow(item, `data.audit[${i}]`)
    sameOrder(row.subject, order.id, `data.audit[${i}].subject`)
    return row
  })

  if (order.side === "BUY") {
    const funding = list(root.funding, "data.funding").map((item, i): FundingRow => {
      const path = `data.funding[${i}]`
      const row = record(item, path)
      const orderId = optionalText(row.orderId, `${path}.orderId`)
      sameOrder(orderId, order.id, `${path}.orderId`)
      return {
        id: text(row.id, `${path}.id`),
        orderId,
        payer: text(row.payer, `${path}.payer`),
        amount: unsigned(row.amount, `${path}.amount`),
        status: text(row.status, `${path}.status`),
        reason: text(row.reason, `${path}.reason`),
        txHash: text(row.txHash, `${path}.txHash`),
        proof: proof(row.proof),
        createdAt: time(row.createdAt, `${path}.createdAt`),
      }
    })
    const holdings = list(root.holdings, "data.holdings").map((item, i): HoldingRow => {
      const path = `data.holdings[${i}]`
      const row = record(item, path)
      const orderId = text(row.orderId, `${path}.orderId`)
      sameOrder(orderId, order.id, `${path}.orderId`)
      return {
        orderId,
        wallet: text(row.wallet, `${path}.wallet`),
        symbol: text(row.symbol, `${path}.symbol`),
        quantity: unsigned(row.quantity, `${path}.quantity`),
        txHash: text(row.txHash, `${path}.txHash`),
        blockHash: text(row.blockHash, `${path}.blockHash`),
        blockNumber: unsigned(row.blockNumber, `${path}.blockNumber`),
        createdAt: time(row.createdAt, `${path}.createdAt`),
      }
    })
    return { side: "BUY", order, funding, operations, audit, holdings }
  }

  const custody = list(root.custody, "data.custody").map((item, i): CustodyRow => {
    const path = `data.custody[${i}]`
    const row = record(item, path)
    const orderId = optionalText(row.orderId, `${path}.orderId`)
    sameOrder(orderId, order.id, `${path}.orderId`)
    return {
      id: text(row.id, `${path}.id`),
      escrowId: text(row.escrowId, `${path}.escrowId`),
      orderId,
      payer: text(row.payer, `${path}.payer`),
      quantity: unsigned(row.quantity, `${path}.quantity`),
      reason: text(row.reason, `${path}.reason`),
      status: text(row.status, `${path}.status`),
      txHash: text(row.txHash, `${path}.txHash`),
      proof: proof(row.proof),
      createdAt: time(row.createdAt, `${path}.createdAt`),
    }
  })
  const reservations = list(root.reservations, "data.reservations").map((item, i): CashReservationRow => {
    const path = `data.reservations[${i}]`
    const row = record(item, path)
    const orderId = text(row.orderId, `${path}.orderId`)
    sameOrder(orderId, order.id, `${path}.orderId`)
    return {
      orderId,
      scopeKey: text(row.scopeKey, `${path}.scopeKey`),
      amount: unsigned(row.amount, `${path}.amount`),
      status: text(row.status, `${path}.status`),
      createdAt: time(row.createdAt, `${path}.createdAt`),
    }
  })
  return { side: "SELL", order, custody, operations, audit, reservations }
}

const RECONCILIATION_STATUSES: readonly ReconciliationStatus[] = ["MATCHED_AT_CUTOFF", "MISMATCH", "UNAVAILABLE", "INCOMPLETE"]

export function parseReconciliation(data: unknown): Reconciliation {
  const root = record(data, "data")
  const status = RECONCILIATION_STATUSES.find((candidate) => candidate === root.status) ?? fail("data.status")
  const reason = optionalText(root.reason, "data.reason")
  const pending = list(root.pending, "data.pending").map((item, i): PendingItem => {
    const row = record(item, `data.pending[${i}]`)
    return {
      kind: text(row.kind, `data.pending[${i}].kind`),
      id: text(row.id, `data.pending[${i}].id`),
      status: text(row.status, `data.pending[${i}].status`),
    }
  })

  if (status === "UNAVAILABLE" || status === "INCOMPLETE") {
    // No comparison happened. A cutoff (e.g. stale coverage) is kept as context only; any
    // snapshot/difference/liability fields are ignored so they can never be read as a result.
    let cutoff: ReconciliationCutoff | null = null
    if (root.cutoff !== undefined && root.cutoff !== null) {
      const c = record(root.cutoff, "data.cutoff")
      cutoff = {
        deploymentDigest: typeof c.deploymentDigest === "string" ? c.deploymentDigest : "",
        throughBlock: typeof c.throughBlock === "string" ? c.throughBlock : "",
        blockHash: typeof c.blockHash === "string" ? c.blockHash : "",
        observedAt: typeof c.observedAt === "string" ? c.observedAt : "",
      }
    }
    return { status, reason: reason ?? fail("data.reason"), cutoff, snapshot: null, differences: [], pending, currentLiabilities: null }
  }

  const c = record(root.cutoff, "data.cutoff")
  const cutoff: ReconciliationCutoff = {
    deploymentDigest: text(c.deploymentDigest, "data.cutoff.deploymentDigest"),
    throughBlock: unsigned(c.throughBlock, "data.cutoff.throughBlock"),
    blockHash: typeof c.blockHash === "string" && HASH.test(c.blockHash) ? c.blockHash : fail("data.cutoff.blockHash"),
    observedAt: time(c.observedAt, "data.cutoff.observedAt"),
  }
  const s = record(root.snapshot, "data.snapshot")
  const wallets = record(s.walletBalances, "data.snapshot.walletBalances")
  const snapshot: ReconciliationSnapshot = {
    blockNumber: unsigned(s.blockNumber, "data.snapshot.blockNumber"),
    blockHash: text(s.blockHash, "data.snapshot.blockHash"),
    blockTimestamp: s.blockTimestamp === undefined || s.blockTimestamp === null ? null : unsigned(s.blockTimestamp, "data.snapshot.blockTimestamp"),
    cashBalance: unsigned(s.cashBalance, "data.snapshot.cashBalance"),
    stockSupply: unsigned(s.stockSupply, "data.snapshot.stockSupply"),
    escrowBalance: unsigned(s.escrowBalance, "data.snapshot.escrowBalance"),
    walletBalances: Object.entries(wallets).map(([wallet, balance]) => [wallet, unsigned(balance, `data.snapshot.walletBalances.${wallet}`)] as const),
  }
  // The comparison must be about the cutoff block the observer vouched for.
  if (snapshot.blockNumber !== cutoff.throughBlock || snapshot.blockHash.toLowerCase() !== cutoff.blockHash.toLowerCase()) fail("data.snapshot.block")

  const differences = list(root.differences, "data.differences").map((item, i): ReconciliationDifference => {
    const row = record(item, `data.differences[${i}]`)
    return {
      asset: text(row.asset, `data.differences[${i}].asset`),
      wallet: optionalText(row.wallet, `data.differences[${i}].wallet`),
      expected: signed(row.expected, `data.differences[${i}].expected`),
      actual: row.actual === undefined || row.actual === null ? null : signed(row.actual, `data.differences[${i}].actual`),
    }
  })
  if (status === "MATCHED_AT_CUTOFF" && differences.length > 0) fail("data.differences")
  if (status === "MISMATCH" && differences.length === 0) fail("data.differences")

  const l = record(root.currentLiabilities, "data.currentLiabilities")
  const currentLiabilities: CurrentLiabilities = {
    cashBalance: signed(l.cashBalance, "data.currentLiabilities.cashBalance"),
    liabilities: signed(l.liabilities, "data.currentLiabilities.liabilities"),
    sellReserved: signed(l.sellReserved, "data.currentLiabilities.sellReserved"),
  }
  return { status, reason, cutoff, snapshot, differences, pending, currentLiabilities }
}
