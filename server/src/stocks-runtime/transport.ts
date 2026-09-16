import { randomUUID } from 'node:crypto';
import { decodeFunctionData } from 'viem';
import { ABI, callDigest, ensure, freezeManifest, manifestDigest, immutable, hash, type AuthorizedCall, type Manifest, type SignerPort, type Submission } from '../stocks/contracts.js';
import { authorizedCall, redemptionCall } from '../stocks/chain.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';

export type HttpFetch = typeof fetch;
export function endpoint(value: string, localHarness = false): URL {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  ensure(!url.username && !url.password && !url.hash && !url.search && (url.protocol === 'https:' || (localHarness && local && url.protocol === 'http:')), 'INVALID_STOCKS_ENDPOINT');
  return url;
}
export function httpStocksRpc(url: string, localHarness = false, request: HttpFetch = fetch): JsonRpcTransport {
  const target = endpoint(url, localHarness);
  const readMethods = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getCode', 'eth_call', 'eth_getLogs']);
  return async (method, params) => {
    ensure(readMethods.has(method), 'READ_ONLY_RPC_METHOD');
    const id = randomUUID();
    const response = await request(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    if (!response.ok) throw new Error('STOCKS_RPC_UNAVAILABLE');
    const result = await response.json() as Record<string, unknown>;
    if (!(result?.jsonrpc === '2.0' && result.id === id && !result.error && Object.prototype.hasOwnProperty.call(result, 'result'))) throw new Error('STOCKS_RPC_RESPONSE_UNAVAILABLE');
    return result.result;
  };
}

export type ExternalSignerOptions = { url: string; authorization: string; deploymentDigest: string; manifest: Manifest; localHarness?: boolean; request?: HttpFetch };
// This is an external signing-service client, never a wallet/key implementation.
// A timeout is propagated without retry; the worker must use lookup(original ID).
export function externalStocksSigner(options: ExternalSignerOptions): SignerPort & { probe(): Promise<void> } {
  const base = endpoint(options.url, options.localHarness);
  ensure(base.pathname === '/' && options.authorization.length > 0, 'INVALID_SIGNER_CONFIGURATION');
  const request = options.request ?? fetch;
  const expected = freezeManifest(options.manifest);
  const deploymentDigest = options.deploymentDigest;
  const authorization = options.authorization;
  ensure(deploymentDigest === manifestDigest(expected), 'SIGNER_DEPLOYMENT_MISMATCH');
  async function call(path: string, method: string, body?: unknown): Promise<unknown> {
    const response = await request(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${authorization}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (method === 'GET' && response.status === 404) return null;
    if (!response.ok) throw new Error('SIGNER_RESPONSE_UNAVAILABLE');
    return response.json();
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
      ensure(frozen.chainId === 91342 && frozen.networkInstance === expected.networkInstance && frozen.deploymentId === expected.deploymentId && frozen.from === expected.signerAddress && frozen.value === '0', 'SIGNER_CALL_SCOPE_MISMATCH');
      const digest = callDigest(frozen);
      // The adapter accepts only the four canonical settlement capabilities.
      // Re-encoding also rejects a changed operation key, asset or target.
      const decoded = decodeFunctionData({ abi: ABI, data: frozen.data });
      let canonical: AuthorizedCall | undefined;
      if (decoded.functionName === 'mintForOperation') canonical = authorizedCall(expected, frozen.operationId, 'MINT', decoded.args[2], decoded.args[3].toString());
      if (decoded.functionName === 'refundForOperation') canonical = authorizedCall(expected, frozen.operationId, 'REFUND', decoded.args[1], decoded.args[2].toString());
      if (decoded.functionName === 'settleRedemption') canonical = redemptionCall(expected, frozen.operationId, 'REDEEM', decoded.args[1], decoded.args[2].toString());
      if (decoded.functionName === 'returnEscrowForOperation') canonical = redemptionCall(expected, frozen.operationId, 'RETURN', decoded.args[1], '0');
      ensure(canonical && callDigest(canonical) === digest, 'SIGNER_CALL_CAPABILITY_MISMATCH');
      const result = submission(await call(`/v1/operations/${encodeURIComponent(frozen.operationId)}`, 'PUT', { protocol: 'ARCO_STOCKS_SIGNER_V1', deploymentDigest, call: frozen, callDigest: digest }), frozen.operationId, digest);
      if (!result) throw new Error('SIGNER_SUBMISSION_UNKNOWN');
      return result;
    },
    async lookup(operationId) { return submission(await call(`/v1/operations/${encodeURIComponent(operationId)}`, 'GET'), operationId); },
  };
}
