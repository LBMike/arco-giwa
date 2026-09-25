import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExternalCashHandoffPlan, requireEmptyPriorStocksEpoch, verifyExternalCashHandoff, verifyExternalCashPredeployment } from './external-cash-handoff.js';
import { externalCashFixture } from './external-cash-handoff-fixture.js';
import type { SqlPool } from '../stocks/contracts.js';
import { httpStocksRpc } from '../stocks-runtime/transport.js';
import { httpStocksSignerRpc } from './http-rpc.js';

function fixture() {
  const f = externalCashFixture();
  const writes: string[] = [];
  const db = { async query(sql: string) {
    writes.push(sql);
    return { rowCount: 1, rows: sql.includes('FROM stocks_signer.account_nonce') ? [f.account]
      : sql.includes('FROM stocks_signer.operation') ? [] : [] };
  }, release() {} };
  const pool: SqlPool = { query: db.query, async connect() { return db; } };
  return { ...f, writes, pool, reviewed: { priorManifestDigest: f.plan.reviewedPriorManifestDigest, manifestDigest: f.plan.reviewedManifestDigest } };
}
test('handoff only accepts pinned v3 cash, exact CREATE order/nonce/address and complete strict public plan', () => {
  const f = fixture();
  assert.equal(parseExternalCashHandoffPlan(f.plan, f.reviewed).manifest.cashSymbol, 'tUSDC');
  const bad = [ { ...f.plan, password: 'INPUT_MUST_NOT_LEAK' }, { ...f.plan, reviewedFirstCreateNonce: '21' },
    { ...f.plan, reviewedPriorInitialNonce: '22' }, { ...f.plan, creations: [...f.plan.creations].reverse() },
    { ...f.plan, creations: f.plan.creations.slice(1) }, { ...f.plan, reviewedManifestDigest: '0'.repeat(64) } ];
  for (const plan of bad) assert.throws(() => parseExternalCashHandoffPlan(plan, f.reviewed), /^Error: TUSDC_HANDOFF_VERIFICATION_REQUIRED$/);
});
test('handoff validates exact finalized creates and old journal without any mutation or broadcast', async () => {
  const f = fixture(); let priorChecks = 0;
  const e = await verifyExternalCashHandoff({ plan: parseExternalCashHandoffPlan(f.plan, f.reviewed), priorJournal: f.pool,
    rpc: f.rpc, requirePriorEpoch: async () => { priorChecks++; } });
  assert.equal(e.initialNonce, '24'); assert.equal(e.priorInitialNonce, '20'); assert.equal(priorChecks, 2);
  assert.equal(f.writes.some(sql => /INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE/.test(sql)), false);
});
test('handoff blocks foreign nonce, unfinalized/reverted CREATE, changed input/code/checkpoint and old exposure', async () => {
  const mutations = [
    ['eth_getTransactionCount', '0x19'], ['eth_getTransactionReceipt', { status: '0x0' }],
    ['eth_getTransactionReceipt', { blockNumber: '0x65' }], ['eth_getTransactionByHash', { input: '0x6002' }],
    ['eth_getTransactionByHash', { nonce: '0x30' }], ['eth_getTransactionByHash', { to: '0x0000000000000000000000000000000000000001' }],
    ['eth_getCode', '0x6002'], ['eth_call', `0x${'0'.repeat(63)}1`], ['eth_chainId', '0x1'],
  ] as const;
  for (const [method, patch] of mutations) {
    const f = fixture();
    await assert.rejects(verifyExternalCashHandoff({ plan: f.plan, priorJournal: f.pool, requirePriorEpoch: async () => {},
      rpc: async (name, params) => { const original = await f.rpc(name, params); return name !== method ? original : typeof patch === 'string' ? patch : { ...(original as object), ...patch }; } }), /^Error: TUSDC_HANDOFF_VERIFICATION_REQUIRED$/);
  }
});
test('prior epoch gate rejects even terminal historical customer records to avoid hiding holdings/history', async () => {
  const good = { paused: true, orders: '0', sells: '0', holdings: '0', funding: '0', outbox: '0', submissions: '0' };
  for (const [key, value] of Object.entries({ paused: false, orders: '1', holdings: '1', funding: '1', submissions: '1' })) {
    const pool = { async query() { return { rows: [{ ...good, [key]: value }], rowCount: 1 }; } } as unknown as SqlPool;
    await assert.rejects(requireEmptyPriorStocksEpoch(pool, 'a'.repeat(64)), /TUSDC_PRIOR_EPOCH_NOT_EMPTY_OR_PAUSED/);
  }
});
test('predeployment gate checks the unconsumed nonce and empty paused epoch before any CREATE exists', async () => {
  const f = fixture(); let checked = 0;
  const priorJournal = { query: async (sql: string) => sql.includes('COUNT(*)') ? { rows: [{ count: '0' }], rowCount: 1 } : f.pool.query(sql) } as SqlPool;
  const options = { priorManifest: f.plan.priorManifest, reviewedPriorManifestDigest: f.plan.reviewedPriorManifestDigest,
    firstCreateNonce: '20', priorJournal, requirePriorEpoch: async () => { checked++; },
    rpc: async (method: string, params: unknown[]) => method === 'eth_getTransactionCount' ? '0x14' : f.rpc(method, params) };
  assert.deepEqual(await verifyExternalCashPredeployment(options), { priorInitialNonce: '20', firstCreateNonce: '20' });
  assert.equal(checked, 2);
  f.account.nextNonce = '21';
  await assert.rejects(verifyExternalCashPredeployment(options), /TUSDC_HANDOFF_VERIFICATION_REQUIRED/);
});
test('pre/post deployment handoff composes the strict real RPC adapters without a latest nonce tag', async () => {
  for (const before of [true, false]) {
    const f = fixture(), calls: Array<{ method: string; params: unknown[] }> = [];
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      calls.push(body);
      const result = body.method === 'eth_getTransactionCount' && before ? '0x14' : await f.rpc(body.method, body.params);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const read = httpStocksRpc('https://sepolia-rpc.giwa.io', false, fetcher);
    const nonce = httpStocksSignerRpc('https://sepolia-rpc.giwa.io', false, fetcher);
    const rpc = (method: string, params: unknown[]) => method === 'eth_getTransactionCount' ? nonce(method, params) : read(method, params);
    if (before) {
      const priorJournal = { query: async (sql: string) => sql.includes('COUNT(*)') ? { rows: [{ count: '0' }], rowCount: 1 } : f.pool.query(sql) } as SqlPool;
      await verifyExternalCashPredeployment({ priorManifest: f.plan.priorManifest, reviewedPriorManifestDigest: f.plan.reviewedPriorManifestDigest,
        firstCreateNonce: '20', priorJournal, rpc, requirePriorEpoch: async () => {} });
    } else {
      const e = await verifyExternalCashHandoff({ plan: f.plan, priorJournal: f.pool, rpc, requirePriorEpoch: async () => {} });
      assert.equal(e.initialNonce, '24');
    }
    assert.ok(calls.some(c => c.method === 'eth_getBlockByNumber' && c.params[0] === 'latest'));
    assert.ok(calls.filter(c => c.method === 'eth_getTransactionCount').every(c => c.params[1] !== 'latest'));
    assert.ok(calls.every(c => c.method !== 'eth_sendRawTransaction'));
  }
});
test('a latest-number reorganization between nonce observation and canonical recheck blocks handoff', async () => {
  const f = fixture(); let latestResolved = false;
  await assert.rejects(verifyExternalCashHandoff({ plan: f.plan, priorJournal: f.pool, requirePriorEpoch: async () => {},
    rpc: async (method, params) => {
      const value = await f.rpc(method, params);
      if (method === 'eth_getBlockByNumber' && params[0] === 'latest') latestResolved = true;
      if (latestResolved && method === 'eth_getBlockByNumber' && params[0] === '0x64') return { ...(value as object), hash: `0x${'f'.repeat(64)}` };
      return value;
    } }), /TUSDC_HANDOFF_VERIFICATION_REQUIRED/);
});
