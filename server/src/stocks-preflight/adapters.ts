import { createRequire } from 'node:module';
import { createDeploymentEvidence } from '../stocks-execution/deployment.js';
import { externalStocksSigner, httpStocksRpc } from '../stocks-runtime/transport.js';
import type { SqlPool } from '../stocks/contracts.js';
import { checkPreflightDatabase, type Migration } from './database.js';
import { preflightDigest, type Prepared } from './checker.js';

export async function boundedProbe<T>(work: () => Promise<T>, timeoutMs: number, mono: () => number = () => performance.now()): Promise<T> {
    const start = mono(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const value = await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('PREFLIGHT_TIMEOUT')), timeoutMs); })]);
        const elapsed = mono() - start;
        if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= timeoutMs) throw new Error('PREFLIGHT_TIMEOUT');
        return value;
    } finally { clearTimeout(timer); }
}

export function createPreflightProbes(prepared: Prepared, migrations: readonly Migration[]) {
    const { config, databaseUrl, historySchema, signerToken } = prepared;
    return {
        async database() {
            const { Pool } = createRequire(import.meta.url)('pg') as { Pool: new (config: unknown) => SqlPool & { end(): Promise<void>; on(event: string, listener: () => void): void } };
            const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 2000, query_timeout: 2500, lock_timeout: 2000, idle_in_transaction_session_timeout: 3000, application_name: 'stocks_readonly_preflight' });
            pool.on('error', () => { /* never log database credentials or raw messages */ });
            try { return await checkPreflightDatabase(pool, config.manifest, migrations, historySchema, { operatorControls: config.operatorControls }); }
            finally { await pool.end(); }
        },
        async deployment() {
            // Existing verifier enforces its own 8s total deadline, canonical
            // checkpoint/code/bindings and no late RPC continuation.
            await createDeploymentEvidence(config.manifest, httpStocksRpc(config.rpcUrl)).get();
        },
        async signer() {
            const signer = externalStocksSigner({ url: config.signerUrl, authorization: signerToken, deploymentDigest: preflightDigest(config), manifest: config.manifest });
            await boundedProbe(() => signer.probe(), 10000);
        },
    };
}
