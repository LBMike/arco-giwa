// Local product preview: forward public reads only. Never forward credentials or fixture execution.
export function publicUpstream(value, loopbackOnly = false) {
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || (loopbackOnly && !local)) throw new Error('INVALID_PUBLIC_UPSTREAM');
  return url.origin;
}
export function readTarget(raw, legacy, market) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || /[%\\]/.test(raw.split('?')[0])) return null;
  const url = new URL(raw, 'http://preview.invalid');
  if (url.hash) return null;
  const path = url.pathname;
  const marketPath = /^\/api\/v1\/stocks\/market\/(catalog|quotes|[A-Z0-9.-]{1,20}\/(profile|chart))$/.test(path);
  const legacyPath = /^\/api\/v1\/evm\/(registry|catalog|featured|market)\/91342$/.test(path)
    || /^\/api\/v1\/evm\/market\/91342\/[a-zA-Z0-9_-]{1,80}\/history$/.test(path)
    || /^\/api\/v1\/(portfolio|activity|redemptions)\/0x[a-fA-F0-9]{40}$/.test(path)
    || /^\/api\/v1\/faucet\/0x[a-fA-F0-9]{40}\/status$/.test(path);
  return marketPath ? `${market}${path}${url.search}` : legacyPath ? `${legacy}${path}${url.search}` : null;
}
export function publicReadGateway({ origin, legacy, market, fetcher = fetch }) {
  const host = new URL(origin).host;
  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(body); };
  return async (req, res, next) => {
    if (!req.url?.startsWith('/api/')) return next();
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, '{"error":"PREVIEW_ORIGIN_DENIED"}');
    if (req.method !== 'GET') return send(res, 405, '{"error":"PREVIEW_READ_ONLY"}');
    const target = readTarget(req.url, legacy, market);
    if (!target) return send(res, 503, '{"error":"PREVIEW_TRANSACTION_BACKEND_NOT_CONNECTED"}');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15_000);
    const close = () => abort.abort(); res.once('close', close);
    try {
      const upstream = await fetcher(target, { method: 'GET', redirect: 'error', credentials: 'omit', signal: abort.signal, headers: { accept: 'application/json' } });
      if (!upstream.headers.get('content-type')?.includes('application/json')) throw new Error('NON_JSON_UPSTREAM');
      const reader = upstream.body?.getReader(); if (!reader) throw new Error('EMPTY_UPSTREAM');
      const chunks = []; let bytes = 0;
      try {
        for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 4_000_000) throw new Error('UPSTREAM_TOO_LARGE'); chunks.push(Buffer.from(part.value)); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!res.destroyed) send(res, upstream.status, Buffer.concat(chunks));
    } catch { if (!res.destroyed) send(res, 502, '{"error":"PUBLIC_DATA_UNAVAILABLE"}'); }
    finally { clearTimeout(timer); res.off('close', close); }
  };
}
