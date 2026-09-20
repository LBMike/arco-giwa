import { stocksHttpResponse } from '../stocks-runtime/http-json.js';
import { PROFILE } from '../stocks/contracts.js';

type Check = 'PASS' | 'FAIL' | 'NOT_READY' | 'NOT_RUN';
type Checks = { apiLiveness: Check; stocksReadiness: Check; browserCors: Check; operatorAuthentication: Check };
const forbiddenOrigin = 'https://stocks-connection-probe.invalid';

function origin(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('https://') || /[\s\\?#]/.test(value)) throw Error('INVALID_ORIGIN');
  const parsed = new URL(value);
  if (parsed.username || parsed.password || !parsed.hostname || /[,*]/.test(parsed.hostname) || parsed.pathname !== '/') throw Error('INVALID_ORIGIN');
  return parsed.origin;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
function exactBody(value: unknown, expected: Record<string, unknown>): boolean {
  const data = record(value);
  return Object.keys(data).sort().join(',') === Object.keys(expected).sort().join(',') &&
    Object.entries(expected).every(([key, wanted]) => data[key] === wanted);
}
function tokens(value: string | null): string[] { return (value ?? '').toLowerCase().split(',').map(part => part.trim()); }
function cors(headers: Headers, allowed: string): boolean {
  return headers.get('access-control-allow-origin') === allowed && tokens(headers.get('vary')).includes('origin');
}

/** Public GET/OPTIONS checks only: no dotenv, session, signature, order or runtime activation. */
export async function checkStocksConnection(apiValue: unknown, frontendValue: unknown, options: {
  request?: typeof fetch;
  timeoutMs?: number;
} = {}) {
  const checks: Checks = { apiLiveness: 'NOT_RUN', stocksReadiness: 'NOT_RUN', browserCors: 'NOT_RUN', operatorAuthentication: 'NOT_RUN' };
  const report = () => ({
    status: Object.values(checks).some(value => value === 'FAIL' || value === 'NOT_RUN') ? 'BLOCKED' :
      checks.stocksReadiness === 'NOT_READY' ? 'NOT_READY' : 'CONNECTION_CHECKS_PASSED',
    tradingAuthorized: false as const, checks,
  });
  let api: string, frontend: string;
  try {
    api = origin(apiValue); frontend = origin(frontendValue);
    if (frontend === forbiddenOrigin) throw Error('RESERVED_ORIGIN');
  } catch { return { ...report(), error: 'INVALID_CONNECTION_SETTINGS' }; }

  const probe = (path: string, acceptedStatuses: readonly number[], method = 'GET', requestOrigin: string | null = frontend) =>
    stocksHttpResponse(new URL(path, api), {
      method, credentials: 'omit', cache: 'no-store', headers: { ...(requestOrigin === null ? {} : { origin: requestOrigin }),
        ...(method === 'OPTIONS' ? { 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,content-type' } : { accept: 'application/json' }) },
    }, { maxBytes: 4096, errorCode: 'STOCKS_RPC_UNAVAILABLE', ...options, acceptedStatuses, body: method === 'OPTIONS' ? 'none' : 'json' });

  try {
    const live = await probe('/health', [200], 'GET', null);
    checks.apiLiveness = exactBody(live.body, { ok: true, service: 'arco-giwa-api' }) ? 'PASS' : 'FAIL';
  } catch { checks.apiLiveness = 'FAIL'; }
  // Do not probe operational routes on an endpoint that is not the expected API.
  if (checks.apiLiveness !== 'PASS') return report();

  await Promise.all([
    (async () => {
      try {
        const ready = await probe('/ready/stocks', [200, 503]);
        if (!exactBody(ready.body, { ok: ready.status === 200, service: 'arco-giwa-stocks', executionAuthorization: false }) ||
          ready.headers.get('cache-control') !== 'no-store') throw Error('INVALID_READINESS');
        checks.stocksReadiness = ready.status === 200 ? 'PASS' : 'NOT_READY';
        if (!cors(ready.headers, frontend)) checks.browserCors = 'FAIL';
      } catch { checks.stocksReadiness = 'FAIL'; }
    })(),
    (async () => {
      try {
        const denied = await probe('/api/v1/admin/stocks/runtime', [403]);
        checks.operatorAuthentication = exactBody(denied.body, { error: 'OPERATOR_FORBIDDEN', ...PROFILE }) &&
          denied.headers.get('cache-control') === 'no-store' ? 'PASS' : 'FAIL';
        if (!cors(denied.headers, frontend)) checks.browserCors = 'FAIL';
      } catch { checks.operatorAuthentication = 'FAIL'; }
    })(),
    (async () => {
      try {
        const allowed = await probe('/api/v1/admin/stocks/runtime', [200, 204], 'OPTIONS');
        const denied = await probe('/api/v1/admin/stocks/runtime', [200, 204, 400, 403], 'OPTIONS', forbiddenOrigin);
        if (!cors(allowed.headers, frontend) || !tokens(allowed.headers.get('access-control-allow-methods')).includes('get') ||
          !['authorization', 'content-type'].every(header => tokens(allowed.headers.get('access-control-allow-headers')).includes(header)) ||
          denied.headers.has('access-control-allow-origin')) throw Error('INVALID_CORS');
        // Other concurrent checks can fail actual GET CORS; a preflight never overwrites that failure.
        if (checks.browserCors !== 'FAIL') checks.browserCors = 'PASS';
      } catch { checks.browserCors = 'FAIL'; }
    })(),
  ]);
  return report();
}
