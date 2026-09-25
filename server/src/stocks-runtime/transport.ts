import { randomUUID } from 'node:crypto';
import { ensure, freezeManifest, manifestDigest, immutable, hash, type AuthorizedCall, type Manifest, type SignerPort, type Submission } from '../stocks/contracts.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';
import { stocksHttpJson, STOCKS_RPC_MAX_BYTES, STOCKS_SIGNER_MAX_BYTES } from './http-json.js';
import { canonicalStocksSignerCall } from './signer-call.js';

export type HttpFetch = typeof fetch;
export function endpoint(value: string, localHarness = false): URL {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  ensure(!url.username && !url.password && !url.hash && !url.search && (url.protocol === 'https:' || (localHarness && local && url.protocol === 'http:')), 'INVALID_STOCKS_ENDPOINT');
  return url;
}
/**
 * A signer on the hosting platform's private network (e.g. a Render private service
 * addressed as `http://arco-stocks-signer:4394`). Only a single DNS label with an
 * explicit port qualifies: public names always contain a dot, IP literals and
 * localhost are excluded. Bearer authentication still applies. RPC URLs never use this.
 */
export function isPrivateNetworkSignerUrl(url: URL): boolean {
  return url.protocol === 'http:' && url.port !== '' && url.hostname !== 'localhost'
    && /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(url.hostname);
}
export function signerEndpoint(value: string, localHarness = false): URL {
  const url = new URL(value);
  if (!isPrivateNetworkSignerUrl(url)) return endpoint(value, localHarness);
  ensure(!url.username && !url.password && !url.hash && !url.search, 'INVALID_STOCKS_ENDPOINT');
  return url;
}
export function httpStocksRpc(url: string, localHarness = false, request: HttpFetch = fetch): JsonRpcTransport {
  const target = endpoint(url, localHarness);
  const readMethods = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_getLogs']);
  return async (method, params) => {
    ensure(readMethods.has(method), 'READ_ONLY_RPC_METHOD');
    const id = randomUUID();
    const result = await stocksHttpJson(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) },
      { request, maxBytes: STOCKS_RPC_MAX_BYTES, errorCode: 'STOCKS_RPC_UNAVAILABLE' }) as Record<string, unknown>;
    if (!(result?.jsonrpc === '2.0' && result.id === id && !result.error && Object.prototype.hasOwnProperty.call(result, 'result'))) throw new Error('STOCKS_RPC_RESPONSE_UNAVAILABLE');
    return result.result;
  };
}

export type ExternalSignerOptions = { url: string; authorization: string; deploymentDigest: string; manifest: Manifest; localHarness?: boolean; request?: HttpFetch };
// This is an external signing-service client, never a wallet/key implementation.
// A timeout is propagated without retry; the worker must use lookup(original ID).
export function externalStocksSigner(options: ExternalSignerOptions): SignerPort & { probe(): Promise<void> } {
  const base = signerEndpoint(options.url, options.localHarness);
  ensure(base.pathname === '/' && options.authorization.length > 0, 'INVALID_SIGNER_CONFIGURATION');
  const request = options.request ?? fetch;
  const expected = freezeManifest(options.manifest);
  const deploymentDigest = options.deploymentDigest;
  const authorization = options.authorization;
  ensure(deploymentDigest === manifestDigest(expected), 'SIGNER_DEPLOYMENT_MISMATCH');
  async function call(path: string, method: string, body?: unknown): Promise<unknown> {
    return stocksHttpJson(new URL(path, base), { method, headers: { authorization: `Bearer ${authorization}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      { request, maxBytes: STOCKS_SIGNER_MAX_BYTES, errorCode: 'SIGNER_RESPONSE_UNAVAILABLE', allowNotFound: method === 'GET' });
  }
  function submission(value: unknown, operationId: string, expectedDigest?: string): Submission | null {
    if (value === null) return null;
    ensure(typeof value === 'object', 'SIGNER_RESPONSE_INVALID');
    const row = value as Record<string, unknown>;
    ensure(row.operationId === operationId && typeof row.callDigest === 'string' && /^[0-9a-f]{64}$/.test(row.callDigest) && (!expectedDigest || row.callDigest === expectedDigest), 'SIGNER_OPERATION_MISMATCH');
    return immutable({ operationId, callDigest: row.callDigest, txHash: hash(String(row.txHash)) });
  }
  return {
    async probe() {
      const value = await call('/v1/capabilities', 'GET') as Record<string, unknown> | null;
      ensure(value?.protocol === 'ARCO_STOCKS_SIGNER_V1' && value.profile === 'DEMO_TESTNET' && value.chainId === 91342 && value.signerAddress === expected.signerAddress && value.noncePolicy === 'DURABLE_SERIALIZED' && value.operationPolicy === 'IMMUTABLE_IDEMPOTENT' && value.replacementPolicy === 'DISABLED', 'SIGNER_CAPABILITIES_MISMATCH', 503);
    },
    async submit(input: AuthorizedCall) {
      const frozen = immutable(input);
      const { digest } = canonicalStocksSignerCall(expected, frozen);
      const result = submission(await call(`/v1/operations/${encodeURIComponent(frozen.operationId)}`, 'PUT', { protocol: 'ARCO_STOCKS_SIGNER_V1', deploymentDigest, call: frozen, callDigest: digest }), frozen.operationId, digest);
      if (!result) throw new Error('SIGNER_SUBMISSION_UNKNOWN');
      return result;
    },
    async lookup(operationId) { return submission(await call(`/v1/operations/${encodeURIComponent(operationId)}`, 'GET'), operationId); },
  };
}
