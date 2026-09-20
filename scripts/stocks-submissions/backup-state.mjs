import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function rowDigest(rows) {
  assert.ok(Array.isArray(rows) && rows.every(row => typeof row === 'string'));
  return createHash('sha256').update(JSON.stringify([...rows].sort())).digest('hex');
}

// Only used against the harness's quiescent, disposable database. No row values
// are exported in the evidence: compare exact row text through sorted digests.
export async function databaseSnapshot(client) {
  const names = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='arco_evm' ORDER BY tablename")).rows.map(row => row.tablename);
  assert.ok(names.some(name => /^Stocks[A-Za-z0-9_]+$/.test(name)) &&
    names.every(name => /^Stocks[A-Za-z0-9_]+$/.test(name) || name === '_prisma_migrations'), 'Unexpected rehearsal schema');
  const tables = [];
  for (const name of names) {
    const rows = (await client.query(`SELECT row_to_json(t)::text AS value FROM arco_evm."${name}" t`)).rows.map(row => row.value);
    tables.push({ name, count: rows.length, digest: rowDigest(rows) });
  }
  const definitions = (await client.query(`
    SELECT 'constraint' AS kind, c.relname AS name, con.conname AS member, pg_get_constraintdef(con.oid, true) AS definition
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='arco_evm'
    UNION ALL SELECT 'trigger', c.relname, t.tgname, pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='arco_evm' AND NOT t.tgisinternal
    UNION ALL SELECT 'index', tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='arco_evm'
    UNION ALL SELECT 'function', p.proname, pg_get_function_identity_arguments(p.oid), pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='arco_evm' AND p.prokind='f'
    UNION ALL SELECT 'column', table_name, column_name,
      json_build_array(ordinal_position, data_type, udt_schema, udt_name, is_nullable, column_default,
        character_maximum_length, numeric_precision, numeric_scale, is_identity, identity_generation, is_generated, generation_expression)::text
      FROM information_schema.columns WHERE table_schema='arco_evm'
    UNION ALL SELECT 'sequence', sequencename, '',
      json_build_array(data_type, start_value, min_value, max_value, increment_by, cycle, cache_size, last_value)::text
      FROM pg_sequences WHERE schemaname='arco_evm'
  `)).rows;
  // PG's own pretty deparser preserves precedence while removing redundant
  // nested AND parentheses introduced by BETWEEN on a dump/restore round trip.
  assert.ok(definitions.some(row => row.kind === 'trigger'), 'Immutable facts must retain their triggers');
  return { version: 1, tables, definitions: rowDigest(definitions.map(row => JSON.stringify(row))) };
}
