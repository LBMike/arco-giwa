// Test-only composition: owned fresh PostgreSQL + unforked local Hardhat only.
// Reuse production runtime/health/worker/observer; never manufacture order states.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeFunctionData, parseAbi } from 'viem';
import { buildApp } from '../../server/dist/app.js';
import { freezeManifest, manifestDigest } from '../../server/dist/stocks/contracts.js';
import { createStocksRpcPort } from '../../server/dist/stocks/rpc.js';
import { reconcileStocks } from '../../server/dist/stocks/reconciliation.js';
import { createStocksRuntime } from '../../server/dist/stocks-runtime/runtime.js';
import { stocksSessionResolvers } from '../../server/dist/stocks-runtime/session.js';
import { httpStocksRpc, externalStocksSigner } from '../../server/dist/stocks-runtime/transport.js';
import { StocksSubmissionsService } from '../../server/dist/stocks-submissions/service.js';
import { StocksSubmissionDiagnosticsService } from '../../server/dist/stocks-submission-diagnostics/service.js';
import { localSigner } from './local-signer.mjs';
import { createShortSessionFixture } from './short-session.mjs';

const { Pool } = createRequire(import.meta.url)('pg');
const faucetAbi = parseAbi(['function faucet(address,uint256)']);

export async function createLocalUiStack({ rpcUrl, bundle, databaseUrl, frontendOrigin = 'http://stocks-local.test', knownHashRecovery = false }) {
  assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1');
  assert.equal(typeof knownHashRecovery, 'boolean');
  assert.equal(bundle.execution, 'LOCAL_EVM_TEST_HARNESS_ONLY');
  const target = new URL(rpcUrl), database = new URL(databaseUrl), origin = new URL(frontendOrigin);
  assert.equal(target.protocol, 'http:'); assert.equal(target.hostname, '127.0.0.1');
  assert.ok(!target.username && !target.password && !target.search && !target.hash);
  assert.ok(!rpcUrl.includes('?') && !rpcUrl.includes('#') && !target.href.includes('?') && !target.href.includes('#'));
  assert.equal(target.pathname, '/');
  assert.match(target.port, /^[1-9][0-9]{0,4}$/, 'Explicit local RPC port required');
  assert.equal(database.pathname, '/stocks_local_test');
  assert.equal(database.username, 'stocks_local'); assert.equal(database.hostname, 'localhost');
  assert.ok(database.searchParams.get('host')?.startsWith('/'), 'Owned Unix-socket database required');
  assert.equal(origin.origin, frontendOrigin); assert.equal(origin.protocol, 'http:');
  assert.ok(['stocks-local.test', '127.0.0.1', 'localhost'].includes(origin.hostname));
  const domain = origin.host;
  const manifest = freezeManifest(bundle.manifest), digest = manifestDigest(manifest);
  const accounts = Object.freeze({ ...bundle.publicAccounts });
  const accountSet = new Set(Object.values(accounts));
  const contractSet = new Set([manifest.cashToken, manifest.stockToken, manifest.fundingVault, manifest.mintController, manifest.redemptionEscrow]);
  const methods = new Set(['eth_chainId', 'hardhat_metadata', 'eth_blockNumber', 'eth_getBlockByNumber',
    'eth_getBlockByHash', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getTransactionCount',
    'eth_getCode', 'eth_call', 'eth_getLogs', 'eth_getBalance', 'eth_estimateGas', 'eth_gasPrice',
    'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'personal_sign', 'eth_sendTransaction']);
  const rpcTrace = [];
  let sequence = 0;
  const event = () => ({ seq: ++sequence, at: Date.now() });
  async function rpc(method, params = []) {
    assert.ok(methods.has(method), 'LOCAL_UI_RPC_METHOD_DENIED');
    if (method === 'personal_sign') {
      assert.equal(params.length, 2); assert.ok(accountSet.has(String(params[1]).toLowerCase()));
    }
    if (method === 'eth_sendTransaction') {
      assert.equal(params.length, 1);
      assert.ok(accountSet.has(String(params[0]?.from).toLowerCase()), 'LOCAL_UI_SENDER_DENIED');
      assert.ok(contractSet.has(String(params[0]?.to).toLowerCase()), 'LOCAL_UI_TARGET_DENIED');
      assert.equal(BigInt(params[0]?.value ?? 0), 0n);
    }
    const id = randomUUID();
    // Only synchronous evidence capture here: no extra await/RPC before send.
    const trace = { ...event(), method };
    if (method === 'eth_sendTransaction') Object.assign(trace, {
      from: params[0].from, to: params[0].to, data: params[0].data, value: params[0].value ?? '0x0',
    });
    rpcTrace.push(trace);
    const response = await fetch(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    assert.ok(response.ok, 'LOCAL_UI_RPC_UNAVAILABLE');
    const row = await response.json();
    assert.equal(row.id, id); assert.ok(!row.error, 'LOCAL_UI_RPC_REJECTED');
    if (method === 'eth_sendTransaction') {
      assert.match(row.result, /^0x[0-9a-f]{64}$/);
      trace.acceptedHash = row.result;
      trace.acceptedSeq = ++sequence; trace.acceptedAt = Date.now();
    }
    return row.result;
  }
  assert.equal(await rpc('eth_chainId'), '0x164ce');
  const metadata = await rpc('hardhat_metadata');
  assert.ok(metadata.instanceId && !metadata.forkedNetwork);
  const unlocked = Object.values(accounts);
  assert.ok(unlocked.every(value => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value)));
  assert.ok(accountSet.has(manifest.signerAddress));
  const pool = new Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  const readTransport = httpStocksRpc(rpcUrl, true);
  const transport = (method, params) => {
    rpcTrace.push({ ...event(), method });
    return readTransport(method, params);
  };
  const chain = createStocksRpcPort(transport, manifest);
  const requests = [], processingErrors = [];
  let runtime, signerServer, app, timer, activeTick, closing, restarting;
  let closed = false, processing = false, port = 0, apiBase;
  const signerToken = `TEST_HARNESS_ONLY_${randomUUID()}`;
  const authSecret = `TEST_HARNESS_ONLY_SESSION_${randomUUID()}`;
  const shortSession = knownHashRecovery ? createShortSessionFixture({ secret: authSecret, holder: accounts.holder }) : null;
  const operators = [{ wallet: accounts.operator, operatorId: 'local-operator', permissions: ['stocks:read'] }];
  const resolvers = stocksSessionResolvers(authSecret, [domain], operators);
  const nonceStore = new Map();
  const legacy = {
    arco: {
      issueAuthNonce: async row => nonceStore.set(row.nonce, { ...row, expiresAt: row.now.getTime() + row.ttlSeconds * 1000 }),
      consumeAuthNonce: async request => {
        const row = nonceStore.get(request.nonce);
        if (!row || row.expiresAt <= Date.now() || row.walletAddress !== request.walletAddress.toLowerCase() || row.domain !== request.domain) return false;
        nonceStore.delete(request.nonce); return true;
      },
      vaultConfigs: async () => [],
    },
    registry: { listNetworks: async () => [{ chainId: 91342, fixture: 'LOCAL_STACK_LEGACY' }],
      getRegistry: async () => ({ network: { chainId: 91342 }, assets: [], products: [] }) },
    portfolio: { portfolio: async wallet => ({ walletAddress: wallet, products: [] }) },
    readiness: { check: async () => ({ ok: true, checks: { localTestFixture: { ok: true } } }) },
    loadRegistry: () => { throw new Error('LOCAL_STACK_MUST_NOT_READ_DEPLOYED_REGISTRY'); },
  };
  const appEnv = { corsAllowedOrigins: [frontendOrigin], authNonceTtlSeconds: 60, authJwtSecret: authSecret,
    adminOperatorToken: `TEST_HARNESS_ONLY_UNUSED_${randomUUID()}`, registryPath: '/TEST_HARNESS_ONLY_NO_REGISTRY_FILE' };
  const tick = () => {
    if (!processing || closed) return Promise.resolve();
    return activeTick ??= runtime.tick().catch(() => { processingErrors.push('LOCAL_UI_RUNTIME_TICK_FAILED'); })
      .finally(() => { activeTick = undefined; });
  };
  async function startProcessing() {
    assert.ok(!closed, 'LOCAL_UI_STACK_CLOSED');
    if (processing) { await activeTick; return; }
    processing = true;
    await tick();
    if (processing && !closed && !timer) { timer = setInterval(() => { void tick(); }, 2000); timer.unref(); }
  }
  async function stopProcessing() {
    processing = false; clearInterval(timer); timer = undefined; await activeTick;
  }
  async function listen() {
    const next = buildApp(appEnv, { ...legacy,
      stocks: { service: runtime.service, ...resolvers, reconciliationCoverage: runtime.reconciliationCoverage },
      stocksExecution: { service: runtime.execution, ...resolvers },
      stocksSubmissions: { service: new StocksSubmissionsService(runtime.service, runtime.submissionReceipts), ...resolvers },
      stocksRuntimeStatus: { getSnapshot: runtime.status, ...resolvers },
      stocksSubmissionDiagnostics: { service: new StocksSubmissionDiagnosticsService(runtime.service), ...resolvers },
    });
    if (shortSession) next.addHook('onSend', async (request, reply, payload) =>
      shortSession.restrict(request.url, reply.statusCode, payload));
    next.addHook('onResponse', async (request, reply) => {
      // No credentials, signatures, query strings, or arbitrary bodies in evidence.
      const path = request.url.split('?')[0];
      const trace = { ...event(), method: request.method, path, status: reply.statusCode };
      if (request.method === 'POST' && path === '/api/v1/stocks/wallet-submissions/claims') {
        const body = request.body;
        if (typeof body?.orderId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(body.orderId)) trace.orderId = body.orderId;
        if (body?.stage === 'APPROVAL' || body?.stage === 'TRANSFER') trace.stage = body.stage;
      }
      requests.push(trace);
    });
    try {
      await next.listen({ host: '127.0.0.1', port });
      port = next.server.address().port; apiBase = `http://127.0.0.1:${port}`; app = next;
    } catch (error) { await next.close(); throw error; }
  }
  async function restartApi() {
    assert.ok(!closed, 'LOCAL_UI_STACK_CLOSED');
    return restarting ??= (async () => {
      await app?.close(); app = undefined;
      if (!closed) await listen();
      return apiBase;
    })().finally(() => { restarting = undefined; });
  }
  function close() {
    if (closing) return closing;
    closed = true;
    // Final shutdown prevents another dispatch in an already-running tick.
    // The reversible stopProcessing path intentionally does not stop runtime.
    runtime?.stop();
    closing = (async () => {
      const failures = [];
      for (const cleanup of [stopProcessing, async () => { await restarting; }, async () => { await app?.close(); },
        async () => { if (runtime) await runtime.close(); }, async () => { await signerServer?.close(); },
        async () => { if (!runtime) await pool.end(); }]) {
        try { await cleanup(); } catch (error) { failures.push(error); }
      }
      nonceStore.clear();
      if (failures.length) throw new AggregateError(failures, 'LOCAL_UI_CLEANUP_FAILED');
    })();
    return closing;
  }
  try {
    signerServer = await localSigner({ pool, rpc, manifest, deploymentDigest: digest, token: signerToken });
    const signer = externalStocksSigner({ url: signerServer.url, authorization: signerToken, deploymentDigest: digest, manifest, localHarness: true });
    runtime = await createStocksRuntime({ manifest, pool, transport, signer, autodispatch: true, paused: false, operators });
    const initial = await chain.block('finalized');
    assert.equal(await chain.tokenBalance(manifest.stockToken, accounts.holder, initial.number), '0');
    assert.equal(await chain.tokenBalance(manifest.cashToken, accounts.holder, initial.number), '0');
    const fundingHash = await rpc('eth_sendTransaction', [{ from: accounts.faucetOperator, to: manifest.cashToken, value: '0x0', gas: '0x1e8480',
      data: encodeFunctionData({ abi: faucetAbi, functionName: 'faucet', args: [accounts.holder, 2000000000n] }) }]);
    let receipt;
    for (let attempt = 0; attempt < 100; attempt++) {
      receipt = await rpc('eth_getTransactionReceipt', [fundingHash]); if (receipt) break; await delay(50);
    }
    assert.equal(receipt?.status, '0x1');
    assert.equal(await chain.tokenBalance(manifest.cashToken, accounts.holder, (await chain.block('finalized')).number), '2000000000');
    await listen(); await startProcessing();
    assert.equal(runtime.status().newOrdersPaused, false, 'Initial observer coverage required');
    const repo = runtime.service.repo;
    async function snapshot() {
      assert.ok(!closed, 'LOCAL_UI_STACK_CLOSED');
      // Diagnostic evidence only: each query is real; not an atomic DB+chain snapshot.
      const actorId = `evm:${accounts.holder}`;
      const rows = async table => (await pool.query(`SELECT * FROM arco_evm."${table}" WHERE "deploymentDigest"=$1`, [digest])).rows;
      const [buyOrders, sellOrders, claims, proofs, audits, portfolio, jobs] = await Promise.all([
        repo.scopedOrders(actorId), repo.sellOrders(actorId), rows('StocksWalletSubmission'), rows('StocksWalletSubmissionProof'),
        rows('StocksAudit'), repo.portfolio(actorId), rows('StocksOutbox'),
      ]);
      const block = await chain.block('finalized');
      const [holderCash, holderStock, vaultCash, escrowStock, stockSupply] = await Promise.all([
        chain.tokenBalance(manifest.cashToken, accounts.holder, block.number), chain.tokenBalance(manifest.stockToken, accounts.holder, block.number),
        chain.tokenBalance(manifest.cashToken, manifest.fundingVault, block.number), chain.tokenBalance(manifest.stockToken, manifest.redemptionEscrow, block.number),
        chain.tokenSupply(manifest.stockToken, block.number),
      ]);
      const operations = (await pool.query('SELECT id, deployment_digest, call_digest, nonce, state, tx_hash FROM stocks_local_harness.signer_operations ORDER BY nonce')).rows;
      return { buyOrders, sellOrders, claims, proofs, audits, portfolio, jobs, rpcTrace: structuredClone(rpcTrace), requests: structuredClone(requests),
        chain: { blockNumber: block.number, blockHash: block.hash, holderCash, holderStock, vaultCash, escrowStock, stockSupply },
        reconciliation: await reconcileStocks(runtime.service, runtime.reconciliationCoverage), runtimeStatus: runtime.status(),
        workerErrors: { processing: [...processingErrors], reviewJobs: jobs.filter(job => job.status === 'REVIEW') },
        signer: { ...signerServer.controls, operations } };
    }
    return { apiBase, frontendOrigin, accounts, manifest, digest, rpc, chain, pool, service: runtime.service, repo,
      armShortSession: shortSession ? () => { assert.ok(!closed); shortSession.arm(); } : undefined,
      observer: { coverage: runtime.reconciliationCoverage }, requests, rpcTrace, startProcessing, stopProcessing, restartApi, snapshot, close };
  } catch (error) { await close().catch(() => {}); throw error; }
}
