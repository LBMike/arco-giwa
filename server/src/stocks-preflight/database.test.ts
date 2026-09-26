import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { testManifest } from '../stocks/test-fixtures.js';
import type { SqlClient, SqlPool } from '../stocks/contracts.js';
import { checkPreflightDatabase } from './database.js';
import { createPreflightProbes } from './adapters.js';
import { migrationGuardFixture } from './guard-test-fixtures.js';
const migrations = [{ name: 'fixture', checksum: 'a'.repeat(64) }];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
test('late acquired connection is released without a query after preflight timeout', async () => {
    const gate = deferred<SqlClient>(); let releases = 0, queries = 0;
    const pool: SqlPool = { connect: () => gate.promise, query: async () => { throw new Error('UNEXPECTED'); } };
    await assert.rejects(checkPreflightDatabase(pool, testManifest(), migrations, 'arco_evm', { timeoutMs: 10 }), /PREFLIGHT_DATABASE_TIMEOUT/);
    gate.resolve({ query: async () => { queries++; return { rows: [], rowCount: 0 }; }, release: () => { releases++; } });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(releases, 1); assert.equal(queries, 0);
});
test('late query completion permits only rollback and connection release', async () => {
    const gate = deferred<{ rows: never[]; rowCount: number }>(), queries: string[] = []; let releases = 0;
    const pool: SqlPool = { query: async () => { throw new Error('UNEXPECTED'); }, connect: async () => ({ query: async sql => { queries.push(sql); return sql.startsWith('BEGIN') ? gate.promise : { rows: [], rowCount: 0 }; }, release: () => { releases++; } }) };
    await assert.rejects(checkPreflightDatabase(pool, testManifest(), migrations, 'arco_evm', { timeoutMs: 10 }), /PREFLIGHT_DATABASE_TIMEOUT/);
    gate.resolve({ rows: [], rowCount: 0 }); await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(queries, ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK']); assert.equal(releases, 1);
});
test('monotonic timeout rejects delayed completion before timer callback and rejects unknown schema before connection', async () => {
    let now = 0, releases = 0, connections = 0;
    const pool: SqlPool = { query: async () => { throw new Error('UNEXPECTED'); }, connect: async () => { connections++; now += 20; return { query: async () => { throw new Error('UNEXPECTED'); }, release: () => { releases++; } }; } };
    await assert.rejects(checkPreflightDatabase(pool, testManifest(), migrations, 'arco_evm', { timeoutMs: 10, monotonicNow: () => now }), /PREFLIGHT_DATABASE_TIMEOUT/);
    assert.equal(releases, 1);
    await assert.rejects(checkPreflightDatabase(pool, testManifest(), migrations, 'other' as 'arco_evm'), /INVALID_HISTORY_SCHEMA/);
    assert.equal(connections, 1);
});

function catalogFixture(controlTables: string[] = [], unreadable?: string) {
    // Optional tables (operator controls, trading limits) exist only when listed in controlTables.
    const controls = new Set(['StocksTradingControl', 'StocksTradingControlEvent', 'StocksTradingLimit', 'StocksTradingLimitEvent']);
    const queries: string[] = [], requested: string[][] = [];
    let connections = 0, releases = 0;
    const pool: SqlPool = {
        query: async () => { throw new Error('POOL_QUERY_NOT_EXPECTED'); },
        connect: async () => {
            connections++;
            return {
                release: () => { releases++; },
                query: async (sql, values = []) => {
                    queries.push(sql);
                    if (sql.includes('pg_catalog.pg_trigger')) {
                        const names = values[1] as string[];
                        const rows = migrationGuardFixture().rows.filter(row => names.includes(row.table_name as string) && (!controls.has(row.table_name as string) || controlTables.includes(row.table_name as string)));
                        return { rows, rowCount: rows.length };
                    }
                    if (sql.includes('pg_catalog.pg_class')) {
                        const names = values[1] as string[]; requested.push([...names]);
                        const rows = names.filter(name => !controls.has(name) || controlTables.includes(name)).map(name => ({ relname: name, can_read: name !== unreadable }));
                        return { rows, rowCount: rows.length };
                    }
                    if (sql.includes('to_regclass')) return { rows: [{ name: 'arco_evm._prisma_migrations' }], rowCount: 1 };
                    if (sql.includes('SELECT migration_name')) return { rows: [{ migration_name: migrations[0].name, checksum: migrations[0].checksum, finished_at: new Date(), rolled_back_at: null }], rowCount: 1 };
                    return { rows: [], rowCount: 0 };
                },
            };
        },
    };
    return { pool, queries, requested, counts: () => ({ connections, releases }) };
}

test('preflight keeps legacy 19-table requirements when operator controls are absent or disabled', async () => {
    const f = catalogFixture();
    const legacy = await checkPreflightDatabase(f.pool, testManifest(), migrations, 'arco_evm');
    const disabled = await checkPreflightDatabase(f.pool, testManifest(), migrations, 'arco_evm', { operatorControls: false });
    assert.deepEqual(disabled, legacy); assert.ok(legacy.every(item => item.status === 'PASS'));
    assert.deepEqual(legacy.map(item => item.id), ['stockTables', 'stockReadAccess', 'migrationHistory', 'stockMutationGuards', 'vaultBinding']);
    assert.ok(f.requested.every(names => names.length === 19 && !names.includes('StocksTradingControl') && !names.includes('StocksTradingControlEvent')));
    assert.deepEqual(f.counts(), { connections: 2, releases: 2 });
});

test('enabled control preflight requires both readable control tables and remains read-only', async () => {
    for (const available of [[], ['StocksTradingControl'], ['StocksTradingControlEvent']]) {
        const f = catalogFixture(available);
        const checks = await checkPreflightDatabase(f.pool, testManifest(), migrations, 'arco_evm', { operatorControls: true });
        assert.equal(checks.find(item => item.id === 'stockTables')?.status, 'FAIL');
        assert.equal(checks.find(item => item.id === 'stockReadAccess')?.status, 'FAIL');
        assert.equal(checks.find(item => item.id === 'vaultBinding')?.status, 'NOT_CHECKED');
        assert.equal(f.requested[0].length, 21);
    }
    for (const unreadable of ['StocksTradingControl', 'StocksTradingControlEvent']) {
        const f = catalogFixture(['StocksTradingControl', 'StocksTradingControlEvent'], unreadable);
        const checks = await checkPreflightDatabase(f.pool, testManifest(), migrations, 'arco_evm', { operatorControls: true });
        assert.equal(checks.find(item => item.id === 'stockTables')?.status, 'PASS');
        assert.equal(checks.find(item => item.id === 'stockReadAccess')?.status, 'FAIL');
    }
    const f = catalogFixture(['StocksTradingControl', 'StocksTradingControlEvent']);
    assert.ok((await checkPreflightDatabase(f.pool, testManifest(), migrations, 'arco_evm', { operatorControls: true })).every(item => item.status === 'PASS'));
    assert.equal(f.queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.ok(f.queries.every(sql => !/INSERT|UPDATE|DELETE|FOR SHARE|pg_advisory/.test(sql)));
    assert.deepEqual(f.counts(), { connections: 1, releases: 1 });
});

test('trading limit preflight requires both limit tables and their guards, alone or with operator controls', async () => {
    const limitTables = ['StocksTradingLimit', 'StocksTradingLimitEvent'];
    for (const available of [[], ['StocksTradingLimit'], ['StocksTradingLimitEvent']]) {
        const f = catalogFixture(available);
        const checks = await checkPreflightDatabase(f.pool, testManifest(), migrations, 'arco_evm', { tradingLimits: true });
        assert.equal(checks.find(item => item.id === 'stockTables')?.status, 'FAIL');
        assert.equal(checks.find(item => item.id === 'vaultBinding')?.status, 'NOT_CHECKED');
        assert.equal(f.requested[0].length, 21);
        assert.ok(f.requested[0].includes('StocksTradingLimit') && !f.requested[0].includes('StocksTradingControl'));
    }
    const limits = catalogFixture(limitTables);
    assert.ok((await checkPreflightDatabase(limits.pool, testManifest(), migrations, 'arco_evm', { tradingLimits: true })).every(item => item.status === 'PASS'));
    const both = catalogFixture(['StocksTradingControl', 'StocksTradingControlEvent', ...limitTables]);
    assert.ok((await checkPreflightDatabase(both.pool, testManifest(), migrations, 'arco_evm', { operatorControls: true, tradingLimits: true })).every(item => item.status === 'PASS'));
    assert.equal(both.requested[0].length, 23);
    const off = catalogFixture(limitTables);
    assert.ok((await checkPreflightDatabase(off.pool, testManifest(), migrations, 'arco_evm', { tradingLimits: false })).every(item => item.status === 'PASS'));
    assert.equal(off.requested[0].length, 19);
    await assert.rejects(checkPreflightDatabase(off.pool, testManifest(), migrations, 'arco_evm', { tradingLimits: 'yes' as never }), /INVALID_STOCKS_TRADING_LIMITS/);
});

test('invalid operator-control preflight flags fail before any connection', async () => {
    const f = catalogFixture();
    for (const flag of ['true', 'false', 0, 1, null, {}]) await assert.rejects(checkPreflightDatabase(f.pool, testManifest(), migrations, 'arco_evm', { operatorControls: flag as boolean }), /INVALID_STOCKS_OPERATOR_CONTROLS/);
    assert.deepEqual(f.counts(), { connections: 0, releases: 0 });
});

test('database adapter forwards the opt-in control flag and always closes its pool without external access', async () => {
    const pg = createRequire(import.meta.url)('pg') as { Pool: unknown }, original = pg.Pool;
    const f = catalogFixture(); let closed = 0;
    pg.Pool = class {
        query = f.pool.query.bind(f.pool);
        connect = f.pool.connect.bind(f.pool);
        on() {}
        async end() { closed++; }
    };
    try {
        for (const operatorControls of [true, false, undefined]) {
            const probes = createPreflightProbes({ config: { profile: 'DEMO_TESTNET', manifest: testManifest(), rpcUrl: 'https://unused.invalid', signerUrl: 'https://unused.invalid', contractPolicyVerified: true, paused: true, operators: [], ...(operatorControls === undefined ? {} : { operatorControls }) }, databaseUrl: 'postgresql://unused.invalid/test', historySchema: 'arco_evm', signerToken: 'TEST_ONLY' }, migrations);
            const checks = await probes.database();
            assert.equal(checks.find(item => item.id === 'stockTables')?.status, operatorControls === true ? 'FAIL' : 'PASS');
        }
        assert.deepEqual(f.requested.map(names => names.length), [21, 19, 19]); assert.equal(closed, 3);
    } finally { pg.Pool = original; }
});
