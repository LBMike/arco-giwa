import { MarketDataError, type Chart, type ChartRange, type Quote } from './contracts.js';
import { decimal, object, optionalDecimal, scaled } from './exact-json.js';
import { chartWindow, RANGE_RULES } from './normalize.js';

const invalid = (): never => { throw new MarketDataError('INVALID_RESPONSE'); };
function timestamp(value: unknown, now: number): number {
  // Alpaca timestamps use RFC3339 UTC, optionally with nanosecond precision.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return invalid();
  const result = Date.parse(value);
  if (!Number.isFinite(result) || result < 946684800000 || result > now + 60000 || new Date(result).toISOString().slice(0, 19) !== value.slice(0, 19)) return invalid();
  return result;
}
const sessionDate = (time: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(time);
function positive(value: unknown): string { const result = decimal(value); if (scaled(result) <= 0n) return invalid(); return result; }
function unscale(value: bigint): string | null {
  const negative = value < 0n; const digits = (negative ? -value : value).toString().padStart(19, '0');
  if (digits.length - 18 > 30) return null;
  const fraction = digits.slice(-18).replace(/0+$/, '');
  return `${negative ? '-' : ''}${digits.slice(0, -18)}${fraction ? `.${fraction}` : ''}`;
}
export function alpacaQuotes(input: unknown, symbols: readonly string[], now: number): Quote[] {
  const result = object(input);
  if (Object.keys(result).some(symbol => !symbols.includes(symbol))) return invalid();
  return symbols.map(symbol => {
    const q: Quote = { symbol, currency: 'USD', price: null, change: null, changePercent: null, previousClose: null, sessionVolume: null, sourceTimestamp: null, observationAgeMs: null, priceSource: null, status: 'UNAVAILABLE', reason: 'MISSING_OBSERVATION' };
    if (result[symbol] == null) return q;
    const row = object(result[symbol]);
    const choices: { time: number; price: string; source: Quote['priceSource'] }[] = [];
    for (const [key, priceKey, source] of [['latestTrade', 'p', 'LAST_TRADE'], ['minuteBar', 'c', 'MINUTE_CLOSE']] as const) {
      if (row[key] == null) continue;
      const observation = object(row[key]);
      if (observation[priceKey] == null || observation.t == null) continue;
      const price = decimal(observation[priceKey]);
      if (scaled(price) > 0n) choices.push({ time: timestamp(observation.t, now), price, source });
    }
    choices.sort((a, b) => b.time - a.time);
    const latest = choices[0]; if (!latest) return q;
    Object.assign(q, { price: latest.price, sourceTimestamp: new Date(latest.time).toISOString(), observationAgeMs: Math.max(0, now - latest.time), priceSource: latest.source, status: 'AVAILABLE', reason: null });
    // Snapshot daily bars can refer to different sessions around market open/reset.
    // Never multiply today's price by an unrelated previous session's volume.
    if (row.dailyBar != null) {
      const daily = object(row.dailyBar);
      if (daily.t != null && sessionDate(timestamp(daily.t, now)) === sessionDate(latest.time)) q.sessionVolume = optionalDecimal(daily.v);
    }
    const previousCloses: { time: number; close: string }[] = [];
    for (const key of ['dailyBar', 'prevDailyBar'] as const) {
      if (row[key] == null) continue;
      const previous = object(row[key]);
      if (previous.t == null) continue;
      const time = timestamp(previous.t, now);
      if (sessionDate(time) < sessionDate(latest.time)) {
        const close = optionalDecimal(previous.c);
        if (close && scaled(close) > 0n) previousCloses.push({ time, close });
      }
    }
    // Before the first current-session bar, dailyBar still holds the previous close.
    previousCloses.sort((a, b) => b.time - a.time);
    if (previousCloses[0]) {
      q.previousClose = previousCloses[0].close;
      const change = scaled(latest.price) - scaled(q.previousClose);
      q.change = unscale(change);
      q.changePercent = unscale(change * 100n * 10n ** 18n / scaled(q.previousClose));
    }
    return q;
  });
}
export function alpacaChartPath(symbol: string, range: ChartRange, now: number, feed: 'iex' | 'sip'): string {
  const window = chartWindow(range, now);
  const timeframe = range === '1D' ? '5Min' : range === '1W' ? '1Hour' : '1Day';
  const params = new URLSearchParams({ timeframe, start: new Date(window.from).toISOString(), end: new Date(window.to).toISOString(), adjustment: 'split', feed, sort: 'asc', limit: '10000' });
  return `/v2/stocks/${encodeURIComponent(symbol)}/bars?${params}`;
}
export function alpacaChart(input: unknown, symbol: string, range: ChartRange, now: number): Chart {
  const row = object(input); const window = chartWindow(range, now); const rule = RANGE_RULES[range];
  if (row.symbol !== symbol || (row.bars != null && !Array.isArray(row.bars))) return invalid();
  if (row.next_page_token != null && (typeof row.next_page_token !== 'string' || !row.next_page_token || row.next_page_token.length > 4096)) return invalid();
  const entries = (row.bars ?? []) as unknown[];
  if (entries.length > Math.ceil(rule.days * 86400000 / rule.width) + 2) return invalid();
  let previous = 0;
  const bars = entries.map(entry => {
    const bar = object(entry); const time = timestamp(bar.t, now);
    const minSpacing = rule.timespan === 'day' ? 23 * 3600000 : rule.width;
    if (time <= previous || (previous && time - previous < minSpacing) || time < window.from - rule.width || time > window.to) return invalid();
    previous = time;
    const open = positive(bar.o); const high = positive(bar.h); const low = positive(bar.l); const close = positive(bar.c); const volume = decimal(bar.v);
    if (scaled(low) > scaled(high) || scaled(open) < scaled(low) || scaled(open) > scaled(high) || scaled(close) < scaled(low) || scaled(close) > scaled(high)) return invalid();
    return { timestamp: new Date(time).toISOString(), open, high, low, close, volume };
  });
  const truncated = row.next_page_token != null;
  return { symbol, currency: 'USD', range, interval: rule.interval, adjustedForSplits: true, from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString(), bars, history: truncated ? 'TRUNCATED' : bars.length ? 'RETURNED_WINDOW' : 'EMPTY', complete: !truncated };
}
