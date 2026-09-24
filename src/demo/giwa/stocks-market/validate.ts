import type { Bar, Catalog, Chart, Envelope, Profile, Quote, Range, Status } from "./contracts"
export class MarketResponseError extends Error { constructor() { super("MARKET_RESPONSE_INVALID") } }
const bad = (): never => { throw new MarketResponseError() }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return bad(); return value as Record<string, unknown> }
function text(value: unknown, max = 200): string { if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) return bad(); return value }
function optional<T>(value: unknown, parse: (value: unknown) => T): T | null { return value === null ? null : parse(value) }
function choice<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== "string" || !allowed.includes(value as T)) return bad(); return value as T }
function count(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return bad(); return value }
export function timestamp(value: unknown): string { const result = text(value, 24); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) return bad(); return result }
export function decimal(value: unknown, signed = false): string { if (typeof value !== "string" || !/^-?(0|[1-9]\d{0,29})(\.\d{1,18})?$/.test(value) || (!signed && value.startsWith("-"))) return bad(); return value }
export function scaled(value: string): bigint { const negative = value.startsWith("-"); const [whole, fraction = ""] = (negative ? value.slice(1) : value).split("."); return (BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"))) * (negative ? -1n : 1n) }
function positive(value: unknown): string { const result = decimal(value); if (scaled(result) <= 0n) return bad(); return result }
export function symbol(value: unknown): string { const result = text(value, 14); if (!/^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,3})?$/.test(result)) return bad(); return result }
function url(value: unknown, allowQuery = false): string { const result = text(value, 2048); let parsed: URL; try { parsed = new URL(result) } catch { return bad() }; if (parsed.protocol !== "https:" || parsed.username || parsed.password || (!allowQuery && (parsed.search || parsed.hash))) return bad(); return parsed.href }
const STATUSES: readonly Status[] = ["AVAILABLE", "STALE", "UNAVAILABLE", "UNCONFIGURED"]
const REASONS = ["NOT_CONFIGURED", "PROVIDER_UNAUTHORIZED", "PROVIDER_RATE_LIMITED", "REQUEST_BUDGET_EXHAUSTED", "PROVIDER_UNAVAILABLE", "TIMEOUT", "INVALID_RESPONSE", "RESPONSE_TOO_LARGE", "NOT_FOUND", "MISSING_OBSERVATION", "OLD_OBSERVATION", "EMPTY_HISTORY"] as const
function availability(row: Record<string, unknown>) { return { status: choice(row.status, STATUSES), reason: optional(row.reason, value => choice(value, REASONS)) } }
export function envelope<T>(value: unknown, parse: (value: unknown) => T): Envelope<T> {
  const row = object(value)
  for (const [key, expected] of Object.entries({ schemaVersion: 1, profile: "DEMO_TESTNET", chainId: 91342, purpose: "DISPLAY_ONLY", priceBasis: "UNDERLYING_SECURITY", executionPriceSource: "FIXED_MOCK_PRICE" })) if (row[key] !== expected) return bad()
  const provider = choice(row.provider, ["MASSIVE", "ALPACA"] as const)
  const marketFeed = provider === "ALPACA" ? choice(row.marketFeed, ["IEX", "SIP"] as const) : undefined
  if (provider === "MASSIVE" && row.marketFeed !== undefined) return bad()
  const a = availability(row)
  if ((a.status === "AVAILABLE" || a.status === "STALE") && row.data === null) return bad()
  const fetchedAt = optional(row.fetchedAt, timestamp)
  if (fetchedAt !== null && Array.isArray(row.data)) for (const item of row.data) {
    const quote = object(item)
    if (quote.sourceTimestamp !== null && quote.sourceTimestamp !== undefined && Date.parse(timestamp(quote.sourceTimestamp)) > Date.parse(fetchedAt) + 60000) return bad()
  }
  return { ...a, provider, ...(marketFeed ? { marketFeed } : {}), fetchedAt, cacheAgeMs: optional(row.cacheAgeMs, count), feedDelay: choice(row.feedDelay, ["UNKNOWN", "DELAYED_15_MIN", "END_OF_DAY", "REALTIME"]), data: optional(row.data, parse) }
}
export function parseCatalog(value: unknown): Catalog {
  const row = object(value); if (!Array.isArray(row.securities) || row.securities.length < 1 || row.securities.length > 40) return bad()
  const names = new Set<string>(); const ranks = new Set<number>()
  const securities = row.securities.map(value => {
    const r = object(value); const name = symbol(r.symbol); if (names.has(name)) return bad(); names.add(name)
    if (r.exchange !== undefined && (typeof r.exchange !== "string" || !/^[A-Z0-9]{2,12}$/.test(r.exchange))) return bad()
    if (r.isin !== undefined && (typeof r.isin !== "string" || !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(r.isin))) return bad()
    if (r.rank !== undefined) { const rank = count(r.rank); if (rank < 1 || rank > 40 || ranks.has(rank)) return bad(); ranks.add(rank) }
    return { symbol: name, name: text(r.name), ...(r.exchange === undefined ? {} : { exchange: r.exchange as string }), ...(r.isin === undefined ? {} : { isin: r.isin as string }), ...(r.rank === undefined ? {} : { rank: r.rank as number }) }
  })
  const p = object(row.provenance)
  const asOfDate = optional(p.asOfDate, value => { const s = text(value, 10); if (!/^\d{4}-\d\d-\d\d$/.test(s) || new Date(s).toISOString().slice(0, 10) !== s) return bad(); return s })
  const verification = choice(p.verification, ["PILOT", "CURATED", "VERIFIED"] as const)
  const sourceUrl = optional(p.sourceUrl, value => url(value, true))
  if (verification === "VERIFIED" && (!sourceUrl || !asOfDate)) return bad()
  return { securities, provenance: { sourceUrl, rankingMetric: optional(p.rankingMetric, v => text(v, 300)), period: optional(p.period, v => text(v, 300)), asOfDate, verification } }
}
export function parseQuotes(value: unknown, symbols: readonly string[]): Quote[] {
  if (!Array.isArray(value) || value.length !== symbols.length) return bad()
  const found = new Set<string>()
  return value.map(value => {
    const r = object(value); const name = symbol(r.symbol); if (!symbols.includes(name) || found.has(name) || r.currency !== "USD") return bad(); found.add(name)
    const a = availability(r); const price = optional(r.price, positive); const sourceTimestamp = optional(r.sourceTimestamp, timestamp)
    const priceSource = optional(r.priceSource, value => choice(value, ["LAST_TRADE", "MINUTE_CLOSE"] as const))
    if ((a.status === "AVAILABLE" || a.status === "STALE") && (price === null || sourceTimestamp === null || priceSource === null)) return bad()
    if ((a.status === "UNAVAILABLE" || a.status === "UNCONFIGURED") && price !== null) return bad()
    return { ...a, symbol: name, currency: "USD", price, sourceTimestamp, priceSource, change: optional(r.change, v => decimal(v, true)), changePercent: optional(r.changePercent, v => decimal(v, true)), sessionVolume: optional(r.sessionVolume, decimal), previousClose: optional(r.previousClose, positive), observationAgeMs: optional(r.observationAgeMs, count) }
  })
}
export function safeLogo(value: unknown, apiBase: string, name: string): string | null {
  if (value === null) return null
  const path = `/api/v1/stocks/market/${symbol(name)}/logo`
  if (value !== path) return bad()
  const base = new URL(apiBase); return new URL(path, base.origin).href
}
export function parseProfile(value: unknown, name: string, apiBase: string): Profile {
  const r = object(value); if (r.symbol !== name || r.currency !== "USD") return bad()
  return { symbol: name, currency: "USD", name: text(r.name), description: optional(r.description, v => text(v, 12000)), exchange: optional(r.exchange, text), securityType: optional(r.securityType, text), marketCap: optional(r.marketCap, decimal), sharesOutstanding: optional(r.sharesOutstanding ?? null, decimal), aum: optional(r.aum ?? null, decimal), aumAsOf: optional(r.aumAsOf ?? null, v => text(v, 30)), issuerFundamentals: optional(r.issuerFundamentals ?? null, value => { const f = object(value); return { source: text(f.source, 100), sourceUrl: url(f.sourceUrl), asOf: text(f.asOf, 10) } }), website: optional(r.website, url), industry: optional(r.industry, v => text(v, 500)), logoUrl: safeLogo(r.logoUrl, apiBase, name), sourceDate: optional(r.sourceDate, v => text(v, 30)) }
}
export function parseChart(value: unknown, name: string, range: Range): Chart {
  const r = object(value); const interval = range === "1D" ? "5m" : range === "1W" ? "1h" : "1d"
  if (r.symbol !== name || r.range !== range || r.currency !== "USD" || r.interval !== interval || r.adjustedForSplits !== true || typeof r.complete !== "boolean") return bad()
  const from = timestamp(r.from); const to = timestamp(r.to); if (from >= to) return bad()
  const width = interval === "5m" ? 300000 : interval === "1h" ? 3600000 : 86400000
  const days = { "1D": 1, "1W": 7, "1M": 31, "3M": 93, "1Y": 366 }[range]
  if (Date.parse(to) - Date.parse(from) !== days * 86400000 || !Array.isArray(r.bars) || r.bars.length > Math.ceil(days * 86400000 / width) + 2) return bad()
  let previous = 0
  const bars: Bar[] = r.bars.map(value => {
    const b = object(value); const time = timestamp(b.timestamp); const ms = Date.parse(time)
    if (ms <= previous || (previous && ms - previous < (interval === "1d" ? 23 * 3600000 : width)) || ms < Date.parse(from) - width || ms > Date.parse(to)) return bad(); previous = ms
    const open = positive(b.open), high = positive(b.high), low = positive(b.low), close = positive(b.close)
    if (scaled(low) > scaled(high) || scaled(open) < scaled(low) || scaled(open) > scaled(high) || scaled(close) < scaled(low) || scaled(close) > scaled(high)) return bad()
    return { timestamp: time, open, high, low, close, volume: decimal(b.volume) }
  })
  const history = choice(r.history, ["RETURNED_WINDOW", "TRUNCATED", "EMPTY"])
  if ((history === "EMPTY" && bars.length !== 0) || (history === "RETURNED_WINDOW" && bars.length === 0) || (history === "TRUNCATED") === r.complete) return bad()
  return { symbol: name, currency: "USD", range, interval, adjustedForSplits: true, from, to, bars, history, complete: r.complete }
}
