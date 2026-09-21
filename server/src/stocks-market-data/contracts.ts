export const MARKET_CONTEXT = Object.freeze({ schemaVersion: 1, profile: 'DEMO_TESTNET', chainId: 91342, purpose: 'DISPLAY_ONLY', priceBasis: 'UNDERLYING_SECURITY', provider: 'MASSIVE', executionPriceSource: 'FIXED_MOCK_PRICE' } as const);
export type FeedDelay = 'UNKNOWN' | 'DELAYED_15_MIN' | 'END_OF_DAY' | 'REALTIME';
export type DataStatus = 'AVAILABLE' | 'STALE' | 'UNAVAILABLE' | 'UNCONFIGURED';
export type DataReason = 'NOT_CONFIGURED' | 'PROVIDER_UNAUTHORIZED' | 'PROVIDER_RATE_LIMITED' | 'REQUEST_BUDGET_EXHAUSTED' | 'PROVIDER_UNAVAILABLE' | 'TIMEOUT' | 'INVALID_RESPONSE' | 'RESPONSE_TOO_LARGE' | 'NOT_FOUND' | 'MISSING_OBSERVATION' | 'OLD_OBSERVATION' | 'EMPTY_HISTORY' | null;
export type ChartRange = '1D' | '1W' | '1M' | '3M' | '1Y';
export interface Security { symbol: string; name: string; exchange?: string; isin?: string; rank?: number }
export interface Provenance { sourceUrl: string | null; rankingMetric: string | null; period: string | null; asOfDate: string | null; verification: 'PILOT' | 'CURATED' | 'VERIFIED' }
export interface DisplayCatalog { securities: readonly Security[]; provenance: Provenance }
export interface Availability { status: DataStatus; reason: DataReason; fetchedAt: string | null; cacheAgeMs: number | null; feedDelay: FeedDelay }
export type MarketProvider = 'MASSIVE' | 'ALPACA';
export type MarketFeed = 'IEX' | 'SIP';
export type MarketResponse<T> = Omit<typeof MARKET_CONTEXT, 'provider'> & { provider: MarketProvider; marketFeed?: MarketFeed } & Availability & { data: T | null };
export interface Quote { symbol: string; currency: 'USD'; price: string | null; change: string | null; changePercent: string | null; sessionVolume: string | null; previousClose: string | null; sourceTimestamp: string | null; observationAgeMs: number | null; priceSource: 'LAST_TRADE' | 'MINUTE_CLOSE' | null; status: DataStatus; reason: DataReason }
export interface CompanyProfile { symbol: string; name: string; description: string | null; exchange: string | null; securityType: string | null; currency: 'USD'; marketCap: string | null; aum?: string | null; aumAsOf?: string | null; website: string | null; industry: string | null; logoUrl: string | null; sourceDate: string | null }
export interface Bar { timestamp: string; open: string; high: string; low: string; close: string; volume: string }
export interface Chart { symbol: string; currency: 'USD'; range: ChartRange; interval: '5m' | '1h' | '1d'; adjustedForSplits: true; from: string; to: string; bars: Bar[]; history: 'RETURNED_WINDOW' | 'TRUNCATED' | 'EMPTY'; complete: boolean }
export interface Logo { bytes: Uint8Array; contentType: 'image/png' | 'image/jpeg' | 'image/webp' }
export class MarketDataError extends Error {
  constructor(readonly reason: Exclude<DataReason, null>, readonly cooldownMs = 0) { super(reason); }
}
export const PILOT_CATALOG: DisplayCatalog = Object.freeze({ securities: Object.freeze([{ symbol: 'NVDA', name: 'NVIDIA' }]), provenance: { sourceUrl: null, rankingMetric: null, period: null, asOfDate: null, verification: 'PILOT' as const } });
