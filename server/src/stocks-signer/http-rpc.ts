import { randomUUID } from 'node:crypto';
import { address, hash, StocksError } from '../stocks/contracts.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';
import { stocksHttpJson, STOCKS_RPC_MAX_BYTES } from '../stocks-runtime/http-json.js';

const configurationInvalid = () => new StocksError('SIGNER_RPC_CONFIGURATION_INVALID', 503);
const methodForbidden = () => new StocksError('SIGNER_RPC_METHOD_FORBIDDEN', 503);
const requestInvalid = () => new StocksError('SIGNER_RPC_REQUEST_INVALID', 503);
const responseInvalid = () => new StocksError('SIGNER_RPC_RESPONSE_INVALID', 503);
const unavailable = () => new StocksError('SIGNER_RPC_UNAVAILABLE', 503);
const quantity = (value: unknown) => typeof value === 'string' && /^0x(0|[1-9a-f][0-9a-f]{0,63})$/.test(value);
const blockTag = (value: unknown) => value === 'finalized' || quantity(value);

function rpcEndpoint(value: string, localHarness: boolean): URL {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (value.includes('?') || value.includes('#') || url.username || url.password || url.search || url.hash
      || !(url.protocol === 'https:' || (localHarness && loopback && url.protocol === 'http:')))
      throw configurationInvalid();
    return url;
  } catch { throw configurationInvalid(); }
}

function validateParams(method: string, params: unknown): void {
  if (!Array.isArray(params)) throw requestInvalid();
  if (method === 'eth_chainId') {
    if (params.length !== 0) throw requestInvalid();
  } else if (method === 'eth_getBlockByNumber') {
    if (params.length !== 2 || !blockTag(params[0]) || typeof params[1] !== 'boolean') throw requestInvalid();
  } else if (method === 'eth_getTransactionCount') {
    if (params.length !== 2 || typeof params[0] !== 'string' || !blockTag(params[1])) throw requestInvalid();
    try { address(params[0]); } catch { throw requestInvalid(); }
  } else if (method === 'eth_sendRawTransaction') {
    // Matches the verified EIP-1559 transport's 8 KiB signed-byte limit.
    if (params.length !== 1 || typeof params[0] !== 'string'
      || params[0].length > 16386 || !/^0x(?:[0-9a-f]{2})+$/.test(params[0])) throw requestInvalid();
  } else throw methodForbidden();
}

/** Inactive signer-only RPC adapter; no listener, key, retry or runtime fallback. */
export function httpStocksSignerRpc(url: string, localHarness = false, request: typeof fetch = fetch): JsonRpcTransport {
  const target = rpcEndpoint(url, localHarness);
  return async (method, params) => {
    validateParams(method, params);
    const id = randomUUID();
    let response: unknown;
    try {
      response = await stocksHttpJson(target, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      }, { request, maxBytes: STOCKS_RPC_MAX_BYTES, errorCode: 'STOCKS_RPC_UNAVAILABLE' });
    } catch {
      // A provider or fetch error can contain signed bytes; never propagate it.
      throw unavailable();
    }
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw responseInvalid();
    const row = response as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== 'id,jsonrpc,result'
      || row.jsonrpc !== '2.0' || row.id !== id) throw responseInvalid();
    if (method === 'eth_sendRawTransaction') {
      try { return hash(row.result as string); } catch { throw responseInvalid(); }
    }
    return row.result;
  };
}
