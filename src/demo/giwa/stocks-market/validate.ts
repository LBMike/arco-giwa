import type { Bar, Catalog, Chart, Dividend, Envelope, NvdaLiveSnapshot, Profile, Quote, Range, Status } from "./contracts"
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
/** Validate the independent NVDA display contract before any streamed value reaches the UI. */
export function parseNvdaLiveSnapshot(value: unknown): NvdaLiveSnapshot {
  const row = object(value)
  if (row.schemaVersion !== 1 || row.symbol !== "NVDA") return bad()
  const observedAt = timestamp(row.observedAt)
  const underlying = object(row.underlying)
  if (underlying.basis !== "UNDERLYING_SECURITY" || underlying.currency !== "USD") return bad()
  const status = choice(underlying.status, STATUSES)
  const reason = optional(underlying.reason, value => choice(value, REASONS))
  const price = optional(underlying.price, positive)
  const sourceTimestamp = optional(underlying.sourceTimestamp, timestamp)
  const priceSource = optional(underlying.priceSource, value => choice(value, ["LAST_TRADE", "MINUTE_CLOSE"] as const))
  const provider = optional(underlying.provider, value => choice(value, ["ALPACA", "MASSIVE"] as const))
  const marketFeed = optional(underlying.marketFeed, value => choice(value, ["IEX", "SIP"] as const))
  if ((provider === "ALPACA") !== (marketFeed !== null)) return bad()
  if ((status === "AVAILABLE" || status === "STALE") && (price === null || sourceTimestamp === null || priceSource === null)) return bad()
  if ((status === "UNAVAILABLE" || status === "UNCONFIGURED") && price !== null) return bad()
  if (provider === null && price !== null) return bad()
  if (sourceTimestamp !== null && Date.parse(sourceTimestamp) > Date.parse(observedAt) + 60_000) return bad()
  const session = object(row.marketSession)
  const state = choice(session.state, ["OPEN", "CLOSED", "UNKNOWN"] as const)
  const sessionObservedAt = optional(session.observedAt, timestamp)
  const nextOpen = optional(session.nextOpen, timestamp)
  const nextClose = optional(session.nextClose, timestamp)
  if (state === "UNKNOWN") {
    if (sessionObservedAt !== null || nextOpen !== null || nextClose !== null) return bad()
  } else if (sessionObservedAt === null || nextOpen === null || nextClose === null || Date.parse(sessionObservedAt) >= Math.min(Date.parse(nextOpen), Date.parse(nextClose)) || (state === "OPEN") !== (Date.parse(nextClose) < Date.parse(nextOpen))) return bad()
  const token = object(row.token)
  if (token.basis !== "ARCO_TOKEN" || token.indicativePrice !== null || token.status !== "UNAVAILABLE") return bad()
  const execution = object(row.testnetExecution)
  if (execution.mode !== "FIXED_MOCK_PRICE" || execution.quoteRequired !== true) return bad()
  const executionStatus = choice(execution.status, ["CATALOG_ONLY", "UNAVAILABLE"] as const)
  const unitPrice = optional(execution.unitPrice, positive)
  if ((executionStatus === "CATALOG_ONLY") !== (unitPrice !== null)) return bad()
  return {
    schemaVersion: 1, symbol: "NVDA", observedAt,
    underlying: {
      basis: "UNDERLYING_SECURITY", currency: "USD", price,
      change: optional(underlying.change, value => decimal(value, true)),
      changePercent: optional(underlying.changePercent, value => decimal(value, true)),
      sessionVolume: optional(underlying.sessionVolume, decimal),
      previousClose: optional(underlying.previousClose, positive),
      observationAgeMs: optional(underlying.observationAgeMs, count),
      status, reason, sourceTimestamp, priceSource, provider, marketFeed,
      feedDelay: choice(underlying.feedDelay, ["UNKNOWN", "DELAYED_15_MIN", "END_OF_DAY", "REALTIME"] as const),
    },
    marketSession: { state, observedAt: sessionObservedAt, nextOpen, nextClose },
    token: { basis: "ARCO_TOKEN", indicativePrice: null, status: "UNAVAILABLE" },
    testnetExecution: { mode: "FIXED_MOCK_PRICE", status: executionStatus, unitPrice, quoteRequired: true },
  }
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
function date(value: unknown): string {
  const result = text(value, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) return bad()
  return result
}
export function parseDividend(value: unknown, name: string): Dividend {
  const row = object(value)
  if (row.symbol !== name || row.currency !== "USD") return bad()
  const frequency = count(row.frequency)
  if (frequency < 1 || frequency > 365) return bad()
  return { symbol: name, currency: "USD", cashAmount: positive(row.cashAmount), splitAdjustedCashAmount: optional(row.splitAdjustedCashAmount, positive), frequency, exDividendDate: date(row.exDividendDate), payDate: optional(row.payDate, date) }
}
export function parseChart(value: unknown, name: string, range: Range): Chart {
  const r = object(value); const interval = range === "1D" ? "5m" : range === "1W" ? "1h" : "1d"
  if (r.symbol !== name || r.range !== range || r.currency !== "USD" || r.interval !== interval || r.adjustedForSplits !== true || typeof r.complete !== "boolean") return bad()
  const from = timestamp(r.from); const to = timestamp(r.to); if (from >= to) return bad()
  const width = interval === "5m" ? 300000 : interval === "1h" ? 3600000 : 86400000
  const days = { "1D": 1, "1W": 7, "1M": 31, "3M": 93, "1Y": 366 }[range]
  if (Date.parse(to) - Date.parse(from) !== days * 86400000 || !Array.isArray(r.bars) || r.bars.length > Math.ceil(days * 86400000 / width) + 2) return bad()
  const parseBar = (value: unknown): Bar => {
    const b = object(value); const time = timestamp(b.timestamp)
    const open = positive(b.open), high = positive(b.high), low = positive(b.low), close = positive(b.close)
    if (scaled(low) > scaled(high) || scaled(open) < scaled(low) || scaled(open) > scaled(high) || scaled(close) < scaled(low) || scaled(close) > scaled(high)) return bad()
    return { timestamp: time, open, high, low, close, volume: decimal(b.volume) }
  }
  let previous = 0
  const bars: Bar[] = r.bars.map(value => {
    const bar = parseBar(value), ms = Date.parse(bar.timestamp)
    if (ms <= previous || (previous && ms - previous < (interval === "1d" ? 23 * 3600000 : width)) || ms < Date.parse(from) - (range === "1D" ? 0 : width) || ms > Date.parse(to)) return bad(); previous = ms
    return bar
  })
  // A carry-forward baseline is a real pre-window observation, never an in-window bar.
  if (r.seed === undefined || r.fallback === undefined || !Array.isArray(r.fallbackBars)) return bad()
  const seed = r.seed === null ? null : parseBar(r.seed)
  if (seed && (range !== "1D" || Date.parse(seed.timestamp) >= Date.parse(from) || Date.parse(seed.timestamp) < Date.parse(from) - 8 * 86400000)) return bad()
  const fallback = r.fallback === null ? null : choice(r.fallback, ["PREVIOUS_SESSION"] as const)
  if (r.fallbackBars.length > Math.ceil(86400000 / width) + 2) return bad()
  let fallbackPrevious = 0
  const fallbackBars: Bar[] = r.fallbackBars.map(value => {
    const bar = parseBar(value), ms = Date.parse(bar.timestamp)
    if (ms <= fallbackPrevious || (fallbackPrevious && ms - fallbackPrevious < width) || ms > Date.parse(to) || ms < Date.parse(from) - 8 * 86400000) return bad()
    fallbackPrevious = ms
    return bar
  })
  const nyDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
  if (range !== "1D" && (seed !== null || fallback !== null || fallbackBars.length !== 0)) return bad()
  if ((fallback === "PREVIOUS_SESSION") !== (fallbackBars.length >= 2) || (fallback !== null && (bars.length >= 2 || fallbackBars.some(bar => nyDay.format(new Date(bar.timestamp)) !== nyDay.format(new Date(fallbackBars[0].timestamp)))))) return bad()
  const history = choice(r.history, ["RETURNED_WINDOW", "TRUNCATED", "EMPTY"])
  if ((history === "EMPTY" && bars.length !== 0) || (history === "RETURNED_WINDOW" && bars.length === 0) || (history === "TRUNCATED") === r.complete) return bad()
  return { symbol: name, currency: "USD", range, interval, adjustedForSplits: true, from, to, bars, seed, fallback, fallbackBars, history, complete: r.complete }
}
