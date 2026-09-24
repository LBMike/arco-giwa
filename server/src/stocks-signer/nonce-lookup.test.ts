import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizedCall } from '../stocks/chain.js';
import { callDigest, manifestDigest, StocksError } from '../stocks/contracts.js';
import { a, h, testManifest } from '../stocks/test-fixtures.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';
import type { SignerOperation } from './core.js';
import { createOriginalNonceLookup } from './nonce-lookup.js';

const manifest = testManifest();
const call = authorizedCall(manifest, 'mint:nonce-lookup', 'MINT', a(10), '10');
const operation: SignerOperation = {
  operationId: call.operationId, deploymentDigest: manifestDigest(manifest), callDigest: callDigest(call),
  call, originalNonce: '7', txHash: null,
};
const candidate = {
  hash: h(88), chainId: '0x164ce', from: manifest.signerAddress, nonce: '0x7',
  to: call.to, input: call.data, value: '0x0', blockHash: h(77), blockNumber: '0x4d',
};
const unavailable = (error: unknown) => error instanceof StocksError
  && error.code === 'SIGNER_ORIGINAL_LOOKUP_UNAVAILABLE' && error.status === 503;

function history(options: { spentAt?: bigint; corruptBlock?: boolean; extra?: unknown[] } = {}) {
  const seen: string[] = [];
  const rpc: JsonRpcTransport = async (method, params) => {
    seen.push(method);
    if (method === 'eth_getTransactionCount') {
      assert.equal(params[0], manifest.signerAddress);
      const block = BigInt(params[1] as string);
      return `0x${(options.spentAt !== undefined && block >= options.spentAt ? 8n : 7n).toString(16)}`;
    }
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === 'finalized') return { number: '0x1000', hash: h(99) };
      const block = BigInt(params[0] as string);
      return { number: `0x${block.toString(16)}`, hash: h(77),
        transactions: options.corruptBlock ? [] : [a(15), ...(options.extra ?? []), candidate].filter(item => typeof item === 'object') };
    }
    throw Error('UNEXPECTED_RPC_METHOD');
  };
  return { rpc, seen };
}

test('binary-searches a finalized signer nonce and returns its original transaction', async () => {
  const { rpc, seen } = history({ spentAt: 77n });
  const found = await createOriginalNonceLookup({ manifest, rpc }).findAtOriginalNonce(operation);
  assert.deepEqual(found, candidate);
  assert.ok(seen.filter(method => method === 'eth_getTransactionCount').length < 20);
  assert.equal(seen.filter(method => method === 'eth_getBlockByNumber').length, 2);
  assert.equal(seen.includes('eth_sendRawTransaction'), false);
});

test('an unconsumed original nonce remains unknown', async () => {
  const { rpc } = history();
  assert.equal(await createOriginalNonceLookup({ manifest, rpc }).findAtOriginalNonce(operation), null);
});

test('a consumed nonce missing from the claimed block fails closed', async () => {
  const { rpc } = history({ spentAt: 77n, corruptBlock: true });
  await assert.rejects(createOriginalNonceLookup({ manifest, rpc }).findAtOriginalNonce(operation), unavailable);
});

test('malformed counts and unrelated signer scope fail closed', async () => {
  const badRpc: JsonRpcTransport = async method => method === 'eth_getBlockByNumber'
    ? { number: '0x1000' } : 'PRIVATE_PROVIDER_RESPONSE';
  await assert.rejects(createOriginalNonceLookup({ manifest, rpc: badRpc }).findAtOriginalNonce(operation), unavailable);
  const { rpc } = history({ spentAt: 77n });
  await assert.rejects(createOriginalNonceLookup({ manifest, rpc }).findAtOriginalNonce(
    { ...operation, call: { ...call, from: a(11) } }), unavailable);
});
