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
