import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Test-only extraction of the repository's current, deliberately narrow SQL
// grammar. Unrecognized new trigger/function statements fail the parity test.
export function migrationGuardFixture() {
  const functions: Record<string, string> = {};
  const guards: [string, string, string, number, boolean][] = [];
  let declarations = 0, functionDeclarations = 0, parsedFunctions = 0;
  for (const name of readdirSync('prisma/migrations').filter(name => name.includes('_stocks_')).sort()) {
    const sql = readFileSync(resolve('prisma/migrations', name, 'migration.sql'), 'utf8');
    declarations += [...sql.matchAll(/CREATE (?:CONSTRAINT )?TRIGGER /g)].length;
    functionDeclarations += [...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION /g)].length;
    for (const m of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION arco_evm\.([^()]+)\(\) RETURNS TRIGGER LANGUAGE plpgsql AS \$\$(.*?)\$\$;/gis)) {
      functions[m[1].replace(/"/g, '')] = m[2]; parsedFunctions++;
    }
    for (const m of sql.matchAll(/CREATE (CONSTRAINT )?TRIGGER "([^"]+)" (BEFORE|AFTER) ([A-Z ]+) ON arco_evm\."([^"]+)" (DEFERRABLE INITIALLY DEFERRED )?FOR EACH (ROW|STATEMENT) EXECUTE FUNCTION arco_evm\.([^()]+)\(\);/g)) {
      const events: Record<string, number> = { INSERT: 4, DELETE: 8, UPDATE: 16, TRUNCATE: 32 };
      const bits = (m[7] === 'ROW' ? 1 : 0) + (m[3] === 'BEFORE' ? 2 : 0) + m[4].split(' OR ').reduce((sum, event) => sum + events[event], 0);
      guards.push([m[5], m[2], m[8].replace(/"/g, ''), bits, !!m[6]]);
    }
  }
  const rows: Record<string, unknown>[] = guards.map(([table, trigger, fn, type, deferred]) => ({
    table_name: table, trigger_name: trigger, enabled: 'O', type_bits: type,
    deferrable: deferred, initially_deferred: deferred, unconditional: true,
    argument_count: 0, columns: '', old_table: null, new_table: null,
    function_schema: 'arco_evm', function_name: fn, body: functions[fn],
    language: 'plpgsql', returns_trigger: true, function_arguments: 0,
    security_definer: false, function_settings: null, volatility: 'v', replication_role: 'origin',
  }));
  return { functions, guards, rows, declarations, functionDeclarations, parsedFunctions };
}
