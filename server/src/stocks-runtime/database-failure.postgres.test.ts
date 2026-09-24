import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { watchStocksPoolErrors } from './database-failure.js';
import { StocksObservationHealth } from './health.js';
import type { SqlPool } from '../stocks/contracts.js';

const { Pool } = createRequire(import.meta.url)('pg') as { Pool: new (options: unknown) => SqlPool & {
  on(event: 'error', listener: () => void): unknown;
  once(event: 'error', listener: () => void): unknown;
  end(): Promise<void>;
} };
const enabled = process.env.STOCKS_SUBMISSIONS_TEST_ONLY === '1' && !!process.env.STOCKS_SUBMISSIONS_TEST_DATABASE_URL;

test('real PG: terminating only this test pool idle connection reports failure and subsequent queries reconnect', { skip: !enabled }, async t => {
  const options = { connectionString: process.env.STOCKS_SUBMISSIONS_TEST_DATABASE_URL, max: 1, connectionTimeoutMillis: 3000 };
  const pool = new Pool(options), controller = new Pool(options);
  t.after(async () => { await pool.end(); await controller.end(); });
  const health = new StocksObservationHealth(); health.record('CURRENT');
  let failures = 0;
  watchStocksPoolErrors(pool, () => ({ notifyDatabaseFailure() { failures++; health.record('UNAVAILABLE_OR_REVIEW_REQUIRED'); } }));
  watchStocksPoolErrors(controller, () => undefined);
  const pid = Number((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failed = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(Error('OWNED_IDLE_ERROR_NOT_OBSERVED')), 5000);
    pool.once('error', () => resolve());
  });
  // The only victim is the dedicated connection opened immediately above in the
  // freshly owned test database. No DB restart or other process termination.
  try {
    await Promise.all([failed, controller.query('SELECT pg_terminate_backend($1) AS stopped', [pid]).then(result => {
      assert.equal(result.rows[0].stopped, true);
    })]);
  } finally { clearTimeout(timer); }
  assert.equal(failures, 1); assert.equal(health.current(), false);
  const next = Number((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  assert.notEqual(next, pid);
  // Reconnecting alone does not claim a complete observation or reopen orders.
  assert.equal(health.status(), 'UNAVAILABLE_OR_REVIEW_REQUIRED');
});
