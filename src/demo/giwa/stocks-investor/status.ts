// Server order states → what the investor is told. Only the server moves an order; nothing here
// infers failure or completion from time, and an *_UNKNOWN state is "checking", never failed.

import type { BuyOrderState, SellOrderState, StocksOrder, StocksPendingOrder } from "./types"

export type OrderStatusCategory =
  | "ACTION_REQUIRED"
  | "DEADLINE_PASSED"
  | "PROCESSING"
  | "CHECKING_RESULT"
  | "LIQUIDITY_PENDING"
  | "REVIEW_REQUIRED"
  | "COMPLETED"
  | "RETURNED"
  | "EXPIRED"

export type OrderStatusMeaning = { label: string; category: OrderStatusCategory; detail: string; terminal: boolean }

const BUY: Record<BuyOrderState, OrderStatusMeaning> = {
  AWAITING_FUNDING: { label: "Awaiting funding", category: "ACTION_REQUIRED", detail: "The order waits for an exact deposit from the ordering wallet before the quote deadline.", terminal: false },
  FUNDED_QUOTE_EXPIRED: { label: "Funded after quote deadline", category: "REVIEW_REQUIRED", detail: "The payment was included after the quote deadline. It is held for review; nothing was bought.", terminal: false },
  FUNDING_REVIEW_REQUIRED: { label: "Funding under review", category: "REVIEW_REQUIRED", detail: "The payment did not match this order exactly. It is held for review.", terminal: false },
  BROKER_PENDING: { label: "Broker processing", category: "PROCESSING", detail: "Funding is confirmed. The mock broker is processing the order.", terminal: false },
  BROKER_UNKNOWN: { label: "Checking broker result", category: "CHECKING_RESULT", detail: "The broker result is being confirmed. This is not a failure, and the order is not resubmitted.", terminal: false },
  MINT_QUEUED: { label: "Mint queued", category: "PROCESSING", detail: "The fill is recorded and the test units are queued for issuance.", terminal: false },
  MINT_SUBMITTED: { label: "Mint submitted", category: "PROCESSING", detail: "The issuance transaction was sent to GIWA. The units count once GIWA confirms it.", terminal: false },
  MINT_FINALITY_PENDING: { label: "Confirming on GIWA", category: "PROCESSING", detail: "The issuance transaction is waiting for GIWA confirmation.", terminal: false },
  MINT_UNKNOWN: { label: "Checking mint result", category: "CHECKING_RESULT", detail: "The issuance result is being confirmed. This is not a failure, and nothing is submitted again.", terminal: false },
  COMPLETED: { label: "Completed", category: "COMPLETED", detail: "The test units are issued to the ordering wallet.", terminal: true },
  REFUNDED: { label: "Refunded", category: "RETURNED", detail: "The test cash was returned to the ordering wallet.", terminal: true },
  REVIEW_REQUIRED: { label: "Operations review required", category: "REVIEW_REQUIRED", detail: "Operations must review this order. No automatic retry or refund is assumed.", terminal: false },
}

const SELL: Record<SellOrderState, OrderStatusMeaning> = {
  AWAITING_ESCROW: { label: "Awaiting escrow", category: "ACTION_REQUIRED", detail: "The order waits for an exact escrow from the ordering wallet before the quote deadline.", terminal: false },
  EXPIRED: { label: "Expired", category: "EXPIRED", detail: "No escrow was observed before the quote deadline. The reservation was released.", terminal: false },
  ESCROW_HELD: { label: "Escrow held", category: "PROCESSING", detail: "The escrowed units are recorded. Payout liquidity is being reserved.", terminal: false },
  ESCROW_REVIEW_REQUIRED: { label: "Escrow under review", category: "REVIEW_REQUIRED", detail: "The escrow did not match this order exactly. The units are held for review.", terminal: false },
  LIQUIDITY_PENDING: { label: "Waiting for liquidity", category: "LIQUIDITY_PENDING", detail: "Payout cash is not yet available. The escrowed units stay held; nothing is sold yet.", terminal: false },
  SELL_BROKER_PENDING: { label: "Broker processing", category: "PROCESSING", detail: "The mock broker is processing the sale.", terminal: false },
  SELL_BROKER_UNKNOWN: { label: "Checking broker result", category: "CHECKING_RESULT", detail: "The broker result is being confirmed. This is not a failure, and the order is not resubmitted.", terminal: false },
  SELL_PARTIAL_HELD: { label: "Partial execution held", category: "REVIEW_REQUIRED", detail: "The broker reported a partial result. Units and cash stay held for review.", terminal: false },
  REDEEM_QUEUED: { label: "Settlement queued", category: "PROCESSING", detail: "The sale is recorded and settlement is queued.", terminal: false },
  RETURN_QUEUED: { label: "Return queued", category: "PROCESSING", detail: "The escrowed units are queued to return to the ordering wallet.", terminal: false },
  SETTLEMENT_PENDING: { label: "Settlement pending", category: "PROCESSING", detail: "The payout transaction is waiting for GIWA confirmation.", terminal: false },
  SETTLEMENT_UNKNOWN: { label: "Checking settlement result", category: "CHECKING_RESULT", detail: "The settlement result is being confirmed. This is not a failure, and nothing is submitted again.", terminal: false },
  COMPLETED: { label: "Completed", category: "COMPLETED", detail: "The units were redeemed and the test cash was paid out to the ordering wallet.", terminal: true },
  RETURNED: { label: "Returned", category: "RETURNED", detail: "The escrowed units were returned to the ordering wallet.", terminal: true },
  REVIEW_REQUIRED: { label: "Operations review required", category: "REVIEW_REQUIRED", detail: "Operations must review this order. No automatic retry or return is assumed.", terminal: false },
}

/**
 * The server keeps a BUY order in AWAITING_FUNDING (and a SELL order in AWAITING_ESCROW until an
 * expiry job runs) after its quote deadline. Past the deadline, by the server's own clock
 * (`observedAt` of the response that carried the order), the order must not be funded or escrowed:
 * a late payment or escrow is held for review, not executed.
 */
export function deadlinePassed(order: Pick<StocksOrder, "state" | "quoteExpiresAt">, observedAt: string | null): boolean {
  if (observedAt === null || (order.state !== "AWAITING_FUNDING" && order.state !== "AWAITING_ESCROW")) return false
  const observed = Date.parse(observedAt)
  const deadline = Date.parse(order.quoteExpiresAt)
  return Number.isFinite(observed) && Number.isFinite(deadline) && observed >= deadline
}

export function orderStatusMeaning(order: Pick<StocksOrder | StocksPendingOrder, "side" | "state">, observedAt: string | null = null): OrderStatusMeaning {
  if ("quoteExpiresAt" in order && typeof order.quoteExpiresAt === "string" && deadlinePassed(order as Pick<StocksOrder, "state" | "quoteExpiresAt">, observedAt)) {
    return order.side === "SELL"
      ? { label: "Escrow deadline passed", category: "DEADLINE_PASSED", detail: "The quote deadline for this order has passed. Do not escrow units for it: a late escrow is held for review, not sold.", terminal: false }
      : { label: "Funding deadline passed", category: "DEADLINE_PASSED", detail: "The quote deadline for this order has passed. Do not send test cash for it: a late payment is held for review, and nothing is bought.", terminal: false }
  }
  return order.side === "SELL" ? SELL[order.state as SellOrderState] : BUY[order.state as BuyOrderState]
}

export type ChipTone = "neutral" | "strong" | "attention" | "positive"

/** One colour meaning everywhere: review and waiting states are never shown as failure. */
export const CATEGORY_TONE: Record<OrderStatusCategory, ChipTone> = {
  ACTION_REQUIRED: "strong",
  DEADLINE_PASSED: "attention",
  PROCESSING: "neutral",
  CHECKING_RESULT: "neutral",
  LIQUIDITY_PENDING: "attention",
  REVIEW_REQUIRED: "attention",
  COMPLETED: "positive",
  RETURNED: "neutral",
  EXPIRED: "neutral",
}
