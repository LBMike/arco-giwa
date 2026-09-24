import { pathToFileURL } from 'node:url';
import { stocksHttpJson } from '../../server/dist/stocks-runtime/http-json.js';

// Container liveness only: never probes a provider/DB or authorizes trading.
export async function healthy(port = process.env.PORT ?? '8080', request = fetch) {
  if (typeof port !== 'string' || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) return false;
  try {
    const body = await stocksHttpJson(new URL(`http://127.0.0.1:${port}/health`), { headers: { accept: 'application/json' } },
      { request, maxBytes: 1024, timeoutMs: 3000, errorCode: 'STOCKS_RPC_UNAVAILABLE' });
    return body?.ok === true && body.service === 'arco-giwa-api';
  } catch { return false; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await healthy() ? 0 : 1;
}
