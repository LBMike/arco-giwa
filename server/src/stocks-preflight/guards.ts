import { createHash } from 'node:crypto';
import { stocksGuards, stocksGuardFunctions } from './guard-contract.js';

// Catalog reads only: never call a trigger function or try a product mutation.
export const guardCatalogSql = `SELECT c.relname AS table_name, t.tgname AS trigger_name,
 t.tgenabled::text AS enabled, t.tgtype::integer AS type_bits,
 t.tgdeferrable AS deferrable, t.tginitdeferred AS initially_deferred,
 t.tgqual IS NULL AS unconditional, t.tgnargs::integer AS argument_count,
 t.tgattr::text AS columns, t.tgoldtable AS old_table, t.tgnewtable AS new_table,
 pn.nspname AS function_schema, p.proname AS function_name, p.prosrc AS body,
 l.lanname AS language, p.prorettype = 'pg_catalog.trigger'::regtype AS returns_trigger,
 p.pronargs::integer AS function_arguments, p.prosecdef AS security_definer,
 p.proconfig AS function_settings, p.provolatile::text AS volatility,
 current_setting('session_replication_role') AS replication_role
 FROM pg_catalog.pg_trigger t
 JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
 JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
 JOIN pg_catalog.pg_language l ON l.oid=p.prolang
 WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND NOT t.tgisinternal`;

export function stockGuardsMatch(rows: Record<string, unknown>[], operatorControls: boolean, tradingLimits = false): boolean {
  const required = stocksGuards.filter(([table]) => (operatorControls || !table.startsWith('StocksTradingControl')) && (tradingLimits || !table.startsWith('StocksTradingLimit')));
  // Extra user triggers can suppress an insert/update before a guard runs, or
  // otherwise change its behavior. Require an exact inventory in checked tables.
  if (rows.length !== required.length) return false;
  return required.every(([table, trigger, fn, type, deferred]) => {
    const matches = rows.filter(row => row.table_name === table && row.trigger_name === trigger);
    if (matches.length !== 1) return false;
    const r = matches[0];
    return (r.enabled === 'O' || r.enabled === 'A') && r.replication_role === 'origin'
      && r.type_bits === type && r.deferrable === deferred && r.initially_deferred === deferred
      && r.unconditional === true && r.argument_count === 0 && r.columns === ''
      && r.old_table === null && r.new_table === null
      && r.function_schema === 'arco_evm' && r.function_name === fn
      && r.language === 'plpgsql' && r.returns_trigger === true && r.function_arguments === 0
      && r.security_definer === false && r.function_settings === null && r.volatility === 'v'
      && typeof r.body === 'string'
      && createHash('sha256').update(r.body).digest('hex') === stocksGuardFunctions[fn];
  });
}
