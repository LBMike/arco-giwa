import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { encodeFunctionData, parseAbi } from 'viem';
import { ensure, freezeManifest, manifestDigest, PROFILE, type Manifest, type SqlPool } from '../stocks/contracts.js';
import { ReceiptVerifier, type ChainPort } from '../stocks/chain.js';
import { StocksRepository } from '../stocks/repository.js';
import { StocksService } from '../stocks/service.js';
import { StocksWorker } from '../stocks/worker.js';
import { createDurableMockBroker } from '../stocks/mock-broker.js';
import { createStocksRpcPort, type JsonRpcTransport } from '../stocks/rpc.js';
import { StocksFinalizedObserver } from './observer.js';
import { endpoint, externalStocksSigner, httpStocksRpc } from './transport.js';
import type { NamedOperator } from './session.js';
import { StocksObservationHealth } from './health.js';

export type StocksRuntimeConfig = {
  profile: 'DEMO_TESTNET'; manifest: Manifest & { schemaVersion: 2; redemptionEscrow: `0x${string}` };
  rpcUrl: string; signerUrl: string; contractPolicyVerified: true; paused: boolean; operators: NamedOperator[];
};
export function parseStocksRuntimeConfig(value: unknown): StocksRuntimeConfig {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_STOCKS_CONFIG');
  const row = value as StocksRuntimeConfig;
  ensure(row.profile === 'DEMO_TESTNET' && row.manifest?.schemaVersion === 2 && row.contractPolicyVerified === true && typeof row.paused === 'boolean', 'INVALID_STOCKS_ACTIVATION');
  freezeManifest(row.manifest);
  endpoint(row.rpcUrl); endpoint(row.signerUrl);
  ensure(Array.isArray(row.operators) && row.operators.every(op => op && typeof op.wallet === 'string' && typeof op.operatorId === 'string' && Array.isArray(op.permissions) && op.permissions.every(p => typeof p === 'string')), 'INVALID_STOCKS_OPERATORS');
  return structuredClone(row);
}

export async function verifyStocksDeployment(manifest: StocksRuntimeConfig['manifest'], rpc: ChainPort, transport: JsonRpcTransport): Promise<void> {
  manifest = freezeManifest(manifest) as StocksRuntimeConfig['manifest'];
  const network = await rpc.network();
  ensure(network.chainId === 91342 && network.networkInstance === manifest.networkInstance && network.checkpointHash === manifest.checkpointHash, 'STOCKS_CHECKPOINT_MISMATCH');
  const finalized = await rpc.block('finalized');
  ensure(finalized && BigInt(finalized.number) >= BigInt(manifest.checkpointNumber), 'STOCKS_FINALITY_UNAVAILABLE');
  for (const target of [manifest.cashToken, manifest.stockToken, manifest.fundingVault, manifest.mintController, manifest.redemptionEscrow]) ensure(await rpc.codeHash(target, finalized.number) === manifest.codeHashes[target.toLowerCase()], 'STOCKS_CODE_MISMATCH');
  const bindings: [string, string, string][] = [
    [manifest.stockToken, 'mintController', manifest.mintController], [manifest.stockToken, 'redemptionEscrow', manifest.redemptionEscrow],
    [manifest.fundingVault, 'cashToken', manifest.cashToken], [manifest.fundingVault, 'redemptionEscrow', manifest.redemptionEscrow], [manifest.fundingVault, 'operator', manifest.signerAddress],
    [manifest.mintController, 'stockToken', manifest.stockToken], [manifest.mintController, 'operator', manifest.signerAddress],
    [manifest.redemptionEscrow, 'stockToken', manifest.stockToken], [manifest.redemptionEscrow, 'cashToken', manifest.cashToken], [manifest.redemptionEscrow, 'fundingVault', manifest.fundingVault], [manifest.redemptionEscrow, 'operator', manifest.signerAddress],
  ];
  for (const [target, getter, expected] of bindings) {
    const data = encodeFunctionData({ abi: parseAbi([`function ${getter}() view returns (address)`]), functionName: getter });
    const value = await transport('eth_call', [{ to: target, data }, `0x${BigInt(finalized.number).toString(16)}`]);
    ensure(value === `0x${expected.slice(2).toLowerCase().padStart(64, '0')}`, 'STOCKS_CONSTRUCTOR_BINDING_MISMATCH');
  }
  for (const [target, expected] of [[manifest.cashToken, 6n], [manifest.stockToken, 9n]] as const) {
    const data = encodeFunctionData({ abi: parseAbi(['function decimals() view returns (uint8)']), functionName: 'decimals' });
    const value = await transport('eth_call', [{ to: target, data }, `0x${BigInt(finalized.number).toString(16)}`]);
    ensure(typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) && BigInt(value) === expected, 'STOCKS_TOKEN_SCALE_MISMATCH');
  }
  ensure((await rpc.block(finalized.number))?.hash === finalized.hash, 'STOCKS_FINALIZED_BLOCK_CHANGED');
}

// Optional composition: absence leaves every legacy route and worker unchanged.
// This function never creates tables, deploys contracts, or handles signing keys.
export async function configuredStocksRuntime(env: NodeJS.ProcessEnv, fallbackDatabaseUrl: string) {
  if (env.STOCKS_MODE === undefined || env.STOCKS_MODE === 'DISABLED') return null;
  ensure(env.STOCKS_MODE === 'DEMO_TESTNET' && env.STOCKS_CONFIG_PATH && env.STOCKS_SIGNER_TOKEN, 'STOCKS_CONFIGURATION_REQUIRED');
  const config = parseStocksRuntimeConfig(JSON.parse(await readFile(env.STOCKS_CONFIG_PATH, 'utf8')));
  const require = createRequire(import.meta.url);
  const { Pool } = require('pg') as { Pool: new (options: unknown) => SqlPool & { end(): Promise<void> } };
  const pool = new Pool({ connectionString: env.STOCKS_DATABASE_URL ?? fallbackDatabaseUrl, max: 8 });
  try {
    const manifest = freezeManifest(config.manifest) as StocksRuntimeConfig['manifest'];
    const digest = manifestDigest(manifest);
    const transport = httpStocksRpc(config.rpcUrl);
    const rpc = createStocksRpcPort(transport, manifest);
    await verifyStocksDeployment(manifest, rpc, transport);
    const signer = externalStocksSigner({ url: config.signerUrl, authorization: env.STOCKS_SIGNER_TOKEN, deploymentDigest: digest, manifest });
    await signer.probe();
    const health = new StocksObservationHealth();
    const repo = new StocksRepository(pool, digest);
    const service = new StocksService(repo, manifest, new ReceiptVerifier(manifest, rpc), { manifestDigest: digest, contractPolicyVerified: true }, async () => config.paused || !health.current());
    const observer = new StocksFinalizedObserver(pool, manifest, digest, rpc, transport, {
      observeFunding: hash => service.observeFunding(hash),
      observeEscrow: hash => service.sell.observeEscrow(hash),
      isTransactionProjected: hash => repo.isTransactionProjected(hash),
    });
    const worker = new StocksWorker(service, createDurableMockBroker(repo), signer);
    let stopped = false;
    let current: Promise<void> | null = null;
    const tick = () => {
      if (stopped || current) return current ?? Promise.resolve();
      current = (async () => {
        try {
          await service.sell.expireReservations();
          for (let n = 0; n < 20 && !stopped; n++) if (!(await worker.runOne())) break;
          health.record(await observer.runOnce());
        } catch { health.record('UNAVAILABLE_OR_REVIEW_REQUIRED'); }
      })().finally(() => { current = null; });
      return current;
    };
    // No implicit scheduler. The existing app/index do not import this module.
    // Public-testnet dispatch wiring requires the separately reviewed activation step.
    return {
      service, operators: config.operators, reconciliationCoverage: () => observer.coverage(),
      status: () => ({ ...PROFILE, enabled: true, observerStatus: health.status(), newOrdersPaused: config.paused || !health.current(), deploymentId: manifest.deploymentId, observedAt: new Date().toISOString() }),
      tick,
      async close() { stopped = true; if (current) await current; await pool.end(); },
    };
  } catch (error) { await pool.end(); throw error; }
}
