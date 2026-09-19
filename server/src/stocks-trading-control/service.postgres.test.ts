import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { StocksError, type Operator, type SqlClient, type SqlPool } from '../stocks/contracts.js';
import { StocksTradingControlService } from './service.js';
import type { TradingControlCommand } from './contracts.js';
import { stocksTradingControlPlugin } from './plugin.js';

const require = createRequire(import.meta.url);
const { Pool } = require('pg') as { Pool: new (options: unknown) => SqlPool & { end(): Promise<void> } };
const enabled = process.env.STOCKS_SUBMISSIONS_TEST_ONLY === '1' && !!process.env.STOCKS_SUBMISSIONS_TEST_DATABASE_URL;
const options = { skip: !enabled };
const operator: Operator = { operatorId: 'operator:alice', permissions: ['stocks:control'] };
function command(expectedVersion: number, paused = false): TradingControlCommand {
  return { paused, expectedVersion, idempotencyKey: randomUUID(), reason: 'Operator checked deployment readiness' };
}
function fixture() {
  if (!enabled) throw new Error('FRESH_PG_HARNESS_REQUIRED');
  const pool = new Pool({ connectionString: process.env.STOCKS_SUBMISSIONS_TEST_DATABASE_URL, max: 8 });
  const digest = randomBytes(32).toString('hex');
  return { pool, digest, service: new StocksTradingControlService(pool, digest) };
}
async function count(pool: SqlPool, table: 'StocksTradingControl' | 'StocksTradingControlEvent', digest: string) {
  return Number((await pool.query(`SELECT COUNT(*)::text AS n FROM arco_evm."${table}" WHERE "deploymentDigest"=$1`, [digest])).rows[0].n);
}

test('real PG control: absent state is paused, reads are mutation-free, and recreation preserves explicit changes', options, async t => {
  const f = fixture(); t.after(() => f.pool.end());
  const initial = { deploymentDigest: f.digest, paused: true, version: 0, updatedAt: null, operatorId: null, reason: null };
  assert.deepEqual(await f.service.read(), initial);
  assert.deepEqual(await f.service.history(), { items: [], nextBeforeVersion: null });
  assert.equal(await count(f.pool, 'StocksTradingControl', f.digest), 0);
  assert.equal(await count(f.pool, 'StocksTradingControlEvent', f.digest), 0);
  const changed = await f.service.change(operator, command(0));
  assert.equal(changed.replayed, false); assert.equal(changed.state.paused, false); assert.equal(changed.state.version, 1);
  assert.equal(changed.state.updatedAt, changed.change.createdAt); assert.equal(changed.change.previousPaused, true);
  assert.deepEqual(await new StocksTradingControlService(f.pool, f.digest).read(), changed.state);
  assert.equal(await count(f.pool, 'StocksTradingControl', f.digest), 1); assert.equal(await count(f.pool, 'StocksTradingControlEvent', f.digest), 1);
});

test('real PG control: concurrent expected-version writers commit one state and one immutable event', options, async t => {
  const f = fixture(); t.after(() => f.pool.end());
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => f.service.change(operator, command(0, index % 2 === 0))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.filter(result => result.status === 'rejected'); assert.equal(rejected.length, 11);
  for (const result of rejected) assert.ok(result.status === 'rejected' && result.reason instanceof StocksError && result.reason.code === 'CONTROL_VERSION_CONFLICT');
  assert.equal((await f.service.read()).version, 1); assert.equal(await count(f.pool, 'StocksTradingControlEvent', f.digest), 1);
});

test('real PG control: concurrent identical idempotency keys replay once and later replay reports current state', options, async t => {
  const f = fixture(); t.after(() => f.pool.end()); const first = command(0);
  const results = await Promise.all(Array.from({ length: 12 }, () => f.service.change(operator, first)));
  assert.equal(results.filter(result => !result.replayed).length, 1); assert.equal(new Set(results.map(result => result.change.id)).size, 1);
  const second = await f.service.change(operator, command(1, true));
  const replay = await f.service.change(operator, first);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.change, results[0].change); assert.deepEqual(replay.state, second.state);
  assert.equal(await count(f.pool, 'StocksTradingControlEvent', f.digest), 2);
});

test('real PG control: idempotency payload/operator conflicts cannot alter state; no-op commands still audit', options, async t => {
  const f = fixture(); t.after(() => f.pool.end()); const request = command(0, true);
  const first = await f.service.change(operator, request);
  assert.equal(first.state.paused, true); assert.equal(first.state.version, 1); assert.equal(first.change.previousPaused, true);
  for (const patch of [{ paused: false }, { expectedVersion: 1 }, { reason: 'Another reason' }]) await assert.rejects(f.service.change(operator, { ...request, ...patch }), /CONTROL_IDEMPOTENCY_CONFLICT/);
  await assert.rejects(f.service.change({ ...operator, operatorId: 'operator:bob' }, request), /CONTROL_IDEMPOTENCY_CONFLICT/);
  await assert.rejects(f.service.change(operator, command(0)), /CONTROL_VERSION_CONFLICT/);
  assert.deepEqual(await f.service.read(), first.state); assert.equal(await count(f.pool, 'StocksTradingControlEvent', f.digest), 1);
});

test('real PG control: deployment namespaces separate state, history, version and idempotency keys', options, async t => {
  const f = fixture(); t.after(() => f.pool.end()); const otherDigest = randomBytes(32).toString('hex');
  const other = new StocksTradingControlService(f.pool, otherDigest), request = command(0);
  const first = await f.service.change(operator, request);
  assert.equal((await other.read()).version, 0); assert.equal((await other.history()).items.length, 0);
  const second = await other.change(operator, request);
  assert.notEqual(first.change.id, second.change.id); assert.equal(second.state.deploymentDigest, otherDigest);
  assert.deepEqual((await f.service.history()).items, [first.change]);
});

test('real PG control: history uses exact newest-first keyset pagination including terminal full pages', options, async t => {
  const f = fixture(); t.after(() => f.pool.end());
  for (let version = 0; version < 6; version++) await f.service.change(operator, command(version, version % 2 === 0));
  const first = await f.service.history(2), second = await f.service.history(2, first.nextBeforeVersion!), last = await f.service.history(2, second.nextBeforeVersion!);
  assert.deepEqual(first.items.map(item => item.version), [6, 5]); assert.equal(first.nextBeforeVersion, 5);
  assert.deepEqual(second.items.map(item => item.version), [4, 3]); assert.equal(second.nextBeforeVersion, 3);
  assert.deepEqual(last.items.map(item => item.version), [2, 1]); assert.equal(last.nextBeforeVersion, null);
  assert.deepEqual(await f.service.history(2, 1), { items: [], nextBeforeVersion: null });
  assert.equal((await f.service.history()).items.length, 6);
  assert.ok(first.items.every(item => !('idempotencyKey' in item) && !('expectedVersion' in item)));
});

test('real PG control: an event write failure rolls back both initial state and later revisions', options, async t => {
  const f = fixture(); t.after(() => f.pool.end());
  const broken: SqlPool = { query: (sql, values) => f.pool.query(sql, values), connect: async () => {
    const db = await f.pool.connect();
    return { release: () => db.release(), query: (sql, values) => sql.startsWith('INSERT INTO arco_evm."StocksTradingControlEvent"') ? Promise.reject(new Error('TEST_EVENT_WRITE_FAILED')) : db.query(sql, values) };
  } };
  const service = new StocksTradingControlService(broken, f.digest);
  await assert.rejects(service.change(operator, command(0)), /TEST_EVENT_WRITE_FAILED/);
  assert.equal(await count(f.pool, 'StocksTradingControl', f.digest), 0); assert.equal(await count(f.pool, 'StocksTradingControlEvent', f.digest), 0);
  const initial = await f.service.change(operator, command(0));
  await assert.rejects(service.change(operator, command(1, true)), /TEST_EVENT_WRITE_FAILED/);
  assert.deepEqual(await f.service.read(), initial.state); assert.equal(await count(f.pool, 'StocksTradingControlEvent', f.digest), 1);
});

test('real PG control: a state write failure also rolls back its already-inserted event', options, async t => {
  const f = fixture(); t.after(() => f.pool.end()); const initial = await f.service.change(operator, command(0));
  const broken: SqlPool = { query: (sql, values) => f.pool.query(sql, values), connect: async () => {
    const db = await f.pool.connect();
    return { release: () => db.release(), query: (sql, values) => sql.startsWith('UPDATE arco_evm."StocksTradingControl"') ? Promise.reject(new Error('TEST_STATE_WRITE_FAILED')) : db.query(sql, values) };
  } };
  await assert.rejects(new StocksTradingControlService(broken, f.digest).change(operator, command(1, true)), /TEST_STATE_WRITE_FAILED/);
  assert.deepEqual(await f.service.read(), initial.state); assert.equal(await count(f.pool, 'StocksTradingControlEvent', f.digest), 1);
});

test('real PG control: immutable events and state guards reject deletion, regression, forged metadata and truncation', options, async t => {
  const f = fixture(); t.after(() => f.pool.end()); const changed = await f.service.change(operator, command(0));
  for (const sql of ['UPDATE arco_evm."StocksTradingControlEvent" SET reason=\'forged\' WHERE "deploymentDigest"=$1', 'DELETE FROM arco_evm."StocksTradingControlEvent" WHERE "deploymentDigest"=$1']) await assert.rejects(f.pool.query(sql, [f.digest]), /immutable fact/);
  await assert.rejects(f.pool.query('DELETE FROM arco_evm."StocksTradingControl" WHERE "deploymentDigest"=$1', [f.digest]), /CONTROL_DELETE_FORBIDDEN/);
  await assert.rejects(f.pool.query('UPDATE arco_evm."StocksTradingControl" SET version=0 WHERE "deploymentDigest"=$1', [f.digest]), /CONTROL_VERSION_REGRESSION/);
  await assert.rejects(f.pool.query('UPDATE arco_evm."StocksTradingControl" SET version=version+1,reason=\'forged\' WHERE "deploymentDigest"=$1', [f.digest]), /CONTROL_EVENT_MISMATCH/);
  await assert.rejects(f.pool.query('TRUNCATE arco_evm."StocksTradingControlEvent"'), /immutable fact/);
  await assert.rejects(f.pool.query('TRUNCATE arco_evm."StocksTradingControl",arco_evm."StocksTradingControlEvent"'), /CONTROL_DELETE_FORBIDDEN|immutable fact/);
  assert.deepEqual(await f.service.read(), changed.state);
});

test('real PG control: direct event inserts require a matching atomic state transition', options, async t => {
  const f = fixture(); t.after(() => f.pool.end()); const changed = await f.service.change(operator, command(0));
  const insert = async (db: Pick<SqlClient, 'query'>, previousPaused: boolean) => db.query('INSERT INTO arco_evm."StocksTradingControlEvent" (id,"deploymentDigest",version,"expectedVersion","previousPaused",paused,"operatorId",reason,"idempotencyKey") VALUES($1,$2,2,1,$3,true,$4,$5,$6)', [randomUUID(), f.digest, previousPaused, operator.operatorId, 'Direct SQL must be atomic', randomUUID()]);
  await assert.rejects(insert(f.pool, true), /CONTROL_EVENT_MISMATCH/);
  await assert.rejects(insert(f.pool, false), /CONTROL_EVENT_NOT_APPLIED/);
  const db = await f.pool.connect();
  try {
    await db.query('BEGIN'); await insert(db, false);
    await assert.rejects(db.query('UPDATE arco_evm."StocksTradingControl" SET version=2,paused=true,"operatorId"=$2,reason=\'different\',"updatedAt"=clock_timestamp() WHERE "deploymentDigest"=$1', [f.digest, operator.operatorId]), /CONTROL_EVENT_MISMATCH/);
  } finally { await db.query('ROLLBACK'); db.release(); }
  assert.deepEqual(await f.service.read(), changed.state); assert.equal(await count(f.pool, 'StocksTradingControlEvent', f.digest), 1);
});

test('real PG control: malformed Unicode is rejected without writes and astral text replays exactly', options, async t => {
  const f = fixture(); t.after(() => f.pool.end());
  const actor = { ...operator, operatorId: '운영자\ud83d\ude80\ud800\udc00\udbff\udfff' };
  const app = Fastify(); t.after(() => app.close());
  app.register(stocksTradingControlPlugin, { service: f.service, resolveOperator: async () => actor });
  const path = '/api/v1/admin/stocks/trading-control', request = command(0);
  for (const reason of ['\ud800', '\udfff', 'before\ud800after', '\udc00\ud800', '\ud800\ud800\udc00', '\ud800\udc00\udc00']) {
    const response = await app.inject({ method: 'POST', url: path, payload: { ...request, reason } });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, 'INVALID_TRADING_CONTROL_INPUT');
    assert.equal(response.headers['cache-control'], 'no-store');
    await assert.rejects(f.service.change(actor, { ...request, reason }), /INVALID_TRADING_CONTROL_INPUT/);
    await assert.rejects(f.service.change({ ...actor, operatorId: reason }, request), /OPERATOR_FORBIDDEN/);
  }
  assert.equal(await count(f.pool, 'StocksTradingControl', f.digest), 0);
  assert.equal(await count(f.pool, 'StocksTradingControlEvent', f.digest), 0);
  for (const reason of ['검증 완료 \ud83d\ude80\ud800\udc00\udbff\udfff', '\ud83d\ude80'.repeat(250)]) {
    const input = { ...request, expectedVersion: (await f.service.read()).version, reason };
    if (input.expectedVersion > 0) input.idempotencyKey = randomUUID();
    const first = await app.inject({ method: 'POST', url: path, payload: input });
    assert.equal(first.statusCode, 200, first.body);
    const stored = first.json().data;
    assert.equal(stored.replayed, false);
    assert.equal(stored.state.reason, reason); assert.equal(stored.change.reason, reason);
    assert.equal(stored.state.operatorId, actor.operatorId); assert.equal(stored.change.operatorId, actor.operatorId);
    const retry = await app.inject({ method: 'POST', url: path, payload: input });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.deepEqual(retry.json().data, { ...stored, replayed: true });
    assert.deepEqual(await new StocksTradingControlService(f.pool, f.digest).read(), stored.state);
    assert.equal((await f.service.history()).items[0].reason, reason);
  }
  assert.equal(await count(f.pool, 'StocksTradingControlEvent', f.digest), 2);
});
