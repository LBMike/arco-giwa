// Server-side USD rates for valuing product NAVs. Fetches the public CoinGecko simple
// price (best-effort, rate-limited) with a ~60s in-memory cache; USDC is pinned to 1.
// On failure callers get null (or the last cached value) and degrade to navUsd: null —
// never a wrong number. baseUsd() is pure.

export type UsdRates = { USDC: number; BTC: number; ETH: number; XRP: number }

const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,ripple&vs_currencies=usd"
const CACHE_TTL_MS = 60_000

let cache: { rates: UsdRates; at: number } | null = null

export async function fetchUsdRates(): Promise<UsdRates | null> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rates
  try {
    const response = await fetch(COINGECKO_URL, { headers: { accept: "application/json" } })
    if (!response.ok) return cache?.rates ?? null
    const body = (await response.json()) as Record<string, { usd?: number }>
    const read = (id: string) => {
      const value = body?.[id]?.usd
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : Number.NaN
    }
    const rates: UsdRates = { USDC: 1, BTC: read("bitcoin"), ETH: read("ethereum"), XRP: read("ripple") }
    cache = { rates, at: Date.now() }
    return rates
  } catch {
    return cache?.rates ?? null
  }
}

// Maps a product's payment-asset symbol to its USD base price. tUSDC is always 1.
// Returns null when the rate is unavailable or the symbol is unknown.
export function baseUsd(paymentAssetSymbol: string, rates: UsdRates | null | undefined): number | null {
  if (paymentAssetSymbol === "tUSDC") return 1
  if (!rates) return null
  const key =
    paymentAssetSymbol === "tBTC" ? "BTC" : paymentAssetSymbol === "tWETH" ? "ETH" : paymentAssetSymbol === "tXRP" ? "XRP" : null
  if (!key) return null
  const value = rates[key]
  return Number.isFinite(value) && value > 0 ? value : null
}
