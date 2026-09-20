import { createRequire } from 'node:module';
import { ensure, freezeManifest, manifestDigest, type Manifest, type SignerPort, type SqlPool } from '../stocks/contracts.js';
import { ReceiptVerifier } from '../stocks/chain.js';
import { StocksRepository } from '../stocks/repository.js';
import { StocksService } from '../stocks/service.js';
import { StocksWorker } from '../stocks/worker.js';
import { createDurableMockBroker } from '../stocks/mock-broker.js';
import { createStocksRpcPort, type JsonRpcTransport } from '../stocks/rpc.js';
import { StocksFinalizedObserver } from './observer.js';
import { endpoint, externalStocksSigner, httpStocksRpc } from './transport.js';
import { parseStocksOperators, type NamedOperator } from './operators.js';
import { readStocksPublicJson } from './public-config.js';
import { StocksObservationHealth } from './health.js';
import { runtimeSnapshot } from './status.js';
import { createSubmissionReceiptVerifier } from '../stocks-submissions/receipts.js';
import { verifyStocksDeployment } from './deployment.js';
export { verifyStocksDeployment } from './deployment.js';
import { createDeploymentEvidence } from '../stocks-execution/deployment.js';
import { StocksExecutionService } from '../stocks-execution/service.js';
import { StocksTradingControlService } from '../stocks-trading-control/service.js';
import { StocksTradingControlPolicy } from '../stocks-trading-control/policy.js';
import { watchStocksPoolErrors } from './database-failure.js';

export type StocksRuntimeConfig = {
  profile: 'DEMO_TESTNET'; manifest: Manifest & { schemaVersion: 2; redemptionEscrow: `0x${string}` };
  rpcUrl: string; signerUrl: string; contractPolicyVerified: true; paused: boolean; operators: NamedOperator[];
  operatorControls?: boolean;
};
export function stocksAutodispatch(env: NodeJS.ProcessEnv): boolean {
  ensure(env.STOCKS_MODE === undefined || env.STOCKS_MODE === 'DISABLED' || env.STOCKS_MODE === 'DEMO_TESTNET', 'INVALID_STOCKS_MODE');
  ensure(env.STOCKS_AUTODISPATCH === undefined || env.STOCKS_AUTODISPATCH === '0' || env.STOCKS_AUTODISPATCH === '1', 'INVALID_STOCKS_AUTODISPATCH');
  const enabled = env.STOCKS_AUTODISPATCH === '1';
  ensure(!enabled || env.STOCKS_MODE === 'DEMO_TESTNET', 'STOCKS_AUTODISPATCH_REQUIRES_TESTNET');
  return enabled;
}
export function parseStocksRuntimeConfig(value: unknown): StocksRuntimeConfig {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_STOCKS_CONFIG');
  const row = value as StocksRuntimeConfig;
  ensure(row.profile === 'DEMO_TESTNET' && row.manifest?.schemaVersion === 2 && row.contractPolicyVerified === true && typeof row.paused === 'boolean', 'INVALID_STOCKS_ACTIVATION');
  ensure(row.operatorControls === undefined || typeof row.operatorControls === 'boolean', 'INVALID_STOCKS_OPERATOR_CONTROLS');
  freezeManifest(row.manifest);
  endpoint(row.rpcUrl); endpoint(row.signerUrl);
  const operators = parseStocksOperators(row.operators);
  return { ...structuredClone(row), operators };
}

// Optional composition: absence leaves every legacy route and worker unchanged.
// This function never creates tables, deploys contracts, or handles signing keys.
export async function configuredStocksRuntime(env: NodeJS.ProcessEnv, fallbackDatabaseUrl: string) {
  const autodispatch = stocksAutodispatch(env);
  if (env.STOCKS_MODE === undefined || env.STOCKS_MODE === 'DISABLED') return null;
  ensure(env.STOCKS_MODE === 'DEMO_TESTNET' && env.STOCKS_CONFIG_PATH && env.STOCKS_SIGNER_TOKEN, 'STOCKS_CONFIGURATION_REQUIRED');
  const config = parseStocksRuntimeConfig(await readStocksPublicJson(env.STOCKS_CONFIG_PATH));
  const require = createRequire(import.meta.url);
  const { Pool } = require('pg') as { Pool: new (options: unknown) => SqlPool & { end(): Promise<void>; on(event: 'error', listener: () => void): unknown } };
  const pool = new Pool({ connectionString: env.STOCKS_DATABASE_URL ?? fallbackDatabaseUrl, max: 8, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  let runtime: Awaited<ReturnType<typeof createStocksRuntime>> | undefined;
  watchStocksPoolErrors(pool, () => runtime);
  try {
    const transport = httpStocksRpc(config.rpcUrl);
    const signer = externalStocksSigner({ url: config.signerUrl, authorization: env.STOCKS_SIGNER_TOKEN, deploymentDigest: manifestDigest(config.manifest), manifest: config.manifest });
    runtime = await createStocksRuntime({ manifest: config.manifest, pool, transport, signer, autodispatch, paused: config.paused, operators: config.operators, operatorControls: config.operatorControls });
    return runtime;
  } catch (error) { await pool.end(); throw error; }
}
// Trusted composition port, shared by the configured server and real local
// integration harness. The caller owns pool cleanup until this returns; then
// runtime.close owns it. No endpoint policy or environment fallback is changed.
export async function createStocksRuntime(options: {
  manifest: StocksRuntimeConfig['manifest'];
  pool: SqlPool & { end(): Promise<void> };
  transport: JsonRpcTransport;
  signer: SignerPort & { probe(): Promise<void> };
  autodispatch: boolean;
  paused: boolean;
  operators: NamedOperator[];
  operatorControls?: boolean;
}) {
  const manifest = freezeManifest(options.manifest) as StocksRuntimeConfig['manifest'];
  const { pool, transport, signer, autodispatch, paused } = options;
  const operators = parseStocksOperators(options.operators);
  ensure(typeof autodispatch === 'boolean' && typeof paused === 'boolean', 'INVALID_STOCKS_RUNTIME_POLICY');
  ensure(options.operatorControls === undefined || typeof options.operatorControls === 'boolean', 'INVALID_STOCKS_OPERATOR_CONTROLS');
  const digest = manifestDigest(manifest);
  const rpc = createStocksRpcPort(transport, manifest);
  await verifyStocksDeployment(manifest, rpc, transport);
  await signer.probe();
  const health = new StocksObservationHealth();
  let databaseFailureVersion = 0;
  const notifyDatabaseFailure = () => {
    databaseFailureVersion++;
    health.record('UNAVAILABLE_OR_REVIEW_REQUIRED');
  };
  let stopped = false;
  let closing: Promise<void> | null = null;
  const repo = new StocksRepository(pool, digest);
  const control = options.operatorControls === true ? new StocksTradingControlPolicy(new StocksTradingControlService(pool, digest), digest) : undefined;
  // Enabling controls requires its migration before startup. An absent control
  // row is initially paused, and no startup path creates or resumes that row.
  if (control) await control.read();
  const basePaused = () => stopped || !autodispatch || paused || !health.current();
  const service = new StocksService(repo, manifest, new ReceiptVerifier(manifest, rpc), { manifestDigest: digest, contractPolicyVerified: true }, async () => {
    if (basePaused()) return true;
    const operatorPaused = control ? await control.isPaused() : false;
    // Stop/health can change while the authoritative control read is in flight.
    return operatorPaused || basePaused();
  });
  // Check the migrated database and immutable physical-vault binding before
  // exposing any configured routes. This never creates schema or tables.
  await service.bindDeployment();
  const observer = new StocksFinalizedObserver(pool, manifest, digest, rpc, transport, {
    observeFunding: hash => service.observeFunding(hash),
    observeEscrow: hash => service.sell.observeEscrow(hash),
    isTransactionProjected: hash => repo.isTransactionProjected(hash),
  });
  const worker = new StocksWorker(service, createDurableMockBroker(repo), signer);
  let current: Promise<void> | null = null;
  const tick = () => {
    if (!autodispatch || stopped || current) return current ?? Promise.resolve();
    const databaseVersion = databaseFailureVersion;
    current = (async () => {
      try {
        // Refresh diagnostics even while another gate blocks new admissions.
        // Control failure does not stop observing already-sent transactions.
        if (control) await control.isPaused();
        await service.sell.expireReservations();
        for (let n = 0; n < 20 && !stopped; n++) if (!(await worker.runOne())) break;
        const observed = await observer.runOnce();
        // An idle connection can fail during otherwise successful work. Only a
        // complete subsequent tick may restore CURRENT after that failure.
        if (!stopped && databaseVersion === databaseFailureVersion) health.record(observed);
      } catch { if (!stopped) health.record('UNAVAILABLE_OR_REVIEW_REQUIRED'); }
    })().finally(() => { current = null; });
    return current;
  };
  const stop = () => { stopped = true; health.record('STOPPED'); };
  // The owning server lifecycle schedules only explicitly enabled dispatch.
  return {
    service, execution: new StocksExecutionService(service, createDeploymentEvidence(manifest, transport, { available: () => !stopped })), submissionReceipts: createSubmissionReceiptVerifier(manifest, rpc), operators, reconciliationCoverage: () => observer.coverage(),
    control,
    status: () => runtimeSnapshot({ deploymentId: manifest.deploymentId, deploymentDigest: digest, autodispatch, configuredPause: paused, stopped, tickInFlight: current !== null, health: health.snapshot(), ...(control ? { operatorControl: control.snapshot() } : {}) }),
    tick,
    notifyDatabaseFailure,
    stop,
    close() {
      stop();
      return closing ??= (async () => { if (current) await current; await pool.end(); })();
    },
  };
}
export type StocksRuntime = NonNullable<Awaited<ReturnType<typeof configuredStocksRuntime>>>;
