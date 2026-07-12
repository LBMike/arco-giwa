// Vault display-profile helpers (P1): fee formatting (basis points <-> percent) and the
// disclaimer-honesty predicate. Pure + dependency-free so it is unit-testable.

// Fees are stored as integer basis points (1 bp = 0.01%). Render as a percent with the
// CLAUDE.md number rule: max 2 decimals, no forced trailing zeros (20 -> "0.2%",
// 25 -> "0.25%", 125 -> "1.25%", 0 -> "0%").
export function formatPercentFromBps(bps: number): string {
  const trimmed = (bps / 100).toFixed(2).replace(/\.?0+$/, "")
  return `${trimmed === "" || trimmed === "-0" ? "0" : trimmed}%`
}

// Parse an operator-entered percent (e.g. "0.25") into basis points, or null when the
// field is blank. Returns "invalid" for out-of-range / non-numeric so the caller can
// surface an error rather than silently coerce.
export function percentInputToBps(input: string): number | null | "invalid" {
  const trimmed = input.trim()
  if (trimmed === "") return null
  // Decimal digits only (e.g. "0.5", ".5", "1.25", "100"). Reject Number()-parseable but
  // non-decimal forms — hex "0x10", exponent "1e2", binary/octal — which would otherwise
  // coerce into large "valid" fees instead of erroring.
  if (!/^\d*\.?\d+$/.test(trimmed)) return "invalid"
  const percent = Number(trimmed)
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return "invalid"
  const bps = Math.round(percent * 100)
  return bps >= 0 && bps <= 10000 ? bps : "invalid"
}

// Prefill an editable percent input from stored basis points.
export function bpsToPercentInput(bps: number | null): string {
  if (bps == null) return ""
  return (bps / 100).toFixed(2).replace(/\.?0+$/, "")
}

// Parse a decimal-only numeric input (portfolio percent / USD). Blank => null; a
// Number()-parseable but non-decimal form (hex "0x64", exponent "1e5") => "invalid",
// matching the fee-input rule so exotic strings never silently coerce.
export function parseDecimalInput(input: string): number | null | "invalid" {
  const trimmed = input.trim()
  if (trimmed === "") return null
  if (!/^\d*\.?\d+$/.test(trimmed)) return "invalid"
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : "invalid"
}

// Portfolio breakdown slice (P3). Stored as a raw JSON array on VaultConfig; maps to the
// existing BreakdownRow so PortfolioCard reuses today's donut/bar rendering.
export type PortfolioSlice = { label: string; percent: number; valueUsd?: number | null }

export const PORTFOLIO_SUM_TOLERANCE = 0.5

// value = the explicit valueUsd, or null when unset (the card fills it in from % × AUM).
// Was `?? 0`, which rendered "$0" for config slices without an explicit value.
export function sliceToBreakdownRow(slice: PortfolioSlice): { label: string; value: number | null; pct: number } {
  return { label: slice.label, value: slice.valueUsd ?? null, pct: slice.percent }
}

// Parse an admin AUM display string ("$903M", "$1.2B+", "50,000") into a number.
// Handles an optional "$", commas/whitespace, K/M/B/T suffix, and trailing "+"/text;
// unparseable input (no leading number) → null.
export function parseAumToNumber(aum: string | null): number | null {
  if (aum == null) return null
  const cleaned = aum.replace(/[$,\s]/g, "")
  const match = cleaned.match(/^(\d*\.?\d+)\s*([kmbt])?/i)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  const suffix = (match[2] ?? "").toLowerCase()
  const multiplier = suffix === "k" ? 1e3 : suffix === "m" ? 1e6 : suffix === "b" ? 1e9 : suffix === "t" ? 1e12 : 1
  return value * multiplier
}

// Per-row display value: explicit valueUsd, else (% × AUM) when AUM is known, else null ("—").
export function resolveSliceValue(row: { value: number | null; pct: number }, aum: number | null): number | null {
  if (row.value != null) return row.value
  if (aum != null) return (row.pct / 100) * aum
  return null
}

// Donut-center TOTAL: explicit total (legacy NAV), else sum of explicit row values,
// else the AUM, else null ("—").
export function resolveDonutTotal(
  explicitTotal: number | null,
  rows: Array<{ value: number | null }>,
  aum: number | null,
): number | null {
  if (explicitTotal != null) return explicitTotal
  const explicit = rows.filter((row): row is { value: number } => row.value != null)
  if (explicit.length > 0) return explicit.reduce((sum, row) => sum + row.value, 0)
  return aum
}

// Validate a portfolio-slice array (client mirror of the server rule — keep in sync with
// server/src/app.ts validatePortfolioSlices). Empty is the caller's concern: an empty set
// means "no override" (null), not an error, so this only sum-checks a non-empty array.
export function validatePortfolioSlices(input: unknown): { ok: boolean; error?: string; slices?: PortfolioSlice[] } {
  if (!Array.isArray(input)) return { ok: false, error: "portfolio must be an array of slices" }
  const slices: PortfolioSlice[] = []
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i] as Record<string, unknown> | null
    if (!raw || typeof raw !== "object") return { ok: false, error: `slice ${i + 1} must be an object` }
    const label = typeof raw.label === "string" ? raw.label.trim() : ""
    if (label.length < 1 || label.length > 40) return { ok: false, error: `slice ${i + 1} label must be 1–40 characters` }
    const percent = raw.percent
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      return { ok: false, error: `slice ${i + 1} percent must be a number 0–100` }
    }
    let valueUsd: number | null | undefined
    if (raw.valueUsd === undefined || raw.valueUsd === null) {
      valueUsd = null
    } else if (typeof raw.valueUsd === "number" && Number.isFinite(raw.valueUsd) && raw.valueUsd >= 0) {
      valueUsd = raw.valueUsd
    } else {
      return { ok: false, error: `slice ${i + 1} valueUsd must be a non-negative number or null` }
    }
    slices.push({ label, percent, valueUsd })
  }
  if (slices.length > 0) {
    const sum = slices.reduce((total, slice) => total + slice.percent, 0)
    if (Math.abs(sum - 100) > PORTFOLIO_SUM_TOLERANCE) {
      return { ok: false, error: `slice percents must sum to ~100% (currently ${sum.toFixed(2)}%)` }
    }
  }
  return { ok: true, slices }
}

// Savings accept-asset entry (client mirror of the server VaultAcceptAsset). Re-declared here
// (not imported from types) to keep this module dependency-free, matching PortfolioSlice above.
// `savingVaultId` is the owning saving vault for a real asset, or null for a dummy/coming-soon.
export type AcceptAsset = {
  symbol: string
  icon: string | null
  apy: number | null
  savingVaultId: string | null
  isDummy: boolean
  // Global cross-vault Savings display order (nullable int ≥0); unset sorts last.
  sortOrder: number | null
}

// Validate an accept-asset array (client mirror of the server rule — keep in sync with
// server/src/app.ts validateAcceptAssets). Empty is the caller's concern (means "no override" =
// null), not an error. This is a SHAPE validator: symbol (1–40, unique case-insensitively), icon
// (null | http(s) URL | /path), apy (null | finite ≥0), isDummy (boolean), and savingVaultId
// (dummy → null; real → non-empty string). The authoritative "savingVaultId references a known
// saving vault" (dangling) check needs the registry, so it lives server-side only.
export function validateAcceptAssets(input: unknown): { ok: boolean; error?: string; assets?: AcceptAsset[] } {
  if (!Array.isArray(input)) return { ok: false, error: "accept-assets must be an array" }
  const assets: AcceptAsset[] = []
  const seenSymbols = new Set<string>()
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i] as Record<string, unknown> | null
    const at = `accept-asset ${i + 1}`
    if (!raw || typeof raw !== "object") return { ok: false, error: `${at} must be an object` }
    const symbol = typeof raw.symbol === "string" ? raw.symbol.trim() : ""
    if (symbol.length < 1 || symbol.length > 40) return { ok: false, error: `${at} symbol must be 1–40 characters` }
    const symbolKey = symbol.toLowerCase()
    if (seenSymbols.has(symbolKey)) return { ok: false, error: `${at} symbol "${symbol}" is a duplicate` }
    seenSymbols.add(symbolKey)
    // icon: null / blank, else an absolute http(s) URL or a single-leading-slash /path.
    let icon: string | null
    if (raw.icon === undefined || raw.icon === null) icon = null
    else if (typeof raw.icon !== "string") return { ok: false, error: `${at} icon must be a string or null` }
    else {
      const trimmed = raw.icon.trim()
      if (trimmed === "") icon = null
      else if (!/^https?:\/\/.+/.test(trimmed) && !/^\/[^/\s]\S*$/.test(trimmed)) {
        return { ok: false, error: `${at} icon must be an http(s) URL or a /path` }
      } else if (trimmed.length > 2048) return { ok: false, error: `${at} icon must be at most 2048 characters` }
      else icon = trimmed
    }
    // apy: null or a finite number ≥0 (the dummy display rate; ignored for a real asset).
    let apy: number | null
    if (raw.apy === undefined || raw.apy === null) apy = null
    else if (typeof raw.apy === "number" && Number.isFinite(raw.apy) && raw.apy >= 0) apy = raw.apy
    else return { ok: false, error: `${at} apy must be a non-negative number or null` }
    if (typeof raw.isDummy !== "boolean") return { ok: false, error: `${at} isDummy must be a boolean` }
    const isDummy = raw.isDummy
    // savingVaultId: a dummy maps to nothing (must be empty); a real asset must name a vault.
    let savingVaultId: string | null
    if (isDummy) {
      if (raw.savingVaultId !== undefined && raw.savingVaultId !== null && raw.savingVaultId !== "") {
        return { ok: false, error: `${at} is a dummy — savingVaultId must be empty` }
      }
      savingVaultId = null
    } else if (typeof raw.savingVaultId !== "string" || raw.savingVaultId.trim() === "") {
      return { ok: false, error: `${at} savingVaultId is required for a non-dummy asset` }
    } else {
      savingVaultId = raw.savingVaultId.trim()
    }
    // sortOrder: null (unset) or a non-negative integer — the global cross-vault Savings display order.
    let sortOrder: number | null
    if (raw.sortOrder === undefined || raw.sortOrder === null) sortOrder = null
    else if (typeof raw.sortOrder === "number" && Number.isInteger(raw.sortOrder) && raw.sortOrder >= 0) sortOrder = raw.sortOrder
    else return { ok: false, error: `${at} sortOrder must be a non-negative integer or null` }
    assets.push({ symbol, icon, apy, savingVaultId, isDummy, sortOrder })
  }
  return { ok: true, assets }
}

// The portfolio card header (updatedAt + note) is aCAPIX legacy content with no config
// field of its own, so it may only render while the disclaimer is up (or on aCAPIX
// itself). Returns the legacy header when allowed, else neutral copy — so no aCAPIX text
// ever renders undisclaimed on a fully-profiled non-aCAPIX vault.
export function resolvePortfolioHeader(
  showsAcapixHeader: boolean,
  legacy: { updatedAt: string; note: string },
): { updatedAt: string; note: string } {
  if (showsAcapixHeader) return { updatedAt: legacy.updatedAt, note: legacy.note }
  return { updatedAt: "—", note: "Allocations reflect the latest published breakdown." }
}

// The aCAPIX legacy portfolio only renders for a view that is ENABLED and has NO config
// override. Snapshot has no legacy (empty state), so it never contributes. Returns true
// when neither Industry nor Exposure would render aCAPIX-derived data.
export function portfolioClearOfAcapix(cfg: {
  cardIndustry: boolean
  cardExposure: boolean
  portfolioIndustry: unknown
  portfolioExposure: unknown
}): boolean {
  const industryClear = !cfg.cardIndustry || cfg.portfolioIndustry != null
  const exposureClear = !cfg.cardExposure || cfg.portfolioExposure != null
  return industryClear && exposureClear
}

// Disclaimer-honesty invariant: for a NON-aCAPIX vault, the "representative sample"
// disclaimer must show whenever the detail page still renders ANY aCAPIX-derived value,
// and disappear only once the vault's own profile fully overrides that content. aCAPIX
// itself never shows it (its content is not "someone else's sample"). Returns the list
// of aCAPIX-derived fields still on fallback; the disclaimer shows iff the list is
// non-empty. (Issuer/Asset-Manager and Redemption Timeline are generic legacy content,
// and Instant liquidity is live-derived, so none of those count.)
export function remainingAcapixFallbacks(input: {
  isAcapix: boolean
  hasAbout: boolean
  hasManagementFee: boolean
  hasPerformanceFee: boolean
  hasInstantMintingFee: boolean
  hasInstantRedemptionFee: boolean
  hasPortfolio: boolean
}): string[] {
  if (input.isAcapix) return []
  const fallbacks: string[] = []
  if (!input.hasAbout) fallbacks.push("about")
  if (!input.hasManagementFee) fallbacks.push("managementFee")
  if (!input.hasPerformanceFee) fallbacks.push("performanceFee")
  if (!input.hasInstantMintingFee) fallbacks.push("instantMintingFee")
  if (!input.hasInstantRedemptionFee) fallbacks.push("instantRedemptionFee")
  if (!input.hasPortfolio) fallbacks.push("portfolio")
  return fallbacks
}
