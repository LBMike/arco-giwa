// One deadline covers headers, streamed bytes and JSON decoding. A timeout is
// an uncertain transport outcome, never proof that a signer did not broadcast.
export const STOCKS_HTTP_TIMEOUT_MS = 10000;
export const STOCKS_RPC_MAX_BYTES = 4 * 1024 * 1024;
export const STOCKS_SIGNER_MAX_BYTES = 64 * 1024;

type Options = {
  maxBytes: number;
  errorCode: 'STOCKS_RPC_UNAVAILABLE' | 'SIGNER_RESPONSE_UNAVAILABLE';
  allowNotFound?: boolean;
  request?: typeof fetch;
  // Injected only by unit tests; runtime adapters use the fixed deadline above.
  timeoutMs?: number;
  now?: () => number;
};

export async function stocksHttpJson(target: URL, init: Omit<RequestInit, 'signal' | 'redirect'>, options: Options): Promise<unknown> {
  return (await stocksHttpResponse(target, init, options)).body;
}

/** Bounded infrastructure probes may inspect expected non-2xx JSON or headers only. */
export async function stocksHttpResponse(target: URL, init: Omit<RequestInit, 'signal' | 'redirect'>,
  options: Options & { acceptedStatuses?: readonly number[]; body?: 'json' | 'none' },
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const { maxBytes, errorCode, allowNotFound = false, request = fetch, timeoutMs = STOCKS_HTTP_TIMEOUT_MS,
    now = () => performance.now() } = options;
  const unavailable = () => new Error(errorCode);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > STOCKS_RPC_MAX_BYTES
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > STOCKS_HTTP_TIMEOUT_MS) throw unavailable();
  const controller = new AbortController(), started = now();
  let finished = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => {
    const elapsed = now() - started;
    if (finished || !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= timeoutMs) throw unavailable();
  };
  const cancel = () => { if (reader) void reader.cancel().catch(() => {}); };
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); cancel(); reject(unavailable()); }, timeoutMs);
  });
  const work = async () => {
    current();
    const response = await request(target, { ...init, redirect: 'error', signal: controller.signal });
    try {
      current();
      if (response.redirected || (response.url && response.url !== target.href)) throw unavailable();
      const result = (body: unknown) => ({ status: response.status, headers: response.headers, body });
      if (allowNotFound && response.status === 404) return result(null);
      if (!(options.acceptedStatuses ? options.acceptedStatuses.includes(response.status) : response.ok)) throw unavailable();
      if (options.body === 'none') return result(null);
      if (!response.body) throw unavailable();
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d{1,16}$/.test(length) || Number(length) > maxBytes)) throw unavailable();
      reader = response.body.getReader();
      // Grow bounded storage rather than retaining an unbounded list of tiny
      // stream chunks. Count actual decoded HTTP bytes even if the header lies.
      let bytes = new Uint8Array(Math.min(8192, maxBytes)), total = 0;
      for (;;) {
        current();
        const item = await reader.read();
        current();
        if (item.done) break;
        const next = total + item.value.byteLength;
        if (next > maxBytes) throw unavailable();
        if (next > bytes.length) {
          const grown = new Uint8Array(Math.min(maxBytes, Math.max(next, bytes.length * 2)));
          grown.set(bytes); bytes = grown;
        }
        bytes.set(item.value, total); total = next;
      }
      const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total)));
      current();
      return result(decoded);
    } finally {
      // Do not wait for a broken provider's cancellation callback. A late fetch
      // is still discarded and cancelled after the caller's deadline has won.
      if (reader) cancel(); else void response.body?.cancel().catch(() => {});
    }
  };
  try {
    const result = await Promise.race([work(), deadline]);
    current();
    return result;
  } catch { throw unavailable(); }
  finally { finished = true; clearTimeout(timer); controller.abort(); cancel(); }
}
