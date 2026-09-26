import { createHash } from 'node:crypto';
import { MARKET_CONTEXT, PILOT_CATALOG, MarketDataError, type Chart, type ChartRange, type CompanyProfile, type DataReason, type DataStatus, type DisplayCatalog, type Dividend, type FeedDelay, type Logo, type MarketResponse, type Quote } from './contracts.js';
import { chart, chartPath, dividend as normalizeDividend, etfAssets, profile, quotes, RANGE_RULES, type InternalProfile } from './normalize.js';
import { alpacaChart, alpacaChartPath, alpacaQuotes } from './alpaca.js';
import { issuerFundamentals } from './issuer.js';
import { AlpacaTransport, MassiveTransport, IssuerTransport } from './transport.js';
import { loadProfileDiskCache, profileCachePath, saveProfileDiskCache, type ProfileCacheEntry } from './profile-disk-cache.js';
import { snapshotSourceTimestamp, validatedSnapshotData, type MarketSnapshotStore } from './snapshot-store.js';
import { isProfileStoreKey } from './profile-store.js';

export interface StocksMarketDataOptions {
  apiKey?: string;
  provider?: 'MASSIVE' | 'ALPACA';
  alpacaKeyId?: string;
  alpacaSecretKey?: string;
  alpacaFeed?: 'iex' | 'sip';
  catalog?: DisplayCatalog;
  feedDelay?: FeedDelay;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  requestsPerMinute?: number;
  massiveRequestsPerMinute?: number;
  etfGlobalEnabled?: boolean;
  issuerFundamentalsEnabled?: boolean;
  /** Explicit, local-only path for validated public company facts. Omit to keep an in-memory cache. */
  profileCachePath?: string;
  /** Optional durable store for validated public market facts. */
  snapshotStore?: MarketSnapshotStore;
  /**
   * Optional durable store for the company facts only (profile, AUM and issuer entries): a restart restores them at once.
   * Quotes and charts keep their in-memory policy. Ignored when snapshotStore is set (it already keeps every key).
   */
  profileStore?: MarketSnapshotStore;
}
export interface StocksMarketDataService {
  catalog(): MarketResponse<DisplayCatalog>;
  quotes(): Promise<MarketResponse<Quote[]>>;
  profile(symbol: string): Promise<MarketResponse<CompanyProfile>>;
  dividend(symbol: string): Promise<MarketResponse<Dividend>>;
  chart(symbol: string, range: ChartRange): Promise<MarketResponse<Chart>>;
  logo(symbol: string): Promise<MarketResponse<Logo>>;
  hasSymbol(symbol: string): boolean;
}
interface Entry { data?: unknown; fetched?: number; retryAt: number; reason: DataReason }
const POLICY = { quotes: { ttl: 15000, maxAge: 300000 }, profile: { ttl: 86400000, maxAge: 604800000 }, dividend: { ttl: 86400000, maxAge: 86400000 }, chart: { ttl: 60000, maxAge: 900000 }, logo: { ttl: 86400000, maxAge: 604800000 } } as const;
const BAD_CONFIG = () => { throw new Error('INVALID_MARKET_DATA_CONFIG'); };
function validDate(value: unknown): boolean { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
function validateCatalog(input: DisplayCatalog): DisplayCatalog {
  if (!input || !Array.isArray(input.securities) || input.securities.length < 1 || input.securities.length > 40 || !input.provenance) return BAD_CONFIG();
  const names = new Set<string>(); const ranks = new Set<number>();
  for (const security of input.securities) {
    if (!security || typeof security.symbol !== 'string' || !/^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,3})?$/.test(security.symbol) || names.has(security.symbol) || typeof security.name !== 'string' || !security.name.trim() || security.name.length > 200) return BAD_CONFIG();
    names.add(security.symbol);
    if (security.exchange !== undefined && (typeof security.exchange !== 'string' || !/^[A-Z0-9]{2,12}$/.test(security.exchange))) return BAD_CONFIG();
    if (security.isin !== undefined && (typeof security.isin !== 'string' || !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(security.isin))) return BAD_CONFIG();
    if (security.rank !== undefined) { if (!Number.isInteger(security.rank) || security.rank < 1 || security.rank > 40 || ranks.has(security.rank)) return BAD_CONFIG(); ranks.add(security.rank); }
  }
  const p = input.provenance;
  if (!['PILOT', 'CURATED', 'VERIFIED'].includes(p.verification) || (p.asOfDate !== null && !validDate(p.asOfDate))) return BAD_CONFIG();
  for (const s of [p.rankingMetric, p.period]) if (s !== null && (typeof s !== 'string' || !s.trim() || s.length > 300)) return BAD_CONFIG();
  if (p.sourceUrl !== null) { try { const u = new URL(p.sourceUrl); if (u.protocol !== 'https:' || u.username || u.password || u.href.length > 2048) return BAD_CONFIG(); } catch { return BAD_CONFIG(); } }
  if (p.verification === 'VERIFIED' && (!p.sourceUrl || !p.asOfDate)) return BAD_CONFIG();
  // Copy only declared public fields. Configuration may contain private extras.
  return { securities: input.securities.map(s => ({ symbol: s.symbol, name: s.name, ...(s.exchange !== undefined ? { exchange: s.exchange } : {}), ...(s.isin !== undefined ? { isin: s.isin } : {}), ...(s.rank !== undefined ? { rank: s.rank } : {}) })), provenance: { sourceUrl: p.sourceUrl, rankingMetric: p.rankingMetric, period: p.period, asOfDate: p.asOfDate, verification: p.verification } };
}
export function createStocksMarketDataService(options: StocksMarketDataOptions = {}): StocksMarketDataService {
  const selected = validateCatalog(options.catalog ?? PILOT_CATALOG); const symbols = selected.securities.map(s => s.symbol);
  const now = options.now ?? Date.now; const delay = options.feedDelay ?? 'UNKNOWN';
  if (!['UNKNOWN', 'DELAYED_15_MIN', 'END_OF_DAY', 'REALTIME'].includes(delay)) return BAD_CONFIG();
  const observationLimit = { UNKNOWN: 20 * 60000, DELAYED_15_MIN: 20 * 60000, END_OF_DAY: 36 * 3600000, REALTIME: 2 * 60000 }[delay];
  const provider = options.provider ?? 'MASSIVE'; const alpacaFeed = options.alpacaFeed ?? 'iex';
  if (!['MASSIVE', 'ALPACA'].includes(provider) || !['iex', 'sip'].includes(alpacaFeed)) return BAD_CONFIG();
  if (options.etfGlobalEnabled !== undefined && typeof options.etfGlobalEnabled !== 'boolean') return BAD_CONFIG();
  if (options.issuerFundamentalsEnabled !== undefined && typeof options.issuerFundamentalsEnabled !== 'boolean') return BAD_CONFIG();
  const issuer = options.issuerFundamentalsEnabled ? new IssuerTransport({ fetch: options.fetch, now, timeoutMs: options.timeoutMs }) : null;
  const transport = options.apiKey ? new MassiveTransport({ apiKey: options.apiKey, fetch: options.fetch, now, timeoutMs: options.timeoutMs, requestsPerMinute: options.massiveRequestsPerMinute ?? options.requestsPerMinute }) : null;
  const alpaca = provider === 'ALPACA' && options.alpacaKeyId && options.alpacaSecretKey ? new AlpacaTransport({ keyId: options.alpacaKeyId, secretKey: options.alpacaSecretKey, fetch: options.fetch, now, timeoutMs: options.timeoutMs, requestsPerMinute: options.requestsPerMinute }) : null;
  const priceTransport = provider === 'ALPACA' ? alpaca : transport;
  const cache = new Map<string, Entry>(); const flights = new Map<string, Promise<void>>();
  const snapshotStore = options.snapshotStore;
  const profileStore = options.profileStore;
  const snapshotScope = createHash('sha256').update(JSON.stringify({ provider, feed: provider === 'ALPACA' ? alpacaFeed : null, delay, symbols: [...symbols].sort() })).digest('hex');
  const hydrated = new Set<string>();
  const diskPath = options.profileCachePath === undefined ? null : profileCachePath(options.profileCachePath);
  const allowed = new Set(symbols);
  if (diskPath) for (const [key, entry] of loadProfileDiskCache(diskPath, allowed, now())) cache.set(key, { ...entry, retryAt: 0, reason: null });
  const saveProfiles = () => {
    if (!diskPath) return;
    const entries = new Map<string, ProfileCacheEntry>();
    for (const [key, entry] of cache) if ((key.startsWith('profile:') || key.startsWith('aum:') || key.startsWith('issuer:')) && entry.data !== undefined && entry.fetched !== undefined) entries.set(key, { data: entry.data as ProfileCacheEntry['data'], fetched: entry.fetched });
    saveProfileDiskCache(diskPath, allowed, entries, now());
  };
  // Retain the accepted source high-water independently of reset/missing snapshots.
  // Only validated catalog symbols can enter this map, so it holds at most 40 keys.
  const latestAcceptedTimestamp = new Map<string, string>();
  const envelope = <T>(status: DataStatus, reason: DataReason, data: T | null, fetched?: number): MarketResponse<T> => ({ ...MARKET_CONTEXT, provider, ...(provider === 'ALPACA' ? { marketFeed: alpacaFeed === 'iex' ? 'IEX' as const : 'SIP' as const } : {}), status, reason, data: data === null ? null : structuredClone(data), fetchedAt: fetched === undefined ? null : new Date(fetched).toISOString(), cacheAgeMs: fetched === undefined ? null : Math.max(0, now() - fetched), feedDelay: delay });
  const checkSymbol = (symbol: string) => { if (!symbols.includes(symbol)) throw new MarketDataError('NOT_FOUND'); };
  async function get<T>(key: string, policy: { ttl: number; maxAge: number }, load: () => Promise<T>): Promise<MarketResponse<T>> {
    const maxAge = snapshotStore && (key === 'quotes' || key.startsWith('chart:')) ? 7 * 86400000 : policy.maxAge;
    const hasTransport = Boolean(key === 'quotes' || key.startsWith('chart:') ? priceTransport : transport);
    // The durable store for this key: every key with snapshotStore, only the company facts with profileStore.
    const store = snapshotStore ?? (profileStore && isProfileStoreKey(key) ? profileStore : undefined);
    if (!hasTransport && !store) return envelope('UNCONFIGURED', 'NOT_CONFIGURED', null);
    let entry = cache.get(key); let time = now();
    if (hasTransport && entry?.data !== undefined && entry.fetched !== undefined && !entry.reason && time - entry.fetched < policy.ttl) return envelope('AVAILABLE', null, entry.data as T, entry.fetched);
    if (!entry || entry.retryAt <= time) {
      let flight = flights.get(key);
      if (!flight) {
        // Keys are exclusively catalog symbols × fixed resource/range keys: <= 321.
        flight = (async () => {
          // A restored row is always provisional until the provider has refreshed it.
          // The source fetch time is retained, so a failed refresh cannot make it fresh.
          if (store && !hydrated.has(key)) {
            if (cache.get(key)?.data === undefined) {
              try {
                const stored = await store.read(snapshotScope, key);
                hydrated.add(key);
                const at = now();
                if (stored && Number.isSafeInteger(stored.fetchedAt) && stored.fetchedAt <= at && at - stored.fetchedAt <= maxAge) {
                  const data = validatedSnapshotData(key, stored.data, symbols, at);
                  if (data !== null) {
                    const fresh = hasTransport && at - stored.fetchedAt < policy.ttl;
                    cache.set(key, { data, fetched: stored.fetchedAt, retryAt: 0, reason: fresh ? null : hasTransport ? 'PROVIDER_UNAVAILABLE' : 'NOT_CONFIGURED' });
                    if (key === 'quotes') for (const q of data as Quote[]) if (q.sourceTimestamp) latestAcceptedTimestamp.set(q.symbol, q.sourceTimestamp);
                  }
                }
              } catch { /* Retry persistence on the next provider attempt. */ }
            } else hydrated.add(key);
          }
          const restored = cache.get(key);
          if (hasTransport && restored?.data !== undefined && restored.fetched !== undefined && !restored.reason && now() - restored.fetched < policy.ttl) return;
          if (!hasTransport) {
            const prior = cache.get(key);
            cache.set(key, { ...prior, retryAt: now() + 30000, reason: 'NOT_CONFIGURED' });
            return;
          }
          try {
            const data = await load();
            if (key === 'quotes') {
              const batch = data as Quote[];
              for (const q of batch) if (q.sourceTimestamp && latestAcceptedTimestamp.get(q.symbol) && q.sourceTimestamp < latestAcceptedTimestamp.get(q.symbol)!) throw new MarketDataError('INVALID_RESPONSE');
              const prior = cache.get(key), previous = prior?.data as Quote[] | undefined;
              if (snapshotStore && Array.isArray(previous) && prior?.fetched !== undefined && now() - prior.fetched <= maxAge && batch.some((q, i) => q.price === null && previous[i]?.price !== null && previous[i]?.price !== undefined)) {
                // The database rejects this partial batch to preserve per-symbol source
                // high-water. Keep the same complete, explicitly stale view in memory.
                cache.set(key, { ...prior, retryAt: now() + 30000, reason: 'MISSING_OBSERVATION' });
                return;
              }
              // Publish high-water updates only after the entire batch validates.
              for (const q of batch) if (q.sourceTimestamp) latestAcceptedTimestamp.set(q.symbol, q.sourceTimestamp);
            }
            if (snapshotStore && (key === 'quotes' ? (data as Quote[]).every(q => q.price === null) : key.startsWith('chart:') && (data as Chart).bars.length === 0 && !(data as Chart).seed && (data as Chart).fallbackBars.length === 0)) {
              const prior = cache.get(key);
              if (prior?.data !== undefined && prior.fetched !== undefined && now() - prior.fetched <= maxAge) {
                cache.set(key, { ...prior, retryAt: now() + 30000, reason: key === 'quotes' ? 'MISSING_OBSERVATION' : 'EMPTY_HISTORY' });
                return;
              }
            }
            cache.set(key, { data, fetched: now(), retryAt: 0, reason: null });
            if (key.startsWith('profile:') || key.startsWith('aum:') || key.startsWith('issuer:')) saveProfiles();
            if (store) {
              const fetchedAt = cache.get(key)!.fetched!;
              const publicData = validatedSnapshotData(key, data, symbols, now());
              if (publicData !== null) try {
                await store.write(snapshotScope, key, { data: publicData, fetchedAt, sourceTimestamp: snapshotSourceTimestamp(key, publicData) });
              } catch { /* A database error cannot hide a valid provider response. */ }
            }
          } catch (error) {
            const reason = error instanceof MarketDataError ? error.reason : 'PROVIDER_UNAVAILABLE';
            const prior = cache.get(key); cache.set(key, { ...prior, retryAt: now() + 30000, reason });
          }
        })();
        flights.set(key, flight);
      }
      await flight; if (flights.get(key) === flight) flights.delete(key);
    }
    entry = cache.get(key); time = now();
    if (entry?.data !== undefined && entry.fetched !== undefined && time - entry.fetched <= maxAge) return envelope(entry.reason ? 'STALE' : 'AVAILABLE', entry.reason, entry.data as T, entry.fetched);
    return envelope(hasTransport ? 'UNAVAILABLE' : 'UNCONFIGURED', entry?.reason ?? (hasTransport ? 'PROVIDER_UNAVAILABLE' : 'NOT_CONFIGURED'), null, entry?.fetched);
  }
  const massiveEnvelope = <T>(result: MarketResponse<T>): MarketResponse<T> => { const { marketFeed: _feed, ...rest } = result; return { ...rest, provider: 'MASSIVE' }; };
  async function enrichIssuer(result: MarketResponse<CompanyProfile>): Promise<MarketResponse<CompanyProfile>> {
    const data = result.data;
    if (!issuer || !data || data.securityType !== 'ETF' || !['DRAM', 'RAM'].includes(data.symbol) || data.aum != null) return result;
    const assets = await get(`issuer:${data.symbol}`, POLICY.profile, async () => issuerFundamentals(await issuer.daily(data.symbol), data.symbol, now()));
    if (assets.status !== 'AVAILABLE' || !assets.data || now() - Date.parse(assets.data.issuerFundamentals.asOf) > 7 * 86400000) return result;
    return { ...result, data: { ...data, ...assets.data } };
  }
  const getProfile = (symbol: string) => get<InternalProfile>(`profile:${symbol}`, POLICY.profile, async () => profile(await transport!.json(`/v3/reference/tickers/${symbol}`), symbol));
  return {
    hasSymbol: symbol => symbols.includes(symbol),
    catalog: () => envelope('AVAILABLE', null, selected),
    async quotes() {
      const result = await get<Quote[]>('quotes', POLICY.quotes, async () => provider === 'ALPACA' ? alpacaQuotes(await alpaca!.json(`/v2/stocks/snapshots?symbols=${symbols.join(',')}&feed=${alpacaFeed}`), symbols, now()) : quotes(await transport!.json(`/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${symbols.join(',')}&include_otc=false`), symbols, now()));
      if (!result.data) result.data = symbols.map(symbol => ({ symbol, currency: 'USD', price: null, change: null, changePercent: null, sessionVolume: null, previousClose: null, sourceTimestamp: null, observationAgeMs: null, priceSource: null, status: result.status, reason: result.reason }));
      else {
        for (const q of result.data) {
          if (q.sourceTimestamp) q.observationAgeMs = Math.max(0, now() - Date.parse(q.sourceTimestamp));
          if (q.price && result.status === 'STALE') { q.status = 'STALE'; q.reason = result.reason; }
          if (q.price && q.observationAgeMs! > observationLimit) { q.status = 'STALE'; q.reason = 'OLD_OBSERVATION'; }
        }
        if (result.status === 'AVAILABLE' && result.data.every(q => q.status === 'UNAVAILABLE')) { result.status = 'UNAVAILABLE'; result.reason = 'MISSING_OBSERVATION'; }
        else if (result.status === 'AVAILABLE' && result.data.some(q => q.status === 'STALE')) { result.status = 'STALE'; result.reason = 'OLD_OBSERVATION'; }
      }
      return result;
    },
    async profile(symbol) {
      checkSymbol(symbol);
      const result = massiveEnvelope(await getProfile(symbol));
      const data = result.data?.profile;
      if (!data) return { ...result, data: null };
      if (data.securityType !== 'ETF' || options.etfGlobalEnabled === false) return enrichIssuer({ ...result, data: { ...data, aum: null, aumAsOf: null } });
      // The optional ETF Global entitlement shares the existing transport budget and cache.
      // A denied/missing AUM read must not discard a valid ticker profile or substitute market cap.
      const assets = await get(`aum:${symbol}`, POLICY.profile, async () => etfAssets(await transport!.json(`/etf-global/v1/profiles?composite_ticker=${symbol}&sort=effective_date.desc&limit=1`), symbol));
      return enrichIssuer({ ...result, ...(assets.status === 'STALE' && assets.data?.aum ? { status: 'STALE' as const, fetchedAt: assets.fetchedAt, cacheAgeMs: assets.cacheAgeMs } : {}), reason: assets.reason ?? result.reason, data: { ...data, aum: assets.data?.aum ?? null, aumAsOf: assets.data?.aumAsOf ?? null } });
    },
    async dividend(symbol) {
      checkSymbol(symbol);
      const requested = now();
      const today = new Date(requested).toISOString().slice(0, 10);
      // Cache even the expected empty result, without sharing profile availability.
      const result = massiveEnvelope(await get<{ value: Dividend | null }>(`dividend:${symbol}`, POLICY.dividend, async () => ({ value: normalizeDividend(await transport!.json(`/stocks/v1/dividends?ticker=${symbol}&distribution_type=recurring&ex_dividend_date.lte=${today}&sort=ex_dividend_date.desc&limit=1`), symbol, requested) })));
      if (result.data?.value) return { ...result, data: result.data.value };
      return { ...result, status: result.status === 'AVAILABLE' ? 'UNAVAILABLE' : result.status, reason: result.status === 'AVAILABLE' ? 'NOT_FOUND' : result.reason, data: null };
    },
    async chart(symbol, range) {
      checkSymbol(symbol); if (!Object.prototype.hasOwnProperty.call(RANGE_RULES, range)) throw new MarketDataError('NOT_FOUND');
      const result = await get<Chart>(`chart:${symbol}:${range}`, POLICY.chart, async () => { const requested = now(); return provider === 'ALPACA' ? alpacaChart(await alpaca!.json(alpacaChartPath(symbol, range, requested, alpacaFeed)), symbol, range, requested) : chart(await transport!.json(chartPath(symbol, range, requested)), symbol, range, requested); });
      if (result.status === 'AVAILABLE' && result.data?.history === 'EMPTY') result.reason = 'EMPTY_HISTORY';
      return result;
    },
    async logo(symbol) {
      checkSymbol(symbol);
      return massiveEnvelope(await get<Logo>(`logo:${symbol}`, POLICY.logo, async () => {
        const p = await getProfile(symbol);
        if (!p.data) throw new MarketDataError(p.reason ?? 'NOT_FOUND');
        if (!p.data.iconPath) throw new MarketDataError('NOT_FOUND');
        return transport!.logo(p.data.iconPath);
      }));
    },
  };
}
