// Operator-facing meaning of the server's state strings. Source of truth for the state sets:
// the CHECK constraints in prisma/migrations/20260916000000_stocks_testnet and
// 20260917000000_stocks_redemption. Unknown strings are never treated as terminal.
import type { OrderSide, ReconciliationStatus } from "./types"

export type StateCategory = "waiting" | "processing" | "unknown" | "attention" | "completed" | "closed" | "unrecognized"

type StateInfo = { readonly category: StateCategory; readonly description: string }

const BUY_STATES: Record<string, StateInfo> = {
  AWAITING_FUNDING: { category: "waiting", description: "Waiting for the buyer's test cash deposit." },
  FUNDED_QUOTE_EXPIRED: { category: "attention", description: "Funding was finalized after the quote deadline; the order is held." },
  FUNDING_REVIEW_REQUIRED: { category: "attention", description: "Funding evidence conflicts or does not match; held for review." },
  BROKER_PENDING: { category: "processing", description: "Mock broker order is pending." },
  BROKER_UNKNOWN: { category: "unknown", description: "Mock broker outcome is unknown. The original request is kept and only looked up, never resubmitted." },
  MINT_QUEUED: { category: "processing", description: "Mint operation is queued." },
  MINT_SUBMITTED: { category: "processing", description: "Mint transaction was submitted; waiting for its receipt." },
  MINT_FINALITY_PENDING: { category: "processing", description: "Mint was included; waiting for a finalized block." },
  MINT_UNKNOWN: { category: "unknown", description: "Mint outcome is unknown. The original operation is kept and only looked up, never resubmitted." },
  COMPLETED: { category: "completed", description: "Finalized mint recorded." },
  REFUNDED: { category: "closed", description: "Own-wallet funding was returned by a finalized refund." },
  REVIEW_REQUIRED: { category: "attention", description: "Unsupported or rejected result; held for operator review." },
}

const SELL_STATES: Record<string, StateInfo> = {
  AWAITING_ESCROW: { category: "waiting", description: "Waiting for the seller's stock escrow." },
  EXPIRED: { category: "closed", description: "Quantity reservation expired before escrow was observed." },
  ESCROW_HELD: { category: "processing", description: "Stock escrow is held; test cash liquidity not yet reserved." },
  ESCROW_REVIEW_REQUIRED: { category: "attention", description: "Escrow evidence did not match; held for review." },
  LIQUIDITY_PENDING: { category: "waiting", description: "Escrow held; waiting for enough test cash liquidity. No broker order yet." },
  SELL_BROKER_PENDING: { category: "processing", description: "Mock broker sell is pending." },
  SELL_BROKER_UNKNOWN: { category: "unknown", description: "Mock broker sell outcome is unknown. The original request is kept and only looked up, never resubmitted." },
  SELL_PARTIAL_HELD: { category: "attention", description: "Partial mock execution; stock custody and cash reservation stay held." },
  REDEEM_QUEUED: { category: "processing", description: "Atomic redemption (burn + payout) is queued." },
  RETURN_QUEUED: { category: "processing", description: "Return of the escrowed stock to the original payer is queued." },
  SETTLEMENT_PENDING: { category: "processing", description: "Redemption was submitted; waiting for finalized settlement." },
  SETTLEMENT_UNKNOWN: { category: "unknown", description: "Settlement outcome is unknown. The original operation is kept and only looked up, never resubmitted." },
  COMPLETED: { category: "completed", description: "Finalized redemption recorded." },
  RETURNED: { category: "closed", description: "Escrowed stock was returned by a finalized transaction." },
  REVIEW_REQUIRED: { category: "attention", description: "Held for operator review." },
}

export const BUY_STATE_ORDER = Object.keys(BUY_STATES)
export const SELL_STATE_ORDER = Object.keys(SELL_STATES)

export function stateInfo(side: OrderSide, state: string): StateInfo {
  const table = side === "BUY" ? BUY_STATES : SELL_STATES
  return Object.prototype.hasOwnProperty.call(table, state)
    ? table[state]
    : { category: "unrecognized", description: "This state is not in the reviewed contract; it is not treated as finished." }
}

export const CATEGORY_LABEL: Record<StateCategory, string> = {
  waiting: "Waiting",
  processing: "Processing",
  unknown: "Outcome unknown",
  attention: "Needs review",
  completed: "Completed",
  closed: "Closed",
  unrecognized: "Unrecognized",
}

export function isInProgress(category: StateCategory): boolean {
  return category !== "completed" && category !== "closed"
}

export function stateRank(side: OrderSide, state: string): number {
  const order = side === "BUY" ? BUY_STATE_ORDER : SELL_STATE_ORDER
  const index = order.indexOf(state)
  return index === -1 ? order.length : index
}

export const OPERATION_KIND_LABEL: Record<string, string> = {
  BROKER: "Mock broker buy",
  MINT: "Mint",
  REFUND: "Funding refund",
  SELL_BROKER: "Mock broker sell",
  REDEEM: "Redemption settlement",
  RETURN: "Escrow return",
}

export const OPERATION_STATUS: Record<string, { label: string; category: StateCategory }> = {
  PENDING: { label: "Queued", category: "waiting" },
  STARTED: { label: "Started", category: "processing" },
  SUBMITTED: { label: "Submitted — waiting for finality", category: "processing" },
  UNKNOWN: { label: "Outcome unknown — looked up by original identity, never resubmitted", category: "unknown" },
  DONE: { label: "Done", category: "completed" },
  REVIEW: { label: "Review required", category: "attention" },
}

export const FUNDING_STATUS: Record<string, { label: string; category: StateCategory }> = {
  ACCEPTED: { label: "Accepted for this order", category: "completed" },
  SUSPENSE: { label: "Suspense — not credited to the order", category: "attention" },
  REFUND_PENDING: { label: "Refund pending", category: "processing" },
  REFUNDED: { label: "Refunded", category: "closed" },
}

export const CUSTODY_STATUS: Record<string, { label: string; category: StateCategory }> = {
  HELD: { label: "Held in escrow", category: "processing" },
  RETURN_PENDING: { label: "Return pending", category: "processing" },
  REDEEM_PENDING: { label: "Redemption pending", category: "processing" },
  RETURNED: { label: "Returned to payer", category: "closed" },
  REDEEMED: { label: "Redeemed (burned)", category: "completed" },
}

export const RESERVATION_STATUS: Record<string, { label: string; category: StateCategory }> = {
  RESERVED: { label: "Reserved", category: "processing" },
  RELEASED: { label: "Released", category: "closed" },
  CONSUMED: { label: "Consumed by redemption", category: "completed" },
}

export function lookupStatus(
  table: Record<string, { label: string; category: StateCategory }>,
  status: string,
): { label: string; category: StateCategory } {
  return Object.prototype.hasOwnProperty.call(table, status) ? table[status] : { label: status, category: "unrecognized" }
}

export const RECONCILIATION_HEADLINE: Record<ReconciliationStatus, string> = {
  MATCHED_AT_CUTOFF: "Matched at the finalized cutoff block",
  MISMATCH: "Mismatch at the finalized cutoff block",
  UNAVAILABLE: "Reconciliation unavailable — no comparison was made",
  INCOMPLETE: "Reconciliation incomplete — no comparison was made",
}

export const RECONCILIATION_REASON: Record<string, string> = {
  NO_FINALIZED_OBSERVER_COVERAGE: "No trusted finalized observer coverage is connected to this server.",
  OBSERVER_DEPLOYMENT_OR_COVERAGE_MISSING: "Observer coverage is missing or belongs to a different deployment.",
  STALE_OR_INVALID_OBSERVER_COVERAGE: "Observer coverage is older than 60 seconds, too far in the future, or has an invalid time.",
  INVALID_CUTOFF: "The observer cutoff block number or hash is malformed.",
  FINALIZED_SNAPSHOT_UNVERIFIED: "The finalized chain snapshot could not be read or verified (RPC, network or code identity check).",
  CUTOFF_NOT_CANONICAL_FINALIZED: "The cutoff block is not canonical and finalized yet.",
}

export const PENDING_KIND_LABEL: Record<string, string> = {
  ORDER: "BUY order",
  SELL: "SELL order",
  FUNDING: "Funding",
  OUTBOX: "Operation",
  CUSTODY: "Escrow custody",
}
