/** Asset categories for the Savings selector; values also form bookmarkable query parameters. */
export const SAVINGS_CATEGORIES = [
  { id: "stablecoins", label: "Stablecoins" },
  { id: "crypto-native", label: "Crypto Native" },
  { id: "gold", label: "Gold" },
] as const
export type SavingsCategory = typeof SAVINGS_CATEGORIES[number]["id"]
const STABLECOINS = new Set(["USDC", "RLUSD", "USDT", "ARCOUSD", "DAI", "USDE", "USDS", "PYUSD", "EURC"])
/**
 * The gold coins the Gold account takes (either one deposits into ArcoGOLD), with their marks. The Gold tab stacks them
 * in this order (SavingsTabs.tsx); on GIWA each is a test coin (tPAXG, tXAUT). `round` is false for a mark that is not a
 * disc (Tether Gold's gem): drawn without a round ring or a round crop around it.
 */
export const SAVINGS_GOLD_COINS: readonly Readonly<{ symbol: string; name: string; logo: string; round: boolean }>[] = [
  { symbol: "PAXG", name: "PAX Gold", logo: "/logos/paxg.png", round: true },
  { symbol: "XAUT", name: "Tether Gold", logo: "/logos/xaut.png", round: false },
]
const GOLD = new Set(SAVINGS_GOLD_COINS.map((coin) => coin.symbol))
/** A GIWA test coin as customers know it: tPAXG is PAXG. */
const coinOf = (symbol: string) => symbol.replace(/^t(?=[A-Z])/, "")
/** The gold coin a symbol is (PAXG for "tPAXG" or "paxg"), or null. */
export function savingsGoldCoin(symbol: string) {
  const coin = coinOf(symbol).toUpperCase()
  return SAVINGS_GOLD_COINS.find((entry) => entry.symbol === coin) ?? null
}
/** Whether a coin's mark is a disc (every mark but Tether Gold's gem): only a disc gets a round ring or crop. */
export function savingsMarkIsRound(symbol: string): boolean {
  return savingsGoldCoin(symbol)?.round ?? true
}
export function savingsAssetCategory(symbol: string): SavingsCategory {
  if (STABLECOINS.has(symbol.toUpperCase())) return "stablecoins"
  return GOLD.has(coinOf(symbol).toUpperCase()) ? "gold" : "crypto-native"
}
/**
 * How many decimals a coin amount shows on the Savings screens: two for a dollar coin, four for any other (a Crypto
 * Native or a gold coin: 0.0083 BTC a year would read "0" at two). Takes the coin as customers know it ("BTC") or the
 * test token ("tBTC").
 */
export function savingsCoinDecimals(symbol: string): 2 | 4 {
  return savingsAssetCategory(coinOf(symbol)) === "stablecoins" ? 2 : 4
}
const isCategory = (value: string | null): value is SavingsCategory => SAVINGS_CATEGORIES.some((category) => category.id === value)
/** Explicit category wins; existing asset deep links retain their matching category. */
export function savingsCategoryFromSearch(params: URLSearchParams): SavingsCategory {
  const category = params.get("category")
  if (isCategory(category)) return category
  const asset = params.get("asset")
  return asset ? savingsAssetCategory(asset) : "stablecoins"
}
export function savingsCategoryPath(category: SavingsCategory): string {
  return `/savings?category=${category}`
}
