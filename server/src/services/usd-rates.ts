// Server-side USD rates for valuing product NAVs; USDC is pinned to 1. XAU (one troy ounce of gold, for ArcoGOLD) is
// read as PAX Gold (CoinGecko "pax-gold", Kraken "PAXGUSD"), a token backed one fine troy ounce each.
//
// Two public, keyless sources, tried in order: CoinGecko simple price, then Kraken's public ticker (one request) for any
// asset CoinGecko did not answer. Each upstream call has a timeout. A source that fails (non-OK status, throw, timeout,
// or a body with no valid value) is not retried for a backoff window and is logged once per failure (so once per
// window), with its source and HTTP status or error name. Successful rounds are cached for CACHE_TTL_MS. Each asset
// keeps its last good value for up to STALE_MS, then reads as unavailable (NaN; null when nothing at all is known).
// Never a wrong number: invalid or non-positive values are dropped. baseUsd() and ounceUsd() are pure.

export type UsdRateSource = "coingecko" | "kraken"
type FetchedAsset = "BTC" | "ETH" | "XRP" | "XAU"

export type UsdRates = {
  USDC: number
  BTC: number
  ETH: number
  XRP: number
  XAU: number
  /** Which upstream each available value came from (absent on hand-built rates). */
  sources?: Partial<Record<FetchedAsset, UsdRateSource>>
}

export const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,ripple,pax-gold&vs_currencies=usd"
export const KRAKEN_URL = "https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD,XRPUSD,PAXGUSD"

const CACHE_TTL_MS = 120_000
const BACKOFF_MS = 60_000
const STALE_MS = 15 * 60_000
const TIMEOUT_MS = 5_000

const ASSETS: readonly FetchedAsset[] = ["BTC", "ETH", "XRP", "XAU"]

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

export type UsdRatesLogger = { warn: (message: string) => void }

export type UsdRatesOptions = {
  fetch?: FetchLike
  now?: () => number
  /** Omit for silence (tests). */
  logger?: UsdRatesLogger
  cacheTtlMs?: number
  backoffMs?: number
  staleMs?: number
  timeoutMs?: number
}

type Parsed = Partial<Record<FetchedAsset, number>>

function validPrice(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

export function parseCoinGecko(body: unknown): Parsed {
  const out: Parsed = {}
  if (!body || typeof body !== "object") return out
  const ids: Record<string, FetchedAsset> = { bitcoin: "BTC", ethereum: "ETH", ripple: "XRP", "pax-gold": "XAU" }
  for (const [id, asset] of Object.entries(ids)) {
    const entry = (body as Record<string, unknown>)[id]
    // Only numbers here: CoinGecko answers numbers, anything else is not trusted.
    const usd = entry && typeof entry === "object" ? (entry as Record<string, unknown>).usd : undefined
    const price = typeof usd === "number" ? validPrice(usd) : null
    if (price !== null) out[asset] = price
  }
  return out
}

/** Kraken's own pair names vary (XXBTZUSD, XETHZUSD, XXRPZUSD, PAXGUSD), so keys are matched, not assumed. */
function krakenAsset(pair: string): FetchedAsset | null {
  const key = pair.toUpperCase()
  if (!key.endsWith("USD")) return null // excludes USDT/USDC quotes
  const base = key.slice(0, -3).replace(/Z$/, "")
  if (/^X?PAXG$/.test(base)) return "XAU"
  if (/^X?(XBT|BTC)$/.test(base)) return "BTC"
  if (/^X?ETH$/.test(base)) return "ETH"
  if (/^X?XRP$/.test(base)) return "XRP"
  return null
}

export function parseKraken(body: unknown): Parsed {
  const out: Parsed = {}
  if (!body || typeof body !== "object") return out
  const { error, result } = body as { error?: unknown; result?: unknown }
  if (Array.isArray(error) && error.length > 0) return out
  if (!result || typeof result !== "object") return out
  for (const [pair, ticker] of Object.entries(result as Record<string, unknown>)) {
    const asset = krakenAsset(pair)
    if (!asset || out[asset] !== undefined) continue
    const last = ticker && typeof ticker === "object" ? (ticker as { c?: unknown }).c : undefined
    // Kraken sends prices as decimal strings; c[0] is the last trade price.
    const price = Array.isArray(last) && typeof last[0] === "string" ? validPrice(last[0]) : null
    if (price !== null) out[asset] = price
  }
  return out
}

const SOURCES: readonly { name: UsdRateSource; url: string; parse: (body: unknown) => Parsed }[] = [
  { name: "coingecko", url: COINGECKO_URL, parse: parseCoinGecko },
  { name: "kraken", url: KRAKEN_URL, parse: parseKraken },
]

export function createUsdRatesFetcher(options: UsdRatesOptions = {}): () => Promise<UsdRates | null> {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init))
  const now = options.now ?? Date.now
  const cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS
  const backoffMs = options.backoffMs ?? BACKOFF_MS
  const staleMs = options.staleMs ?? STALE_MS
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS

  const lastGood: Partial<Record<FetchedAsset, { value: number; at: number; source: UsdRateSource }>> = {}
  const backoffUntil: Partial<Record<UsdRateSource, number>> = {}
  let nextRefreshAt = 0
  let inflight: Promise<void> | null = null

  const warn = (source: UsdRateSource, detail: Record<string, unknown>) => {
    options.logger?.warn(
      JSON.stringify({ service: "arco-giwa-api", usdRates: "upstream-failed", source, ...detail, retryInMs: backoffMs }),
    )
  }

  async function query(source: (typeof SOURCES)[number]): Promise<Parsed | null> {
    try {
      const response = await doFetch(source.url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        warn(source.name, { status: response.status })
        return null
      }
      const parsed = source.parse(await response.json())
      if (Object.keys(parsed).length === 0) {
        warn(source.name, { status: response.status, error: "no-valid-prices" })
        return null
      }
      return parsed
    } catch (error) {
      warn(source.name, { error: error instanceof Error ? error.name : "unknown" })
      return null
    }
  }

  async function refresh() {
    const missing = new Set<FetchedAsset>(ASSETS)
    let answered = false
    for (const source of SOURCES) {
      if (missing.size === 0) break
      const at = now()
      if ((backoffUntil[source.name] ?? 0) > at) continue
      const parsed = await query(source)
      if (!parsed) {
        backoffUntil[source.name] = now() + backoffMs
        continue
      }
      answered = true
      delete backoffUntil[source.name]
      for (const asset of [...missing]) {
        const value = parsed[asset]
        if (value === undefined) continue
        lastGood[asset] = { value, at: now(), source: source.name }
        missing.delete(asset)
      }
    }
    // A round where something answered is cached; otherwise every source is backing off, so the next attempt waits
    // for the first backoff to end (meanwhile callers get the last good values, within STALE_MS).
    const end = now()
    const pending = Object.values(backoffUntil).filter((t): t is number => typeof t === "number" && t > end)
    nextRefreshAt = answered ? end + cacheTtlMs : pending.length ? Math.min(...pending) : end + backoffMs
  }

  function compose(): UsdRates | null {
    const at = now()
    const rates: UsdRates = { USDC: 1, BTC: Number.NaN, ETH: Number.NaN, XRP: Number.NaN, XAU: Number.NaN, sources: {} }
    let any = false
    for (const asset of ASSETS) {
      const good = lastGood[asset]
      if (!good || at - good.at > staleMs) continue
      rates[asset] = good.value
      rates.sources![asset] = good.source
      any = true
    }
    return any ? rates : null
  }

  return async function fetchUsdRates() {
    if (now() >= nextRefreshAt) {
      if (!inflight) inflight = refresh().finally(() => (inflight = null))
      await inflight
    }
    return compose()
  }
}

/** The process-wide fetcher (logs upstream failures to stderr as JSON, like the rest of the server). */
export const fetchUsdRates = createUsdRatesFetcher({ logger: { warn: (message) => console.warn(message) } })

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

/** USD per troy ounce (ArcoGOLD's unit), or null when the rate is unavailable. */
export function ounceUsd(rates: UsdRates | null | undefined): number | null {
  const value = rates?.XAU
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
}

/** Where an ounce price came from, as reported in the ArcoGOLD savings answer. */
export type OunceUsdSource = "coingecko:pax-gold" | "kraken:paxg"

/** The ounce price with its actual source, or null when unavailable. */
export function ounceQuote(rates: UsdRates | null | undefined): { usd: number; source: OunceUsdSource } | null {
  const usd = ounceUsd(rates)
  if (usd === null) return null
  return { usd, source: rates?.sources?.XAU === "kraken" ? "kraken:paxg" : "coingecko:pax-gold" }
}
