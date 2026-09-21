/** Asset categories for the Savings selector; values also form bookmarkable query parameters. */
export const SAVINGS_CATEGORIES = [
  { id: "stablecoins", label: "Stablecoins" },
  { id: "crypto-native", label: "Crypto Native" },
] as const
export type SavingsCategory = typeof SAVINGS_CATEGORIES[number]["id"]
const STABLECOINS = new Set(["USDC", "RLUSD", "USDT", "DAI", "USDE", "USDS", "PYUSD", "EURC"])
export function savingsAssetCategory(symbol: string): SavingsCategory {
  return STABLECOINS.has(symbol.toUpperCase()) ? "stablecoins" : "crypto-native"
}
/** Explicit category wins; existing asset deep links retain their matching category. */
export function savingsCategoryFromSearch(params: URLSearchParams): SavingsCategory {
  const category = params.get("category")
  if (category === "stablecoins" || category === "crypto-native") return category
  const asset = params.get("asset")
  return asset ? savingsAssetCategory(asset) : "stablecoins"
}
export function savingsCategoryPath(category: SavingsCategory): string {
  return `/savings?category=${category}`
}
