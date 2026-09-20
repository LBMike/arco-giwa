import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { databaseSnapshot } from './backup-state.mjs';

const phase = process.argv[2], file = process.env.STOCKS_SUBMISSIONS_TEST_BACKUP_FILE;
assert.ok(['capture', 'verify'].includes(phase) && process.argv.length === 3);
assert.equal(process.env.STOCKS_SUBMISSIONS_TEST_ONLY, '1');
assert.ok(file && isAbsolute(file) && /^stocks-submissions-pg-[A-Za-z0-9_-]+$/.test(dirname(file).split('/').at(-1)));
const url = new URL(process.env.STOCKS_SUBMISSIONS_TEST_DATABASE_URL);
assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, 'localhost');
assert.equal(url.username, 'submissions_harness'); assert.equal(url.password, ''); assert.equal(url.port, '');
assert.equal(url.pathname, phase === 'capture' ? '/submissions_test' : '/submissions_restored');
assert.deepEqual([...url.searchParams.keys()], ['host']);
assert.equal(url.searchParams.get('host'), join(dirname(file), 'socket'));
const { Pool } = createRequire(import.meta.url)('pg');
const pool = new Pool({ connectionString: url.href, max: 1 });
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = await databaseSnapshot(client);
    if (phase === 'capture') writeFileSync(file, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
    else {
      assert.deepEqual(snapshot, JSON.parse(readFileSync(file, 'utf8')), 'Restored rows or database rules differ');
      assert.equal((await client.query("SELECT 1 FROM pg_database WHERE datname='submissions_test'")).rowCount, 0,
        'Original database must be absent during restore verification');
      console.log(JSON.stringify({ kind: 'STOCKS_BACKUP_RESTORE_SNAPSHOT_PASS', tables: snapshot.tables.length,
        rows: snapshot.tables.reduce((sum, table) => sum + table.count, 0), rulesDigest: snapshot.definitions }));
    }
    await client.query('COMMIT');
  } finally { client.release(); }
} finally { await pool.end(); }
