import test from 'node:test';
import assert from 'node:assert/strict';
import { type SqlClient, type SqlPool } from '../stocks/contracts.js';
import { h, testManifest } from '../stocks/test-fixtures.js';
import { seedSignerJournal, signerJournalStatus } from './journal-seed.js';

const manifest = testManifest();

function fixture() {
  const state = {
    checkpointCount: '0x2', finalizedCount: '0x5', pendingCount: '0x5',
    relations: { account_nonce: true, operation: true, signed_intent: true },
    account: null as Record<string, unknown> | null,
    inserts: [] as unknown[][], queries: [] as string[], releases: 0, rolledBack: 0, committed: 0,
  };
  const client: SqlClient = {
    async query(sql, values) {
      state.queries.push(sql);
      if (sql.startsWith('ROLLBACK')) { state.rolledBack++; return { rows: [], rowCount: null }; }
      if (sql.startsWith('COMMIT')) { state.committed++; return { rows: [], rowCount: null }; }
      if (/^(BEGIN|SET LOCAL)/.test(sql)) return { rows: [], rowCount: null };
      if (sql.includes('to_regclass')) return { rows: [state.relations], rowCount: 1 };
      if (sql.includes('INSERT INTO stocks_signer.account_nonce')) {
        state.inserts.push(values ?? []);
        if (state.account) return { rows: [], rowCount: 0 };
        const [signerAddress, networkInstance, checkpointNumber, checkpointHash, nonce] = values as string[];
        state.account = { signerAddress, networkInstance, checkpointNumber, checkpointHash, initialNonce: nonce, nextNonce: nonce };
        return { rows: [{ signerAddress }], rowCount: 1 };
      }
      if (sql.includes('FROM stocks_signer.account_nonce')) {
        assert.deepEqual(values, [manifest.signerAddress]);
        return { rows: state.account ? [state.account] : [], rowCount: state.account ? 1 : 0 };
      }
      throw Error('UNEXPECTED_TEST_SQL');
    },
    release() { state.releases++; },
  };
  const pool: SqlPool = { async connect() { return client; }, async query() { throw Error('MUST_USE_TRANSACTION'); } };
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    if (method === 'eth_chainId') return '0x164ce';
    if (method === 'eth_getBlockByNumber') {
      const [tag] = params;
      if (tag === '0x1') return { number: '0x1', hash: manifest.checkpointHash };
      if (tag === 'finalized' || tag === '0xa') return { number: '0xa', hash: h(10) };
    }
    if (method === 'eth_getTransactionCount') {
      const [signer, tag] = params;
      assert.equal(signer, manifest.signerAddress);
      if (tag === '0x1') return state.checkpointCount;
      if (tag === '0xa') return state.finalizedCount;
      if (tag === 'pending') return state.pendingCount;
    }
    if (method === 'eth_sendRawTransaction') throw Error('SEED_MUST_NOT_SEND');
    throw Error('UNEXPECTED_TEST_RPC');
  };
  return { state, pool, rpc };
}

test('seed writes exactly one account row at the reviewed nonce when the chain is quiet at that nonce', async () => {
  const f = fixture();
  assert.deepEqual(await seedSignerJournal({ pool: f.pool, manifest, reviewedInitialNonce: '5', rpc: f.rpc }), { status: 'SEEDED', nonce: '5' });
  assert.equal(f.state.inserts.length, 1);
  assert.deepEqual(f.state.inserts[0], [manifest.signerAddress, manifest.networkInstance, manifest.checkpointNumber, manifest.checkpointHash, '5']);
  assert.equal(f.state.account?.nextNonce, '5');
  assert.equal(f.state.committed, 1); assert.equal(f.state.releases, 1);
  // Re-running with the same reviewed nonce is a no-op.
  assert.deepEqual(await seedSignerJournal({ pool: f.pool, manifest, reviewedInitialNonce: '5', rpc: f.rpc }), { status: 'ALREADY_SEEDED', nonce: '5' });
  assert.equal(f.state.account?.initialNonce, '5');
});

test('seed refuses a busy or different chain nonce before touching the database', async () => {
  for (const patch of [{ pendingCount: '0x6' }, { finalizedCount: '0x4', pendingCount: '0x4' }]) {
    const f = fixture(); Object.assign(f.state, patch);
    await assert.rejects(() => seedSignerJournal({ pool: f.pool, manifest, reviewedInitialNonce: '5', rpc: f.rpc }), /SIGNER_SEED_CHAIN_NONCE_MISMATCH/);
    assert.equal(f.state.queries.length, 0);
  }
  for (const nonce of ['', '-1', '05', '1.0', '9007199254740992', 5 as unknown as string]) {
    const f = fixture();
    await assert.rejects(() => seedSignerJournal({ pool: f.pool, manifest, reviewedInitialNonce: nonce, rpc: f.rpc }), /SIGNER_SEED_NONCE_INVALID/);
  }
});

test('seed refuses a missing schema and any existing row that is not the same reviewed seed', async () => {
  const missing = fixture(); missing.state.relations.signed_intent = false;
  await assert.rejects(() => seedSignerJournal({ pool: missing.pool, manifest, reviewedInitialNonce: '5', rpc: missing.rpc }), /SIGNER_SEED_MIGRATION_MISSING/);
  assert.equal(missing.state.inserts.length, 0); assert.equal(missing.state.rolledBack, 1);
  for (const account of [
    { networkInstance: manifest.networkInstance, checkpointNumber: manifest.checkpointNumber, checkpointHash: manifest.checkpointHash, initialNonce: '4', nextNonce: '5' },
    { networkInstance: 'other:network', checkpointNumber: manifest.checkpointNumber, checkpointHash: manifest.checkpointHash, initialNonce: '5', nextNonce: '5' },
  ]) {
    const f = fixture(); f.state.account = account;
    await assert.rejects(() => seedSignerJournal({ pool: f.pool, manifest, reviewedInitialNonce: '5', rpc: f.rpc }), /SIGNER_SEED_ACCOUNT_MISMATCH/);
    assert.equal(f.state.rolledBack, 1); assert.equal(f.state.account, account);
  }
});

test('status is read-only and reports chain nonces with the journal row', async () => {
  const f = fixture();
  const before = await signerJournalStatus({ pool: f.pool, manifest, rpc: f.rpc });
  assert.deepEqual(before, { signerAddress: manifest.signerAddress,
    chain: { checkpoint: '2', finalized: '5', pending: '5', quiet: true }, journal: { schema: true, account: null } });
  assert.ok(f.state.queries.includes('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY'));
  assert.equal(f.state.inserts.length, 0);
  f.state.relations.operation = false;
  assert.deepEqual((await signerJournalStatus({ pool: f.pool, manifest, rpc: f.rpc })).journal, { schema: false, account: null });
  f.state.relations.operation = true; f.state.pendingCount = '0x6';
  f.state.account = { networkInstance: manifest.networkInstance, checkpointNumber: manifest.checkpointNumber, checkpointHash: manifest.checkpointHash, initialNonce: '5', nextNonce: '5' };
  const after = await signerJournalStatus({ pool: f.pool, manifest, rpc: f.rpc });
  assert.equal(after.chain.quiet, false);
  assert.deepEqual(after.journal.account, { initialNonce: '5', nextNonce: '5', matchesManifest: true });
});
