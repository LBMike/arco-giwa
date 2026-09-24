import { immutable, StocksError, type SqlPool } from '../stocks/contracts.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';
import { createStocksSignerCore } from './core.js';
import type { SignerHostConfig } from './host-config.js';
import { createStocksSignerHttpService } from './http-service.js';
import { createOriginalNonceLookup } from './nonce-lookup.js';
import { createOriginalSignerTransport } from './original-transport.js';
import type { ExternalTransactionCustody } from './original-transport.js';
import { PostgresSignerJournal } from './postgres-journal.js';
import { createStocksSignerReadiness } from './readiness.js';

/** Owns the supplied pool/custody from entry, including every startup failure. */
export async function startStocksSignerHost(options: {
  config: SignerHostConfig; pool: SqlPool & { end(): Promise<void> }; rpc: JsonRpcTransport;
  custody: ExternalTransactionCustody & { ready(): Promise<boolean>; close(): void };
  bearerToken: string; mode: 'check' | 'serve'; signal?: AbortSignal;
}) {
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  let app: ReturnType<typeof createStocksSignerHttpService> | undefined;
  const close = (): Promise<void> => {
    if (!closePromise) {
      closing = true;
      closePromise = (async () => {
        try {
          // A disconnected HTTP socket is not evidence that its async signing
          // work ended. Drain admitted operations explicitly before PG/custody.
          const results = await Promise.allSettled([app?.close(), ...active]);
          if (results[0].status === 'rejected') throw new Error('SIGNER_HOST_CLOSE_FAILED');
        }
        finally {
          try { await options.pool.end(); }
          finally { options.custody.close(); }
        }
      })();
    }
    return closePromise;
  };
  try {
    const config = immutable(options.config);
    const manifest = config.manifest;
    const journal = new PostgresSignerJournal(options.pool, manifest, config.reviewedInitialNonce);
    const transport = createOriginalSignerTransport({ manifest, rpc: options.rpc, custody: options.custody,
      intent: journal, lookup: createOriginalNonceLookup({ manifest, rpc: options.rpc }), limits: config.limits });
    const core = createStocksSignerCore({ manifest, journal, transport });
    const available = () => !closing && !options.signal?.aborted && config.custody.exclusiveAccountControlConfirmed === true;
    const admit = <T>(work: () => Promise<T>): Promise<T> => {
      if (!available()) return Promise.reject(new StocksError('SIGNER_NOT_READY', 503));
      const pending = Promise.resolve().then(work);
      active.add(pending);
      void pending.then(() => active.delete(pending), () => active.delete(pending));
      return pending;
    };
    const probeRpc: JsonRpcTransport = (method, params) => {
      if (!available()) return Promise.reject(new Error('SIGNER_STOPPING'));
      return options.rpc(method, params);
    };
    const probe = createStocksSignerReadiness({ manifest, reviewedManifestDigest: config.reviewedManifestDigest,
      reviewedInitialNonce: config.reviewedInitialNonce, journal, rpc: probeRpc,
      operationalReady: async () => available() && await options.custody.ready() && available() });
    const ready = async () => available() && await probe() && available();
    app = createStocksSignerHttpService({ manifest, core: {
      parsePut: core.parsePut,
      submit: (id, body) => admit(() => core.submit(id, body)),
      lookup: id => admit(() => core.lookup(id)),
    }, bearerToken: options.bearerToken, ready });
    if (!await ready()) throw new Error('NOT_READY');
    if (options.mode === 'check') { await close(); return { address: null, close }; }
    if (options.mode !== 'serve' || !available()) throw new Error('INVALID_START');
    const address = await app.listen({ ...config.listen });
    if (!available()) throw new Error('INTERRUPTED_START');
    return { address, close };
  } catch {
    try { await close(); } catch { /* All resource cleanup attempts ran; redact details. */ }
    throw new StocksError('SIGNER_HOST_NOT_READY', 503);
  }
}
