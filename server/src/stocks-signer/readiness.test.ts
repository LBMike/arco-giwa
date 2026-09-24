import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { manifestDigest, type SqlClient, type SqlPool } from '../stocks/contracts.js';
import { h, testManifest } from '../stocks/test-fixtures.js';
import { createStocksSignerCore } from './core.js';
import { createStocksSignerHttpService } from './http-service.js';
import { PostgresSignerJournal } from './postgres-journal.js';
import { createStocksSignerReadiness } from './readiness.js';

const manifest = testManifest();
const digest = manifestDigest(manifest);
const triggers = [
  ['account_nonce', 'account_nonce_guard'], ['account_nonce', 'account_nonce_no_truncate'],
  ['operation', 'operation_guard'], ['operation', 'operation_no_truncate'],
  ['operation', 'operation_signed_intent_guard'],
  ['signed_intent', 'signed_intent_guard'], ['signed_intent', 'signed_intent_no_truncate'],
].map(([table_name, trigger_name]) => ({ table_name, trigger_name, enabled: 'O' }));

function fixture() {
  const state = {
    chainId: '0x164ce', checkpointHash: manifest.checkpointHash as string, finalizedNumber: '0xa',
    checkpointCount: '0x2', finalizedCount: '0x3', pendingCount: '0x3', recheckFinalizedHash: h(10),
    relations: { account_nonce: true, operation: true, signed_intent: true },
    triggers: structuredClone(triggers),
    account: { chainId: 91342, signerAddress: manifest.signerAddress,
      networkInstance: manifest.networkInstance, checkpointNumber: manifest.checkpointNumber,
      checkpointHash: manifest.checkpointHash, initialNonce: '3', nextNonce: '3' } as Record<string, unknown> | null,
    broken: false, replicationRole: 'origin', operational: true, operationalChecks: 0, rpcCalls: [] as string[],
    rpcParams: [] as { method: string; params: unknown[] }[],
    dbQueries: [] as string[], releases: 0, dbError: false,
  };
  const client: SqlClient = {
    async query(sql, values) {
      state.dbQueries.push(sql);
      if (state.dbError) throw Error('PRIVATE_DATABASE_URL');
      if (sql.includes("current_setting('session_replication_role')"))
        return { rows: [{ replication_role: state.replicationRole }], rowCount: 1 };
      if (sql.includes('to_regclass')) return { rows: [state.relations], rowCount: 1 };
      if (sql.includes('pg_catalog.pg_trigger')) return { rows: state.triggers, rowCount: state.triggers.length };
      if (sql.includes('FROM stocks_signer.account_nonce')) {
        assert.deepEqual(values, [manifest.signerAddress]);
        return { rows: state.account ? [state.account] : [], rowCount: state.account ? 1 : 0 };
      }
      if (sql.includes('FROM stocks_signer.operation o')) {
        assert.deepEqual(values, [manifest.signerAddress]);
        return { rows: state.broken ? [{ '?column?': 1 }] : [], rowCount: state.broken ? 1 : 0 };
      }
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)) return { rows: [], rowCount: null };
      throw Error('UNEXPECTED_TEST_SQL');
    },
    release() { state.releases++; },
  };
  const pool: SqlPool = {
    async connect() { return client; },
    async query() { throw Error('READINESS_MUST_USE_READ_ONLY_TRANSACTION'); },
  };
  const journal = new PostgresSignerJournal(pool, manifest, '3');
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    state.rpcCalls.push(method);
    state.rpcParams.push({ method, params });
    if (method === 'eth_chainId') { assert.deepEqual(params, []); return state.chainId; }
    if (method === 'eth_getBlockByNumber') {
      const [tag, full] = params;
      assert.equal(full, false);
      if (tag === '0x1') return { number: '0x1', hash: state.checkpointHash };
      if (tag === 'finalized') return { number: state.finalizedNumber, hash: h(10) };
      if (tag === '0xa') return { number: '0xa', hash: state.recheckFinalizedHash };
    }
    if (method === 'eth_getTransactionCount') {
      const [signer, tag] = params;
      assert.equal(signer, manifest.signerAddress);
      if (tag === '0x1') return state.checkpointCount;
      if (tag === state.finalizedNumber) return state.finalizedCount;
      if (tag === 'pending') return state.pendingCount;
    }
    throw Error('UNEXPECTED_TEST_RPC');
  };
  const ready = createStocksSignerReadiness({ manifest, reviewedManifestDigest: digest, reviewedInitialNonce: '3',
    journal, rpc, operationalReady: async () => { state.operationalChecks++; return state.operational; } });
  return { state, journal, rpc, ready };
}

test('readiness verifies reviewed manifest, finalized checkpoint, historical nonce and durable journal before policy gate', async () => {
  const f = fixture();
  assert.equal(await f.ready(), true);
  assert.equal(f.state.operationalChecks, 1);
  assert.deepEqual(f.state.rpcCalls, ['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByNumber',
    'eth_getTransactionCount', 'eth_getTransactionCount', 'eth_getBlockByNumber',
    'eth_getTransactionCount', 'eth_chainId', 'eth_getBlockByNumber']);
  assert.deepEqual(f.state.rpcParams[6], { method: 'eth_getTransactionCount',
    params: [manifest.signerAddress, 'pending'] });
  assert.equal(f.state.dbQueries[0], 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
  assert.equal(f.state.dbQueries[f.state.dbQueries.length - 1], 'COMMIT');
  assert.equal(f.state.releases, 1);
  assert.equal(f.state.rpcCalls.includes('eth_sendRawTransaction'), false);
});

test('a journal-owned pending nonce remains eligible for original-operation recovery', async () => {
  const f = fixture();
  f.state.account!.nextNonce = '4';
  f.state.pendingCount = '0x4';
  assert.equal(await f.ready(), true);
  assert.equal(f.state.operationalChecks, 1);
});

test('visible foreign pending nonce and inconsistent provider pending view fail closed', async () => {
  for (const pendingCount of ['0x4', '0x2', '0xgarbage']) {
    const f = fixture();
    f.state.pendingCount = pendingCount;
    assert.equal(await f.ready(), false);
    assert.equal(f.state.operationalChecks, 0);
    assert.equal(f.state.rpcParams.some(call => call.method === 'eth_getTransactionCount'
      && call.params[1] === 'pending'), true);
  }
});

test('wrong chain, checkpoint, finality or nonce fails closed before operational gate', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.state.chainId = '0x1'; },
    (f: ReturnType<typeof fixture>) => { f.state.checkpointHash = h(90); },
    (f: ReturnType<typeof fixture>) => { f.state.finalizedNumber = '0x0'; },
    (f: ReturnType<typeof fixture>) => { f.state.checkpointCount = '0x4'; },
    (f: ReturnType<typeof fixture>) => { f.state.finalizedCount = '0x2'; },
    (f: ReturnType<typeof fixture>) => { f.state.finalizedCount = '0x4'; },
    (f: ReturnType<typeof fixture>) => { f.state.finalizedCount = '0x1'; },
    (f: ReturnType<typeof fixture>) => { f.state.recheckFinalizedHash = h(90); },
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(await f.ready(), false);
    assert.equal(f.state.operationalChecks, 0);
    assert.equal(f.state.releases, f.state.dbQueries.length ? 1 : 0);
  }
});

test('missing migration, disabled guard, bad account seed or mismatched signed intent rejects readiness', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.state.relations.signed_intent = false; },
    (f: ReturnType<typeof fixture>) => { f.state.replicationRole = 'replica'; },
    (f: ReturnType<typeof fixture>) => { f.state.triggers.find(row => row.trigger_name === 'operation_signed_intent_guard')!.enabled = 'D'; },
    (f: ReturnType<typeof fixture>) => { f.state.account = null; },
    (f: ReturnType<typeof fixture>) => { f.state.account!.networkInstance = 'ANOTHER_NETWORK'; },
    (f: ReturnType<typeof fixture>) => { f.state.account!.initialNonce = '4'; },
    (f: ReturnType<typeof fixture>) => { f.state.account!.nextNonce = '2'; },
    (f: ReturnType<typeof fixture>) => { f.state.broken = true; },
    (f: ReturnType<typeof fixture>) => { f.state.dbError = true; },
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(await f.ready(), false);
    assert.equal(f.state.operationalChecks, 0);
    assert.equal(f.state.releases, 1);
    assert.equal(f.state.dbQueries[f.state.dbQueries.length - 1], f.state.dbError
      ? 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY' : 'ROLLBACK');
  }
});

test('unreviewed configuration or operational policy failure can never advertise capabilities', async t => {
  const f = fixture();
  const unreviewed = createStocksSignerReadiness({ manifest, reviewedManifestDigest: '0'.repeat(64),
    reviewedInitialNonce: '3', journal: f.journal, rpc: f.rpc, operationalReady: async () => true });
  assert.equal(await unreviewed(), false);
  assert.equal(f.state.rpcCalls.length, 0);
  f.state.operational = false;
  const core = createStocksSignerCore({ manifest, journal: f.journal, transport: {
    sendOnce: async () => { throw Error('MUST_NOT_SIGN'); }, findOriginal: async () => null,
  } });
  const token = randomBytes(32).toString('base64url');
  const app = createStocksSignerHttpService({ manifest, core, bearerToken: token, ready: f.ready });
  t.after(() => app.close());
  const denied = await app.inject({ method: 'GET', url: '/v1/capabilities' });
  assert.equal(denied.statusCode, 401);
  assert.equal(f.state.rpcCalls.length, 0, 'auth must precede readiness work');
  const blocked = await app.inject({ method: 'GET', url: '/v1/capabilities',
    headers: { authorization: `Bearer ${token}` } });
  assert.equal(blocked.statusCode, 503);
  assert.deepEqual(blocked.json(), { error: 'SIGNER_NOT_READY' });
  assert.equal(f.state.operationalChecks, 1);
  f.state.operational = true;
  const allowed = await app.inject({ method: 'GET', url: '/v1/capabilities',
    headers: { authorization: `Bearer ${token}` } });
  assert.equal(allowed.statusCode, 200);
});

test('deadline returns false and concurrent probes share one in-flight readiness check', async () => {
  const f = fixture();
  let release!: (value: boolean) => void;
  let calls = 0;
  const pending = new Promise<boolean>(resolve => { release = resolve; });
  const ready = createStocksSignerReadiness({ manifest, reviewedManifestDigest: digest,
    reviewedInitialNonce: '3', journal: f.journal, rpc: f.rpc,
    operationalReady: async () => { calls++; return pending; }, deadlineMs: 20 });
  const responses = await Promise.all([ready(), ready(), ready()]);
  assert.deepEqual(responses, [false, false, false]);
  assert.equal(calls, 1);
  assert.equal(await ready(), false, 'a hung check must not start another connection');
  assert.equal(calls, 1);
  release(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await ready(), true);
  assert.equal(calls, 2);
});
