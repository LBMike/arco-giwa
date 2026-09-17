import assert from 'node:assert/strict';
import test from 'node:test';
import { testManifest } from '../stocks/test-fixtures.js';
import type { SqlClient, SqlPool } from '../stocks/contracts.js';
import { checkPreflightDatabase } from './database.js';
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
