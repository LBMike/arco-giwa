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
  SubmissionDiagnostics,
  SubmissionStage,
  SubmissionStatus,
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

// ---------------------------------------------------------------- wallet submission diagnostics (read only)
// Mirrors server/src/stocks-submission-diagnostics/public.ts. Every object has an exact key set, so a field the reviewed
// contract does not have (raw proof JSON, calldata, internal errors) makes the whole response invalid instead of shown.

const DIAGNOSTIC_STATES: Record<"BUY" | "SELL", readonly string[]> = {
  BUY: ["AWAITING_FUNDING", "FUNDED_QUOTE_EXPIRED", "FUNDING_REVIEW_REQUIRED", "BROKER_PENDING", "BROKER_UNKNOWN", "MINT_QUEUED", "MINT_SUBMITTED", "MINT_FINALITY_PENDING", "MINT_UNKNOWN", "COMPLETED", "REFUNDED", "REVIEW_REQUIRED"],
  SELL: ["AWAITING_ESCROW", "EXPIRED", "ESCROW_HELD", "ESCROW_REVIEW_REQUIRED", "LIQUIDITY_PENDING", "SELL_BROKER_PENDING", "SELL_BROKER_UNKNOWN", "SELL_PARTIAL_HELD", "REDEEM_QUEUED", "RETURN_QUEUED", "SETTLEMENT_PENDING", "SETTLEMENT_UNKNOWN", "COMPLETED", "RETURNED", "REVIEW_REQUIRED"],
}
const SUBMISSION_STATUSES: readonly SubmissionStatus[] = ["REQUEST_MAY_START", "UNKNOWN", "SUBMITTED", "CONFIRMED", "REVERTED"]
const DIAG_LABEL = /^[a-zA-Z0-9:_-]{1,128}$/
const DIAG_DIGEST = /^[0-9a-f]{64}$/
const DIAG_HASH = /^0x[0-9a-f]{64}$/
const DIAG_ADDRESS = /^0x[0-9a-f]{40}$/
const DIAG_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function exactKeys(row: Json, keys: readonly string[], path: string) {
  const present = Object.keys(row)
  if (present.length !== keys.length || !keys.every((key) => Object.prototype.hasOwnProperty.call(row, key))) fail(`${path}{keys}`)
}
function matching(value: unknown, pattern: RegExp, path: string): string {
  return typeof value === "string" && pattern.test(value) ? value : fail(path)
}
function isoTime(value: unknown, path: string): string {
  const iso = matching(value, DIAG_ISO, path)
  return new Date(iso).toISOString() === iso ? iso : fail(path)
}
function nonZero(value: string, path: string): string {
  return /^0x0+$/.test(value) ? fail(path) : value
}

function submissionStage(value: unknown, stage: "APPROVAL" | "TRANSFER", intentKey: string, path: string): SubmissionStage | null {
  if (value === null) return null
  const row = record(value, path)
  exactKeys(row, ["claimId", "intentKey", "stage", "transactionDigest", "status", "txHash", "createdAt", "updatedAt", "receipt"], path)
  if (row.stage !== stage) fail(`${path}.stage`)
  if (row.intentKey !== intentKey) fail(`${path}.intentKey`)
  const status = SUBMISSION_STATUSES.includes(row.status as SubmissionStatus) ? (row.status as SubmissionStatus) : fail(`${path}.status`)
  const createdAt = isoTime(row.createdAt, `${path}.createdAt`)
  const updatedAt = isoTime(row.updatedAt, `${path}.updatedAt`)
  if (Date.parse(createdAt) > Date.parse(updatedAt)) fail(`${path}.updatedAt`)
  const txHash = row.txHash === null ? null : nonZero(matching(row.txHash, DIAG_HASH, `${path}.txHash`), `${path}.txHash`)
  // A reserved claim has no hash; a submitted or verified one always has the recorded hash.
  if (status === "REQUEST_MAY_START" && txHash !== null) fail(`${path}.txHash`)
  if ((status === "SUBMITTED" || status === "CONFIRMED" || status === "REVERTED") && txHash === null) fail(`${path}.txHash`)
  const terminal = status === "CONFIRMED" || status === "REVERTED"
  let receipt: SubmissionStage["receipt"] = null
  if (terminal) {
    const proof = record(row.receipt, `${path}.receipt`)
    exactKeys(proof, ["status", "blockNumber", "blockHash", "verifiedAt"], `${path}.receipt`)
    if (proof.status !== status) fail(`${path}.receipt.status`)
    const verifiedAt = isoTime(proof.verifiedAt, `${path}.receipt.verifiedAt`)
    if (Date.parse(verifiedAt) < Date.parse(createdAt) || Date.parse(verifiedAt) > Date.parse(updatedAt)) fail(`${path}.receipt.verifiedAt`)
    receipt = {
      status,
      blockNumber: matching(proof.blockNumber, /^(0|[1-9]\d{0,77})$/, `${path}.receipt.blockNumber`),
      blockHash: nonZero(matching(proof.blockHash, DIAG_HASH, `${path}.receipt.blockHash`), `${path}.receipt.blockHash`),
      verifiedAt,
    }
  } else if (row.receipt !== null) fail(`${path}.receipt`)
  return {
    claimId: matching(row.claimId, DIAG_LABEL, `${path}.claimId`),
    stage,
    transactionDigest: matching(row.transactionDigest, DIAG_DIGEST, `${path}.transactionDigest`),
    status,
    txHash,
    createdAt,
    updatedAt,
    receipt,
  }
}

/**
 * Validates GET /api/v1/admin/stocks/wallet-submissions/:side/:orderId data for exactly the requested order and side.
 * `observedAt` is the envelope's server snapshot time: nothing in the snapshot may be later than it.
 */
export function parseSubmissionDiagnostics(data: unknown, expected: { readonly side: "BUY" | "SELL"; readonly orderId: string; readonly observedAt: string }): SubmissionDiagnostics {
  const root = record(data, "data")
  exactKeys(root, ["deploymentId", "deploymentDigest", "order", "enrollment", "intentKey", "approval", "transfer", "readOnly", "executionAuthorization", "resubmissionAllowed"], "data")
  // The server states this diagnostic grants nothing; anything else is not the reviewed contract.
  if (root.readOnly !== true) fail("data.readOnly")
  if (root.executionAuthorization !== false) fail("data.executionAuthorization")
  if (root.resubmissionAllowed !== false) fail("data.resubmissionAllowed")
  const order = record(root.order, "data.order")
  exactKeys(order, ["id", "side", "state", "wallet", "version", "quoteExpiresAt", "quoteExpired"], "data.order")
  const orderSide = side(order.side, "data.order.side")
  if (orderSide !== expected.side) fail("data.order.side")
  if (order.id !== expected.orderId || typeof order.id !== "string" || !DIAG_LABEL.test(order.id)) fail("data.order.id")
  if (typeof order.state !== "string" || !DIAGNOSTIC_STATES[orderSide].includes(order.state)) fail("data.order.state")
  if (typeof order.version !== "number" || !Number.isSafeInteger(order.version) || order.version < 0) fail("data.order.version")
  const observedAt = isoTime(expected.observedAt, "$.observedAt")
  const quoteExpiresAt = isoTime(order.quoteExpiresAt, "data.order.quoteExpiresAt")
  if (typeof order.quoteExpired !== "boolean" || order.quoteExpired !== Date.parse(quoteExpiresAt) <= Date.parse(observedAt)) fail("data.order.quoteExpired")
  const enrollment = root.enrollment === "ENROLLED" || root.enrollment === "NOT_ENROLLED" ? root.enrollment : fail("data.enrollment")
  const intentKey = matching(root.intentKey, DIAG_DIGEST, "data.intentKey")
  const approval = submissionStage(root.approval, "APPROVAL", intentKey, "data.approval")
  const transfer = submissionStage(root.transfer, "TRANSFER", intentKey, "data.transfer")
  if (enrollment === "NOT_ENROLLED" && (approval !== null || transfer !== null)) fail("data.enrollment")
  if (approval && transfer && approval.claimId === transfer.claimId) fail("data.transfer.claimId")
  for (const [row, path] of [[approval, "data.approval"], [transfer, "data.transfer"]] as const) {
    if (row && Date.parse(row.updatedAt) > Date.parse(observedAt)) fail(`${path}.updatedAt`)
  }
  return {
    deploymentId: matching(root.deploymentId, DIAG_LABEL, "data.deploymentId"),
    deploymentDigest: matching(root.deploymentDigest, DIAG_DIGEST, "data.deploymentDigest"),
    order: {
      id: expected.orderId,
      side: orderSide,
      state: order.state,
      wallet: /^0x0{40}$/.test(String(order.wallet)) ? fail("data.order.wallet") : matching(order.wallet, DIAG_ADDRESS, "data.order.wallet"),
      version: order.version,
      quoteExpiresAt,
      quoteExpired: order.quoteExpired,
    },
    enrollment,
    intentKey,
    approval,
    transfer,
    readOnly: true,
    executionAuthorization: false,
    resubmissionAllowed: false,
  }
}
