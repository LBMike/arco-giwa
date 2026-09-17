import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { enabled, fixture } from '../stocks-submissions/test-fixtures.js';
import { checkPreflightDatabase } from './database.js';
import { createPreflightProbes } from './adapters.js';
import { liquidityScope, type SqlPool } from '../stocks/contracts.js';
const options = { skip: !enabled };
const migrations = readdirSync('prisma/migrations', { withFileTypes: true }).filter(f => f.isDirectory()).map(f => ({ name: f.name, checksum: createHash('sha256').update(readFileSync(resolve('prisma/migrations', f.name, 'migration.sql'))).digest('hex') }));
// The isolated harness applies Stocks SQL directly. Prisma history is a test
// fixture here, not evidence that Prisma migrate deploy was exercised.
async function history(pool: SqlPool) {
    await pool.query('CREATE TABLE IF NOT EXISTS arco_evm."_prisma_migrations" (id text PRIMARY KEY, migration_name text NOT NULL, checksum text NOT NULL, finished_at timestamptz, rolled_back_at timestamptz)');
    await pool.query('DELETE FROM arco_evm."_prisma_migrations"');
    for (const m of migrations) await pool.query('INSERT INTO arco_evm."_prisma_migrations" VALUES($1,$2,$3,clock_timestamp(),NULL)', [randomUUID(), m.name, m.checksum]);
}
test('real PG preflight reads only: migration hashes, 19 tables and unbound/matching/conflicting vault', options, async t => {
    const f = await fixture(); t.after(() => f.pool.end()); await history(f.pool);
    const queries: string[] = [], connect = f.pool.connect.bind(f.pool);
    const monitored: SqlPool = { query: f.pool.query.bind(f.pool), connect: async () => { const db = await connect(); return { release: () => db.release(), query: async (sql, values) => {
        queries.push(sql); const result = await db.query(sql, values);
        if (sql.startsWith('BEGIN')) assert.equal((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
        return result;
    } }; } };
    const first = await checkPreflightDatabase(monitored, f.manifest, migrations, 'arco_evm');
    assert.ok(first.every(c => c.status === 'PASS')); assert.equal(first.find(c => c.id === 'vaultBinding')?.code, 'VAULT_UNBOUND_BEFORE_FIRST_START');
    assert.equal((await f.pool.query('SELECT * FROM arco_evm."StocksLiquidityBinding" WHERE "scopeKey"=$1', [liquidityScope(f.manifest)])).rowCount, 0);
    await f.stocks.bindDeployment();
    assert.equal((await checkPreflightDatabase(monitored, f.manifest, migrations, 'arco_evm')).find(c => c.id === 'vaultBinding')?.code, 'VAULT_BINDING_MATCHES');
    const conflict = await checkPreflightDatabase(monitored, { ...f.manifest, deploymentId: 'CHANGED' }, migrations, 'arco_evm');
    assert.equal(conflict.find(c => c.id === 'vaultBinding')?.status, 'FAIL');
    assert.ok(queries.every(sql => !/INSERT|UPDATE|DELETE|FOR SHARE|pg_advisory/.test(sql)));
});
test('real PG rejects changed, missing, unfinished, duplicate and unknown migration records; rollback history is allowed', options, async t => {
    const f = await fixture(); t.after(() => f.pool.end());
    for (const sql of [
        `UPDATE arco_evm."_prisma_migrations" SET checksum='changed' WHERE migration_name=$1`,
        `DELETE FROM arco_evm."_prisma_migrations" WHERE migration_name=$1`,
        `UPDATE arco_evm."_prisma_migrations" SET finished_at=NULL WHERE migration_name=$1`,
        `INSERT INTO arco_evm."_prisma_migrations" SELECT 'duplicate',migration_name,checksum,finished_at,rolled_back_at FROM arco_evm."_prisma_migrations" WHERE migration_name=$1`,
        `UPDATE arco_evm."_prisma_migrations" SET migration_name='unexpected' WHERE migration_name=$1`,
    ]) {
        await history(f.pool); await f.pool.query(sql, [migrations[0].name]);
        assert.equal((await checkPreflightDatabase(f.pool, f.manifest, migrations, 'arco_evm')).find(c => c.id === 'migrationHistory')?.status, 'FAIL');
    }
    await history(f.pool);
    await f.pool.query('INSERT INTO arco_evm."_prisma_migrations" VALUES($1,$2,$3,NULL,clock_timestamp())', [randomUUID(), migrations[0].name, 'old']);
    assert.equal((await checkPreflightDatabase(f.pool, f.manifest, migrations, 'arco_evm')).find(c => c.id === 'migrationHistory')?.status, 'PASS');
});
test('real PG reports missing history without claiming success, and real adapter closes its pool', options, async t => {
    const f = await fixture(); t.after(() => f.pool.end());
    await f.pool.query('DROP TABLE IF EXISTS arco_evm."_prisma_migrations"');
    assert.equal((await checkPreflightDatabase(f.pool, f.manifest, migrations, 'arco_evm')).find(c => c.id === 'migrationHistory')?.code, 'MIGRATION_HISTORY_UNAVAILABLE');
    await history(f.pool);
    const probes = createPreflightProbes({ config: { profile: 'DEMO_TESTNET', manifest: f.manifest, rpcUrl: 'https://unused.invalid', signerUrl: 'https://unused.invalid', contractPolicyVerified: true, paused: true, operators: [] }, databaseUrl: process.env.STOCKS_SUBMISSIONS_TEST_DATABASE_URL!, historySchema: 'arco_evm', signerToken: 'TEST_ONLY' }, migrations);
    assert.ok((await probes.database()).every(c => c.status === 'PASS'));
    assert.equal((await f.pool.query("SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE application_name='stocks_readonly_preflight'")).rows[0].count, '0');
});
test('real PG locked migration history times out and rolls back without late writes', options, async t => {
    const f = await fixture(); t.after(() => f.pool.end()); await history(f.pool);
    const locker = await f.pool.connect();
    try {
        await locker.query('BEGIN'); await locker.query('LOCK TABLE arco_evm."_prisma_migrations" IN ACCESS EXCLUSIVE MODE');
        const start = performance.now();
        await assert.rejects(checkPreflightDatabase(f.pool, f.manifest, migrations, 'arco_evm'));
        assert.ok(performance.now() - start < 4000);
    } finally { await locker.query('ROLLBACK'); locker.release(); }
    assert.ok((await checkPreflightDatabase(f.pool, f.manifest, migrations, 'arco_evm')).every(c => c.status === 'PASS'));
});
test('real PG missing Stocks table blocks startup checks despite matching history', options, async t => {
    const f = await fixture(); t.after(() => f.pool.end()); await history(f.pool);
    await f.pool.query('ALTER TABLE arco_evm."StocksWalletSubmissionProof" RENAME TO "PreflightHiddenProof"');
    try {
        const checks = await checkPreflightDatabase(f.pool, f.manifest, migrations, 'arco_evm');
        assert.equal(checks.find(c => c.id === 'migrationHistory')?.status, 'PASS');
        assert.equal(checks.find(c => c.id === 'stockTables')?.status, 'FAIL');
        assert.equal(checks.find(c => c.id === 'stockReadAccess')?.status, 'FAIL');
        assert.equal(checks.find(c => c.id === 'vaultBinding')?.status, 'NOT_CHECKED');
    } finally { await f.pool.query('ALTER TABLE arco_evm."PreflightHiddenProof" RENAME TO "StocksWalletSubmissionProof"'); }
});
