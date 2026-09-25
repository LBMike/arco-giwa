import test from 'node:test';
import assert from 'node:assert/strict';
import { a, h, testManifest, testTusdcManifest } from '../stocks/test-fixtures.js';
import { CASH_ADMIN_SLOT } from '../stocks/cash-identity.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';
import type { ExternalTransactionCustody } from './original-transport.js';
import { guardCashSigning } from './cash-guard.js';

test('v3 denies both new signing and broadcast after cash upgrade, but allows historical read recovery', async () => {
  const manifest = testTusdcManifest(); let changed = false, signed = 0, broadcast = 0, recovered = 0;
  const rpc: JsonRpcTransport = async (method, args) => {
    if (method === 'eth_chainId') return '0x164ce';
    if (method === 'eth_getBlockByNumber') return { number: '0xc8', hash: h(200) };
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_getStorageAt') return `0x${(args[1] === CASH_ADMIN_SLOT ? manifest.cashIdentity.proxyAdmin : changed ? a(300) : manifest.cashIdentity.implementation).slice(2).padStart(64, '0')}`;
    if (method === 'eth_sendRawTransaction') { broadcast++; return h(99); }
    if (method === 'eth_getTransactionByHash') { recovered++; return { hash: h(99) }; }
    assert.fail(method);
  };
  const guard = guardCashSigning(manifest, rpc, { signOriginal: async () => { signed++; return '0x02' as `0x${string}`; } });
  const request = {} as Parameters<ExternalTransactionCustody['signOriginal']>[0]; // Identity guard passes request through; original transport validates its shape.
  await guard.custody.signOriginal(request);
  assert.equal(signed, 1);
  changed = true;
  await assert.rejects(guard.custody.signOriginal(request), /CASH_IDENTITY_MISMATCH/);
  await assert.rejects(guard.rpc('eth_sendRawTransaction', ['0x02']), /CASH_IDENTITY_MISMATCH/);
  assert.equal(signed, 1); assert.equal(broadcast, 0);
  assert.deepEqual(await guard.rpc('eth_getTransactionByHash', [h(99)]), { hash: h(99) });
  assert.equal(recovered, 1);
});
test('v2 signing policy is unchanged and does not make proxy requests', async () => {
  let signed = 0;
  const guard = guardCashSigning(testManifest(), async method => { assert.equal(method, 'eth_sendRawTransaction'); return h(99); }, { signOriginal: async () => { signed++; return '0x02' as `0x${string}`; } });
  await guard.check();
  await guard.custody.signOriginal({} as Parameters<ExternalTransactionCustody['signOriginal']>[0]);
  assert.equal(await guard.rpc('eth_sendRawTransaction', ['0x02']), h(99)); assert.equal(signed, 1);
});
