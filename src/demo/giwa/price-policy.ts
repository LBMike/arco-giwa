// price-policy.ts — pure, unit-testable helpers for the GIWA price-feed admin panel.
//
// The on-chain ProductPriceFeed (packages/contracts/contracts/ProductPriceFeed.sol)
// stores prices at 8 decimals, so price 1.0 == 100_000_000 (1e8). Everything here is
// deterministic and side-effect free (no React, no I/O) so it runs under
// `npm run test:frontend` (node --test) and can be reasoned about in isolation.

export const FEED_DECIMALS = 8
export const FEED_SCALE = 100_000_000 // 1e8 — one whole unit at 8 decimals
export const SECONDS_PER_DAY = 86_400
export const DAYS_PER_YEAR = 365

/**
 * Detail-page APY stat text: the published rate, else the implied-from-posts rate
 * (mirrors what the vault list shows); "—" when neither exists (<2 price posts).
 * Up to 2 decimals, no forced trailing zeros — same format as the current stat.
 */
export function marketApyText(market: { apy: number | null; impliedApy: number | null } | null): string {
  const apy = market?.apy ?? market?.impliedApy ?? null
  return apy != null ? `${apy.toFixed(2).replace(/\.?0+$/, "")}%` : "—"
}

/**
 * Numeric APY percent from the SAME source as marketApyText (published rate, else implied), or
 * null. Raw/unrounded so the Savings "Est. Annual Yield" calc uses the exact rate the "%" stat
 * rounds only for display — the two can never diverge in source.
 */
export function marketApyPercent(market: { apy: number | null; impliedApy: number | null } | null): number | null {
  return market?.apy ?? market?.impliedApy ?? null
}

/**
 * NAV/share price stat: an explicit exception to the 2-decimal financial-figure rule.
 * NAV sits near par, so 2 decimals hide real movement (1.0016 → $1.00). Show up to 4
 * decimals (min 2, no forced trailing zeros); par stays "$1.00". See root CLAUDE.md.
 */
export function navSharePrice(navUsd: number): string {
  return `$${navSharePriceValue(navUsd)}`
}

/**
 * The NAV/share number without a currency prefix — the single 2–4 decimal formatting rule shared
 * by the detail PRICE stat (which prefixes "$") and the holdings Price/24hΔ column (navBase is
 * denominated in the payment asset, so a "$" there would be wrong).
 */
export function navSharePriceValue(nav: number): string {
  return nav.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

/**
 * 24h share-price change, in percent, from a vault's price history.
 *   Δ% = (nowNavBase − navBase at/before now−24h) / that price × 100
 * Returns null when the vault has NO history at all (nothing to compare → the column shows "—").
 * When history exists but holds no point ≥24h back, the change is 0% (not null): the vault simply
 * hasn't been posted long enough to have moved.
 */
export function priceChange24hPct(points: { t: number; navBase: number }[]): number | null {
  if (!points.length) return null
  const sorted = [...points].sort((a, b) => a.t - b.t)
  const now = sorted[sorted.length - 1]
  const cutoff = now.t - SECONDS_PER_DAY
  // Latest point at or before the cutoff (ascending scan keeps the last match).
  let baseline: { t: number; navBase: number } | undefined
  for (const point of sorted) {
    if (point.t <= cutoff) baseline = point
  }
  if (!baseline || !(baseline.navBase > 0)) return 0
  return ((now.navBase - baseline.navBase) / baseline.navBase) * 100
}

/**
 * Signed 24h-change label + direction. Up covers Δ ≥ 0 (a change that rounds to zero renders the
 * unsigned "0%" and still reads as up), so a "-0%" can never appear.
 */
export function formatPriceDelta(pct: number): { text: string; up: boolean } {
  const rounded = Number(pct.toFixed(2))
  if (rounded === 0) return { text: "0%", up: true }
  return { text: `${rounded > 0 ? "+" : "-"}${Math.abs(rounded)}%`, up: rounded > 0 }
}

/**
 * Round a human price (e.g. 1.0014770549) to its 8-decimal integer answer, half-up.
 * `Math.floor(x + 0.5)` is exact half-up for the non-negative prices this feed accepts.
 */
export function toAnswer(price: number): bigint {
  if (!Number.isFinite(price)) throw new Error("price must be a finite number")
  return BigInt(Math.floor(price * FEED_SCALE + 0.5))
}

/** Convert an 8-decimal integer answer back to a human price. */
export function fromAnswer(answer: bigint): number {
  return Number(answer) / FEED_SCALE
}

/**
 * NAV-per-share price: price = NAV / sharesOutstanding, both in human units so the
 * token/payment-asset decimals cancel and the result is "payment-asset per share"
 * (consistent with the 1:1 baseline, price 1.0). Guards against non-positive shares.
 */
export function computeNavPrice({ nav, shares }: { nav: number; shares: number }): number {
  if (!(shares > 0)) throw new Error("shares must be greater than 0")
  return nav / shares
}

/**
 * Compounding APY implied by a price change over the period — DISPLAY ONLY, never
 * affects the posted price: ((newPrice / basePrice) ^ (365 / periodDays) - 1) * 100.
 * Returns null when basePrice or periodDays is not strictly positive (incl. NaN).
 */
export function impliedApyPercent({
  basePrice,
  newPrice,
  periodDays,
}: {
  basePrice: number
  newPrice: number
  periodDays: number
}): number | null {
  if (!(basePrice > 0) || !(periodDays > 0)) return null
  return ((newPrice / basePrice) ** (DAYS_PER_YEAR / periodDays) - 1) * 100
}

/**
 * Simple (non-compounding) APR implied by the same price change — display only:
 * (newPrice / basePrice - 1) * (365 / periodDays) * 100. Same null guard as APY.
 */
export function impliedAprPercent({
  basePrice,
  newPrice,
  periodDays,
}: {
  basePrice: number
  newPrice: number
  periodDays: number
}): number | null {
  if (!(basePrice > 0) || !(periodDays > 0)) return null
  return (newPrice / basePrice - 1) * (DAYS_PER_YEAR / periodDays) * 100
}

/** Fractional days between an on-chain updatedAt (unix seconds) and now (unix seconds). */
export function elapsedDays(updatedAtSeconds: number | bigint, nowSeconds: number): number {
  return (nowSeconds - Number(updatedAtSeconds)) / SECONDS_PER_DAY
}

/**
 * Staleness, mirroring the contract exactly: getDataInBase18() reverts when
 * `block.timestamp - updatedAt > healthyDiff`, so the feed is FRESH at the boundary
 * (now - updatedAt == healthyDiff) and STALE only once it is strictly exceeded.
 */
export function isStale({
  updatedAt,
  healthyDiff,
  now,
}: {
  updatedAt: number | bigint
  healthyDiff: number | bigint
  now: number
}): boolean {
  return now - Number(updatedAt) > Number(healthyDiff)
}

export type AnswerValidation = { ok: boolean; reason?: string }

/**
 * Validate a candidate answer against the feed's [min, max] bounds. setRoundDataSafe
 * requires answer > 0 and minExpectedAnswer <= answer <= maxExpectedAnswer.
 */
export function validateAnswer(answer: bigint, { min, max }: { min: bigint; max: bigint }): AnswerValidation {
  if (answer <= 0n) return { ok: false, reason: "Price must be greater than 0" }
  if (answer < min) return { ok: false, reason: `Answer ${answer} is below the feed minimum ${min}` }
  if (answer > max) return { ok: false, reason: `Answer ${answer} exceeds the feed maximum ${max}` }
  return { ok: true }
}

/**
 * Estimated counter-amount for the invest/redeem preview at the current share price
 * (payment-asset per share): invest => shares = payAmount / price; redeem => assets =
 * payAmount * price. Returns null for non-finite or non-positive inputs. This is an
 * estimate only — the actual on-chain amount can differ slightly by vault rounding.
 */
export function computeQuote({
  payAmount,
  price,
  side,
}: {
  payAmount: number
  price: number
  side: "invest" | "redeem"
}): number | null {
  if (!Number.isFinite(price) || !Number.isFinite(payAmount)) return null
  if (!(price > 0) || !(payAmount > 0)) return null
  return side === "invest" ? payAmount / price : payAmount * price
}
