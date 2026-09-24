import type { MarketResponse, Quote } from './contracts.js';
import { createNvdaLiveSnapshot, type NvdaLiveSnapshot, type NvdaLiveSnapshotOptions, type NvdaMarketSession } from './live-snapshot.js';
import type { StocksMarketDataService } from './service.js';

const MAX_CLOSED_REFRESH_MS = 15 * 60_000;
const MAX_CLOCK_AGE_MS = 3 * 60_000;
const CLOSED_CLOCK_REFRESH_MS = 5 * 60_000;

export interface NvdaLiveReaderOptions extends NvdaLiveSnapshotOptions {
  /** A closed-session quote is an observation, never an official closing price. */
  closedQuoteRefreshMs?: number;
}

const unknownSession = (): NvdaMarketSession => ({ state: 'UNKNOWN', observedAt: null, nextOpen: null, nextClose: null });

function validatedSession(value: NvdaMarketSession | undefined, now: number): NvdaMarketSession {
  if (!value || value.state === 'UNKNOWN' || (value.state !== 'OPEN' && value.state !== 'CLOSED')) return unknownSession();
  const observed = Date.parse(value.observedAt ?? '');
  const nextOpen = Date.parse(value.nextOpen ?? '');
  const nextClose = Date.parse(value.nextClose ?? '');
  if (![now, observed, nextOpen, nextClose].every(Number.isFinite) || Math.abs(now - observed) > MAX_CLOCK_AGE_MS) return unknownSession();
  if (nextOpen <= observed || nextClose <= observed) return unknownSession();
  if (value.state === 'OPEN' && (nextClose <= now || nextClose >= nextOpen)) return unknownSession();
  if (value.state === 'CLOSED' && (nextOpen <= now || nextOpen >= nextClose)) return unknownSession();
  return value;
}

function cacheable(result: MarketResponse<Quote[]>): boolean {
  return !!result.data?.some(row => row.symbol === 'NVDA' && row.price !== null && (row.status === 'AVAILABLE' || row.status === 'STALE'));
}

function reusedObservation(result: MarketResponse<Quote[]>, now: number): MarketResponse<Quote[]> {
  return {
    ...result,
    data: result.data?.map(row => {
      if (row.symbol !== 'NVDA' || row.price === null) return row;
      const sourceTime = Date.parse(row.sourceTimestamp ?? '');
      const observationAgeMs = Number.isFinite(sourceTime) ? Math.max(0, now - sourceTime) : row.observationAgeMs;
      return row.status === 'AVAILABLE'
        ? { ...row, observationAgeMs, status: 'STALE' as const, reason: 'OLD_OBSERVATION' as const }
        : { ...row, observationAgeMs };
    }) ?? null,
  };
}

/** Keep display quotes economical while CLOSED. Orders never consume this reader. */
export function createNvdaLiveReader(options: NvdaLiveReaderOptions): () => Promise<NvdaLiveSnapshot> {
  const refreshMs = options.closedQuoteRefreshMs ?? MAX_CLOSED_REFRESH_MS;
  if (!Number.isSafeInteger(refreshMs) || refreshMs < 1 || refreshMs > MAX_CLOSED_REFRESH_MS) {
    throw new Error('INVALID_NVDA_LIVE_READER_CONFIG');
  }
  const now = options.now ?? Date.now;
  let state: NvdaMarketSession['state'] | null = null;
  let generation = 0;
  let cached: { response: MarketResponse<Quote[]>; at: number } | null = null;
  let closedClock: { session: NvdaMarketSession; at: number } | null = null;
  let pending: { generation: number; promise: Promise<MarketResponse<Quote[]>> } | null = null;

  const quotes = (closed: boolean): Promise<MarketResponse<Quote[]>> => {
    const requestedAt = now();
    if (closed && cached && requestedAt >= cached.at && requestedAt - cached.at < refreshMs) {
      return Promise.resolve(reusedObservation(cached.response, requestedAt));
    }
    if (pending?.generation === generation) return pending.promise;
    const readGeneration = generation;
    const promise = Promise.resolve().then(() => options.marketData.quotes()).then(response => {
      if (closed && readGeneration === generation && cacheable(response)) cached = { response, at: now() };
      return response;
    }).finally(() => {
      if (pending?.promise === promise) pending = null;
    });
    pending = { generation: readGeneration, promise };
    return promise;
  };

  return async () => {
    const requestedAt = now();
    let session: NvdaMarketSession;
    if (closedClock && requestedAt >= closedClock.at && requestedAt - closedClock.at < CLOSED_CLOCK_REFRESH_MS &&
        requestedAt < Date.parse(closedClock.session.nextOpen ?? '')) {
      session = closedClock.session;
    } else {
      let clock: NvdaMarketSession | undefined;
      try { clock = await options.marketClock?.get(); } catch { /* Unknown session forces a fresh quote read. */ }
      // Check after the request so a boundary crossed during the clock read
      // cannot reuse the just-ended session's quote.
      const observedAt = now();
      session = validatedSession(clock, observedAt);
      closedClock = session.state === 'CLOSED' ? { session, at: observedAt } : null;
    }
    if (session.state !== state) {
      state = session.state;
      generation++;
      cached = null;
      pending = null;
    }
    const marketData = { quotes: () => quotes(session.state === 'CLOSED') } as StocksMarketDataService;
    return createNvdaLiveSnapshot({
      ...options,
      marketData,
      marketClock: { get: async () => session },
      now,
    });
  };
}
