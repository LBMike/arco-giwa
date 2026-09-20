import { performance } from 'node:perf_hooks';
import { MarketDataError, type Logo } from './contracts.js';
import { parseExactJson } from './exact-json.js';

export interface TransportLimits { fetch?: typeof fetch; now?: () => number; timeoutMs?: number; requestsPerMinute?: number }
export interface TransportOptions extends TransportLimits { apiKey: string }
export interface AlpacaTransportOptions extends TransportLimits { keyId: string; secretKey: string }
function credential(value: string): string {
  if (!/^[\x21-\x7e]{1,512}$/.test(value)) throw new Error('INVALID_MARKET_DATA_CONFIG');
  return value;
}
export function brandingPath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  try {
    const url = new URL(input);
    if (url.origin !== 'https://api.massive.com' || url.username || url.password || url.search || url.hash) return null;
    if (!/^\/v1\/reference\/company-branding\/[A-Za-z0-9_-]+\/images\/[A-Za-z0-9_.-]+\.(?:png|jpe?g|webp)$/.test(url.pathname)) return null;
    return url.pathname;
  } catch { return null; }
}
class BoundedTransport {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  protected readonly timeout: number;
  private readonly budget: number;
  private calls: number[] = [];
  private cooldownUntil = 0;
  constructor(options: TransportLimits, private readonly origin: string, private readonly authentication: Record<string, string>) {
    this.fetcher = options.fetch ?? fetch; this.now = options.now ?? Date.now;
    this.timeout = options.timeoutMs ?? 4000; this.budget = options.requestsPerMinute ?? 5;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 10 || this.timeout > 15000 || !Number.isSafeInteger(this.budget) || this.budget < 1 || this.budget > 300) throw new Error('INVALID_MARKET_DATA_CONFIG');
  }
  protected async request(path: string, maxBytes: number, image = false): Promise<{ bytes: Uint8Array; type: string }> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || url.username || url.password || url.hash || url.searchParams.has('apiKey') || !path.startsWith('/') || path.startsWith('//')) throw new MarketDataError('INVALID_RESPONSE');
    const now = this.now();
    if (now < this.cooldownUntil) throw new MarketDataError('PROVIDER_RATE_LIMITED');
    this.calls = this.calls.filter(t => t > now - 60000);
    if (this.calls.length >= this.budget) throw new MarketDataError('REQUEST_BUDGET_EXHAUSTED');
    this.calls.push(now);
    const controller = new AbortController(); const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let finished = false;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new MarketDataError('TIMEOUT')); }, this.timeout); });
    const work = async () => {
      const response = await this.fetcher(url, { headers: { ...this.authentication, Accept: image ? 'image/png,image/jpeg,image/webp' : 'application/json' }, redirect: 'error', signal: controller.signal });
      if (finished || performance.now() - started >= this.timeout) { void response.body?.cancel().catch(() => {}); throw new MarketDataError('TIMEOUT'); }
      if (response.redirected || (response.url && new URL(response.url).origin !== url.origin)) throw new MarketDataError('INVALID_RESPONSE');
      if (response.status === 429) {
        const retry = response.headers.get('retry-after');
        const parsed = retry && /^\d{1,5}$/.test(retry) ? Number(retry) * 1000 : 60000;
        this.cooldownUntil = this.now() + Math.min(300000, Math.max(30000, parsed));
        void response.body?.cancel().catch(() => {}); throw new MarketDataError('PROVIDER_RATE_LIMITED');
      }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new MarketDataError(response.status === 401 || response.status === 403 ? 'PROVIDER_UNAUTHORIZED' : response.status === 404 ? 'NOT_FOUND' : 'PROVIDER_UNAVAILABLE'); }
      const type = (response.headers.get('content-type') ?? '').split(';')[0].toLowerCase().trim();
      if ((!image && type !== 'application/json') || (image && !['image/png', 'image/jpeg', 'image/webp'].includes(type))) { void response.body?.cancel().catch(() => {}); throw new MarketDataError('INVALID_RESPONSE'); }
      const declared = response.headers.get('content-length');
      if (declared && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(maxBytes))) { void response.body?.cancel().catch(() => {}); throw new MarketDataError('RESPONSE_TOO_LARGE'); }
      if (!response.body) throw new MarketDataError('INVALID_RESPONSE');
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
      for (;;) {
        const item = await reader.read();
        if (finished || performance.now() - started >= this.timeout) throw new MarketDataError('TIMEOUT');
        if (item.done) break;
        total += item.value.byteLength; if (total > maxBytes) throw new MarketDataError('RESPONSE_TOO_LARGE'); chunks.push(item.value);
      }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { bytes, type };
    };
    try { const result = await Promise.race([work(), deadline]); if (performance.now() - started >= this.timeout) throw new MarketDataError('TIMEOUT'); return result; }
    catch (error) { throw error instanceof MarketDataError ? error : new MarketDataError('PROVIDER_UNAVAILABLE'); }
    finally { finished = true; clearTimeout(timer); controller.abort(); if (reader) void reader.cancel().catch(() => {}); }
  }
  async json(path: string): Promise<unknown> {
    const started = performance.now();
    const response = await this.request(path, 2 * 1024 * 1024);
    try {
      const result = parseExactJson(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes));
      if (performance.now() - started >= this.timeout) throw new MarketDataError('TIMEOUT');
      return result;
    }
    catch (e) { throw e instanceof MarketDataError ? e : new MarketDataError('INVALID_RESPONSE'); }
  }
}
export class AlpacaTransport extends BoundedTransport {
  constructor(options: AlpacaTransportOptions) {
    super(options, 'https://data.alpaca.markets', { 'APCA-API-KEY-ID': credential(options.keyId), 'APCA-API-SECRET-KEY': credential(options.secretKey) });
  }
}
export class MassiveTransport extends BoundedTransport {
  constructor(options: TransportOptions) {
    super(options, 'https://api.massive.com', { Authorization: `Bearer ${credential(options.apiKey)}` });
  }
  async logo(path: string): Promise<Logo> {
    if (brandingPath(`https://api.massive.com${path}`) !== path) throw new MarketDataError('INVALID_RESPONSE');
    const { bytes, type } = await this.request(path, 256 * 1024, true);
    const png = bytes.length >= 24 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10])) && Buffer.from(bytes.subarray(12,16)).toString() === 'IHDR';
    const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
    const webp = bytes.length >= 20 && Buffer.from(bytes.subarray(0,4)).toString() === 'RIFF' && Buffer.from(bytes.subarray(8,12)).toString() === 'WEBP';
    if (!(type === 'image/png' && png || type === 'image/jpeg' && jpeg || type === 'image/webp' && webp)) throw new MarketDataError('INVALID_RESPONSE');
    return { bytes, contentType: type as Logo['contentType'] };
  }
}
