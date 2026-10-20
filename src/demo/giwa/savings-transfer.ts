// The Savings deposit / withdraw screens' rules, kept pure so they can be tested without a wallet: how a typed amount
// is cleaned, what the percent shortcuts fill in, and what the main button says and does for the wallet's state.
// The wording and order match the invest panel on the product page (components.tsx primaryActionLabel).

import { formatUnits, parseUnits } from "viem"
import type { GiwaRedemption, UiPhase } from "./types"

export type TransferMode = "deposit" | "withdraw"

/** The phases while a transaction the user started is still in flight. */
export const BUSY_PHASES: readonly UiPhase[] = ["approving", "simulating", "submitting", "confirming"]

/**
 * Commas as the user meant them. With a point present, commas group thousands ("1,000.5"). A single comma followed by
 * exactly three digits groups thousands too ("1,000"); any other single comma is a decimal comma ("1,5", typed on a
 * keypad set to a decimal-comma locale). Several commas group thousands ("1,000,000").
 */
function normalizeSeparators(raw: string): string {
  const text = raw.replace(/\s/g, "")
  if (text.includes(".")) return text.replace(/,/g, "")
  const first = text.indexOf(",")
  if (first !== -1 && first === text.lastIndexOf(",")) {
    return text.length - first - 1 === 3 ? text.replace(",", "") : text.replace(",", ".")
  }
  return text.replace(/,/g, "")
}

/** Keeps a decimal the input can hold: digits and one point, at most `decimals` places, no leading zeros. */
export function sanitizeAmountInput(raw: string, decimals: number): string {
  const cleaned = normalizeSeparators(raw).replace(/[^\d.]/g, "")
  const point = cleaned.indexOf(".")
  let whole = point === -1 ? cleaned : cleaned.slice(0, point)
  let fraction = point === -1 ? null : cleaned.slice(point + 1).replace(/\./g, "")
  whole = whole.replace(/^0+(?=\d)/, "")
  if (fraction !== null && decimals > 0) {
    fraction = fraction.slice(0, Math.max(0, decimals))
    return `${whole === "" ? "0" : whole}.${fraction}`
  }
  return whole
}

/** Parses a human amount into base units; null when it is not a plain non-negative number ("--", "", "1."). */
export function toBaseUnits(value: string, decimals: number): bigint | null {
  const trimmed = value.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  try {
    return parseUnits(trimmed, decimals)
  } catch {
    return null
  }
}

/** True when the amount is more than the balance. Compared in base units, so MAX is never "over". */
export function exceedsBalance(amount: string, balance: string, decimals: number): boolean {
  const wanted = toBaseUnits(amount, decimals)
  const held = toBaseUnits(balance, decimals)
  if (wanted === null || held === null) return false
  return wanted > 0n && wanted > held
}

function trimDecimal(value: string, maxDecimals: number): string {
  const [whole, fraction = ""] = value.split(".")
  const cut = fraction.slice(0, maxDecimals).replace(/0+$/, "")
  return cut === "" ? whole : `${whole}.${cut}`
}

/**
 * The amount for a share of the balance (25 → a quarter). 100 gives the balance exactly, so MAX can spend all of it;
 * smaller shares are cut to `displayDecimals`. "" when the balance is unknown or empty.
 */
export function amountForPercent(balance: string, percent: number, decimals: number, displayDecimals = 6): string {
  const held = toBaseUnits(balance, decimals)
  if (held === null || held === 0n || !(percent > 0)) return ""
  if (percent >= 100) return balance.trim()
  const share = (held * BigInt(Math.round(percent * 100))) / 10_000n
  if (share === 0n) return ""
  return trimDecimal(formatUnits(share, decimals), displayDecimals)
}

/** Where the amount sits on the 0–100 slider. */
export function percentOfBalance(amount: string, balance: string, decimals: number): number {
  const wanted = toBaseUnits(amount, decimals)
  const held = toBaseUnits(balance, decimals)
  if (wanted === null || held === null || held === 0n) return 0
  if (wanted >= held) return 100
  return Number((wanted * 10_000n) / held) / 100
}

export type TransferAction = "connect" | "switch-network" | "faucet" | "review"

export type TransferCta = Readonly<{ label: string; action: TransferAction | null; disabled: boolean }>

/**
 * The main button, on the amount screen and again when Confirm is pressed. Prerequisites first, then the amount, then
 * Review. `synced` is false while the operation hook does not yet hold this screen's operation (it is only switched
 * once no earlier transaction is in flight), so nothing can be sent with another operation's decimals.
 */
export function transferCta({
  phase,
  amount,
  balance,
  decimals,
  paused,
  synced = true,
}: {
  phase: UiPhase
  amount: string
  balance: string
  decimals: number
  paused: boolean
  synced?: boolean
}): TransferCta {
  if (phase === "disconnected") return { label: "Connect Wallet", action: "connect", disabled: false }
  if (phase === "wrong-network") return { label: "Switch to GIWA", action: "switch-network", disabled: false }
  if (phase === "missing-gas") return { label: "Get GIWA ETH", action: "faucet", disabled: false }
  if (phase === "missing-payment-token") return { label: "Payment token missing", action: null, disabled: true }
  if (phase === "loading-registry") return { label: "Loading…", action: null, disabled: true }
  if (BUSY_PHASES.includes(phase) || !synced) return { label: "Processing the transaction", action: null, disabled: true }
  if (paused) return { label: "Temporarily unavailable", action: null, disabled: true }
  const wanted = toBaseUnits(amount, decimals)
  if (wanted === null || wanted === 0n) return { label: "Enter an Amount", action: null, disabled: true }
  if (exceedsBalance(amount, balance, decimals)) return { label: "Insufficient Balance", action: null, disabled: true }
  return { label: "Review", action: "review", disabled: false }
}

/** True when the operation hook holds an operation of this screen's kind (a deposit, or an instant / requested redeem). */
export function operationMatchesMode(operation: string, mode: TransferMode): boolean {
  return mode === "deposit" ? operation === "deposit" : operation === "redeemInstant" || operation === "requestRedeem"
}

const PENDING_STATUSES = new Set(["REQUESTED", "SETTLING"])

/**
 * This product's withdrawals still waiting for their payout. With a redemption vault, only those requested from it: a
 * Savings vault paid out in another coin through a route has a redemption vault per coin, and a row is shown with the
 * coin it pays out in (a row that names no vault is kept).
 */
export function pendingWithdrawals(rows: readonly GiwaRedemption[], productId: string, redemptionVault?: string | null): GiwaRedemption[] {
  // Rows come from the indexer API: read defensively, a row without a product or status is not shown.
  const wanted = productId.toLowerCase()
  const vault = redemptionVault?.toLowerCase() ?? null
  return rows.filter(
    (row) =>
      String(row.productId ?? "").toLowerCase() === wanted &&
      PENDING_STATUSES.has(String(row.status ?? "").toUpperCase()) &&
      (vault === null || !row.redemptionVaultAddress || String(row.redemptionVaultAddress).toLowerCase() === vault),
  )
}

/** The expected settlement time of a withdrawal request, as the product page words it. */
export function redemptionTimelineText(days: number | null | undefined): string {
  return days != null ? `${days} Days` : "30-90 Business Days"
}
