import { liquidityScope, manifestDigest, ensure, type Manifest, type SqlPool } from '../stocks/contracts.js';
import type { Check } from './checker.js';

export type Migration = { name: string; checksum: string };
const tables = ['StocksQuote', 'StocksOrder', 'StocksFunding', 'StocksOutbox', 'StocksJournal', 'StocksHolding', 'StocksAudit', 'StocksProviderReceipt', 'StocksSellQuote', 'StocksSellOrder', 'StocksQuantityReservation', 'StocksCustody', 'StocksQuantityMovement', 'StocksCashReservation', 'StocksObserverCursor', 'StocksLiquidityBinding', 'StocksWalletSubmissionEnrollment', 'StocksWalletSubmission', 'StocksWalletSubmissionProof'];
const check = (id: string, ok: boolean, good: string, bad: string): Check => ({ id, status: ok ? 'PASS' : 'FAIL', code: ok ? good : bad });

export async function checkPreflightDatabase(pool: SqlPool, manifest: Manifest, migrations: readonly Migration[], historySchema: 'public' | 'arco_evm', options: { timeoutMs?: number; monotonicNow?: () => number; operatorControls?: boolean } = {}): Promise<Check[]> {
    ensure(historySchema === 'public' || historySchema === 'arco_evm', 'INVALID_HISTORY_SCHEMA');
    ensure(migrations.length > 0 && new Set(migrations.map(m => m.name)).size === migrations.length && migrations.every(m => /^[a-zA-Z0-9_]+$/.test(m.name) && /^[0-9a-f]{64}$/.test(m.checksum)), 'INVALID_EXPECTED_MIGRATIONS');
    ensure(options.operatorControls === undefined || typeof options.operatorControls === 'boolean', 'INVALID_STOCKS_OPERATOR_CONTROLS');
    const requiredTables = options.operatorControls === true ? [...tables, 'StocksTradingControl', 'StocksTradingControlEvent'] : tables;
    const timeout = options.timeoutMs ?? 5000, mono = options.monotonicNow ?? (() => performance.now());
    ensure(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 5000, 'INVALID_PREFLIGHT_TIMEOUT');
    const start = mono(); let closed = false, timer: ReturnType<typeof setTimeout> | undefined;
    const live = () => { const age = mono() - start; ensure(!closed && Number.isFinite(age) && age >= 0 && age < timeout, 'PREFLIGHT_DATABASE_TIMEOUT'); };
    const work = async () => {
        live(); const db = await pool.connect();
        try { live(); } catch (error) { db.release(); throw error; }
        const query = async (sql: string, params?: unknown[]) => { live(); const rows = await db.query(sql, params); live(); return rows; };
        try {
            await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            await query("SET LOCAL statement_timeout='2000ms'");
            await query("SET LOCAL lock_timeout='2000ms'");
            await query("SET LOCAL idle_in_transaction_session_timeout='3000ms'");
            const present = (await query('SELECT c.relname, has_table_privilege(c.oid,\'SELECT\') AS can_read FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND c.relkind=\'r\'', ['arco_evm', requiredTables])).rows;
            const schemaOk = requiredTables.every(name => present.some(r => r.relname === name));
            const checks = [check('stockTables', schemaOk, 'STOCK_TABLES_PRESENT', 'STOCK_TABLES_MISSING')];
            checks.push(check('stockReadAccess', schemaOk && present.every(row => row.can_read === true), 'STOCK_TABLES_READABLE', 'STOCK_TABLES_UNREADABLE_OR_MISSING'));
            const historyExists = !!(await query('SELECT to_regclass($1)::text AS name', [`"${historySchema}"."_prisma_migrations"`])).rows[0]?.name;
            const history = historyExists ? (await query(`SELECT migration_name, checksum, finished_at, rolled_back_at FROM "${historySchema}"."_prisma_migrations"`)).rows : [];
            const active = history.filter(row => row.rolled_back_at === null);
            const expected = new Map(migrations.map(m => [m.name, m.checksum]));
            const matched = active.every(row => row.finished_at !== null && expected.get(row.migration_name) === row.checksum) && migrations.every(m => active.filter(row => row.migration_name === m.name).length === 1);
            checks.push(check('migrationHistory', matched, 'MIGRATION_HISTORY_MATCHES', historyExists ? 'MIGRATION_HISTORY_MISSING_FAILED_OR_CHANGED' : 'MIGRATION_HISTORY_UNAVAILABLE'));
            if (schemaOk) {
                const binding = (await query('SELECT "deploymentDigest" FROM arco_evm."StocksLiquidityBinding" WHERE "scopeKey"=$1', [liquidityScope(manifest)])).rows[0];
                checks.push(check('vaultBinding', !binding || binding.deploymentDigest === manifestDigest(manifest), binding ? 'VAULT_BINDING_MATCHES' : 'VAULT_UNBOUND_BEFORE_FIRST_START', 'VAULT_BOUND_TO_OTHER_DEPLOYMENT'));
            } else checks.push({ id: 'vaultBinding', status: 'NOT_CHECKED', code: 'STOCK_TABLES_MISSING' });
            await query('COMMIT');
            live(); return checks;
        } catch (error) { try { await db.query('ROLLBACK'); } catch { /* preserve diagnostic failure */ } throw error; }
        finally { db.release(); }
    };
    try { return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => { closed = true; reject(new Error('PREFLIGHT_DATABASE_TIMEOUT')); }, timeout); })]); }
    finally { closed = true; clearTimeout(timer); }
}
