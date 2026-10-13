import type { VaultCategory } from "../../../shared/vault-taxonomy"

// Investor-facing category titles. The taxonomy values stay as stored (server, admin console,
// saved overrides); customers see the catalog's three categories.
export const CATEGORY_TITLES: Record<VaultCategory, string> = {
  "U.S Treasuries": "Cash Management",
  "Prime Credit": "Income Strategies",
  "Arco Saving": "Arco Saving",
  "Equity Exposure": "Equity Exposure",
}

/** Display title for a taxonomy value; an unknown value is shown as-is. */
export function categoryTitle(category: string): string {
  return (CATEGORY_TITLES as Record<string, string>)[category] ?? category
}

/** Headline-rate label on a product page: equity funds show a return, every other fund an APY. */
export function rateLabel(category: string | null | undefined): "APY" | "Return" {
  return category === "Equity Exposure" ? "Return" : "APY"
}
