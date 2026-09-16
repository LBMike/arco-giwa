import { MarketDataError, type Bar, type Chart, type ChartRange, type CompanyProfile, type Quote } from './contracts.js';
import { decimal, integer, object, optionalDecimal, scaled } from './exact-json.js';
import { brandingPath } from './transport.js';

const invalid = (): never => { throw new MarketDataError('INVALID_RESPONSE'); };
export function providerObject(input: unknown): Record<string, unknown> {
  const result = object(input); if (!['OK', 'DELAYED'].includes(String(result.status))) return invalid(); return result;
}
function timestamp(input: unknown, now: number, nanos = false): number {
  const value = integer(input) / (nanos ? 1000000n : 1n);
  if (value < 946684800000n || value > BigInt(now + 60000) || value > BigInt(Number.MAX_SAFE_INTEGER)) return invalid();
  return Number(value);
}
function text(input: unknown, max = 200): string | null {
  if (input == null) return null;
  if (typeof input !== 'string' || !input.trim() || input.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(input)) return invalid();
  return input;
}
function positive(input: unknown): string { const result = decimal(input); if (scaled(result) <= 0n) return invalid(); return result; }
function emptyQuote(symbol: string): Quote { return { symbol, currency: 'USD', price: null, change: null, changePercent: null, previousClose: null, sessionVolume: null, sourceTimestamp: null, observationAgeMs: null, priceSource: null, status: 'UNAVAILABLE', reason: 'MISSING_OBSERVATION' }; }
export function quotes(input: unknown, symbols: readonly string[], now: number): Quote[] {
  const result = providerObject(input);
  if (!Array.isArray(result.tickers) || result.tickers.length > symbols.length) return invalid();
  const found = new Map<string, Quote>();
  for (const item of result.tickers) {
    const row = object(item); const symbol = row.ticker;
    if (typeof symbol !== 'string' || !symbols.includes(symbol) || found.has(symbol)) return invalid();
    const q = emptyQuote(symbol);
    const choices: { time: number; price: string; source: Quote['priceSource'] }[] = [];
    for (const [key, priceKey, nanos, source] of [['lastTrade', 'p', true, 'LAST_TRADE'], ['min', 'c', false, 'MINUTE_CLOSE']] as const) {
      if (row[key] != null) {
        const observation = object(row[key]);
        // Empty snapshot objects/zeroed reset observations are not market prices.
        if (observation[priceKey] != null && observation.t != null && scaled(decimal(observation[priceKey])) > 0n && integer(observation.t) > 0n) choices.push({ time: timestamp(observation.t, now, nanos), price: positive(observation[priceKey]), source });
      }
    }
    choices.sort((a, b) => b.time - a.time);
    if (choices[0]) {
      q.price = choices[0].price; q.sourceTimestamp = new Date(choices[0].time).toISOString(); q.priceSource = choices[0].source;
      q.observationAgeMs = Math.max(0, now - choices[0].time); q.status = 'AVAILABLE'; q.reason = null;
      q.change = optionalDecimal(row.todaysChange, true); q.changePercent = optionalDecimal(row.todaysChangePerc, true);
      if (row.day != null) q.sessionVolume = optionalDecimal(object(row.day).v);
      if (row.prevDay != null) { const previous = optionalDecimal(object(row.prevDay).c); q.previousClose = previous && scaled(previous) > 0n ? previous : null; }
    }
    found.set(symbol, q);
  }
  return symbols.map(symbol => found.get(symbol) ?? emptyQuote(symbol));
}
export interface InternalProfile { profile: CompanyProfile; iconPath: string | null }
export function profile(input: unknown, symbol: string): InternalProfile {
  const row = object(providerObject(input).results);
  if (row.ticker !== symbol || row.locale !== 'us' || row.market !== 'stocks' || row.currency_name !== 'usd') return invalid();
  const name = text(row.name); if (!name) return invalid();
  const iconPath = row.branding == null ? null : brandingPath(object(row.branding).icon_url);
  let website: string | null = null;
  if (typeof row.homepage_url === 'string') { try { const url = new URL(row.homepage_url); if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.href.length <= 2048) website = url.href; } catch { /* Omit unsafe optional links. */ } }
  return { iconPath, profile: { symbol, name, description: text(row.description, 12000), exchange: text(row.primary_exchange), securityType: text(row.type), currency: 'USD', marketCap: optionalDecimal(row.market_cap), website, industry: text(row.sic_description, 500), logoUrl: iconPath ? `/api/v1/stocks/market/${symbol}/logo` : null, sourceDate: null } };
}
export const RANGE_RULES = Object.freeze({ '1D': { days: 1, multiplier: 5, timespan: 'minute', interval: '5m', width: 300000 }, '1W': { days: 7, multiplier: 1, timespan: 'hour', interval: '1h', width: 3600000 }, '1M': { days: 31, multiplier: 1, timespan: 'day', interval: '1d', width: 86400000 }, '3M': { days: 93, multiplier: 1, timespan: 'day', interval: '1d', width: 86400000 }, '1Y': { days: 366, multiplier: 1, timespan: 'day', interval: '1d', width: 86400000 } } as const);
export function chartWindow(range: ChartRange, now: number) { return { from: now - RANGE_RULES[range].days * 86400000, to: now }; }
export function chartPath(symbol: string, range: ChartRange, now: number): string {
  const rule = RANGE_RULES[range]; const window = chartWindow(range, now);
  return `/v2/aggs/ticker/${symbol}/range/${rule.multiplier}/${rule.timespan}/${window.from}/${window.to}?adjusted=true&sort=asc&limit=50000`;
}
export function chart(input: unknown, symbol: string, range: ChartRange, now: number): Chart {
  const row = providerObject(input); const window = chartWindow(range, now); const rule = RANGE_RULES[range];
  if (row.ticker !== symbol || row.adjusted !== true || (row.results != null && !Array.isArray(row.results))) return invalid();
  const entries = (row.results ?? []) as unknown[];
  // Bound retained chart memory by the selected interval, not just provider bytes.
  const maxBars = Math.ceil(rule.days * 86400000 / rule.width) + 2;
  if (entries.length > maxBars) return invalid();
  if (row.resultsCount != null && integer(row.resultsCount) !== BigInt(entries.length)) return invalid();
  if (row.queryCount != null && integer(row.queryCount) > 50000n) return invalid();
  const bars: Bar[] = []; let previous = 0;
  for (const entry of entries) {
    const bar = object(entry); const time = timestamp(bar.t, now);
    // The provider expands the start to its aggregate boundary (including ET days).
    const minSpacing = rule.timespan === 'day' ? 23 * 3600000 : rule.width;
    if (time <= previous || (previous && time - previous < minSpacing) || time < window.from - rule.width || time > window.to) return invalid(); previous = time;
    const open = positive(bar.o); const high = positive(bar.h); const low = positive(bar.l); const close = positive(bar.c); const volume = decimal(bar.v);
    if (scaled(low) > scaled(high) || scaled(open) < scaled(low) || scaled(open) > scaled(high) || scaled(close) < scaled(low) || scaled(close) > scaled(high)) return invalid();
    bars.push({ timestamp: new Date(time).toISOString(), open, high, low, close, volume });
  }
  const truncated = row.next_url != null || (row.queryCount != null && integer(row.queryCount) >= 50000n) || entries.length === 50000;
  return { symbol, currency: 'USD', range, interval: rule.interval, adjustedForSplits: true, from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString(), bars, history: truncated ? 'TRUNCATED' : bars.length ? 'RETURNED_WINDOW' : 'EMPTY', complete: !truncated };
}
