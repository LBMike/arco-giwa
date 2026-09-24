// Local owner workspace only: read public display data from an explicit loopback
// market host. Execution, wallet, auth and admin routes never cross this adapter.
const ROOT = '/api/v1/stocks/market';
const CONTEXT = Object.freeze({ schemaVersion: 1, profile: 'DEMO_TESTNET', chainId: 91342,
  purpose: 'DISPLAY_ONLY', priceBasis: 'UNDERLYING_SECURITY', executionPriceSource: 'FIXED_MOCK_PRICE' });
const RANGES = new Set(['1D', '1W', '1M', '3M', '1Y']);
const STATUSES = new Set(['AVAILABLE', 'STALE', 'UNAVAILABLE', 'UNCONFIGURED']);
const REASONS = new Set(['NOT_CONFIGURED', 'PROVIDER_UNAUTHORIZED', 'PROVIDER_RATE_LIMITED',
  'REQUEST_BUDGET_EXHAUSTED', 'PROVIDER_UNAVAILABLE', 'TIMEOUT', 'INVALID_RESPONSE',
  'RESPONSE_TOO_LARGE', 'NOT_FOUND', 'MISSING_OBSERVATION', 'OLD_OBSERVATION', 'EMPTY_HISTORY']);
const DELAYS = new Set(['UNKNOWN', 'DELAYED_15_MIN', 'END_OF_DAY', 'REALTIME']);
const SYMBOL = /^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,3})?$/;
// Pinned to server/src/stocks-market-runtime/catalog.ts. A catalog change must
// be reviewed here before this owner-only bridge accepts it as the live feed.
const LIVE_SYMBOLS = new Set('SOXL MU TSLA SNDK GOOGL SOXS SGOV SPCX SCHD NVDA VOO KORU AVGO IONQ MSTR META TQQQ QQQM AMZN IREN QLD SKHY MRK MRVL QQQ SMR JEPQ LITE BE DRAM NBIS PLTR SOXX INTC RAM ORCL MRNA CRCL BMNR RKLB'.split(' '));
const DECIMAL = /^-?(0|[1-9]\d{0,29})(\.\d{1,18})?$/;
const MAX_BYTES = 2_000_000;
const invalid = () => { throw Error('LOCAL_MARKET_INVALID_RESPONSE'); };
const row = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : invalid();
const oneOf = (value, allowed) => allowed.has(value) ? value : invalid();
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : invalid();
function text(value, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) invalid();
  return value;
}
const nullable = (value, parse) => value === null ? null : parse(value);
function timestamp(value) {
  const result = text(value, 24);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) invalid();
  return result;
}
function decimal(value, signed = false, positive = false) {
  if (typeof value !== 'string' || !DECIMAL.test(value) || (!signed && value.startsWith('-')) ||
      (positive && /^0(?:\.0+)?$/.test(value))) invalid();
  return value;
}
function httpsUrl(value, query = false) {
  const result = text(value, 2048);
  let parsed;
  try { parsed = new URL(result); } catch { invalid(); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || (!query && parsed.search)) invalid();
  return parsed.href;
}
function marketSymbol(value) {
  const result = text(value, 14);
  if (!SYMBOL.test(result)) invalid();
  return result;
}
function parseEnvelope(value, parseData, expectedProvider, expectedFeed) {
  const input = row(value);
  for (const [key, expected] of Object.entries(CONTEXT)) if (input[key] !== expected) invalid();
  const provider = oneOf(input.provider, new Set(['MASSIVE', 'ALPACA']));
  const marketFeed = provider === 'ALPACA' ? oneOf(input.marketFeed, new Set(['IEX', 'SIP'])) : undefined;
  if (provider === 'MASSIVE' && input.marketFeed !== undefined) invalid();
  if (expectedProvider && provider !== expectedProvider) invalid();
  if (expectedFeed !== undefined && expectedFeed !== null && marketFeed !== expectedFeed) invalid();
  const status = oneOf(input.status, STATUSES);
  const reason = nullable(input.reason, value => oneOf(value, REASONS));
  const fetchedAt = nullable(input.fetchedAt, timestamp);
  const cacheAgeMs = nullable(input.cacheAgeMs, count);
  const feedDelay = oneOf(input.feedDelay, DELAYS);
  if ((status === 'AVAILABLE' || status === 'STALE') && input.data === null) invalid();
  const data = input.data === null ? null : parseData(input.data);
  if (fetchedAt !== null && Array.isArray(data)) for (const item of data) {
    if (item.sourceTimestamp && Date.parse(item.sourceTimestamp) > Date.parse(fetchedAt) + 60_000) invalid();
  }
  return { ...CONTEXT, provider, ...(marketFeed ? { marketFeed } : {}), status, reason,
    fetchedAt, cacheAgeMs, feedDelay, data };
}
function parseCatalog(value) {
  const input = row(value);
  if (!Array.isArray(input.securities) || input.securities.length < 1 || input.securities.length > 40) invalid();
  const symbols = new Set(), ranks = new Set();
  const securities = input.securities.map(value => {
    const item = row(value), symbol = marketSymbol(item.symbol);
    if (symbols.has(symbol)) invalid();
    symbols.add(symbol);
    const result = { symbol, name: text(item.name) };
    if (item.exchange !== undefined) {
      if (typeof item.exchange !== 'string' || !/^[A-Z0-9]{2,12}$/.test(item.exchange)) invalid();
      result.exchange = item.exchange;
    }
    if (item.isin !== undefined) {
      if (typeof item.isin !== 'string' || !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(item.isin)) invalid();
      result.isin = item.isin;
    }
    if (item.rank !== undefined) {
      const rank = count(item.rank);
      if (rank < 1 || rank > 40 || ranks.has(rank)) invalid();
      ranks.add(rank); result.rank = rank;
    }
    return result;
  });
  const source = row(input.provenance), verification = oneOf(source.verification, new Set(['PILOT', 'CURATED', 'VERIFIED']));
  const sourceUrl = nullable(source.sourceUrl, value => httpsUrl(value, true));
  const asOfDate = nullable(source.asOfDate, value => {
    const date = text(value, 10);
    if (!/^\d{4}-\d\d-\d\d$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) invalid();
    return date;
  });
  if (verification === 'VERIFIED' && (!sourceUrl || !asOfDate)) invalid();
  return { securities, provenance: { sourceUrl,
    rankingMetric: nullable(source.rankingMetric, value => text(value, 300)),
    period: nullable(source.period, value => text(value, 300)), asOfDate, verification } };
}
function parseQuotes(value, symbols) {
  if (!Array.isArray(value) || value.length !== symbols.size) invalid();
  const seen = new Set();
  return value.map(value => {
    const input = row(value), symbol = marketSymbol(input.symbol);
    if (!symbols.has(symbol) || seen.has(symbol) || input.currency !== 'USD') invalid();
    seen.add(symbol);
    const status = oneOf(input.status, STATUSES), reason = nullable(input.reason, value => oneOf(value, REASONS));
    const price = nullable(input.price, value => decimal(value, false, true));
    const sourceTimestamp = nullable(input.sourceTimestamp, timestamp);
    const priceSource = nullable(input.priceSource, value => oneOf(value, new Set(['LAST_TRADE', 'MINUTE_CLOSE'])));
    if ((status === 'AVAILABLE' || status === 'STALE') && (!price || !sourceTimestamp || !priceSource)) invalid();
    if ((status === 'UNAVAILABLE' || status === 'UNCONFIGURED') && price !== null) invalid();
    return { symbol, currency: 'USD', status, reason, price,
      change: nullable(input.change, value => decimal(value, true)),
      changePercent: nullable(input.changePercent, value => decimal(value, true)),
      sessionVolume: nullable(input.sessionVolume, decimal),
      previousClose: nullable(input.previousClose, value => decimal(value, false, true)),
      sourceTimestamp, observationAgeMs: nullable(input.observationAgeMs, count), priceSource };
  });
}
function parseProfile(value, symbol) {
  const input = row(value);
  if (input.symbol !== symbol || input.currency !== 'USD') invalid();
  const logoPath = `${ROOT}/${symbol}/logo`;
  if (input.logoUrl !== null && input.logoUrl !== logoPath) invalid();
  const issuer = input.issuerFundamentals == null ? null : row(input.issuerFundamentals);
  return { symbol, currency: 'USD', name: text(input.name),
    description: nullable(input.description, value => text(value, 12000)),
    exchange: nullable(input.exchange, text), securityType: nullable(input.securityType, text),
    marketCap: nullable(input.marketCap, decimal),
    sharesOutstanding: nullable(input.sharesOutstanding ?? null, decimal),
    aum: nullable(input.aum ?? null, decimal),
    aumAsOf: nullable(input.aumAsOf ?? null, value => text(value, 30)),
    issuerFundamentals: issuer === null ? null : { source: text(issuer.source, 100),
      sourceUrl: httpsUrl(issuer.sourceUrl), asOf: text(issuer.asOf, 10) },
    website: nullable(input.website, httpsUrl), industry: nullable(input.industry, value => text(value, 500)),
    // The local owner API intentionally has no proxied logo route.
    logoUrl: null, sourceDate: nullable(input.sourceDate, value => text(value, 30)) };
}
function parseChart(value, symbol, range) {
  const input = row(value), interval = range === '1D' ? '5m' : range === '1W' ? '1h' : '1d';
  if (input.symbol !== symbol || input.range !== range || input.currency !== 'USD' || input.interval !== interval ||
      input.adjustedForSplits !== true || typeof input.complete !== 'boolean') invalid();
  const from = timestamp(input.from), to = timestamp(input.to);
  if (from >= to) invalid();
  const width = interval === '5m' ? 300000 : interval === '1h' ? 3600000 : 86400000;
  const days = { '1D': 1, '1W': 7, '1M': 31, '3M': 93, '1Y': 366 }[range];
  if (Date.parse(to) - Date.parse(from) !== days * 86400000 || !Array.isArray(input.bars) ||
      input.bars.length > Math.ceil(days * 86400000 / width) + 2) invalid();
  let previous = 0;
  const bars = input.bars.map(value => {
    const bar = row(value), timestampValue = timestamp(bar.timestamp), time = Date.parse(timestampValue);
    if (time <= previous || (previous && time - previous < (interval === '1d' ? 23 * 3600000 : width)) ||
        time < Date.parse(from) - width || time > Date.parse(to)) invalid();
    previous = time;
    const open = decimal(bar.open, false, true), high = decimal(bar.high, false, true);
    const low = decimal(bar.low, false, true), close = decimal(bar.close, false, true);
    const scaled = value => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0')); };
    if (scaled(low) > scaled(high) || scaled(open) < scaled(low) || scaled(open) > scaled(high) ||
        scaled(close) < scaled(low) || scaled(close) > scaled(high)) invalid();
    return { timestamp: timestampValue, open, high, low, close, volume: decimal(bar.volume) };
  });
  const history = oneOf(input.history, new Set(['RETURNED_WINDOW', 'TRUNCATED', 'EMPTY']));
  if ((history === 'EMPTY' && bars.length !== 0) || (history === 'RETURNED_WINDOW' && bars.length === 0) ||
      (history === 'TRUNCATED') === input.complete) invalid();
  return { symbol, currency: 'USD', range, interval, adjustedForSplits: true,
    from, to, bars, history, complete: input.complete };
}
function loopbackOrigin(value) {
  const match = typeof value === 'string' && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(value);
  if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) throw Error('EXPLICIT_LOOPBACK_MARKET_ORIGIN_REQUIRED');
  return `http://127.0.0.1:${match[1]}`;
}

export async function createMarketDisplayProxy({ origin, fetcher = fetch, timeoutMs = 4000, maxBytes = MAX_BYTES } = {}) {
  const base = loopbackOrigin(origin);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES || typeof fetcher !== 'function')
    throw Error('INVALID_LOCAL_MARKET_BUDGET');
  async function read(path) {
    const target = `${base}${ROOT}/${path}`;
    const controller = new AbortController();
    let timer, reader;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); void reader?.cancel().catch(() => {}); reject(Error('LOCAL_MARKET_TIMEOUT'));
    }, timeoutMs); });
    try {
      const response = await Promise.race([fetcher(target, { method: 'GET', redirect: 'error',
        credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { accept: 'application/json' } }), deadline]);
      if (!response.ok || response.redirected || (response.url && response.url !== target) ||
          !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) invalid();
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) invalid();
      reader = response.body.getReader();
      const parts = []; let bytes = 0;
      for (;;) {
        const part = await Promise.race([reader.read(), deadline]);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBytes) invalid();
        parts.push(part.value);
      }
      const joined = new Uint8Array(bytes); let offset = 0;
      for (const part of parts) { joined.set(part, offset); offset += part.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
    } finally {
      clearTimeout(timer); controller.abort();
      if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} }
    }
  }
  let initial;
  try {
    initial = parseEnvelope(await read('catalog'), parseCatalog);
    if (initial.status !== 'AVAILABLE' || !initial.data || initial.provider !== 'ALPACA' ||
        initial.marketFeed !== 'IEX' || initial.feedDelay !== 'REALTIME' ||
        initial.data.provenance.verification !== 'CURATED' ||
        LIVE_SYMBOLS.size !== 40 || !LIVE_SYMBOLS.has('NVDA') ||
        initial.data.securities.length !== 40 ||
        !initial.data.securities.every(item => LIVE_SYMBOLS.has(item.symbol))) invalid();
  } catch { throw Error('LOCAL_MARKET_UNAVAILABLE'); }
  const symbols = new Set(initial.data.securities.map(item => item.symbol));
  const priceProvider = initial.provider, priceFeed = initial.marketFeed;
  const unavailable = (provider, marketFeed) => ({ ...CONTEXT, provider,
    ...(marketFeed ? { marketFeed } : {}), status: 'UNAVAILABLE', reason: 'PROVIDER_UNAVAILABLE',
    fetchedAt: null, cacheAgeMs: null, feedDelay: initial.feedDelay, data: null });
  const guarded = async (path, parseData, provider = priceProvider, feed = priceFeed) => {
    try { return parseEnvelope(await read(path), parseData, provider, feed); }
    catch { return unavailable(provider, feed); }
  };
  const requireSymbol = symbol => { if (!symbols.has(symbol)) throw Error('UNKNOWN_MARKET_SYMBOL'); };
  return {
    catalog: () => structuredClone(initial),
    hasSymbol: symbol => symbols.has(symbol),
    quotes: () => guarded('quotes', value => parseQuotes(value, symbols)),
    profile: symbol => { requireSymbol(symbol); return guarded(`${symbol}/profile`, value => parseProfile(value, symbol), 'MASSIVE', null); },
    chart: (symbol, range) => { requireSymbol(symbol); if (!RANGES.has(range)) throw Error('INVALID_MARKET_RANGE');
      return guarded(`${symbol}/chart?range=${range}`, value => parseChart(value, symbol, range)); },
    logo: async symbol => { requireSymbol(symbol); return unavailable('MASSIVE', undefined); },
  };
}
