// Browser DTOs for docs/contracts/stocks-market-data-v1.md; no server/runtime imports.
export type Status = "AVAILABLE" | "STALE" | "UNAVAILABLE" | "UNCONFIGURED"
export type FeedDelay = "UNKNOWN" | "DELAYED_15_MIN" | "END_OF_DAY" | "REALTIME"
export type Range = "1D" | "1W" | "1M" | "3M" | "1Y"
export const RANGES: readonly Range[] = ["1D", "1W", "1M", "3M", "1Y"]
export type MarketProvider = "MASSIVE" | "ALPACA"
export type MarketFeed = "IEX" | "SIP"
export type Envelope<T> = { provider?: MarketProvider; marketFeed?: MarketFeed; status: Status; reason: string | null; fetchedAt: string | null; cacheAgeMs: number | null; feedDelay: FeedDelay; data: T | null }
export type Security = { symbol: string; name: string; exchange?: string; isin?: string; rank?: number }
export type Catalog = { securities: Security[]; provenance: { sourceUrl: string | null; rankingMetric: string | null; period: string | null; asOfDate: string | null; verification: "PILOT" | "CURATED" | "VERIFIED" } }
export type Quote = { symbol: string; currency: "USD"; price: string | null; change: string | null; changePercent: string | null; sessionVolume: string | null; previousClose: string | null; sourceTimestamp: string | null; observationAgeMs: number | null; priceSource: "LAST_TRADE" | "MINUTE_CLOSE" | null; status: Status; reason: string | null }
export type Profile = { symbol: string; name: string; currency: "USD"; description: string | null; exchange: string | null; securityType: string | null; marketCap: string | null; sharesOutstanding?: string | null; aum?: string | null; aumAsOf?: string | null; website: string | null; industry: string | null; logoUrl: string | null; sourceDate: string | null }
export type Bar = { timestamp: string; open: string; high: string; low: string; close: string; volume: string }
export type Chart = { symbol: string; currency: "USD"; range: Range; interval: "5m" | "1h" | "1d"; adjustedForSplits: true; from: string; to: string; bars: Bar[]; history: "RETURNED_WINDOW" | "TRUNCATED" | "EMPTY"; complete: boolean }
export type MarketFetch = (url: string, init: RequestInit) => Promise<Response>
