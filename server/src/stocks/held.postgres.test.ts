import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { SqlPool } from './contracts.js';
import { a } from './test-fixtures.js';
import { parseHeldQuery, readHeldPayments } from './held.js';

const require = createRequire(import.meta.url);
const pg = require('pg') as { Pool: new (options: unknown) => SqlPool & { end(): Promise<void> } };
const enabled = process.env.STOCKS_TEST_HARNESS_ONLY === '1' && !!process.env.STOCKS_TEST_DATABASE_URL;

test('real PG: held payments list only order-less funding and custody of this deployment, with the direct hold, newest first', { skip: !enabled }, async t => {
  const pool = new pg.Pool({ connectionString: process.env.STOCKS_TEST_DATABASE_URL, max: 2 });
  t.after(() => pool.end());
  const digest = `TEST_HARNESS_ONLY_${randomUUID()}`, other = `TEST_HARNESS_ONLY_${randomUUID()}`;
  const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
  const proof = JSON.stringify({ fixture: 'held' });
  const at = (second: number, micros = 0) => `2026-09-20T12:00:${String(second).padStart(2, '0')}.${String(micros).padStart(6, '0')}Z`;
  const funding = (id: string, digestValue: string, amount: string, createdAt: string, reason = 'UNIDENTIFIED_ORDER') => pool.query(
    'INSERT INTO arco_evm."StocksFunding" (id,payer,amount,status,reason,"txHash",proof,"deploymentDigest","createdAt") VALUES ($1,$2,$3,\'SUSPENSE\',$4,$5,$6,$7,$8)',
    [id, a(101), amount, reason, tx(Number(amount)), proof, digestValue, createdAt]);
  const custody = (id: string, quantity: string, createdAt: string) => pool.query(
    'INSERT INTO arco_evm."StocksCustody" (id,"escrowId","deploymentDigest",payer,quantity,reason,status,"txHash",proof,"createdAt") VALUES ($1,$2,$3,$4,$5,\'UNIDENTIFIED_ORDER\',\'HELD\',$6,$7,$8)',
    [id, `escrow-${id}`, digest, a(102), quantity, tx(Number(quantity.slice(0, 6))), proof, createdAt]);
  const audit = (subject: string, detail: Record<string, unknown>, digestValue = digest) => pool.query(
    'INSERT INTO arco_evm."StocksAudit" (id,subject,action,detail,"deploymentDigest") VALUES ($1,$2,\'DIRECT_ORDER_NOT_CREATED\',$3,$4)',
    [randomUUID(), subject, JSON.stringify(detail), digestValue]);

  const f1 = randomUUID(), f2 = randomUUID(), f3 = randomUUID(), c1 = randomUUID(), c2 = randomUUID();
  await funding(f1, digest, '1000000', at(1));
  await funding(f2, digest, '2000000', at(3, 500001), 'UNATTRIBUTED_TRANSFER');
  await funding(f3, other, '3000000', at(4));
  await custody(c1, '5000000000000000000', at(2));
  // Same instant as f2 down to the microsecond: the side and then the id order them.
  await custody(c2, '6000000000000000000', at(3, 500001));
  await audit('0xarcodrct-f1', { side: 'BUY', fundingId: f1, hold: 'TRADING_PAUSED' });
  await audit('0xarcodrct-c1', { side: 'SELL', custodyId: c1, hold: 'BELOW_ONE_UNIT' });
  await audit('0xarcodrct-f3', { side: 'BUY', fundingId: f3, hold: 'PRICE_UNAVAILABLE' }, other);

  const source = { pool, deploymentDigest: digest };
  const all = await readHeldPayments(source, parseHeldQuery({}));
  assert.deepEqual(all.items.map(item => [item.side, item.id, item.hold, item.cashAmount, item.quantity]), [
    ['SELL', c2, null, null, '6000000000000000000'],
    ['BUY', f2, null, '2000000', null],
    ['SELL', c1, 'BELOW_ONE_UNIT', null, '5000000000000000000'],
    ['BUY', f1, 'TRADING_PAUSED', '1000000', null],
  ]);
  assert.equal(all.items[1].reason, 'UNATTRIBUTED_TRANSFER');
  assert.equal(all.nextCursor, null);

  const pages: string[][] = [];
  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<typeof readHeldPayments>> = await readHeldPayments(source, parseHeldQuery({ limit: '1', ...(cursor ? { cursor } : {}) }));
    pages.push(page.items.map(item => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(pages, [[c2], [f2], [c1], [f1]]);
});
