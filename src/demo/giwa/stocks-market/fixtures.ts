// EXPLICIT synthetic fixtures for offline tests/browser verification only. Never imported by production views.
import type { Catalog, Chart, Envelope, MarketFetch, Profile, Quote, Range } from "./contracts"
export const FIXTURE_TIME = "2026-09-16T12:00:00.000Z"
export const CONTEXT = { schemaVersion: 1, profile: "DEMO_TESTNET", chainId: 91342, purpose: "DISPLAY_ONLY", priceBasis: "UNDERLYING_SECURITY", provider: "MASSIVE", executionPriceSource: "FIXED_MOCK_PRICE" }
export function fixtureEnvelope<T>(data: T | null, status: Envelope<T>["status"] = "AVAILABLE") { return { ...CONTEXT, status, reason: status === "UNCONFIGURED" ? "NOT_CONFIGURED" : status === "STALE" ? "OLD_OBSERVATION" : null, fetchedAt: FIXTURE_TIME, cacheAgeMs: 0, feedDelay: "UNKNOWN", data } }
export function fixtureCatalog(symbols = ["NVDA", "AAPL"]): Catalog { return { securities: symbols.map(symbol => ({ symbol, name: symbol === "NVDA" ? "NVIDIA" : "Apple", exchange: "XNAS" })), provenance: { verification: symbols.length === 1 ? "PILOT" : "CURATED", sourceUrl: null, rankingMetric: null, period: null, asOfDate: null } } }
export function fixtureQuote(symbol = "NVDA"): Quote { return { symbol, currency: "USD", price: symbol === "NVDA" ? "183.123456789012345678" : "245.5", change: "5.01", changePercent: "2.81", sessionVolume: "123456789.5", previousClose: "178.113456789012345678", sourceTimestamp: FIXTURE_TIME, observationAgeMs: 0, priceSource: "LAST_TRADE", status: "AVAILABLE", reason: null } }
export function fixtureChart(symbol = "NVDA", range: Range = "1D"): Chart {
  const days = { "1D": 1, "1W": 7, "1M": 31, "3M": 93, "1Y": 366 }[range]
  const width = range === "1D" ? 300000 : range === "1W" ? 3600000 : 86400000
  const end = Date.parse(FIXTURE_TIME); const from = end - days * 86400000
  return { symbol, currency: "USD", range, interval: range === "1D" ? "5m" : range === "1W" ? "1h" : "1d", adjustedForSplits: true, from: new Date(from).toISOString(), to: FIXTURE_TIME, history: "RETURNED_WINDOW", complete: true, bars: Array.from({ length: 12 }, (_, index) => { const value = String(170 + index); return { timestamp: new Date(end - (14 - index) * width).toISOString(), open: value, close: value, high: String(171 + index), low: String(169 + index), volume: "1000" } }) }
}
export function fixtureProfile(symbol = "NVDA"): Profile { return { symbol, name: symbol === "NVDA" ? "NVIDIA" : "Apple", currency: "USD", description: "명시적 오프라인 fixture 기업정보입니다. 실제 시세나 투자 정보가 아닙니다.", exchange: "XNAS", securityType: "CS", marketCap: "123456789012345678901234.56", website: null, industry: "Fixture industry", logoUrl: null, sourceDate: null } }
export function fixtureMarketFetch(mode: "ready" | "keyless" | "stale" | "partial" | "empty" | "one" = "ready", symbols = ["NVDA", "AAPL"]): MarketFetch {
  return async (url) => {
    const path = new URL(url).pathname; const name = path.split("/")[path.split("/").length - 2] ?? "NVDA"
    if (path.endsWith("/catalog")) return Response.json(fixtureEnvelope(fixtureCatalog(symbols)))
    if (path.endsWith("/quotes")) return Response.json(fixtureEnvelope([...symbols].reverse().map(symbol => mode === "keyless" ? { ...fixtureQuote(symbol), status: "UNCONFIGURED", reason: "NOT_CONFIGURED", price: null, change: null, changePercent: null, sessionVolume: null, previousClose: null, sourceTimestamp: null, observationAgeMs: null, priceSource: null } : { ...fixtureQuote(symbol), status: mode === "stale" ? "STALE" : "AVAILABLE", reason: mode === "stale" ? "OLD_OBSERVATION" : null }), mode === "keyless" ? "UNCONFIGURED" : mode === "stale" ? "STALE" : "AVAILABLE"))
    if (mode === "keyless") return Response.json(fixtureEnvelope(null, "UNCONFIGURED"))
    if (path.endsWith("/profile")) return Response.json(fixtureEnvelope(fixtureProfile(name)))
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
