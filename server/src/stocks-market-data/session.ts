import { parseExactJson, object } from './exact-json.js';

const CLOCK_URL = 'https://paper-api.alpaca.markets/v2/clock';
const CACHE_MS = 60_000;
const MAX_RESPONSE_BYTES = 8 * 1024;
const MAX_CLOCK_SKEW_MS = 120_000;

export type MarketSessionState = 'OPEN' | 'CLOSED' | 'UNKNOWN';
export interface MarketSession {
  state: MarketSessionState;
  observedAt: string | null;
  nextOpen: string | null;
  nextClose: string | null;
}
export interface AlpacaMarketClockOptions {
  keyId: string;
  secretKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}
export interface AlpacaMarketClock { get(): Promise<MarketSession> }

const unknown = (): MarketSession => ({ state: 'UNKNOWN', observedAt: null, nextOpen: null, nextClose: null });
const credential = (value: string): string => {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(value)) throw new Error('INVALID_MARKET_CLOCK_CONFIG');
  return value;
};

function timestamp(value: unknown): { ms: number; iso: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText = '', zone] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  if (year < 1970 || year > 2100 || hour > 23 || minute > 59 || second > 59) return null;
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) return null;
  let offset = 0;
  if (zone !== 'Z') {
    const zoneHour = Number(zone.slice(1, 3)), zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 14 || zoneMinute > 59 || (zoneHour === 14 && zoneMinute !== 0)) return null;
    offset = (zone[0] === '+' ? 1 : -1) * (zoneHour * 60 + zoneMinute);
  }
  const ms = local.getTime() + Number(fractionText.padEnd(3, '0').slice(0, 3)) - offset * 60_000;
  if (!Number.isFinite(ms)) return null;
  return { ms, iso: new Date(ms).toISOString() };
}

function validatedSession(input: unknown, localNow: number): MarketSession | null {
  let data: Record<string, unknown>;
  try { data = object(input); } catch { return null; }
  const observed = timestamp(data.timestamp), nextOpen = timestamp(data.next_open), nextClose = timestamp(data.next_close);
  if (typeof data.is_open !== 'boolean' || !observed || !nextOpen || !nextClose) return null;
  if (Math.abs(observed.ms - localNow) > MAX_CLOCK_SKEW_MS) return null;
  if (nextOpen.ms <= observed.ms || nextClose.ms <= observed.ms) return null;
  if (data.is_open && nextOpen.ms <= nextClose.ms) return null;
  if (!data.is_open && nextClose.ms <= nextOpen.ms) return null;
  return {
    state: data.is_open ? 'OPEN' : 'CLOSED',
    observedAt: observed.iso,
    nextOpen: nextOpen.iso,
    nextClose: nextClose.iso,
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json' || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error('INVALID_RESPONSE');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(MAX_RESPONSE_BYTES))) {
    void response.body.cancel().catch(() => {});
    throw new Error('INVALID_RESPONSE');
  }
  const reader = response.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error('INVALID_RESPONSE');
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return parseExactJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { void reader.cancel().catch(() => {}); }
}

/** Read-only US equity market session; never authorizes or prices an order. */
export function createAlpacaMarketClock(options: AlpacaMarketClockOptions): AlpacaMarketClock {
  const keyId = credential(options.keyId), secretKey = credential(options.secretKey);
  const timeoutMs = options.timeoutMs ?? 4_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 15_000) throw new Error('INVALID_MARKET_CLOCK_CONFIG');
  const fetcher = options.fetch ?? fetch, now = options.now ?? Date.now;
  let cached: MarketSession | null = null;
  let cachedAt = 0;
  let expiresAt = 0;
  let pending: Promise<MarketSession> | null = null;

  const load = async (): Promise<MarketSession> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('TIMEOUT')); }, timeoutMs);
    });
    try {
      const response = await Promise.race([
        fetcher(CLOCK_URL, {
          method: 'GET',
          headers: { Accept: 'application/json', 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secretKey },
          redirect: 'error',
          signal: controller.signal,
        }),
        deadline,
      ]);
      if (response.status !== 200 || response.redirected || (response.url && response.url !== CLOCK_URL)) {
        void response.body?.cancel().catch(() => {});
        return unknown();
      }
      const raw = await Promise.race([readBoundedJson(response), deadline]);
      const receivedAt = now();
      return Number.isFinite(receivedAt) ? validatedSession(raw, receivedAt) ?? unknown() : unknown();
    } catch { return unknown(); }
    finally { clearTimeout(timer); controller.abort(); }
  };

  return {
    async get(): Promise<MarketSession> {
      const requestedAt = now();
      if (cached && Number.isFinite(requestedAt) && requestedAt >= cachedAt && requestedAt < expiresAt) return { ...cached };
      if (!pending) {
        pending = load().then(result => {
          const completedAt = now();
          cached = result;
          cachedAt = completedAt;
          expiresAt = Number.isFinite(completedAt) ? completedAt + CACHE_MS : 0;
          if (result.state !== 'UNKNOWN') {
            const boundary = Date.parse(result.state === 'OPEN' ? result.nextClose! : result.nextOpen!);
            expiresAt = Math.min(expiresAt, boundary);
          }
          return result;
        }).finally(() => { pending = null; });
      }
      return { ...await pending };
    },
  };
}
