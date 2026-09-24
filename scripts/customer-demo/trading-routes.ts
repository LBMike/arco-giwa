// Transport validation only. The existing backend owns eligibility, order state,
// idempotency and receipt verification; this module never grants permission to sign.
type WriteKind = "quote" | "order" | "claim" | "outcome" | "reconcile"
const prefix = "/api/v1/stocks/"
const label = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value)
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const address = (value: unknown) => typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value)
const hash = (value: unknown) => typeof value === "string" && /^0x[a-f0-9]{64}$/.test(value) && !/^0x0{64}$/.test(value)
const stage = (value: unknown) => value === "APPROVAL" || value === "TRANSFER"

export function tradingRead(path: string, method: string): boolean {
  return method === "GET" && (path === `${prefix}execution/deployment`
    || /^\/api\/v1\/stocks\/(execution|wallet-submissions)\/(BUY|SELL)\/[A-Za-z0-9:_-]{1,128}$/.test(path))
}

export function tradingWrite(path: string, method: string): WriteKind | null {
  if (method !== "POST") return null
  if (path === `${prefix}quotes` || path === `${prefix}sell-quotes`) return "quote"
  if (["orders", "sell-orders", "orders/recover", "sell-orders/recover"].some(route => path === prefix + route)) return "order"
  if (path === `${prefix}wallet-submissions/claims`) return "claim"
  if (path === `${prefix}wallet-submissions/outcomes`) return "outcome"
  if (path === `${prefix}wallet-submissions/reconcile`) return "reconcile"
  return null
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_CUSTOMER_TRADE")
  return value as Record<string, unknown>
}
function exact(row: Record<string, unknown>, keys: string[]) {
  return Object.keys(row).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(row, key))
}

/** Reject unexpected fields before they can leave the customer's computer. */
export function tradingBody(text: string, kind: WriteKind): string {
  if (Buffer.byteLength(text) > (kind === "claim" ? 8192 : 4096)) throw new Error("INVALID_CUSTOMER_TRADE")
  const row = object(JSON.parse(text))
  let valid = false
  if (kind === "quote") valid = exact(row, ["symbol", "quantity"]) && row.symbol === "NVDA"
    && typeof row.quantity === "string" && /^(0|[1-9][0-9]{0,29})(\.[0-9]{1,9})?$/.test(row.quantity)
  else if (kind === "order") valid = exact(row, ["quoteId", "idempotencyKey"]) && label(row.quoteId)
    && typeof row.idempotencyKey === "string" && /^[A-Za-z0-9:_-]{8,128}$/.test(row.idempotencyKey)
  else if (kind === "claim") {
    const tx = object(row.transaction)
    valid = exact(row, ["side", "orderId", "intentKey", "stage", "transactionDigest", "transaction", "deploymentDigest"])
      && (row.side === "BUY" || row.side === "SELL") && label(row.orderId) && digest(row.intentKey)
      && stage(row.stage) && digest(row.transactionDigest) && digest(row.deploymentDigest)
      && exact(tx, ["chainId", "from", "to", "data", "value"]) && tx.chainId === 91342 && tx.value === "0"
      && address(tx.from) && address(tx.to) && typeof tx.data === "string" && /^0x(?:[a-fA-F0-9]{2}){4,2048}$/.test(tx.data)
  } else {
    const hasHash = Object.prototype.hasOwnProperty.call(row, "txHash")
    valid = exact(row, ["claimId", "intentKey", "stage", "transactionDigest", ...(kind === "outcome" ? ["status"] : []), ...(kind === "reconcile" || hasHash ? ["txHash"] : [])])
      && label(row.claimId) && digest(row.intentKey) && stage(row.stage) && digest(row.transactionDigest)
      && (kind === "reconcile" ? hash(row.txHash) : (row.status === "UNKNOWN" || row.status === "SUBMITTED")
        && (!hasHash || hash(row.txHash)) && (row.status !== "SUBMITTED" || hasHash))
  }
  if (!valid) throw new Error("INVALID_CUSTOMER_TRADE")
  return JSON.stringify(row)
}
