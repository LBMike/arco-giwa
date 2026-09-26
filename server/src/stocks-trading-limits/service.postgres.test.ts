import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import type { SqlPool } from '../stocks/contracts.js';
import { a } from '../stocks/test-fixtures.js';
import { StocksTradingLimitService } from './service.js';
import type { TradingSide } from './contracts.js';

// The trading limit tables and the day's usage over the real Stocks schema (all migrations applied).
const require = createRequire(import.meta.url);
const pg = require('pg') as { Pool: new (options: unknown) => SqlPool & { end(): Promise<void> } };
const enabled = process.env.STOCKS_TEST_HARNESS_ONLY === '1' && !!process.env.STOCKS_TEST_DATABASE_URL;
const options = { skip: !enabled };
const CONTROL = { operatorId: 'limits-operator', permissions: ['stocks:read', 'stocks:control'] };
const READER = { operatorId: 'limits-reader', permissions: ['stocks:read'] };
const USDC = (whole: number) => (BigInt(whole) * 1_000_000n).toString();

async function scenario(work: (pool: SqlPool, digest: string, limits: StocksTradingLimitService) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.STOCKS_TEST_DATABASE_URL, max: 6 });
  const digest = randomBytes(32).toString('hex');
  try { await work(pool, digest, new StocksTradingLimitService(pool, digest, ['NVDA'])); } finally { await pool.end(); }
}

/** An order row of `side` as the order paths write it; `at` and `expires` are SQL timestamp expressions. */
async function order(pool: SqlPool, digest: string, side: TradingSide, cash: string, state: string, at = 'clock_timestamp()', expires = "clock_timestamp()+interval '60 seconds'") {
  const quote = randomUUID(), id = randomUUID();
  const [quotes, orders] = side === 'BUY' ? ['StocksQuote', 'StocksOrder'] : ['StocksSellQuote', 'StocksSellOrder'];
  await pool.query(`INSERT INTO arco_evm."${quotes}" (id,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest","expiresAt") VALUES ($1,'limits-actor',$2,'NVDA',1000,$3,$4,${expires})`, [quote, a(901), cash, digest]);
  await pool.query(
    `INSERT INTO arco_evm."${orders}" (id,"orderKey","quoteId","actorId",wallet,symbol,quantity,"cashAmount","idempotencyKey","deploymentId","deploymentDigest","quoteExpiresAt",state,"createdAt")
     VALUES ($1,$2,$3,'limits-actor',$4,'NVDA',1000,$5,$6,'TEST_LIMITS',$7,${expires},$8,${at})`,
    [id, `limits:${id}`, quote, a(901), cash, `limits:${id}`, digest, state],
  );
}

const command = (overrides: Record<string, unknown> = {}) => ({ enabled: true, dailyCashLimit: null, expectedVersion: 0, idempotencyKey: `limit:${randomUUID()}`, reason: 'Testing limits', ...overrides }) as never;

test('PG limits: without a change every side is enabled with no cap, one row per side, and the day is a KST day', options, () => scenario(async (pool, digest, limits) => {
  const read = await limits.read();
  assert.deepEqual(read.items.map(item => [item.symbol, item.side, item.enabled, item.dailyCashLimit, item.version, item.usedToday]), [['NVDA', 'BUY', true, null, 0, '0'], ['NVDA', 'SELL', true, null, 0, '0']]);
  const start = new Date(read.window.start);
  // 00:00 in Seoul is 15:00 UTC of the previous day.
  assert.deepEqual([start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()], [15, 0, 0, 0]);
  assert.equal(Date.parse(read.window.resetsAt) - start.getTime(), 86_400_000);
  assert.ok(start.getTime() <= Date.now() && Date.now() < Date.parse(read.window.resetsAt));
  assert.equal(read.window.timeZone, 'Asia/Seoul');
  assert.equal((await pool.query('SELECT 1 FROM arco_evm."StocksTradingLimit" WHERE "deploymentDigest"=$1', [digest])).rows.length, 0, 'reading creates no row');
  assert.equal(await limits.check('NVDA', 'BUY', 10n ** 30n), null);
}));

test('PG limits: a change is versioned, replayable, conflict-checked and needs stocks:control', options, () => scenario(async (_pool, _digest, limits) => {
  await assert.rejects(() => limits.change(READER, 'NVDA', 'BUY', command({ enabled: false })), (e: any) => e.code === 'OPERATOR_FORBIDDEN' && e.status === 403);
  const first = command({ enabled: false, idempotencyKey: 'limit-key-0001', reason: 'Pause buys for review' });
  const made = await limits.change(CONTROL, 'NVDA', 'BUY', first);
  assert.equal(made.replayed, false);
  assert.deepEqual([made.state.enabled, made.state.dailyCashLimit, made.state.version, made.state.operatorId, made.state.reason], [false, null, 1, 'limits-operator', 'Pause buys for review']);
  assert.deepEqual([made.change.previousEnabled, made.change.previousDailyCashLimit, made.change.enabled, made.change.version], [true, null, false, 1]);
  assert.equal(made.state.updatedAt, made.change.createdAt);
  const replay = await limits.change(CONTROL, 'NVDA', 'BUY', first);
  assert.equal(replay.replayed, true);
  assert.equal(replay.change.id, made.change.id);
  await assert.rejects(() => limits.change(CONTROL, 'NVDA', 'BUY', { ...(first as object), reason: 'Something else' } as never), (e: any) => e.code === 'LIMIT_IDEMPOTENCY_CONFLICT' && e.status === 409);
  await assert.rejects(() => limits.change(CONTROL, 'NVDA', 'SELL', first), (e: any) => e.code === 'LIMIT_IDEMPOTENCY_CONFLICT', 'a key belongs to one (symbol, side)');
  await assert.rejects(() => limits.change(CONTROL, 'NVDA', 'BUY', command({ expectedVersion: 0 })), (e: any) => e.code === 'LIMIT_VERSION_CONFLICT' && e.status === 409);
  const capped = await limits.change(CONTROL, 'NVDA', 'SELL', command({ dailyCashLimit: USDC(50_000), reason: 'Cap sells at 50,000' }));
  assert.deepEqual([capped.state.side, capped.state.enabled, capped.state.dailyCashLimit, capped.state.version], ['SELL', true, USDC(50_000), 1]);
  const reopened = await limits.change(CONTROL, 'NVDA', 'BUY', command({ expectedVersion: 1, reason: 'Reopen buys' }));
  assert.deepEqual([reopened.change.previousEnabled, reopened.state.enabled, reopened.state.version], [false, true, 2]);
  const history = await limits.history();
  assert.deepEqual(history.items.map(item => [item.side, item.version, item.reason]), [['BUY', 2, 'Reopen buys'], ['SELL', 1, 'Cap sells at 50,000'], ['BUY', 1, 'Pause buys for review']]);
  assert.equal((await limits.history(1)).items.length, 1);
  const read = await limits.read();
  assert.deepEqual(read.items.map(item => [item.side, item.enabled, item.dailyCashLimit, item.version]), [['BUY', true, null, 2], ['SELL', true, USDC(50_000), 1]]);
  for (const bad of [
    () => limits.change(CONTROL, 'TSLA', 'BUY', command()),
    () => limits.change(CONTROL, 'NVDA', 'HOLD' as never, command()),
    () => limits.change(CONTROL, 'NVDA', 'SELL', command({ expectedVersion: 1, dailyCashLimit: '0' })),
    () => limits.change(CONTROL, 'NVDA', 'SELL', command({ expectedVersion: 1, dailyCashLimit: '1.5' })),
    () => limits.change(CONTROL, 'NVDA', 'SELL', command({ expectedVersion: 1, dailyCashLimit: 5 })),
    () => limits.change(CONTROL, 'NVDA', 'SELL', command({ expectedVersion: 1, reason: ' padded' })),
    () => limits.change(CONTROL, 'NVDA', 'SELL', command({ expectedVersion: 1, idempotencyKey: 'short' })),
    () => limits.change(CONTROL, 'NVDA', 'SELL', { ...(command({ expectedVersion: 1 }) as object), extra: true } as never),
  ]) await assert.rejects(bad, (e: any) => e.code === 'INVALID_TRADING_LIMIT_INPUT' && e.status === 400);
}));

test('PG limits: the table guards reject any write that skips the event log', options, () => scenario(async (pool, digest, limits) => {
  await limits.change(CONTROL, 'NVDA', 'BUY', command({ enabled: false }));
  await assert.rejects(() => pool.query('UPDATE arco_evm."StocksTradingLimit" SET enabled=true, version=version+1 WHERE "deploymentDigest"=$1', [digest]), /LIMIT_EVENT_MISMATCH/);
  await assert.rejects(() => pool.query('UPDATE arco_evm."StocksTradingLimit" SET enabled=true WHERE "deploymentDigest"=$1', [digest]), /LIMIT_VERSION_REGRESSION/);
  await assert.rejects(() => pool.query('DELETE FROM arco_evm."StocksTradingLimit" WHERE "deploymentDigest"=$1', [digest]), /LIMIT_DELETE_FORBIDDEN/);
  await assert.rejects(() => pool.query('UPDATE arco_evm."StocksTradingLimitEvent" SET reason=\'rewritten\' WHERE "deploymentDigest"=$1', [digest]));
  await assert.rejects(() => pool.query('DELETE FROM arco_evm."StocksTradingLimitEvent" WHERE "deploymentDigest"=$1', [digest]));
  await assert.rejects(() => pool.query('INSERT INTO arco_evm."StocksTradingLimit" ("deploymentDigest",symbol,side,enabled,version,"updatedAt","operatorId",reason) VALUES ($1,\'NVDA\',\'SELL\',false,1,clock_timestamp(),\'x\',\'x\')', [digest]), /LIMIT_INITIAL_STATE_INVALID/);
  // An event that is never applied to the state row cannot commit.
  await pool.query('INSERT INTO arco_evm."StocksTradingLimit" ("deploymentDigest",symbol,side) VALUES ($1,\'NVDA\',\'SELL\')', [digest]);
  await assert.rejects(() => pool.query(
    'INSERT INTO arco_evm."StocksTradingLimitEvent" (id,"deploymentDigest",symbol,side,version,"expectedVersion","previousEnabled",enabled,"operatorId",reason,"idempotencyKey") VALUES ($1,$2,\'NVDA\',\'SELL\',1,0,true,false,\'x\',\'x\',\'direct-insert-01\')',
    [randomUUID(), digest]), /LIMIT_EVENT_NOT_APPLIED/);
  const read = await limits.read();
  assert.deepEqual(read.items.map(item => [item.side, item.enabled, item.version]), [['BUY', false, 1], ['SELL', true, 0]]);
}));

test('PG limits: the day counts reserved, running and done orders of this deployment, not ended or earlier ones', options, () => scenario(async (pool, digest, limits) => {
  await limits.change(CONTROL, 'NVDA', 'BUY', command({ dailyCashLimit: USDC(100) }));
  const yesterday = `(date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul') - interval '1 second'`;
  await order(pool, digest, 'BUY', USDC(30), 'COMPLETED');
  await order(pool, digest, 'BUY', USDC(20), 'AWAITING_FUNDING');
  await order(pool, digest, 'BUY', USDC(40), 'AWAITING_FUNDING', 'clock_timestamp()', "clock_timestamp()-interval '5 minutes'");
  await order(pool, digest, 'BUY', USDC(5), 'REVIEW_REQUIRED');
  // Left out: unpaid past the grace, ended without trading, before today, another deployment, the other side.
  await order(pool, digest, 'BUY', USDC(50), 'AWAITING_FUNDING', 'clock_timestamp()', "clock_timestamp()-interval '11 minutes'");
  for (const state of ['FUNDED_QUOTE_EXPIRED', 'FUNDING_REVIEW_REQUIRED', 'REFUNDED']) await order(pool, digest, 'BUY', USDC(500), state);
  await order(pool, digest, 'BUY', USDC(1000), 'COMPLETED', yesterday);
  await order(pool, randomBytes(32).toString('hex'), 'BUY', USDC(1000), 'COMPLETED');
  await order(pool, digest, 'SELL', USDC(1000), 'COMPLETED');
  const read = await limits.read();
  assert.equal(read.items.find(item => item.side === 'BUY')!.usedToday, USDC(95));
  assert.equal(await limits.check('NVDA', 'BUY', BigInt(USDC(5))), null, 'exactly at the cap passes');
  assert.equal(await limits.check('NVDA', 'BUY', BigInt(USDC(5)) + 1n), 'DAILY_LIMIT_REACHED');
  await order(pool, digest, 'BUY', USDC(5), 'BROKER_PENDING');
  assert.equal(await limits.check('NVDA', 'BUY', 1n), 'DAILY_LIMIT_REACHED', 'a full day refuses even the smallest order');

  await limits.change(CONTROL, 'NVDA', 'SELL', command({ dailyCashLimit: USDC(2000) }));
  await order(pool, digest, 'SELL', USDC(300), 'AWAITING_ESCROW');
  await order(pool, digest, 'SELL', USDC(700), 'AWAITING_ESCROW', 'clock_timestamp()', "clock_timestamp()-interval '11 minutes'");
  for (const state of ['EXPIRED', 'ESCROW_REVIEW_REQUIRED', 'RETURN_QUEUED', 'RETURNED']) await order(pool, digest, 'SELL', USDC(700), state);
  await order(pool, digest, 'SELL', USDC(200), 'SELL_BROKER_PENDING');
  assert.equal((await limits.read()).items.find(item => item.side === 'SELL')!.usedToday, USDC(1500));
  assert.equal(await limits.check('NVDA', 'SELL', BigInt(USDC(500))), null);
  assert.equal(await limits.check('NVDA', 'SELL', BigInt(USDC(501))), 'DAILY_LIMIT_REACHED');

  await limits.change(CONTROL, 'NVDA', 'SELL', command({ enabled: false, dailyCashLimit: null, expectedVersion: 1 }));
  assert.equal(await limits.check('NVDA', 'SELL', 1n), 'SIDE_DISABLED');
}));

test('PG limits: two orders at the cap at the same time: the second waits for the first and is refused', options, () => scenario(async (pool, digest, limits) => {
  await limits.change(CONTROL, 'NVDA', 'BUY', command({ dailyCashLimit: USDC(100) }));
  const first = await pool.connect(), second = await pool.connect();
  try {
    await first.query('BEGIN');
    await second.query('BEGIN');
    assert.equal(await limits.admit(first, 'NVDA', 'BUY', BigInt(USDC(60))), null);
    let settled = false;
    const waiting = limits.admit(second, 'NVDA', 'BUY', BigInt(USDC(60))).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(settled, false, 'the second order waits while the first holds the (symbol, side)');
    const quote = randomUUID(), id = randomUUID();
    await first.query(`INSERT INTO arco_evm."StocksQuote" (id,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest","expiresAt") VALUES ($1,'limits-actor',$2,'NVDA',1000,$3,$4,clock_timestamp()+interval '60 seconds')`, [quote, a(902), USDC(60), digest]);
    await first.query(`INSERT INTO arco_evm."StocksOrder" (id,"orderKey","quoteId","actorId",wallet,symbol,quantity,"cashAmount","idempotencyKey","deploymentId","deploymentDigest","quoteExpiresAt") VALUES ($1,$2,$3,'limits-actor',$4,'NVDA',1000,$5,$6,'TEST_LIMITS',$7,clock_timestamp()+interval '60 seconds')`, [id, `limits:${id}`, quote, a(902), USDC(60), `limits:${id}`, digest]);
    await first.query('COMMIT');
    assert.equal(await waiting, 'DAILY_LIMIT_REACHED');
    await second.query('ROLLBACK');
  } finally { first.release(); second.release(); }
}));
