export const DAY_SECONDS = 86_400

// Display-only implied APY from a NAV change over a period. Single source shared by
// Monitoring's apyTrend sparkline and the market list's implied APY so every surface
// agrees; mirrors the frontend price-policy helper's formula. Returns null when
// basePrice or periodDays is not strictly positive (incl. NaN).
export function impliedApyPercent(basePrice: number, newPrice: number, periodDays: number): number | null {
  if (!(basePrice > 0) || !(periodDays > 0)) return null
  return ((newPrice / basePrice) ** (365 / periodDays) - 1) * 100
}
