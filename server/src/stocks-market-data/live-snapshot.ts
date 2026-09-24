import type { DataReason, DataStatus, FeedDelay, MarketFeed, MarketProvider, Quote } from './contracts.js';
import type { StocksMarketDataService } from './service.js';

export interface NvdaMarketSession {
  state: 'OPEN' | 'CLOSED' | 'UNKNOWN';
  observedAt: string | null;
  nextOpen: string | null;
  nextClose: string | null;
}

export interface NvdaLiveSnapshot {
  schemaVersion: 1;
  symbol: 'NVDA';
  observedAt: string;
  underlying: {
    basis: 'UNDERLYING_SECURITY';
    currency: 'USD';
    price: string | null;
    change: Quote['change'];
    changePercent: Quote['changePercent'];
    sessionVolume: Quote['sessionVolume'];
    previousClose: Quote['previousClose'];
    observationAgeMs: Quote['observationAgeMs'];
    status: DataStatus;
    reason: DataReason;
    sourceTimestamp: string | null;
    priceSource: Quote['priceSource'];
    provider: MarketProvider | null;
    marketFeed: MarketFeed | null;
    feedDelay: FeedDelay;
  };
  marketSession: NvdaMarketSession;
  token: {
    basis: 'ARCO_TOKEN';
    indicativePrice: null;
    status: 'UNAVAILABLE';
  };
  testnetExecution: {
    mode: 'FIXED_MOCK_PRICE';
    status: 'CATALOG_ONLY' | 'UNAVAILABLE';
    unitPrice: string | null;
    quoteRequired: true;
  };
}

export interface NvdaLiveSnapshotOptions {
  marketData: StocksMarketDataService;
  marketClock?: { get(): Promise<NvdaMarketSession> };
  executionCatalog?: () => {
    instruments: readonly { symbol: string; price: string; priceSource: string; orderCapability: string }[];
  };
  now?: () => number;
}

const unknownSession = (): NvdaMarketSession => ({ state: 'UNKNOWN', observedAt: null, nextOpen: null, nextClose: null });

function safeSession(value: NvdaMarketSession | undefined): NvdaMarketSession {
  if (!value || !['OPEN', 'CLOSED', 'UNKNOWN'].includes(value.state)) return unknownSession();
  const date = (input: unknown): string | null => typeof input === 'string' && Number.isFinite(Date.parse(input)) ? input : null;
  return { state: value.state, observedAt: date(value.observedAt), nextOpen: date(value.nextOpen), nextClose: date(value.nextClose) };
}

function fixedCatalogPrice(readCatalog?: NvdaLiveSnapshotOptions['executionCatalog']): string | null {
  if (!readCatalog) return null;
  try {
    const instrument = readCatalog().instruments.find(row => row.symbol === 'NVDA');
    if (instrument?.priceSource !== 'FIXED_MOCK_PRICE') return null;
    const price = instrument.price;
    if (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/.test(price) || !/[1-9]/.test(price)) return null;
    return price;
  } catch {
    return null;
  }
}

/** Read-only display snapshot. Neither the market row nor catalog price authorizes an order. */
export async function createNvdaLiveSnapshot(options: NvdaLiveSnapshotOptions): Promise<NvdaLiveSnapshot> {
  const [marketResult, clockResult] = await Promise.allSettled([
    Promise.resolve().then(() => options.marketData.quotes()),
    Promise.resolve().then(() => options.marketClock?.get()),
  ]);
  const market = marketResult.status === 'fulfilled' ? marketResult.value : null;
  const row = market?.data?.find(quote => quote.symbol === 'NVDA');
  const unitPrice = fixedCatalogPrice(options.executionCatalog);
  const session = clockResult.status === 'fulfilled' ? safeSession(clockResult.value) : unknownSession();
  return {
    schemaVersion: 1,
    symbol: 'NVDA',
    observedAt: new Date((options.now ?? Date.now)()).toISOString(),
    underlying: {
      basis: 'UNDERLYING_SECURITY',
      currency: 'USD',
      price: row?.price ?? null,
      change: row?.change ?? null,
      changePercent: row?.changePercent ?? null,
      sessionVolume: row?.sessionVolume ?? null,
      previousClose: row?.previousClose ?? null,
      observationAgeMs: row?.observationAgeMs ?? null,
      status: row?.status ?? (market?.status === 'UNCONFIGURED' ? 'UNCONFIGURED' : 'UNAVAILABLE'),
      reason: row ? row.reason : (market?.reason ?? 'MISSING_OBSERVATION'),
      sourceTimestamp: row?.sourceTimestamp ?? null,
      priceSource: row?.priceSource ?? null,
      provider: market?.provider ?? null,
      marketFeed: market?.marketFeed ?? null,
      feedDelay: market?.feedDelay ?? 'UNKNOWN',
    },
    marketSession: session,
    token: { basis: 'ARCO_TOKEN', indicativePrice: null, status: 'UNAVAILABLE' },
    testnetExecution: { mode: 'FIXED_MOCK_PRICE', status: unitPrice === null ? 'UNAVAILABLE' : 'CATALOG_ONLY', unitPrice, quoteRequired: true },
  };
}
