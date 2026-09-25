import pg from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { readLocalCustomerServerConfig, localCustomerEnvironment } from './local-environment.mjs';
import { acquireLocalDemoLock, prepareProductDatabase } from './local-operations.mjs';
import { readStocksPublicJson } from '../../server/dist/stocks-runtime/public-config.js';
import { parseStocksRuntimeConfig, verifyStocksDeployment } from '../../server/dist/stocks-runtime/runtime.js';
import { LOCAL_CUSTOMER_MANIFEST } from '../../server/dist/stocks-runtime/local-customer.js';
import { httpStocksRpc } from '../../server/dist/stocks-runtime/transport.js';
import { createStocksRpcPort } from '../../server/dist/stocks/rpc.js';
import { ReceiptVerifier } from '../../server/dist/stocks/chain.js';
import { StocksRepository } from '../../server/dist/stocks/repository.js';
import { StocksService } from '../../server/dist/stocks/service.js';
import { StocksFinalizedObserver } from '../../server/dist/stocks-runtime/observer.js';
import { StocksTradingControlService } from '../../server/dist/stocks-trading-control/service.js';
import { reconcileStocks } from '../../server/dist/stocks/reconciliation.js';

// Explicit one-time local preparation: no key, signer, worker, API or control write.
const base = '/Users/whdqkf88/Desktop/arco-giwa/GIWA_LOCAL_DEMO_20260924';
const abort = new AbortController();
const stop = () => abort.abort();
let pool, release, stage = 'CONFIGURATION';
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  if (process.argv.length !== 3 || process.argv[2] !== '--prepare-observer') throw Error('ARGS');
  release = await acquireLocalDemoLock();
  const serverPath = `${base}/private/server.json`, runtimePath = `${base}/runtime.json`;
  const env = localCustomerEnvironment(await readLocalCustomerServerConfig(serverPath), runtimePath);
  const config = parseStocksRuntimeConfig(await readStocksPublicJson(runtimePath), true);
  stage = 'DATABASE';
  if ((await prepareProductDatabase({ serverPath, runtimePath })).status !== 'DATABASE_READY') throw Error('DATABASE_NOT_READY');
  pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  pool.on('error', stop);
  const control = new StocksTradingControlService(pool, LOCAL_CUSTOMER_MANIFEST);
  const initial = await control.read();
  if (!initial.paused || initial.version !== 0) throw Error('EXISTING_CONTROL');
  // Existing order/worker recovery belongs to the real runtime, never this helper.
  for (const table of ['StocksOrder', 'StocksSellOrder', 'StocksOutbox']) {
    const found = await pool.query(`SELECT 1 FROM arco_evm."${table}" WHERE "deploymentDigest"=$1 LIMIT 1`, [LOCAL_CUSTOMER_MANIFEST]);
    if (found.rowCount !== 0) throw Error('EXISTING_WORK');
  }
  stage = 'DEPLOYMENT';
  const transport = httpStocksRpc(config.rpcUrl), rpc = createStocksRpcPort(transport, config.manifest);
  await verifyStocksDeployment(config.manifest, rpc, transport);
  const repo = new StocksRepository(pool, LOCAL_CUSTOMER_MANIFEST);
  const service = new StocksService(repo, config.manifest, new ReceiptVerifier(config.manifest, rpc),
    { manifestDigest: LOCAL_CUSTOMER_MANIFEST, contractPolicyVerified: true }, async () => true);
  await service.bindDeployment();
  const observer = new StocksFinalizedObserver(pool, config.manifest, LOCAL_CUSTOMER_MANIFEST, rpc, transport, {
    observeFunding: hash => service.observeFunding(hash), observeEscrow: hash => service.sell.observeEscrow(hash),
    isTransactionProjected: hash => repo.isTransactionProjected(hash),
  });
  const until = Date.now() + 60 * 60 * 1000;
  let retries = 0, batches = 0, lastReport = 0, current = false;
  stage = 'OBSERVATION';
  while (!abort.signal.aborted && Date.now() < until) {
    let status;
    try {
      await service.sell.expireReservations();
      status = await observer.runOnce();
    } catch (error) {
      // Only fixed read-transport failures retry; rejected evidence never does.
      if (!['STOCKS_RPC_UNAVAILABLE', 'STOCKS_RPC_RESPONSE_UNAVAILABLE'].includes(error?.message)) throw error;
      status = 'RPC_UNAVAILABLE';
    }
    if (['BUSY', 'RPC_UNAVAILABLE'].includes(status)) {
      if (++retries > 3) throw Error('RETRY_EXHAUSTED');
      console.log(JSON.stringify({ status, retry: retries }));
      await delay(retries * 5000, undefined, { signal: abort.signal });
      continue;
    }
    if (!['CATCHING_UP', 'CURRENT'].includes(status)) throw Error('PROJECTION_REVIEW_REQUIRED');
    retries = 0; batches++;
    if (Date.now() - lastReport >= 10000 || status === 'CURRENT') {
      const coverage = await observer.coverage();
      console.log(JSON.stringify({ status, batches, throughBlock: coverage?.throughBlock }));
      lastReport = Date.now();
    }
    if (status === 'CURRENT') { current = true; break; }
  }
  if (!current || abort.signal.aborted) throw Error('OBSERVATION_NOT_CURRENT');
  stage = 'RECONCILIATION';
  const matched = await reconcileStocks(service, () => observer.coverage());
  if (matched.status !== 'MATCHED_AT_CUTOFF' || matched.differences.length !== 0
    || matched.cutoff.deploymentDigest !== LOCAL_CUSTOMER_MANIFEST) throw Error('RECONCILIATION_NOT_MATCHED');
  const finalControl = await control.read();
  if (abort.signal.aborted || !finalControl.paused || finalControl.version !== 0) throw Error('CONTROL_CHANGED');
  console.log(JSON.stringify({ status: 'LOCAL_OBSERVER_PREPARED', throughBlock: matched.cutoff.throughBlock,
    reconciliation: matched.status, tradingResumed: false, signerStarted: false }));
} catch (error) {
  const codes = ['CODE_IDENTITY_MISMATCH', 'NETWORK_MISMATCH', 'OBSERVER_CURSOR_OR_FINALITY_INVALID', 'OBSERVER_STALE_FINALIZED_HEAD',
    'EXISTING_CONTROL', 'EXISTING_WORK', 'RETRY_EXHAUSTED', 'PROJECTION_REVIEW_REQUIRED', 'RECONCILIATION_NOT_MATCHED', 'CONTROL_CHANGED'];
  const code = codes.includes(error?.code) ? error.code : codes.includes(error?.message) ? error.message : 'UNAVAILABLE';
  console.error(JSON.stringify({ status: 'LOCAL_OBSERVER_PREPARATION_FAILED', stage, code }));
  process.exitCode = 1;
} finally {
  await pool?.end(); await release?.();
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
}
