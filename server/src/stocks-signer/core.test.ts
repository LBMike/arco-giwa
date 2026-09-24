import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizedCall, redemptionCall } from '../stocks/chain.js';
import { callDigest, manifestDigest, type AuthorizedCall } from '../stocks/contracts.js';
import { a, h, testManifest } from '../stocks/test-fixtures.js';
import { createStocksSignerCore, parseStocksSignerPut, type DurableSignerJournal, type OriginalSignerTransport, type SignerOperation } from './core.js';

const manifest = testManifest();
const digest = manifestDigest(manifest);
const request = (call: AuthorizedCall) => ({ protocol: 'ARCO_STOCKS_SIGNER_V1', deploymentDigest: digest, call, callDigest: callDigest(call) });

class FakeDurableJournal implements DurableSignerJournal {
  rows = new Map<string, SignerOperation>();
  reserves = 0;
  reads = 0;
  async reserve(input: Omit<SignerOperation, 'originalNonce' | 'txHash'>) {
    this.reserves++;
    const current = this.rows.get(input.operationId);
    if (current) return { created: false, operation: structuredClone(current) };
    if ([...this.rows.values()].some(row => row.txHash === null)) throw Error('UNRESOLVED_ORIGINAL_NONCE');
    const operation = { ...structuredClone(input), originalNonce: String(this.rows.size), txHash: null };
    // This synchronous insert models an atomic, committed unique-key claim.
    this.rows.set(input.operationId, operation);
    return { created: true, operation: structuredClone(operation) };
  }
  async read(id: string) { this.reads++; return structuredClone(this.rows.get(id) ?? null); }
  async recordHash(id: string, expectedDigest: string, txHash: string) {
    const current = this.rows.get(id);
    assert.ok(current);
    assert.equal(current.callDigest, expectedDigest);
    assert.ok(current.txHash === null || current.txHash === txHash);
    const operation = { ...current, txHash };
    this.rows.set(id, operation);
    return structuredClone(operation);
  }
}

test('accepts only exact signer v1 request and the four canonical settlement calls', () => {
  const calls = [
    authorizedCall(manifest, 'mint:one', 'MINT', a(10), '10'),
    authorizedCall(manifest, 'refund:two', 'REFUND', a(10), '11'),
    authorizedCall(manifest, `refund:${manifest.networkInstance}:${h(99)}:3`, 'REFUND', a(10), '11'),
    redemptionCall(manifest, 'redeem:three', 'REDEEM', h(5), '12'),
    redemptionCall(manifest, 'return:four', 'RETURN', h(5), '0'),
  ];
  for (const call of calls) assert.deepEqual(parseStocksSignerPut(manifest, call.operationId, request(call)).call, call);
  const valid = calls[0];
  for (const bad of [
    { ...request(valid), extra: true },
    { ...request(valid), protocol: 'FOREIGN' },
    { ...request(valid), deploymentDigest: '0'.repeat(64) },
    { ...request(valid), callDigest: '0'.repeat(64) },
    { ...request(valid), call: { ...valid, to: a(88) } },
    { ...request(valid), call: { ...valid, from: a(88) } },
    { ...request(valid), call: { ...valid, value: '1' } },
    { ...request(valid), call: { ...valid, data: valid.data.toUpperCase().replace('0X', '0x') } },
    { ...request(valid), call: { ...valid, extra: true } },
    { ...request(valid), call: { ...valid, operationId: 'refund:one' } },
  ]) assert.throws(() => parseStocksSignerPut(manifest, valid.operationId, bad));
  assert.throws(() => parseStocksSignerPut(manifest, 'mint:other', request(valid)), /SIGNER_OPERATION_MISMATCH/);
  assert.throws(() => parseStocksSignerPut(manifest, '../mint:one', request(valid)), /SIGNER_OPERATION_ID_INVALID/);
});

test('concurrent and repeated PUTs reserve once, send once and retain the original hash across core instances', async () => {
  const journal = new FakeDurableJournal();
  const call = authorizedCall(manifest, 'mint:concurrent', 'MINT', a(10), '10');
  let sends = 0;
  let release!: (value: string) => void;
  const pending = new Promise<string>(resolve => { release = resolve; });
  const transport: OriginalSignerTransport = { sendOnce: async operation => {
    sends++;
    assert.equal(operation.originalNonce, '0');
    assert.equal(journal.rows.get(call.operationId)?.originalNonce, operation.originalNonce);
    return pending;
  }, findOriginal: async () => null };
  const first = createStocksSignerCore({ manifest, journal, transport });
  const second = createStocksSignerCore({ manifest, journal, transport });
  const original = first.submit(call.operationId, request(call));
  // reserve is committed before the external send can complete.
  await Promise.resolve();
  assert.equal(journal.rows.get(call.operationId)?.txHash, null);
  assert.equal(await second.submit(call.operationId, request(call)), null);
  release(h(77));
  assert.deepEqual(await original, { operationId: call.operationId, callDigest: callDigest(call), txHash: h(77) });
  assert.deepEqual(await second.submit(call.operationId, request(call)), await second.lookup(call.operationId));
  assert.equal(sends, 1);
  assert.equal(journal.reserves, 3);
});

test('changed payload under an original ID is rejected before any second send', async () => {
  const journal = new FakeDurableJournal();
  const firstCall = authorizedCall(manifest, 'refund:immutable', 'REFUND', a(10), '10');
  const changed = authorizedCall(manifest, 'refund:immutable', 'REFUND', a(10), '11');
  let sends = 0;
  const core = createStocksSignerCore({ manifest, journal, transport: {
    sendOnce: async () => { sends++; return h(31); }, findOriginal: async () => null,
  } });
  await core.submit(firstCall.operationId, request(firstCall));
  await assert.rejects(core.submit(changed.operationId, request(changed)), /SIGNER_IMMUTABLE_OPERATION_CONFLICT/);
  assert.equal(sends, 1);
});

test('a missing durable original nonce blocks the side effect', async () => {
  const call = authorizedCall(manifest, 'mint:no-nonce', 'MINT', a(10), '10');
  let sends = 0;
  const core = createStocksSignerCore({ manifest, journal: {
    reserve: async input => ({ created: true, operation: { ...input, originalNonce: '', txHash: null } }),
    read: async () => null,
    recordHash: async () => { throw Error('UNEXPECTED_RECORD'); },
  }, transport: { sendOnce: async () => { sends++; return h(1); }, findOriginal: async () => null } });
  await assert.rejects(core.submit(call.operationId, request(call)), /^Error: SIGNER_RECORD_MISMATCH$/);
  assert.equal(sends, 0);
});

test('the recorded hash cannot silently change the reserved original nonce', async () => {
  const call = authorizedCall(manifest, 'mint:nonce-switch', 'MINT', a(10), '10');
  const journal = new FakeDurableJournal();
  const core = createStocksSignerCore({ manifest, journal: {
    reserve: input => journal.reserve(input),
    read: id => journal.read(id),
    recordHash: async (id, expectedDigest, txHash) => ({ ...await journal.recordHash(id, expectedDigest, txHash), originalNonce: '1' }),
  }, transport: { sendOnce: async () => h(40), findOriginal: async () => null } });
  await assert.rejects(core.submit(call.operationId, request(call)), /^Error: SIGNER_RECORD_MISMATCH$/);
});

test('lookup rejects a valid record returned for a different requested operation ID', async () => {
  const otherCall = authorizedCall(manifest, 'mint:other', 'MINT', a(10), '10');
  const other: SignerOperation = {
    operationId: otherCall.operationId, deploymentDigest: digest, callDigest: callDigest(otherCall),
    call: otherCall, originalNonce: '0', txHash: h(44),
  };
  let recoveryReads = 0;
  const core = createStocksSignerCore({ manifest, journal: {
    reserve: async () => { throw Error('UNEXPECTED_RESERVE'); },
    read: async () => other,
    recordHash: async () => { throw Error('UNEXPECTED_WRITE'); },
  }, transport: {
    sendOnce: async () => { throw Error('UNEXPECTED_SEND'); },
    findOriginal: async () => { recoveryReads++; return null; },
  } });
  await assert.rejects(core.lookup('mint:requested'), /^Error: SIGNER_RECORD_MISMATCH$/);
  assert.equal(recoveryReads, 0);
});

test('unknown send is never retried; GET only recovers the original transaction', async () => {
  const journal = new FakeDurableJournal();
  const call = redemptionCall(manifest, 'redeem:uncertain', 'REDEEM', h(5), '120');
  let sends = 0, lookups = 0;
  let originalHash: string | null = null;
  const transport: OriginalSignerTransport = {
    sendOnce: async () => { sends++; throw Error('PRIVATE_PROVIDER_PATH'); },
    findOriginal: async operation => {
      lookups++;
      assert.equal(operation.callDigest, callDigest(call));
      assert.equal(operation.originalNonce, '0');
      return originalHash;
    },
  };
  const core = createStocksSignerCore({ manifest, journal, transport });
  await assert.rejects(core.submit(call.operationId, request(call)), /^Error: SIGNER_ORIGINAL_OUTCOME_UNKNOWN$/);
  assert.equal(await core.submit(call.operationId, request(call)), null);
  const next = authorizedCall(manifest, 'mint:later', 'MINT', a(10), '10');
  await assert.rejects(core.submit(next.operationId, request(next)), /^Error: SIGNER_JOURNAL_UNAVAILABLE$/);
  assert.equal(await core.lookup(call.operationId), null);
  originalHash = h(90);
  assert.deepEqual(await core.lookup(call.operationId), { operationId: call.operationId, callDigest: callDigest(call), txHash: h(90) });
  assert.equal(sends, 1);
  assert.equal(lookups, 2);
  assert.equal(await core.lookup('mint:unknown'), null);
  assert.equal(lookups, 2);
});

test('journal and recovery failures return fixed codes without exposing private errors', async () => {
  const call = authorizedCall(manifest, 'mint:errors', 'MINT', a(10), '10');
  const journal = new FakeDurableJournal();
  const core = createStocksSignerCore({ manifest, journal, transport: {
    sendOnce: async () => { throw Error('PRIVATE_SIGNER_KEY'); },
    findOriginal: async () => { throw Error('PRIVATE_RPC_PATH'); },
  } });
  await assert.rejects(core.submit(call.operationId, request(call)), /^Error: SIGNER_ORIGINAL_OUTCOME_UNKNOWN$/);
  await assert.rejects(core.lookup(call.operationId), /^Error: SIGNER_RECOVERY_UNAVAILABLE$/);
  const broken = createStocksSignerCore({ manifest, journal: {
    reserve: async () => { throw Error('PRIVATE_DB_URL'); },
    read: async () => { throw Error('PRIVATE_DB_URL'); },
    recordHash: async () => { throw Error('PRIVATE_DB_URL'); },
  }, transport: { sendOnce: async () => h(1), findOriginal: async () => null } });
  await assert.rejects(broken.submit(call.operationId, request(call)), /^Error: SIGNER_JOURNAL_UNAVAILABLE$/);
  await assert.rejects(broken.lookup(call.operationId), /^Error: SIGNER_JOURNAL_UNAVAILABLE$/);
});
