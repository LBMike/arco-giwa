// Pure logic for the Vault Operations "Limits" editor (unit-tested in limits.test.tsx).
// setLimits overwrites ALL fields atomically, so an untouched input must resubmit the CURRENT
// on-chain value — a blank must never become 0. Everything here works in human units (whole
// tokens/shares); the server scales to base units per decimals.

// A cap "effectively unlimited" fill: 1e15 human → ≤1e33 scaled, far below uint256 max, huge vs
// any realistic supply, and displays cleanly (unlike type(uint256).max, which reads like a bug).
export const UNLIMITED_HUMAN = "1000000000000000"

// Blank/whitespace input ⇒ keep the current value (never 0).
export function resolveLimit(input: string, current: string): string {
  return input.trim() || current
}

// The three caps (maxSupplyCap / vaultMintAllowance / vaultRedeemAllowance) must be > 0 — a 0 cap
// bricks the vault. Minimums may legitimately be 0 (no floor).
export function isPositiveHuman(value: string): boolean {
  const n = Number(value)
  return Number.isFinite(n) && n > 0
}

// "$≈" hint. Share fields multiply by navUsd (USD/share); payment fields by baseUsd
// (USD/payment-token) — the caller passes the correct per-field multiplier. Null multiplier or a
// non-positive amount → no hint (never "~$NaN").
export function usdHint(human: string, mult: number | null | undefined): string | null {
  if (mult == null) return null
  const n = Number(human)
  if (!Number.isFinite(n) || n <= 0) return null
  return `~$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n * mult)}`
}

// Non-blocking info signal: a vaultMintAllowance below maxSupplyCap is ALLOWED (it is not a
// contract invariant and every deployed vault ships this way) but worth surfacing. Both are
// resolved human strings.
export function allowanceBelowCap(vaultMintAllowance: string, maxSupplyCap: string): boolean {
  const a = Number(vaultMintAllowance)
  const c = Number(maxSupplyCap)
  return Number.isFinite(a) && Number.isFinite(c) && a < c
}

// ── Limit usage (server: vault-limit-usage.ts) ──────────────────────────────────────────────
// The vaults check LIFETIME mints/redemptions against their allowances, so a vault can stop
// taking deposits while its supply is far below the cap. These helpers word that for an operator.

export type LimitUsageLevel = "ok" | "near" | "exhausted"
export type LimitUsageSide = { used: string; limit: string; remaining: string; usedPct: number; level: LimitUsageLevel }
export type VaultLimitUsage = {
  deposit: {
    mintAllowance: LimitUsageSide
    supplyCap: LimitUsageSide | null
    remainingShares: string
    binding: "mintAllowance" | "supplyCap"
    level: LimitUsageLevel
  }
  redemption: LimitUsageSide
}

// A limit at or above this reads as "unlimited" (the "Set unlimited" fill is 1e15).
const UNLIMITED_THRESHOLD = 1e14

function amount(value: string): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n)
}

/** One line under a limit: what is used, what is left. Unlimited limits say so instead of a huge number. */
export function usageLine(side: LimitUsageSide, usedLabel: string): string {
  if (Number(side.limit) >= UNLIMITED_THRESHOLD) return `${usedLabel} ${amount(side.used)} · unlimited`
  if (side.level === "exhausted") return `${usedLabel} ${amount(side.used)} of ${amount(side.limit)} · none left`
  return `${usedLabel} ${amount(side.used)} of ${amount(side.limit)} · ${amount(side.remaining)} left (${side.usedPct}% used)`
}

/** Header badges for a vault card; empty when both sides have room. */
export function limitBadges(usage: VaultLimitUsage | null | undefined): string[] {
  if (!usage) return []
  const badges: string[] = []
  if (usage.deposit.level === "exhausted") badges.push("Deposits blocked · limit reached")
  else if (usage.deposit.level === "near") badges.push(`Deposit limit · ${amount(usage.deposit.remainingShares)} shares left`)
  if (usage.redemption.level === "exhausted") badges.push("Withdrawals blocked · limit reached")
  else if (usage.redemption.level === "near") badges.push(`Withdrawal limit · ${amount(usage.redemption.remaining)} left`)
  return badges
}

/** What the next deposit runs into, in the contract's own words, for the Limits card. */
export function depositLimitNote(usage: VaultLimitUsage): string | null {
  const { deposit } = usage
  if (deposit.level === "ok") return null
  const which = deposit.binding === "supplyCap" ? "max supply cap (ADV: max supply)" : "vault mint allowance (ADV: vault allowance)"
  if (deposit.level === "exhausted") return `Deposits revert now: the ${which} is used up. Raise it to reopen deposits.`
  return `A deposit minting more than ${amount(deposit.remainingShares)} shares reverts on the ${which}.`
}

export function redemptionLimitNote(usage: VaultLimitUsage, unit: string): string | null {
  const side = usage.redemption
  if (side.level === "ok") return null
  if (side.level === "exhausted") return "Withdrawals revert now: the vault redeem allowance is used up (ARV: vault allowance). Raise it to reopen withdrawals."
  return `A withdrawal paying more than ${amount(side.remaining)} ${unit} reverts on the vault redeem allowance (ARV: vault allowance).`
}

/** Counts for the Vault Operations summary tiles. Vaults with unreadable usage are counted apart. */
export function limitAttention(rows: ReadonlyArray<{ usage: VaultLimitUsage | null }>): {
  depositBlocked: number
  depositNear: number
  withdrawBlocked: number
  withdrawNear: number
  unread: number
} {
  const count = { depositBlocked: 0, depositNear: 0, withdrawBlocked: 0, withdrawNear: 0, unread: 0 }
  for (const row of rows) {
    if (!row.usage) {
      count.unread += 1
      continue
    }
    if (row.usage.deposit.level === "exhausted") count.depositBlocked += 1
    else if (row.usage.deposit.level === "near") count.depositNear += 1
    if (row.usage.redemption.level === "exhausted") count.withdrawBlocked += 1
    else if (row.usage.redemption.level === "near") count.withdrawNear += 1
  }
  return count
}

/** Tile wording: "All clear", "2 blocked", "1 blocked · 2 near limit". */
export function attentionLabel(blocked: number, near: number): string {
  const parts: string[] = []
  if (blocked > 0) parts.push(`${blocked} blocked`)
  if (near > 0) parts.push(`${near} near limit`)
  return parts.length ? parts.join(" · ") : "All clear"
}
