import { MarketDataError, type Bar, type Chart, type ChartRange, type CompanyProfile, type Dividend, type Quote } from './contracts.js';
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
  return { iconPath, profile: { symbol, name, description: text(row.description, 12000), exchange: text(row.primary_exchange), securityType: text(row.type), currency: 'USD', marketCap: optionalDecimal(row.market_cap), sharesOutstanding: optionalDecimal(row.share_class_shares_outstanding), website, industry: text(row.sic_description, 500), logoUrl: iconPath ? `/api/v1/stocks/market/${symbol}/logo` : null, sourceDate: null } };
}
function calendarDate(input: unknown): string {
  const value = text(input, 10);
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) return invalid();
  return value;
}
/** Only a recent recurring distribution can establish a current payout schedule. */
export function dividend(input: unknown, symbol: string, now: number): Dividend | null {
  const rows = providerObject(input).results;
  if (!Array.isArray(rows) || rows.length > 1) return invalid();
  if (!rows.length) return null;
  const row = object(rows[0]);
  if (row.ticker !== symbol || row.currency !== 'USD' || row.distribution_type !== 'recurring') return invalid();
  const exDividendDate = calendarDate(row.ex_dividend_date);
  const payDate = row.pay_date == null ? null : calendarDate(row.pay_date);
  const cashAmount = positive(row.cash_amount);
  const splitAdjustedCashAmount = row.split_adjusted_cash_amount == null ? null : positive(row.split_adjusted_cash_amount);
  const count = integer(row.frequency);
  if (count < 1n || count > 365n) return invalid();
  const frequency = Number(count);
  const today = new Date(now).toISOString().slice(0, 10);
  if (exDividendDate > today) return invalid();
  const ageDays = (Date.parse(today) - Date.parse(exDividendDate)) / 86400000;
  const maxAgeDays = Math.min(550, Math.max(21, Math.ceil(366 / frequency * 1.5) + 7));
  if (ageDays > maxAgeDays) return null;
  return { symbol, currency: 'USD', cashAmount, splitAdjustedCashAmount, frequency, exDividendDate, payDate };
}
export const RANGE_RULES = Object.freeze({ '1D': { days: 1, multiplier: 5, timespan: 'minute', interval: '5m', width: 300000 }, '1W': { days: 7, multiplier: 1, timespan: 'hour', interval: '1h', width: 3600000 }, '1M': { days: 31, multiplier: 1, timespan: 'day', interval: '1d', width: 86400000 }, '3M': { days: 93, multiplier: 1, timespan: 'day', interval: '1d', width: 86400000 }, '1Y': { days: 366, multiplier: 1, timespan: 'day', interval: '1d', width: 86400000 } } as const);
export function chartWindow(range: ChartRange, now: number) { return { from: now - RANGE_RULES[range].days * 86400000, to: now }; }
// A rolling 24-hour request is empty throughout weekends and market holidays. Fetch a bounded
// calendar-week lookback to find the last pre-window seed or a separate previous-session fallback.
export function chartRequestWindow(range: ChartRange, now: number) { return { from: now - (range === '1D' ? 7 : RANGE_RULES[range].days) * 86400000, to: now }; }
const tradingDateFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
function tradingDate(time: number): string {
  const parts = Object.fromEntries(tradingDateFormatter.formatToParts(time).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function chartSession<T extends { timestamp: string }>(bars: T[], range: ChartRange, now: number): { bars: T[]; seed: T | null; fallback: 'PREVIOUS_SESSION' | null; fallbackBars: T[]; from: string; to: string } {
  const window = chartWindow(range, now);
  const from = new Date(window.from).toISOString(); const to = new Date(window.to).toISOString();
  if (range !== '1D') return { bars, seed: null, fallback: null, fallbackBars: [], from, to };
  const rolling: T[] = []; let seed: T | null = null;
  for (const bar of bars) {
    if (Date.parse(bar.timestamp) < window.from) seed = bar;
    else rolling.push(bar);
  }
  // Keep fallback observations distinct: a prior session can overlap the rolling window.
  let fallbackBars: T[] = [];
  if (rolling.length < 2) {
    const today = tradingDate(now);
    const prior = bars.filter(bar => tradingDate(Date.parse(bar.timestamp)) < today);
    const latestPriorDate = prior.length ? tradingDate(Date.parse(prior[prior.length - 1].timestamp)) : null;
    if (latestPriorDate) {
      const candidate = prior.filter(bar => tradingDate(Date.parse(bar.timestamp)) === latestPriorDate);
      if (candidate.length >= 2) fallbackBars = candidate;
    }
  }
  return { bars: rolling, seed, fallback: fallbackBars.length ? 'PREVIOUS_SESSION' : null, fallbackBars, from, to };
}
export function chartPath(symbol: string, range: ChartRange, now: number): string {
  const rule = RANGE_RULES[range]; const window = chartRequestWindow(range, now);
  return `/v2/aggs/ticker/${symbol}/range/${rule.multiplier}/${rule.timespan}/${window.from}/${window.to}?adjusted=true&sort=asc&limit=50000`;
}
export function chart(input: unknown, symbol: string, range: ChartRange, now: number): Chart {
  const row = providerObject(input); const window = chartRequestWindow(range, now); const rule = RANGE_RULES[range];
  if (row.ticker !== symbol || row.adjusted !== true || (row.results != null && !Array.isArray(row.results))) return invalid();
  const entries = (row.results ?? []) as unknown[];
  // Bound retained chart memory by the selected interval, not just provider bytes.
  const maxBars = Math.ceil((window.to - window.from) / rule.width) + 2;
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
  const session = chartSession(bars, range, now);
  return { symbol, currency: 'USD', range, interval: rule.interval, adjustedForSplits: true, from: session.from, to: session.to, bars: session.bars, seed: session.seed, fallback: session.fallback, fallbackBars: session.fallbackBars, history: truncated ? 'TRUNCATED' : session.bars.length ? 'RETURNED_WINDOW' : 'EMPTY', complete: !truncated };
}

/** ETF Global profiles: AUM is its own measure, never the ticker's market_cap. */
export function etfAssets(input: unknown, symbol: string): { aum: string | null; aumAsOf: string | null } {
  const rows = providerObject(input).results;
  if (!Array.isArray(rows) || rows.length > 1) return invalid();
  if (!rows.length) return { aum: null, aumAsOf: null };
  const row = object(rows[0]);
  if (row.composite_ticker !== symbol || row.product_type !== 'etf') return invalid();
  const date = text(row.effective_date, 10);
  if (date !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) return invalid();
  return { aum: optionalDecimal(row.aum), aumAsOf: date };
}
