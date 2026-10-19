import type {
  GiwaArcoUSDAlert,
  GiwaArcoUSDAlertDelivery,
  GiwaArcoUSDAlerts,
  GiwaArcoUSDKeeper,
  GiwaArcoUSDKeeperReport,
  GiwaArcoUSDQueue,
  GiwaArcoUSDReserve,
  GiwaArcoUSDSavingsState,
} from "./types"

// Pure helpers for the admin ArcoUSD page (AdminArcoUSD.tsx): number formatting, the gate and
// pause readouts, and the queue head's "can it be paid now" verdict. No React, no I/O.

export type ArcoUSDAdminTab = "overview" | "queue" | "flows" | "savings"
export const ARCOUSD_ADMIN_TABS: readonly { id: ArcoUSDAdminTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "queue", label: "Queue" },
  { id: "flows", label: "Flows" },
  { id: "savings", label: "Savings" },
]

export function arcoUSDAdminTab(value: string | null): ArcoUSDAdminTab {
  return value === "queue" || value === "flows" || value === "savings" ? value : "overview"
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

/** Every pause on the buy and settlement path, in the order a buy meets them, then queue payouts. */
export function pauseRows(reserve: NonNullable<GiwaArcoUSDReserve["reserve"]>): PauseRow[] {
  return [
    { label: "Router buy", paused: reserve.routerPaused, effect: "Fund buys through the Router" },
    { label: "Reserve deposit", paused: reserve.depositPaused, effect: "Stablecoin deposits and stablecoin-paid buys" },
    { label: "ArcoUSD mint", paused: reserve.arcoUSDMintPaused, effect: "Deposits (mint) and stablecoin-paid buys" },
    { label: "Reserve settleFor", paused: reserve.settlementPaused, effect: "Every fund buy" },
    { label: "ArcoUSD burn", paused: reserve.arcoUSDBurnPaused, effect: "Settlement and queue payouts" },
    { label: "Reserve processQueue", paused: reserve.queuePaused ?? false, effect: "Standard-queue payouts (requests keep their place)" },
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

/** Queue payouts stop while the Reserve, its processQueue, ArcoUSD or ArcoUSD burn is paused. */
export function payoutsPaused(reserve: GiwaArcoUSDReserve["reserve"] | null | undefined): boolean {
  return Boolean(reserve && (reserve.reservePaused || reserve.queuePaused || reserve.arcoUSDPaused || reserve.arcoUSDBurnPaused))
}

// ── Alerts ──────────────────────────────────────────────────────────────────

export type AlertTone = "negative" | "attention" | "neutral" | "positive"

/** Pill label and tone: open alerts by severity, then waiting and cleared ones. */
export function alertBadge(alert: Pick<GiwaArcoUSDAlert, "status" | "severity">): { label: string; tone: AlertTone } {
  if (alert.status === "RESOLVED") return { label: "Resolved", tone: "positive" }
  if (alert.status === "PENDING") return { label: "Pending", tone: "neutral" }
  return alert.severity === "CRITICAL" ? { label: "Critical", tone: "negative" } : { label: "Warning", tone: "attention" }
}

/** "just now", "12m ago", "2h 5m ago". */
export function agoText(iso: string | null | undefined, now: number): string {
  if (!iso) return "—"
  const seconds = (now - Date.parse(iso)) / 1000
  if (!Number.isFinite(seconds)) return "—"
  return seconds < 60 ? "just now" : `${durationText(seconds)} ago`
}

/** The line under an alert: how long it has been open / waiting / since it cleared, and the last send. */
export function alertMeta(alert: GiwaArcoUSDAlert, now: number): string {
  if (alert.status === "RESOLVED") return `Resolved ${agoText(alert.resolvedAt, now)}`
  if (alert.status === "PENDING") return `Seen ${agoText(alert.firstSeenAt, now)}; sent only if it lasts`
  const sent = alert.lastNotifiedAt ? `last sent ${agoText(alert.lastNotifiedAt, now)}` : "not sent yet"
  return `Open ${durationText((now - Date.parse(alert.openedAt ?? alert.firstSeenAt)) / 1000)} · ${sent}`
}

/** Whether the watcher is alive: never ran, stopped running, failed its last round, or fine. */
export function watcherStatus(alerts: Pick<GiwaArcoUSDAlerts, "watcher">, now: number): { tone: AlertTone; text: string } {
  const watcher = alerts.watcher
  if (!watcher) return { tone: "attention", text: "The watcher has not run yet. It runs in the indexer worker once ArcoUSD is deployed." }
  if (watcher.stale) return { tone: "negative", text: `The watcher last ran ${agoText(watcher.lastRunAt, now)}. The indexer worker may be down.` }
  if (watcher.lastError) return { tone: "negative", text: `The watcher's last run failed ${agoText(watcher.lastRunAt, now)}: ${watcher.lastError}` }
  const ran = `The watcher ran ${agoText(watcher.lastRunAt, now)}.`
  return watcher.reconciled === false
    ? { tone: "attention", text: `${ran} It could not compare the queue with the chain this time (indexer behind, or its block unreadable).` }
    : { tone: "positive", text: ran }
}

const CHANNEL_LABEL: Record<string, string> = { telegram: "Telegram", slack: "Slack" }

/** "Telegram: sent · Slack: failed (Slack answered 404)". */
export function deliveryText(delivery: GiwaArcoUSDAlertDelivery): string {
  const parts = Object.entries(delivery).map(([channel, result]) =>
    `${CHANNEL_LABEL[channel] ?? channel}: ${result?.ok ? "sent" : `failed${result?.error ? ` (${result.error})` : ""}`}`,
  )
  return parts.length ? parts.join(" · ") : "No channel answered"
}

export function channelLabel(id: string): string {
  return CHANNEL_LABEL[id] ?? id
}

// ── Queue keeper ────────────────────────────────────────────────────────────

/**
 * Mode pill: Off / Dry run / Live, then its trouble the way the watcher judges it: Not running (stale),
 * Failing (no good round for 10 minutes), or Retrying (the last round failed, the one before was fine).
 */
export function keeperBadge(keeper: GiwaArcoUSDKeeper["keeper"], now: number = Date.now()): { label: string; tone: AlertTone } {
  const mode = keeper?.report?.mode
  if (!keeper || !mode || mode === "off") return { label: "Off", tone: "neutral" }
  const name = mode === "live" ? "Live" : "Dry run"
  if (keeper.stale) return { label: "Not running", tone: "negative" }
  if (keeper.lastError) {
    const lastOk = keeper.lastOkAt ? Date.parse(keeper.lastOkAt) : Number.NaN
    const failing = !Number.isFinite(lastOk) || now - lastOk > 10 * 60_000
    return failing ? { label: `${name} · failing`, tone: "negative" } : { label: `${name} · retrying`, tone: "attention" }
  }
  return mode === "live" ? { label: name, tone: "positive" } : { label: name, tone: "attention" }
}

/**
 * "0.0123 ETH" from wei. Gas, not a financial value: up to 4 decimals so a nearly empty wallet does not
 * read as 0 (the 2-decimal rule is for money shown to customers).
 */
export function gasText(wei: string | null | undefined): string {
  if (!wei || !/^\d+$/.test(wei)) return "—"
  const value = Number(BigInt(wei)) / 1e18
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 4 })} ETH`
}

const TX_STATUS: Record<NonNullable<GiwaArcoUSDKeeperReport["lastTx"]>["status"], { label: string; tone: AlertTone }> = {
  pending: { label: "Pending", tone: "attention" },
  success: { label: "Mined", tone: "positive" },
  reverted: { label: "Reverted", tone: "negative" },
  replaced: { label: "Replaced", tone: "neutral" },
  failed: { label: "Failed", tone: "negative" },
}

export function keeperTxBadge(status: NonNullable<GiwaArcoUSDKeeperReport["lastTx"]>["status"]): { label: string; tone: AlertTone } {
  return TX_STATUS[status] ?? { label: status, tone: "neutral" }
}

/** "tUSDC would pay 3 · tUSDT nothing now · tRLUSD failed: …"; "Not checked this round" when it stopped first. */
export function simulationText(report: Pick<GiwaArcoUSDKeeperReport, "simulations" | "simulated">): string {
  if (report.simulated === false) return "Not checked this round"
  const simulations = report.simulations ?? []
  if (!simulations.length) return "No backlog to check"
  return simulations
    .map((item) =>
      item.error
        ? `${item.symbol} failed: ${item.error}`
        : item.paid
          ? `${item.symbol} would pay ${countText(item.paid, "request")}`
          : item.clearing
            ? `${item.symbol} would first step past cancelled or failed entries`
            : `${item.symbol} nothing payable now`,
    )
    .join(" · ")
}

// ─────────────────────────────── Savings ───────────────────────────────

/** Share price (ArcoUSD per sArcoUSD): up to 4 decimals, at least 2 (the NAV exception: near-par
 *  prices need sub-cent precision). "—" when not a number. */
export function sharePriceText(value: string | number | null | undefined): string {
  const price = typeof value === "number" ? value : Number(value)
  if (value === null || value === undefined || value === "" || !Number.isFinite(price)) return "—"
  return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

/** ArcoUSD released into the share price per day at the current rate. */
export function rewardsPerDayUsd(state: Pick<GiwaArcoUSDSavingsState, "rewardRate">): number | null {
  try {
    return Number(BigInt(state.rewardRate) * 86_400n) / 1e18
  } catch {
    return null
  }
}

/** Every switch Savings depends on: the vault's own (deposit, withdraw, addRewards, all), the
 *  distributor, and the Reserve and ArcoUSD mint pauses that stop distribute(). */
export function savingsPauseRows(state: GiwaArcoUSDSavingsState): PauseRow[] {
  return [
    { label: "sArcoUSD deposit", paused: state.depositPaused, effect: state.seeded ? "Deposits and mints" : "Deposits and mints (closed until the seed)" },
    { label: "sArcoUSD withdraw", paused: state.withdrawPaused, effect: "Withdrawals and redemptions" },
    { label: "sArcoUSD addRewards", paused: state.rewardsPaused, effect: "No yield can be added (distributions revert)" },
    { label: "sArcoUSD (all)", paused: state.vaultPaused, effect: "Deposits, withdrawals and rewards (share transfers continue)" },
    { label: "Distributor", paused: state.distributor.paused, effect: "distribute()" },
    { label: "Reserve (all)", paused: state.distributor.reservePaused, effect: "distribute() refuses while the Reserve is paused" },
    { label: "ArcoUSD mint", paused: state.distributor.arcoUSDMintPaused, effect: "distribute() cannot mint (ArcoUSD paused or mint paused)" },
  ]
}

export type DistributionVerdict =
  | { readonly kind: "paused"; readonly what: string }
  | { readonly kind: "unknown"; readonly error: string }
  | { readonly kind: "nav" }
  | { readonly kind: "waiting"; readonly until: string }
  | { readonly kind: "nothing"; readonly why: string }
  | { readonly kind: "ready"; readonly amountUsd: string }

/** Whether distribute() would mint now, and if not, why (the first reason that applies). Every pause
 *  on its path makes it revert: the distributor, the Reserve, sArcoUSD (all or addRewards), ArcoUSD mint. */
export function distributionVerdict(state: GiwaArcoUSDSavingsState, now: number): DistributionVerdict {
  const { distributor } = state
  if (distributor.paused) return { kind: "paused", what: "The distributor" }
  if (distributor.reservePaused) return { kind: "paused", what: "The Reserve" }
  if (state.vaultPaused) return { kind: "paused", what: "sArcoUSD" }
  if (state.rewardsPaused) return { kind: "paused", what: "sArcoUSD addRewards" }
  if (distributor.arcoUSDMintPaused) return { kind: "paused", what: "ArcoUSD mint" }
  const preview = distributor.preview
  if (!preview) return { kind: "unknown", error: "The distributor preview could not be read (see the API log)" }
  if (!preview.navOk) return { kind: "nav" }
  if (Date.parse(distributor.nextDistributionAt) > now) return { kind: "waiting", until: distributor.nextDistributionAt }
  if (!state.seeded) return { kind: "nothing", why: "No savers yet (the vault is not seeded)" }
  let amount = 0n
  try {
    amount = BigInt(preview.amount)
  } catch {
    return { kind: "unknown", error: "Unreadable preview amount" }
  }
  if (amount > 0n) return { kind: "ready", amountUsd: preview.amountUsd }
  const zero = (value: string) => {
    try {
      return BigInt(value) === 0n
    } catch {
      return false
    }
  }
  if (zero(preview.mintHeadroom)) return { kind: "nothing", why: "The Reserve mint cap is reached" }
  if (zero(preview.surplus)) return { kind: "nothing", why: "No Reserve surplus above the margin" }
  if (zero(preview.rateCap)) return { kind: "nothing", why: "Nothing saved long enough to earn yet" }
  return { kind: "nothing", why: "Nothing to distribute" }
}
