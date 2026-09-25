import assert from 'node:assert/strict';
import test from 'node:test';
import { giwaConfirmedTransport, GIWA_CONFIRMATION_DEPTH } from './giwa-confirmation.js';
import type { JsonRpcTransport } from './rpc.js';

function chain(heads: number[]) {
  const calls: [string, unknown[]][] = [];
  let index = 0;
  const inner: JsonRpcTransport = async (method, params) => {
    calls.push([method, params]);
    if (method === 'eth_getBlockByNumber' && params[0] === 'latest') return { number: `0x${heads[Math.min(index++, heads.length - 1)].toString(16)}`, hash: `0x${'1'.repeat(64)}` };
    if (method === 'eth_getBlockByNumber') return { number: params[0], hash: `0x${'2'.repeat(64)}`, full: params[1] };
    return `passthrough:${method}`;
  };
  return { inner, calls };
}

test('finalized is answered with the GIWA head minus the confirmation depth', async () => {
  const { inner, calls } = chain([1000]);
  const rpc = giwaConfirmedTransport(inner);
  assert.equal(GIWA_CONFIRMATION_DEPTH, 2n);
  assert.deepEqual(await rpc('eth_getBlockByNumber', ['finalized', false]), { number: '0x3e6', hash: `0x${'2'.repeat(64)}`, full: false });
  assert.deepEqual(calls, [['eth_getBlockByNumber', ['latest', false]], ['eth_getBlockByNumber', ['0x3e6', false]]]);
});

test('every other request passes through unchanged', async () => {
  const { inner, calls } = chain([1000]);
  const rpc = giwaConfirmedTransport(inner);
  assert.equal(await rpc('eth_getTransactionReceipt', ['0xabc']), 'passthrough:eth_getTransactionReceipt');
  assert.deepEqual(await rpc('eth_getBlockByNumber', ['0x10', true]), { number: '0x10', hash: `0x${'2'.repeat(64)}`, full: true });
  assert.deepEqual(await rpc('eth_getBlockByNumber', ['latest', false]), { number: '0x3e8', hash: `0x${'1'.repeat(64)}` });
  assert.deepEqual(calls.map(([method, params]) => [method, params[0]]), [['eth_getTransactionReceipt', '0xabc'], ['eth_getBlockByNumber', '0x10'], ['eth_getBlockByNumber', 'latest']]);
});

test('the confirmed boundary never moves backwards when a lagging node answers', async () => {
  const { inner, calls } = chain([1000, 997, 1003]);
  const rpc = giwaConfirmedTransport(inner);
  await rpc('eth_getBlockByNumber', ['finalized', false]);
  await rpc('eth_getBlockByNumber', ['finalized', false]);
  await rpc('eth_getBlockByNumber', ['finalized', false]);
  assert.deepEqual(calls.filter(([, params]) => params[0] !== 'latest').map(([, params]) => params[0]), ['0x3e6', '0x3e6', '0x3e9']);
});

test('a missing head stays missing and a malformed head fails closed', async () => {
  assert.equal(await giwaConfirmedTransport(async () => null)('eth_getBlockByNumber', ['finalized', false]), null);
  await assert.rejects(giwaConfirmedTransport(async () => ({ number: '12' }))('eth_getBlockByNumber', ['finalized', false]), /MALFORMED_RPC_QUANTITY/);
  const { inner } = chain([1]);
  assert.deepEqual(await giwaConfirmedTransport(inner)('eth_getBlockByNumber', ['finalized', false]), { number: '0x0', hash: `0x${'2'.repeat(64)}`, full: false });
  assert.throws(() => giwaConfirmedTransport(inner, -1n), /INVALID_GIWA_CONFIRMATION/);
});
