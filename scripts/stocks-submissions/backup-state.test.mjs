import test from 'node:test';
import assert from 'node:assert/strict';
import { rowDigest, databaseSnapshot } from './backup-state.mjs';

test('row digest is order independent but detects edits, deletion and duplicates', () => {
  const rows = ['{"id":1,"amount":"10"}', '{"id":2,"amount":"20"}'];
  assert.equal(rowDigest(rows), rowDigest([...rows].reverse()));
  for (const changed of [rows.slice(1), [...rows, rows[0]], [rows[0].replace('10', '11'), rows[1]]])
    assert.notEqual(rowDigest(rows), rowDigest(changed));
  assert.deepEqual(rows, ['{"id":1,"amount":"10"}', '{"id":2,"amount":"20"}']);
});

test('snapshot rejects empty or foreign table inventories before reading rows', async () => {
  for (const tablename of [null, 'OtherProduct', 'StocksBad";DROP']) {
    let calls = 0;
    await assert.rejects(databaseSnapshot({ query: async () => { calls++; return { rows: tablename ? [{ tablename }] : [] }; } }));
    assert.equal(calls, 1);
  }
});

test('snapshot includes empty tables and refuses missing immutable-fact triggers', async () => {
  const client = { query: async sql => ({ rows: sql.includes('FROM pg_tables') ? [{ tablename: 'StocksEmpty' }]
    : sql.includes('row_to_json') ? [] : [{ kind: 'trigger', name: 'StocksEmpty', member: 'immutable', definition: 'fixture' }] }) };
  const snapshot = await databaseSnapshot(client);
  assert.deepEqual(snapshot.tables, [{ name: 'StocksEmpty', count: 0, digest: rowDigest([]) }]);
  await assert.rejects(databaseSnapshot({ query: async sql => ({ rows: sql.includes('FROM pg_tables') ? [{ tablename: 'StocksEmpty' }] : [] }) }));
});

test('migration history is included in the same restore comparison', async () => {
  const snapshot = await databaseSnapshot({ query: async sql => ({ rows: sql.includes('FROM pg_tables')
    ? [{ tablename: 'StocksOrder' }, { tablename: '_prisma_migrations' }]
    : sql.includes('row_to_json') ? [{ value: sql.includes('_prisma_migrations') ? '{"checksum":"original"}' : '{"id":"order"}' }]
    : [{ kind: 'trigger', name: 'StocksOrder', member: 'immutable', definition: 'fixture' }] }) });
  assert.equal(snapshot.tables.find(table => table.name === '_prisma_migrations').digest, rowDigest(['{"checksum":"original"}']));
});
