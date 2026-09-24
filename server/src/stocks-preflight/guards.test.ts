import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { stocksGuards, stocksGuardFunctions } from './guard-contract.js';
import { stockGuardsMatch } from './guards.js';
import { migrationGuardFixture } from './guard-test-fixtures.js';

test('guard contract covers every current migration trigger and final replaced function body', () => {
  const f = migrationGuardFixture();
  assert.equal(f.guards.length, f.declarations);
  assert.equal(f.parsedFunctions, f.functionDeclarations);
  assert.deepEqual(f.guards, stocksGuards);
  assert.deepEqual(Object.fromEntries(Object.entries(f.functions).map(([name, body]) => [name, createHash('sha256').update(body).digest('hex')])), stocksGuardFunctions);
  assert.ok(stockGuardsMatch(f.rows, true));
  const legacy = f.rows.filter(r => !(r.table_name as string).startsWith('StocksTradingControl'));
  assert.ok(stockGuardsMatch(legacy, false));
  assert.equal(stockGuardsMatch(legacy, true), false);
});

test('missing, duplicate, unexpected and individually disabled guards never pass', () => {
  const { rows } = migrationGuardFixture();
  assert.equal(stockGuardsMatch([...rows, { ...rows[0], trigger_name: 'Unexpected' }], true), false);
  assert.equal(stockGuardsMatch([...rows.slice(1), rows[1]], true), false);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(stockGuardsMatch(rows.filter((_, index) => i !== index), true), false);
    assert.equal(stockGuardsMatch(rows.map((r, index) => i === index ? { ...r, enabled: 'D' } : r), true), false);
  }
});

test('same-name weakened trigger or function fails; ALWAYS firing is accepted', () => {
  const { rows } = migrationGuardFixture();
  for (const mutation of [
    { enabled: 'R' }, { replication_role: 'replica' }, { replication_role: 'local' },
    { type_bits: 9 }, { deferrable: true }, { initially_deferred: true },
    { unconditional: false }, { argument_count: 1 }, { columns: '1' },
    { old_table: 'old_rows' }, { new_table: 'new_rows' },
    { function_schema: 'public' }, { function_name: 'replacement' },
    { body: 'BEGIN RETURN NEW; END' }, { body: null }, { language: 'sql' },
    { returns_trigger: false }, { function_arguments: 1 }, { security_definer: true },
    { function_settings: ['session_replication_role=replica'] }, { volatility: 's' },
  ]) assert.equal(stockGuardsMatch([{ ...rows[0], ...mutation }, ...rows.slice(1)], true), false, JSON.stringify(mutation));
  assert.ok(stockGuardsMatch(rows.map(r => ({ ...r, enabled: 'A' })), true));
});
