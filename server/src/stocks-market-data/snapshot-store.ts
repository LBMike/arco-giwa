import type { Bar, Chart, Quote } from './contracts.js';
import { scaled } from './exact-json.js';
import { RANGE_RULES } from './normalize.js';
import { validateProfileCacheValue, type ProfileCacheValue } from './profile-disk-cache.js';

/** Public, normalized market facts only. The store never receives provider bodies or keys. */
export interface MarketSnapshot {
  data: unknown;
  fetchedAt: number;
  sourceTimestamp: number | null;
}
export interface MarketSnapshotStore {
  read(scope: string, key: string): Promise<MarketSnapshot | null>;
  write(scope: string, key: string, snapshot: MarketSnapshot): Promise<void>;
}

export const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const DECIMAL = /^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?$/;
const POSITIVE = /^(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?$/;
const RECORD = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const amount = (value: unknown, signed = false): value is string | null => value === null || (typeof value === 'string' && (signed ? DECIMAL : POSITIVE).test(value));
const reason = (value: unknown): value is Quote['reason'] => value === null || ['NOT_CONFIGURED', 'PROVIDER_UNAUTHORIZED', 'PROVIDER_RATE_LIMITED', 'REQUEST_BUDGET_EXHAUSTED', 'PROVIDER_UNAVAILABLE', 'TIMEOUT', 'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE', 'NOT_FOUND', 'MISSING_OBSERVATION', 'OLD_OBSERVATION', 'EMPTY_HISTORY'].includes(String(value));

function quote(value: unknown, symbol: string, now: number): Quote | null {
  const row = RECORD(value);
  if (!row || row.symbol !== symbol || row.currency !== 'USD' || !amount(row.price) || !amount(row.change, true) || !amount(row.changePercent, true) || !amount(row.sessionVolume) || !amount(row.previousClose) || !reason(row.reason)) return null;
  if (!['AVAILABLE', 'STALE', 'UNAVAILABLE'].includes(String(row.status))) return null;
  if (row.price === null) {
    if (row.sourceTimestamp !== null || row.priceSource !== null || row.observationAgeMs !== null || row.status === 'AVAILABLE') return null;
  } else if (!iso(row.sourceTimestamp) || Date.parse(row.sourceTimestamp) > now + 60000 || !['LAST_TRADE', 'MINUTE_CLOSE'].includes(String(row.priceSource)) || typeof row.observationAgeMs !== 'number' || !Number.isSafeInteger(row.observationAgeMs) || row.observationAgeMs < 0) return null;
  return {
    symbol, currency: 'USD', price: row.price, change: row.change, changePercent: row.changePercent,
    sessionVolume: row.sessionVolume, previousClose: row.previousClose,
    sourceTimestamp: row.sourceTimestamp as string | null, observationAgeMs: row.observationAgeMs as number | null,
    priceSource: row.priceSource as Quote['priceSource'], status: row.status as Quote['status'], reason: row.reason,
  };
}

function bar(value: unknown, now: number): Bar | null {
  const row = RECORD(value);
  if (!row || !iso(row.timestamp) || Date.parse(row.timestamp) > now + 60000 || !amount(row.open) || row.open === null || !amount(row.high) || row.high === null || !amount(row.low) || row.low === null || !amount(row.close) || row.close === null || !amount(row.volume) || row.volume === null) return null;
  const low = scaled(row.low), high = scaled(row.high), open = scaled(row.open), close = scaled(row.close);
  if (low > high || open < low || open > high || close < low || close > high) return null;
  return { timestamp: row.timestamp, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume };
}

function chart(value: unknown, symbol: string, range: Chart['range'], now: number): Chart | null {
  const row = RECORD(value), rule = RANGE_RULES[range];
  if (!row || row.symbol !== symbol || row.currency !== 'USD' || row.range !== range || row.interval !== rule.interval || row.adjustedForSplits !== true || !iso(row.from) || !iso(row.to) || Date.parse(row.from) >= Date.parse(row.to)) return null;
  if (!Array.isArray(row.bars) || !Array.isArray(row.fallbackBars) || row.bars.length + row.fallbackBars.length > 2100 || !['RETURNED_WINDOW', 'TRUNCATED', 'EMPTY'].includes(String(row.history)) || typeof row.complete !== 'boolean' || ![null, 'PREVIOUS_SESSION'].includes(row.fallback as null | string)) return null;
  const from = Date.parse(row.from), to = Date.parse(row.to);
  if (to - from !== rule.days * 86400000 || to > now + 60000 || now - to > 7 * 86400000 + 60000 || row.complete !== (row.history !== 'TRUNCATED')) return null;
  const bars = row.bars.map(v => bar(v, now)), fallbackBars = row.fallbackBars.map(v => bar(v, now)), seed = row.seed === null ? null : bar(row.seed, now);
  if (bars.some(v => v === null) || fallbackBars.some(v => v === null) || (row.seed !== null && !seed)) return null;
  const ordered = (values: (Bar | null)[]) => values.every((v, i) => i === 0 || Date.parse(values[i - 1]!.timestamp) < Date.parse(v!.timestamp));
  const minSpacing = range === '1D' ? rule.width : range === '1W' ? rule.width : 23 * 3600000;
  const spaced = (values: (Bar | null)[]) => values.every((v, i) => i === 0 || Date.parse(v!.timestamp) - Date.parse(values[i - 1]!.timestamp) >= minSpacing);
  const inside = (values: (Bar | null)[], min: number, max: number) => values.every(v => Date.parse(v!.timestamp) >= min && Date.parse(v!.timestamp) <= max);
  if (!ordered(bars) || !ordered(fallbackBars) || !spaced(bars) || !spaced(fallbackBars) || !inside(bars, range === '1D' ? from : from - rule.width, to)) return null;
  if (row.history === 'EMPTY' ? bars.length !== 0 : row.history === 'RETURNED_WINDOW' && bars.length === 0) return null;
  if (range !== '1D' && (seed !== null || row.fallback !== null || fallbackBars.length !== 0)) return null;
  if (seed && (Date.parse(seed.timestamp) >= from || Date.parse(seed.timestamp) < to - 7 * 86400000 - rule.width)) return null;
  if (row.fallback === 'PREVIOUS_SESSION' ? fallbackBars.length < 2 : fallbackBars.length !== 0) return null;
  if (!inside(fallbackBars, to - 7 * 86400000 - rule.width, to)) return null;
  return { symbol, currency: 'USD', range, interval: rule.interval, adjustedForSplits: true, from: row.from, to: row.to, bars: bars as Bar[], seed, fallback: row.fallback as Chart['fallback'], fallbackBars: fallbackBars as Bar[], history: row.history as Chart['history'], complete: row.complete };
}

/** Reconstruct only catalog-bounded DTO fields; reject malformed database JSON. */
export function validatedSnapshotData(key: string, value: unknown, symbols: readonly string[], now: number): Quote[] | Chart | ProfileCacheValue | null {
  const allowed = new Set(symbols);
  let data: Quote[] | Chart | ProfileCacheValue | null = null;
  if (key === 'quotes') {
    if (!Array.isArray(value) || value.length !== symbols.length) return null;
    const rows = value.map((v, i) => quote(v, symbols[i], now));
    if (rows.some(v => v === null) || rows.every(v => v?.price === null)) return null;
    data = rows as Quote[];
  } else if (key.startsWith('chart:')) {
    const parts = key.split(':');
    if (parts.length !== 3 || !allowed.has(parts[1]) || !Object.prototype.hasOwnProperty.call(RANGE_RULES, parts[2])) return null;
    data = chart(value, parts[1], parts[2] as Chart['range'], now);
    if (data && !data.bars.length && !data.seed && !data.fallbackBars.length) return null;
  } else {
    data = validateProfileCacheValue(value, key, allowed);
    if (key.startsWith('aum:') && data && 'aum' in data && data.aum === null) return null;
  }
  if (data === null || Buffer.byteLength(JSON.stringify(data)) > MAX_SNAPSHOT_BYTES) return null;
  return data;
}

export function snapshotSourceTimestamp(key: string, data: Quote[] | Chart | ProfileCacheValue): number | null {
  if (key === 'quotes') {
    const times = (data as Quote[]).map(q => q.sourceTimestamp ? Date.parse(q.sourceTimestamp) : 0);
    return times.length ? Math.max(...times) || null : null;
  }
  if (key.startsWith('chart:')) {
    const c = data as Chart; const times = [...c.bars, ...(c.seed ? [c.seed] : []), ...c.fallbackBars].map(b => Date.parse(b.timestamp));
    return times.length ? Math.max(...times) : null;
  }
  if (key.startsWith('profile:')) {
    const date = (data as { profile: { sourceDate: string | null } }).profile.sourceDate;
    return date ? Date.parse(date) : null;
  }
  const asOf = (data as { aumAsOf?: string | null }).aumAsOf;
  return asOf ? Date.parse(asOf) : null;
}
