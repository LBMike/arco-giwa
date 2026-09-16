// Display text for the Stocks investor module. Exact values only: settlement amounts are never
// rounded, because a rounded deposit or escrow amount would be a different amount.

import { formatBaseUnits, formatHumanDecimal, formatSignedBaseUnits } from "./decimal"
import type { FeatureError, TradeBlock } from "./controller"
import type { SignedOutReason } from "./session"
import { STOCKS_CASH_SCALE, STOCKS_QUANTITY_SCALE, type BaseUnits, type StocksCashSymbol } from "./types"

export function formatQuantity(value: BaseUnits): string {
  return formatBaseUnits(value, STOCKS_QUANTITY_SCALE, { group: true })
}

/** Holdings can report a deficit (negative wallet or available quantity); render it exactly, signed. */
export function formatSignedQuantity(value: string): string {
  return formatSignedBaseUnits(value, STOCKS_QUANTITY_SCALE, { group: true })
}

export function formatCash(value: BaseUnits): string {
  return formatBaseUnits(value, STOCKS_CASH_SCALE, { group: true })
}

export function formatPrice(value: string): string {
  return formatHumanDecimal(value, { group: true })
}

export function cashLabel(symbol: StocksCashSymbol): string {
  return symbol === "ARCO_TEST_USDC" ? "ARCO_TEST_USDC (test cash)" : "ARCO_TEST_RLUSD (test cash)"
}

/** Absolute UTC, second precision: "2026-09-17 01:02:03 UTC". */
export function formatUtc(iso: string): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return iso
  return `${new Date(time).toISOString().slice(0, 19).replace("T", " ")} UTC`
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}

export function signedOutMessage(reason: SignedOutReason): string {
  switch (reason) {
    case "WALLET_MISMATCH":
      return "The connected wallet is not the wallet this session was verified for. Sign in again with the connected wallet."
    case "CHAIN_MISMATCH":
      return "Switch the connected wallet to GIWA Sepolia (chain 91342) to use this verified session."
    case "INVALID_SESSION":
      return "The sign-in session is not valid for GIWA Stocks. Sign in again with your wallet signature."
    default:
      return "Sign in with your wallet signature to request quotes, place orders and view Stocks holdings. Connecting a wallet alone does not sign you in."
  }
}

export function tradeBlockMessage(block: Exclude<TradeBlock, null>): string {
  switch (block) {
    case "NO_CLIENT":
      return "The Stocks API is not configured for this app."
    case "CATALOG_NOT_READY":
      return "Trading is available once the Stocks catalog has loaded."
    case "NOT_ACTIVATED":
      return "Stocks trading is not activated on this server. Quotes and orders are unavailable."
    case "SIGNED_OUT":
      return "Sign in with your wallet signature to trade."
    case "AUTH_REJECTED":
      return "The server did not accept this sign-in session. Sign in again to continue."
    case "ATTEMPT_UNRESOLVED":
      return "Resolve the order request below before starting another."
    case "ATTEMPT_OPEN":
      return "Your order is shown below."
  }
}

const REFUSED: Record<string, string> = {
  STOCKS_PAUSED: "Trading is paused. No quote or order was created.",
  STOCKS_NOT_ACTIVATED: "Stocks trading is not activated on this server. No quote or order was created.",
  VAULT_ALREADY_BOUND_TO_OTHER_DEPLOYMENT: "The Stocks deployment is unavailable. No quote or order was created.",
  INVALID_DECIMAL: "Enter the quantity as a plain decimal number, for example 0.5.",
  EXCESS_PRECISION: "Use at most 9 decimal places.",
  AMOUNT_BOUNDS: "This quantity is outside the accepted range.",
  ZERO_SELL_PAYOUT: "This quantity is too small: the sale would pay out zero test cash.",
  UNSUPPORTED_SYMBOL: "This stock is not available for orders.",
  QUOTE_NOT_FOUND: "This quote is no longer available. No order was created.",
  QUOTE_EXPIRED_OR_DEPLOYMENT_CHANGED: "The quote expired, or the deployment changed, before the order was accepted. No order was created.",
  QUOTE_ALREADY_USED: "This quote was already used for another order. No new order was created.",
  IDEMPOTENCY_CONFLICT: "This request key was already used for a different quote. No new order was created.",
  INSUFFICIENT_AVAILABLE_STOCK: "Not enough available NVDA units. Reserved and escrowed units cannot be sold again.",
  INVALID_ORDER_REQUEST: "The order request was not accepted. No order was created.",
  INVALID_BODY: "The request was not accepted.",
  UNEXPECTED_FIELDS: "The request was not accepted.",
  ORDER_NOT_FOUND: "This order was not found for the signed-in wallet.",
  SELL_ORDER_NOT_FOUND: "This order was not found for the signed-in wallet.",
  INTERNAL_ERROR: "The server reported an internal error.",
}

/**
 * Error text for an order attempt. A refusal of a retry may say nothing about an earlier send whose
 * outcome is unknown, so "no order was created" is only said when it is proven for this request key.
 */
export function attemptErrorMessage(error: FeatureError, outcomeUnknown: boolean): string {
  if (error.kind === "NETWORK") return error.code === "TIMEOUT" ? "No answer was received from the Stocks API in time." : "No answer was received from the Stocks API."
  if (error.kind === "INVALID_RESPONSE") return "The server's answer could not be read as a Stocks response."
  if (!outcomeUnknown) return errorMessage(error)
  switch (error.kind) {
    case "REFUSED":
      if (error.code === "STOCKS_PAUSED") return "Trading is paused, so this retry was not processed. The earlier request may still have created the order."
      if (error.code === "STOCKS_NOT_ACTIVATED" || error.code === "VAULT_ALREADY_BOUND_TO_OTHER_DEPLOYMENT") return "Stocks trading is unavailable, so this retry was not processed. The earlier request may still have created the order."
      if (error.code === "IDEMPOTENCY_CONFLICT") return "The server already holds a request with this key. Check your orders before doing anything else."
      if (error.code === "INTERNAL_ERROR") return "The server reported an internal error. The request may still have created the order."
      return `The server refused this retry (${error.code ?? error.status ?? "unknown"}). The earlier request may still have created the order.`
    case "NOT_REGISTERED":
      return "The Stocks API is not available right now, so this retry was not processed. The earlier request may still have created the order."
    case "UNAUTHORIZED":
      return "The sign-in session was not accepted, so this retry was not processed. The earlier request may still have created the order."
    case "MISMATCH":
      return "The server's answer did not match this request, so it was not used. The request may still have created the order."
    default:
      return errorMessage(error)
  }
}

export function errorMessage(error: FeatureError): string {
  switch (error.kind) {
    case "NETWORK":
      return error.code === "TIMEOUT" ? "The Stocks API did not answer in time." : "The Stocks API could not be reached."
    case "NOT_REGISTERED":
      return "Stocks trading is not available on this server."
    case "INVALID_RESPONSE":
      return "The server's answer was not a valid Stocks response, so it was not used."
    case "UNAUTHORIZED":
      return "The server did not accept this sign-in session. Sign in again."
    case "MISMATCH":
      return error.code === "DEPLOYMENT_CHANGED"
        ? "The Stocks deployment changed. The catalog is being reloaded."
        : "The server's answer did not match this request or wallet, so it was not used."
    case "LOCAL":
      return "The order request could not be prepared safely. Nothing was sent."
    case "REFUSED":
      return (error.code && REFUSED[error.code]) ?? `The server refused the request (${error.code ?? error.status ?? "unknown"}).`
  }
}
