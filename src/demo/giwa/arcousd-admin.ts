import type { GiwaArcoUSDQueue, GiwaArcoUSDReserve } from "./types"

// Pure helpers for the admin ArcoUSD page (AdminArcoUSD.tsx): number formatting, the gate and
// pause readouts, and the queue head's "can it be paid now" verdict. No React, no I/O.

export type ArcoUSDAdminTab = "overview" | "queue" | "flows"
export const ARCOUSD_ADMIN_TABS: readonly { id: ArcoUSDAdminTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "queue", label: "Queue" },
  { id: "flows", label: "Flows" },
]

export function arcoUSDAdminTab(value: string | null): ArcoUSDAdminTab {
  return value === "queue" || value === "flows" ? value : "overview"
}

/** "$1,234.56" from a decimal string (max 2 decimals, no forced trailing zeros); "—" when not a number. */
export function usdText(value: string | number | null | undefined): string {
  const amount = typeof value === "number" ? value : Number(value)
  if (value === null || value === undefined || value === "" || !Number.isFinite(amount)) return "—"
  const sign = amount < 0 ? "-" : ""
  return `${sign}$${Math.abs(amount).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
}

/** Axis labels: "$950", "$12.5K", "$28.53M", "$1.2B" (max 2 decimals). */
export function usdCompact(value: number): string {
  if (!Number.isFinite(value)) return "—"
  const abs = Math.abs(value)
  const sign = value < 0 ? "-" : ""
  const [scaled, unit] = abs >= 1e9 ? [abs / 1e9, "B"] : abs >= 1e6 ? [abs / 1e6, "M"] : abs >= 1e3 ? [abs / 1e3, "K"] : [abs, ""]
  return `${sign}$${Number(scaled.toFixed(2))}${unit}`
}

/** "1,234.5" (max 2 decimals by default); "—" when not a number. */
export function amountText(value: string | number | null | undefined, maxDecimals = 2): string {
  const amount = typeof value === "number" ? value : Number(value)
  if (value === null || value === undefined || value === "" || !Number.isFinite(amount)) return "—"
  return amount.toLocaleString("en-US", { maximumFractionDigits: maxDecimals })
}

/** "50%" from basis points (max 2 decimals). */
export function bpsText(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return "—"
  return `${Number((bps / 100).toFixed(2))}%`
}

/** "2d 4h", "3h 20m", "12m", "45s". */
export function durationText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—"
  const s = Math.floor(seconds)
  const days = Math.floor(s / 86_400)
  const hours = Math.floor((s % 86_400) / 3_600)
  const minutes = Math.floor((s % 3_600) / 60)
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${s}s`
}

/** "1 buy" / "3 buys". */
export function countText(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`
}

export function shortAddress(address: string | null | undefined): string {
  return address && address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : (address ?? "—")
}

const GATE_REASON: Record<string, string> = {
  "not-deployed": "ArcoUSD is not deployed",
  "read-failed": "The reserve could not be read",
  "settlement-paused": "Settlement is paused (Reserve, settleFor, ArcoUSD or burn)",
  "buy-paused": "Buys are paused (Router, deposit or mint)",
  "mint-cap": "Less than one threshold-sized buy left under the mint cap",
  "insufficient-buffer": "The settlement buffer is below the threshold",
  "asset-missing": "The gate asset is not a Reserve asset",
  "config-invalid": "The buy gate setting is invalid (ARCOUSD_BUY_GATE_*)",
}

/** Gate status line: "Open", "Closed: <why>", "Inactive". */
export function gateText(gate: GiwaArcoUSDReserve["gate"]): { status: "open" | "closed" | "inactive"; label: string; detail: string | null } {
  if (gate.status === "open") return { status: "open", label: "Open", detail: null }
  if (gate.status === "inactive") return { status: "inactive", label: "Inactive", detail: GATE_REASON["not-deployed"] }
  return { status: "closed", label: "Closed", detail: gate.reason ? (GATE_REASON[gate.reason] ?? gate.reason) : null }
}

export type PauseRow = { readonly label: string; readonly paused: boolean; readonly effect: string }

/** Every pause on the buy and settlement path, in the order a buy meets them. */
export function pauseRows(reserve: NonNullable<GiwaArcoUSDReserve["reserve"]>): PauseRow[] {
  return [
    { label: "Router buy", paused: reserve.routerPaused, effect: "Fund buys through the Router" },
    { label: "Reserve deposit", paused: reserve.depositPaused, effect: "Stablecoin deposits and stablecoin-paid buys" },
    { label: "ArcoUSD mint", paused: reserve.arcoUSDMintPaused, effect: "Deposits (mint) and stablecoin-paid buys" },
    { label: "Reserve settleFor", paused: reserve.settlementPaused, effect: "Every fund buy" },
    { label: "ArcoUSD burn", paused: reserve.arcoUSDBurnPaused, effect: "Settlement and queue payouts" },
    { label: "Reserve (all)", paused: reserve.reservePaused, effect: "Every Reserve function except cancel" },
    { label: "ArcoUSD (all)", paused: reserve.arcoUSDPaused, effect: "Mint and burn (transfers continue)" },
  ]
}

/** Room left under the mint cap in USD (liabilities = ArcoUSD supply); null when unreadable. */
export function mintHeadroomUsd(reserve: NonNullable<GiwaArcoUSDReserve["reserve"]>): number | null {
  try {
    const left = BigInt(reserve.mintCap) - BigInt(reserve.totalLiabilities)
    return Number(left) / 1e18
  } catch {
    return null
  }
}

export type HeadVerdict =
  | { readonly kind: "empty" }
  | { readonly kind: "paused" }
  | { readonly kind: "payable" }
  | { readonly kind: "waiting-delay"; readonly until: string }
  | { readonly kind: "waiting-liquidity"; readonly shortBy: string }
  | { readonly kind: "unknown" }

/**
 * Whether processQueue would pay the head now. It pays from the Reserve's whole BALANCE of the
 * asset (not `available`, which already subtracts the queue itself), once the head is past
 * queueMinDelay, and nothing it calls is paused (the Reserve, or ArcoUSD itself / its burn: a payout
 * burns the escrow). The server's process-queue preview is the authoritative answer.
 */
export function headVerdict(
  summary: GiwaArcoUSDQueue["assets"][number],
  reserveAssets: readonly { address: string; balance: string; decimals: number }[],
  now: number,
  paused = false,
): HeadVerdict {
  if (!summary.head) return { kind: "empty" }
  if (paused) return { kind: "paused" }
  if (Date.parse(summary.head.eligibleAt) > now) return { kind: "waiting-delay", until: summary.head.eligibleAt }
  const asset = reserveAssets.find((item) => item.address.toLowerCase() === summary.asset.toLowerCase())
  if (!asset) return { kind: "unknown" }
  try {
    const balance = BigInt(asset.balance)
    const head = BigInt(summary.head.assetAmount)
    if (balance >= head) return { kind: "payable" }
    const short = Number(head - balance) / 10 ** asset.decimals
    return { kind: "waiting-liquidity", shortBy: amountText(short) }
  } catch {
    return { kind: "unknown" }
  }
}

export const QUEUE_FILTERS: readonly { id: GiwaArcoUSDQueue["filter"]; label: string }[] = [
  { id: "open", label: "Open (queued + failed)" },
  { id: "QUEUED", label: "Queued" },
  { id: "PAYOUT_FAILED", label: "Payout failed" },
  { id: "PAID", label: "Paid" },
  { id: "CANCELLED", label: "Cancelled" },
  { id: "all", label: "All" },
]

export function queueFilter(value: string | null): GiwaArcoUSDQueue["filter"] {
  return QUEUE_FILTERS.some((filter) => filter.id === value) ? (value as GiwaArcoUSDQueue["filter"]) : "open"
}

export const FLOW_WINDOWS = [7, 30, 90] as const

/** processQueue batch size from a text field: 1..50, else null. */
export function batchSize(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const count = Number(value.trim())
  return count >= 1 && count <= 50 ? count : null
}

const EVENT_LABEL: Record<string, string> = {
  Deposited: "Deposit",
  RedeemedInstant: "Instant redemption",
  RedeemQueued: "Redemption queued",
  RedeemPaid: "Queue payout",
  RedeemPayoutFailed: "Payout failed",
  RedeemCancelled: "Redemption cancelled",
  SettledFor: "Fund settlement",
  Bought: "Router buy",
  Allocated: "MMF allocation",
  RecalledInstant: "MMF recall (instant)",
  RecallRequested: "MMF recall requested",
  RecallClaimed: "MMF recall claimed",
  RecallAcknowledged: "MMF recall acknowledged",
}

export function eventLabel(name: string): string {
  return EVENT_LABEL[name] ?? name
}
