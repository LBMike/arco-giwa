// EXPLICIT synthetic fixtures for offline tests/browser verification only. Never imported by production views.
import type { Catalog, Chart, Envelope, MarketFetch, Profile, Quote, Range } from "./contracts"
import { CURATED_SELECTION, CURATED_STOCKS, curatedStock } from "./curated"
export const FIXTURE_TIME = "2026-09-16T12:00:00.000Z"
export const CONTEXT = { schemaVersion: 1, profile: "DEMO_TESTNET", chainId: 91342, purpose: "DISPLAY_ONLY", priceBasis: "UNDERLYING_SECURITY", provider: "MASSIVE", executionPriceSource: "FIXED_MOCK_PRICE" }
export function fixtureEnvelope<T>(data: T | null, status: Envelope<T>["status"] = "AVAILABLE") { return { ...CONTEXT, status, reason: status === "UNCONFIGURED" ? "NOT_CONFIGURED" : status === "STALE" ? "OLD_OBSERVATION" : null, fetchedAt: FIXTURE_TIME, cacheAgeMs: 0, feedDelay: "UNKNOWN", data } }
export function fixtureCatalog(symbols = ["NVDA", "AAPL"]): Catalog { return { securities: symbols.map(symbol => ({ symbol, name: symbol === "NVDA" ? "NVIDIA" : "Apple", exchange: "XNAS" })), provenance: { verification: symbols.length === 1 ? "PILOT" : "CURATED", sourceUrl: null, rankingMetric: null, period: null, asOfDate: null } } }
export function fixtureQuote(symbol = "NVDA"): Quote { return { symbol, currency: "USD", price: symbol === "NVDA" ? "183.123456789012345678" : "245.5", change: "5.01", changePercent: "2.81", sessionVolume: "123456789.5", previousClose: "178.113456789012345678", sourceTimestamp: FIXTURE_TIME, observationAgeMs: 0, priceSource: "LAST_TRADE", status: "AVAILABLE", reason: null } }
export function fixtureChart(symbol = "NVDA", range: Range = "1D"): Chart {
  const days = { "1D": 1, "1W": 7, "1M": 31, "3M": 93, "1Y": 366 }[range]
  const width = range === "1D" ? 300000 : range === "1W" ? 3600000 : 86400000
  const end = Date.parse(FIXTURE_TIME); const from = end - days * 86400000
  return { symbol, currency: "USD", range, interval: range === "1D" ? "5m" : range === "1W" ? "1h" : "1d", adjustedForSplits: true, from: new Date(from).toISOString(), to: FIXTURE_TIME, history: "RETURNED_WINDOW", complete: true, seed: null, fallback: null, fallbackBars: [], bars: Array.from({ length: 12 }, (_, index) => { const value = String(170 + index); return { timestamp: new Date(end - (14 - index) * width).toISOString(), open: value, close: value, high: String(171 + index), low: String(169 + index), volume: "1000" } }) }
}
export function fixtureProfile(symbol = "NVDA"): Profile { return { symbol, name: symbol === "NVDA" ? "NVIDIA" : "Apple", currency: "USD", description: "명시적 오프라인 fixture 기업정보입니다. 실제 시세나 투자 정보가 아닙니다.", exchange: "XNAS", securityType: "CS", marketCap: "123456789012345678901234.56", website: null, industry: "Fixture industry", logoUrl: null, sourceDate: null } }
export function fixtureMarketFetch(mode: "ready" | "keyless" | "stale" | "partial" | "empty" | "one" = "ready", symbols = ["NVDA", "AAPL"]): MarketFetch {
  return async (url) => {
    const path = new URL(url).pathname; const name = path.split("/")[path.split("/").length - 2] ?? "NVDA"
    if (path.endsWith("/catalog")) return Response.json(fixtureEnvelope(fixtureCatalog(symbols)))
    if (path.endsWith("/quotes")) return Response.json(fixtureEnvelope([...symbols].reverse().map(symbol => mode === "keyless" ? { ...fixtureQuote(symbol), status: "UNCONFIGURED", reason: "NOT_CONFIGURED", price: null, change: null, changePercent: null, sessionVolume: null, previousClose: null, sourceTimestamp: null, observationAgeMs: null, priceSource: null } : { ...fixtureQuote(symbol), status: mode === "stale" ? "STALE" : "AVAILABLE", reason: mode === "stale" ? "OLD_OBSERVATION" : null }), mode === "keyless" ? "UNCONFIGURED" : mode === "stale" ? "STALE" : "AVAILABLE"))
    if (mode === "keyless") return Response.json(fixtureEnvelope(null, "UNCONFIGURED"))
    if (path.endsWith("/profile")) return Response.json(fixtureEnvelope(fixtureProfile(name)))
    if (path.endsWith("/dividend")) return Response.json({ ...fixtureEnvelope(null, "UNAVAILABLE"), reason: "NOT_FOUND" })
    if (path.endsWith("/chart")) {
      const chart = fixtureChart(name, new URL(url).searchParams.get("range") as Range)
      if (mode === "partial") { chart.complete = false; chart.history = "TRUNCATED"; chart.bars.splice(4, 3) }
      if (mode === "empty") { chart.history = "EMPTY"; chart.bars = [] }
      if (mode === "one") chart.bars = chart.bars.slice(0, 1)
      return Response.json(fixtureEnvelope(chart, mode === "stale" ? "STALE" : "AVAILABLE"))
    }
    return Response.json({}, { status: 404 })
  }
}

// Synthetic 40-symbol market for tests and the preview only: the curated rows with invented, deterministic values.
// Nothing here is a real quote, volume, chart or company fact.
export const TOP40_UNAVAILABLE: readonly string[] = ["SCHD", "NBIS"]
export const TOP40_STALE: readonly string[] = ["SGOV"]
export const TOP40_FLAT = "QQQ"
type Top40Options = { unavailable?: readonly string[]; stale?: readonly string[] }
function seed(symbol: string): number { let hash = 2166136261; for (const char of symbol) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619) >>> 0 } return hash }
function fixed(units: bigint, digits: number): string { const negative = units < 0n; const abs = negative ? -units : units; const base = 10n ** BigInt(digits); return `${negative ? "-" : ""}${abs / base}.${String(abs % base).padStart(digits, "0")}` }
function divide(numerator: bigint, denominator: bigint): bigint { const quotient = numerator / denominator, remainder = numerator % denominator; return remainder * 2n >= denominator ? quotient + 1n : remainder * 2n <= -denominator ? quotient - 1n : quotient }
/** Price and previous close in cents; QQQ is unchanged so the neutral state is visible. */
function levels(symbol: string) { const hash = seed(symbol); const price = 1000n + BigInt(hash % 90000); const bps = symbol === TOP40_FLAT ? 0n : BigInt(((hash >>> 8) % 801) - 400); return { hash, price, previous: divide(price * 10000n, 10000n + bps) } }
export function fixtureTop40Catalog(): Catalog { return { securities: CURATED_STOCKS.map(item => ({ symbol: item.symbol, name: item.name, isin: item.isin, rank: item.rank })), provenance: { verification: "CURATED", sourceUrl: null, rankingMetric: `${CURATED_SELECTION.source} ${CURATED_SELECTION.metric}`, period: CURATED_SELECTION.period, asOfDate: CURATED_SELECTION.retrievedDate } } }
export function fixtureTop40Quote(symbol: string, options: Top40Options = {}): Quote {
  if ((options.unavailable ?? TOP40_UNAVAILABLE).includes(symbol)) return { symbol, currency: "USD", price: null, change: null, changePercent: null, sessionVolume: null, previousClose: null, sourceTimestamp: null, observationAgeMs: null, priceSource: null, status: "UNAVAILABLE", reason: "MISSING_OBSERVATION" }
  const stale = (options.stale ?? TOP40_STALE).includes(symbol); const { hash, price, previous } = levels(symbol)
  return { symbol, currency: "USD", price: fixed(price, 2), change: fixed(price - previous, 2), changePercent: fixed(divide((price - previous) * 1_000_000n, previous), 4), sessionVolume: String(100_000 + (hash % 50_000_000)), previousClose: fixed(previous, 2), sourceTimestamp: FIXTURE_TIME, observationAgeMs: stale ? 5_400_000 : 0, priceSource: "LAST_TRADE", status: stale ? "STALE" : "AVAILABLE", reason: stale ? "OLD_OBSERVATION" : null }
}
export function fixtureTop40Quotes(options: Top40Options = {}): Quote[] { return CURATED_STOCKS.map(item => fixtureTop40Quote(item.symbol, options)) }
export function fixtureTop40Profile(symbol: string): Profile { const item = curatedStock(symbol); return { symbol, name: item?.name ?? symbol, currency: "USD", description: "명시적 오프라인 fixture 기업정보입니다. 실제 시세나 투자 정보가 아닙니다.", exchange: null, securityType: item?.kind === "ETF" ? "ETF" : item?.detail === "ADS" ? "ADRC" : "CS", marketCap: null, website: null, industry: null, logoUrl: null, sourceDate: null } }
/** Bars end at the quote price; 1D starts at the previous close. Valid for parseChart in every range. */
export function fixtureTop40Chart(symbol: string, range: Range = "1D"): Chart {
  const days = { "1D": 1, "1W": 7, "1M": 31, "3M": 93, "1Y": 366 }[range]; const count = { "1D": 96, "1W": 120, "1M": 22, "3M": 64, "1Y": 250 }[range]
  const width = range === "1D" ? 300000 : range === "1W" ? 3600000 : 86400000; const end = Date.parse(FIXTURE_TIME)
  const { hash, price, previous } = levels(symbol); const reach = { "1D": 1n, "1W": 3n, "1M": 6n, "3M": 10n, "1Y": 20n }[range]
  let start = price - (price - previous) * reach; if (start < 100n) start = 100n
  const waves = 3 + (hash % 4); const amplitude = Number(price) / 100
  const closes = Array.from({ length: count }, (_, index) => { const value = start + divide((price - start) * BigInt(index), BigInt(count - 1)) + BigInt(Math.round(amplitude * Math.sin(Math.PI * index * waves / (count - 1)))); return index === count - 1 ? price : value < 1n ? 1n : value })
  const bars = closes.map((close, index) => { const open = index ? closes[index - 1] : close; const pad = BigInt(1 + (hash % 5)); const low = (open < close ? open : close) - pad; return { timestamp: new Date(end - (count - index) * width).toISOString(), open: fixed(open, 2), high: fixed((open > close ? open : close) + pad, 2), low: fixed(low < 1n ? 1n : low, 2), close: fixed(close, 2), volume: String(1000 + ((hash >>> (index % 16)) % 5000)) } })
  return { symbol, currency: "USD", range, interval: range === "1D" ? "5m" : range === "1W" ? "1h" : "1d", adjustedForSplits: true, from: new Date(end - days * 86400000).toISOString(), to: FIXTURE_TIME, history: "RETURNED_WINDOW", complete: true, seed: null, fallback: null, fallbackBars: [], bars }
}
export function fixtureTop40MarketFetch(options: Top40Options = {}): MarketFetch {
  return async (url) => {
    const parsed = new URL(url); const path = parsed.pathname; const parts = path.split("/"); const name = parts[parts.length - 2] ?? ""
    if (path.endsWith("/catalog")) return Response.json(fixtureEnvelope(fixtureTop40Catalog()))
    if (path.endsWith("/quotes")) return Response.json(fixtureEnvelope(fixtureTop40Quotes(options)))
    if (!curatedStock(name)) return Response.json({}, { status: 404 })
    if (path.endsWith("/profile")) return Response.json(fixtureEnvelope(fixtureTop40Profile(name)))
    if (path.endsWith("/dividend")) return Response.json({ ...fixtureEnvelope(null, "UNAVAILABLE"), reason: "NOT_FOUND" })
    if (path.endsWith("/chart")) {
      if ((options.unavailable ?? TOP40_UNAVAILABLE).includes(name)) return Response.json({ ...fixtureEnvelope(null, "UNAVAILABLE"), reason: "MISSING_OBSERVATION" })
      return Response.json(fixtureEnvelope(fixtureTop40Chart(name, parsed.searchParams.get("range") as Range), (options.stale ?? TOP40_STALE).includes(name) ? "STALE" : "AVAILABLE"))
    }
    return Response.json({}, { status: 404 })
  }
}
