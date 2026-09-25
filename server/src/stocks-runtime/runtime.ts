import { createRequire } from 'node:module';
import { ensure, freezeManifest, manifestDigest, type Manifest, type SignerPort, type SqlPool } from '../stocks/contracts.js';
import { ReceiptVerifier } from '../stocks/chain.js';
import { StocksRepository } from '../stocks/repository.js';
import { StocksService } from '../stocks/service.js';
import { StocksWorker } from '../stocks/worker.js';
import { createDurableMockBroker } from '../stocks/mock-broker.js';
import { createStocksRpcPort, type JsonRpcTransport } from '../stocks/rpc.js';
import { giwaConfirmedTransport } from '../stocks/giwa-confirmation.js';
import type { StocksPricing } from '../stocks/pricing.js';
import { stocksPricingFromEnvironment } from './pricing.js';
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
import { validateLocalCustomerRuntime } from './local-customer.js';
import { verifyCurrentCashIdentity } from '../stocks/cash-identity.js';

export type StocksRuntimeConfig = {
  profile: 'DEMO_TESTNET'; manifest: Manifest;
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
export function parseStocksRuntimeConfig(value: unknown, localCustomer = false): StocksRuntimeConfig {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_STOCKS_CONFIG');
  const row = value as StocksRuntimeConfig;
  ensure(row.profile === 'DEMO_TESTNET' && [2, 3].includes(row.manifest?.schemaVersion) && row.contractPolicyVerified === true && typeof row.paused === 'boolean', 'INVALID_STOCKS_ACTIVATION');
  ensure(row.operatorControls === undefined || typeof row.operatorControls === 'boolean', 'INVALID_STOCKS_OPERATOR_CONTROLS');
  freezeManifest(row.manifest);
  endpoint(row.rpcUrl);
  const operators = parseStocksOperators(row.operators);
  if (localCustomer) validateLocalCustomerRuntime({ ...row, operators });
  else endpoint(row.signerUrl);
  return { ...structuredClone(row), operators };
}

// Optional composition: absence leaves every legacy route and worker unchanged.
// This function never creates tables, deploys contracts, or handles signing keys.
export async function configuredStocksRuntime(env: NodeJS.ProcessEnv, fallbackDatabaseUrl: string, localCustomer = false) {
  const autodispatch = stocksAutodispatch(env);
  if (env.STOCKS_MODE === undefined || env.STOCKS_MODE === 'DISABLED') return null;
  ensure(env.STOCKS_MODE === 'DEMO_TESTNET' && env.STOCKS_CONFIG_PATH && env.STOCKS_SIGNER_TOKEN, 'STOCKS_CONFIGURATION_REQUIRED');
  const config = parseStocksRuntimeConfig(await readStocksPublicJson(env.STOCKS_CONFIG_PATH), localCustomer);
  const require = createRequire(import.meta.url);
  const { Pool } = require('pg') as { Pool: new (options: unknown) => SqlPool & { end(): Promise<void>; on(event: 'error', listener: () => void): unknown } };
  const pool = new Pool({ connectionString: env.STOCKS_DATABASE_URL ?? fallbackDatabaseUrl, max: 8, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  let runtime: Awaited<ReturnType<typeof createStocksRuntime>> | undefined;
  watchStocksPoolErrors(pool, () => runtime);
  try {
    // Settle on GIWA confirmation, not Ethereum finality (see giwa-confirmation.ts).
    const transport = giwaConfirmedTransport(httpStocksRpc(config.rpcUrl));
    const signer = externalStocksSigner({ url: config.signerUrl, authorization: env.STOCKS_SIGNER_TOKEN, deploymentDigest: manifestDigest(config.manifest), manifest: config.manifest, localHarness: localCustomer });
    runtime = await createStocksRuntime({ manifest: config.manifest, pool, transport, signer, autodispatch, paused: config.paused, operators: config.operators, operatorControls: config.operatorControls, pricing: stocksPricingFromEnvironment(env) });
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
  /** How quotes are priced. Default: the fixed mock price. */
  pricing?: StocksPricing;
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
  let cashIdentityReady = true; // Full startup verification has already succeeded.
  let closing: Promise<void> | null = null;
  const repo = new StocksRepository(pool, digest);
  const control = options.operatorControls === true ? new StocksTradingControlPolicy(new StocksTradingControlService(pool, digest), digest) : undefined;
  // Enabling controls requires its migration before startup. An absent control
  // row is initially paused, and no startup path creates or resumes that row.
  if (control) await control.read();
  const basePaused = () => stopped || !autodispatch || paused || !cashIdentityReady || !health.current();
  // A direct payment or escrow is held only for an explicit halt, never for observation health: the observer reads
  // deposits made while it was down or catching up, and their orders then wait for dispatch like any other.
  const directHalted = () => stopped || paused || !cashIdentityReady;
  const service = new StocksService(repo, manifest, new ReceiptVerifier(manifest, rpc), { manifestDigest: digest, contractPolicyVerified: true }, async () => {
    if (basePaused()) return true;
    const operatorPaused = control ? await control.isPaused() : false;
    // Stop/health can change while the authoritative control read is in flight.
    return operatorPaused || basePaused();
  }, undefined, undefined, options.pricing, async () => {
    if (directHalted()) return true;
    const operatorPaused = control ? await control.isPaused() : false;
    return operatorPaused || directHalted();
  });
  // Check the migrated database and immutable physical-vault binding before
  // exposing any configured routes. This never creates schema or tables.
  await service.bindDeployment();
  const observer = new StocksFinalizedObserver(pool, manifest, digest, rpc, transport, {
    observeFunding: hash => service.observeFunding(hash),
    observeEscrow: hash => service.sell.observeEscrow(hash),
    isTransactionProjected: hash => repo.isTransactionProjected(hash),
  });
  const workerSigner: SignerPort = {
    async submit(call) { await verifyCurrentCashIdentity(manifest, transport); return signer.submit(call); },
    lookup(operationId) { return signer.lookup(operationId); },
  };
  const worker = new StocksWorker(service, createDurableMockBroker(repo), workerSigner);
  let current: Promise<void> | null = null;
  const tick = () => {
    if (!autodispatch || stopped || current) return current ?? Promise.resolve();
    const databaseVersion = databaseFailureVersion;
    current = (async () => {
      try {
        try { await verifyCurrentCashIdentity(manifest, transport); cashIdentityReady = true; }
        catch { cashIdentityReady = false; health.record('UNAVAILABLE_OR_REVIEW_REQUIRED'); }
        // Refresh diagnostics even while another gate blocks new admissions.
        // Control failure does not stop observing already-sent transactions.
        if (control) await control.isPaused();
        await service.sell.expireReservations();
        for (let n = 0; n < 20 && !stopped; n++) if (!(await worker.runOne())) break;
        const observed = await observer.runOnce();
        // An idle connection can fail during otherwise successful work. Only a
        // complete subsequent tick may restore CURRENT after that failure.
        if (!stopped && databaseVersion === databaseFailureVersion) health.record(cashIdentityReady ? observed : 'UNAVAILABLE_OR_REVIEW_REQUIRED');
        // Dispatch what this pass just observed (a deposit or an escrow) now, not on the next tick.
        for (let n = 0; n < 20 && !stopped; n++) if (!(await worker.runOne())) break;
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
