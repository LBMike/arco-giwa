import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { SiweMessage } from 'siwe';
import { encodeFunctionData, getAddress, parseAbi, stringToHex } from 'viem';
import { buildApp } from '../../server/dist/app.js';
import { ABI, manifestDigest, callDigest, freezeManifest } from '../../server/dist/stocks/contracts.js';
import { ReceiptVerifier, authorizedCall } from '../../server/dist/stocks/chain.js';
import { StocksRepository } from '../../server/dist/stocks/repository.js';
import { StocksService } from '../../server/dist/stocks/service.js';
import { StocksWorker } from '../../server/dist/stocks/worker.js';
import { createDurableMockBroker } from '../../server/dist/stocks/mock-broker.js';
import { createStocksRpcPort } from '../../server/dist/stocks/rpc.js';
import { reconcileStocks } from '../../server/dist/stocks/reconciliation.js';
import { httpStocksRpc, externalStocksSigner } from '../../server/dist/stocks-runtime/transport.js';
import { stocksSessionResolvers } from '../../server/dist/stocks-runtime/session.js';
import { StocksFinalizedObserver } from '../../server/dist/stocks-runtime/observer.js';
import { createStocksRuntime, verifyStocksDeployment } from '../../server/dist/stocks-runtime/runtime.js';
import { startManagedStocksServer } from '../../server/dist/stocks-runtime/lifecycle.js';
import { localSigner } from './local-signer.mjs';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const { sign } = require('jsonwebtoken');
const tokenAbi = parseAbi(['function faucet(address,uint256)', 'function approve(address,uint256) returns (bool)']);

export async function runStack({ rpcUrl, bundle, databaseUrl }) {
  assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1');
  assert.equal(bundle.execution, 'LOCAL_EVM_TEST_HARNESS_ONLY');
  assert.ok(new URL(databaseUrl).pathname === '/stocks_local_test');
  assert.match(new URL(rpcUrl).hostname, /^127\.0\.0\.1$/);
  const manifest = freezeManifest(bundle.manifest);
  const accounts = bundle.publicAccounts;
  const digest = manifestDigest(manifest);
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const report = { execution: 'LOCAL_EVM_TEST_HARNESS_ONLY', chainId: 91342, deploymentId: manifest.deploymentId, scenarios: [] };
  const passed = name => report.scenarios.push(name);
  // Only this test-only adapter has write RPC methods. Product reads use httpStocksRpc.
  async function rpc(method, params) {
    const id = randomUUID();
    const response = await fetch(rpcUrl, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(10000) });
    const row = await response.json();
    assert.equal(row.id, id); assert.ok(!row.error, `${method}: ${row.error?.message ?? 'RPC error'}`);
    return row.result;
  }
  assert.equal(await rpc('eth_chainId', []), '0x164ce');
  const metadata = await rpc('hardhat_metadata', []);
  assert.ok(metadata.instanceId && !metadata.forkedNetwork);
  const transport = httpStocksRpc(rpcUrl, true);
  const chain = createStocksRpcPort(transport, manifest);
  await verifyStocksDeployment(manifest, chain, transport);
  const verifier = new ReceiptVerifier(manifest, chain);
  const repo = new StocksRepository(pool, digest);
  const service = new StocksService(repo, manifest, verifier, { manifestDigest: digest, contractPolicyVerified: true },
    async () => false,
    async fact => fact.payer === fact.verifiedWallet && ['AMOUNT_MISMATCH', 'QUOTE_EXPIRED', 'SECOND_PAYMENT'].includes(fact.reason),
    async fact => fact.payer === fact.verifiedWallet && ['QUANTITY_MISMATCH', 'QUOTE_EXPIRED'].includes(fact.reason));
  const broker = createDurableMockBroker(repo);
  const hooks = { observeFunding: hash => service.observeFunding(hash), observeEscrow: hash => service.sell.observeEscrow(hash),
    isTransactionProjected: hash => repo.isTransactionProjected(hash) };
  const observer = new StocksFinalizedObserver(pool, manifest, digest, chain, transport, hooks);
  let signerServer;
  let signer;
  const signerToken = `TEST_HARNESS_ONLY_${randomUUID()}`;
  const authSecret = `TEST_HARNESS_ONLY_SESSION_${randomUUID()}`;
  const domain = 'stocks-local.test';
  const operators = [{ wallet: accounts.operator, operatorId: 'local-operator', permissions: ['stocks:read'] }];
  const resolvers = stocksSessionResolvers(authSecret, [domain], operators);
  const nonceStore = new Map();
  // Minimal legacy service fixture; actual Stocks services above use PostgreSQL
  // and the local EVM. Never load an existing product registry or external DB.
  const legacy = {
    arco: {
      issueAuthNonce: async row => nonceStore.set(row.nonce, { ...row, expiresAt: row.now.getTime() + row.ttlSeconds * 1000 }),
      consumeAuthNonce: async request => {
        const row = nonceStore.get(request.nonce);
        if (!row || row.expiresAt <= Date.now() || row.walletAddress !== request.walletAddress.toLowerCase() || row.domain !== request.domain) return false;
        nonceStore.delete(request.nonce);
        return true;
      },
      vaultConfigs: async () => [],
    },
    registry: {
      listNetworks: async () => [{ chainId: 91342, fixture: 'LOCAL_STACK_LEGACY' }],
      getRegistry: async () => ({ network: { chainId: 91342 }, assets: [], products: [] }),
    },
    portfolio: { portfolio: async wallet => ({ walletAddress: wallet, products: [] }) },
    readiness: { check: async () => ({ ok: true, checks: { localTestFixture: { ok: true } } }) },
    loadRegistry: () => { throw new Error('LOCAL_STACK_MUST_NOT_READ_DEPLOYED_REGISTRY'); },
  };
  const appEnv = { corsAllowedOrigins: [`https://${domain}`], authNonceTtlSeconds: 60,
    authJwtSecret: authSecret, adminOperatorToken: 'TEST_HARNESS_ONLY_LEGACY_OPERATOR',
    registryPath: '/TEST_HARNESS_ONLY_NO_REGISTRY_FILE' };
  const app = buildApp(appEnv, {
    ...legacy,
    stocks: { service, ...resolvers, reconciliationCoverage: () => observer.coverage() },
  });
  try {
    const resetSigner = async () => {
      if (signerServer) await signerServer.close();
      signerServer = await localSigner({ pool, rpc, manifest, deploymentDigest: digest, token: signerToken });
      signer = externalStocksSigner({ url: signerServer.url, authorization: signerToken, deploymentDigest: digest, manifest, localHarness: true });
      await signer.probe();
    };
    await resetSigner();
    const worker = () => new StocksWorker(service, broker, signer);
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const tokens = {};
    async function api(path, body, actor = 'holder', status = 200) {
      const response = await fetch(`${url}/api/v1/${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', ...(actor ? { authorization: `Bearer ${tokens[actor]}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const row = await response.json();
      assert.equal(response.status, status, JSON.stringify({ path, row }));
      return row.data ?? row;
    }
    // Existing nonce/SIWE endpoints issue every ordinary session. The ephemeral
    // local node signs for its unlocked test accounts; no key material is read.
    for (const name of ['holder', 'otherHolder', 'operator']) {
      const nonce = await api('auth/nonce', { walletAddress: accounts[name], domain }, null);
      const message = new SiweMessage({ domain, address: getAddress(accounts[name]), uri: `https://${domain}`,
        version: '1', chainId: 91342, nonce: nonce.nonce, issuedAt: new Date().toISOString() }).prepareMessage();
      const signature = await rpc('personal_sign', [stringToHex(message), accounts[name]]);
      const verified = await api('auth/verify', { message, signature }, null);
      assert.equal(verified.walletAddress, accounts[name].toLowerCase());
      assert.equal(verified.chainId, 91342);
      tokens[name] = verified.token;
      await api('auth/verify', { message, signature }, null, 401);
    }
    // Explicit adversarial session fixtures verify chain/domain binding at the
    // real app's Stocks boundary; they never substitute for ordinary SIWE login.
    tokens.wrongChain = sign({ sub: accounts.holder, chainId: 1, domain }, authSecret, { algorithm: 'HS256', expiresIn: '15m' });
    tokens.wrongDomain = sign({ sub: accounts.holder, chainId: 91342, domain: 'foreign.test' }, authSecret, { algorithm: 'HS256', expiresIn: '15m' });
    assert.deepEqual(await (await fetch(`${url}/health`)).json(), { ok: true, service: 'arco-giwa-api' });
    assert.equal((await fetch(`${url}/ready`)).status, 200);
    assert.deepEqual(await api('evm/catalog/91342', undefined, null), []);
    assert.equal((await api('evm/networks', undefined, null))[0].chainId, 91342);
    async function waitReceipt(txHash) {
      for (let n = 0; n < 30; n++) {
        const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
        if (receipt) { assert.equal(receipt.status, '0x1'); return receipt; }
        await delay(100);
      }
      throw new Error('Local transaction receipt unavailable');
    }
    async function send(from, to, abi, functionName, args) {
      const data = encodeFunctionData({ abi, functionName, args });
      const hash = await rpc('eth_sendTransaction', [{ from, to, data, value: '0x0', gas: '0x1e8480' }]);
      await waitReceipt(hash);
      return hash;
    }
    async function buy(quantity, suffix) {
      const quote = await api('stocks/quotes', { symbol: 'NVDA', quantity });
      return api('stocks/orders', { quoteId: quote.id, idempotencyKey: `local-buy-${suffix}` });
    }
    async function sell(quantity, suffix) {
      const quote = await api('stocks/sell-quotes', { symbol: 'NVDA', quantity });
      return api('stocks/sell-orders', { quoteId: quote.id, idempotencyKey: `local-sell-${suffix}` });
    }
    async function deposit(order, amount = order.cashAmount) {
      await send(accounts.holder, manifest.cashToken, tokenAbi, 'approve', [manifest.fundingVault, BigInt(amount)]);
      return send(accounts.holder, manifest.fundingVault, ABI, 'depositForOrder', [order.orderKey, BigInt(amount)]);
    }
    async function escrow(order, quantity = order.quantity) {
      await send(accounts.holder, manifest.stockToken, tokenAbi, 'approve', [manifest.redemptionEscrow, BigInt(quantity)]);
      return send(accounts.holder, manifest.redemptionEscrow, ABI, 'escrowForOrder', [order.orderKey, manifest.stockToken, BigInt(quantity)]);
    }
    async function drain(predicate, context) {
      for (let n = 0; n < 30; n++) {
        await Promise.all([worker().runOne(), worker().runOne()]);
        await observer.runOnce();
        if (await predicate()) return;
        await delay(100);
      }
      throw new Error(`Timed out while ${context}`);
    }
    const buyState = async id => (await repo.scopedOrders(`evm:${accounts.holder}`, id))[0]?.state;
    const sellState = async id => (await repo.sellOrders(`evm:${accounts.holder}`, id))[0]?.state;
    const currentBalance = async (token, wallet) => chain.tokenBalance(token, wallet, (await chain.block('finalized')).number);

    // HTTP actor identities are signed sessions, not caller-provided wallet fields.
    await api('stocks/quotes', { symbol: 'NVDA', quantity: '1' }, null, 401);
    await api('stocks/quotes', { symbol: 'NVDA', quantity: '1' }, 'wrongChain', 401);
    await api('stocks/sell-quotes', { symbol: 'NVDA', quantity: '1' }, 'wrongDomain', 401);
    await api('admin/stocks/overview', undefined, 'holder', 403);
    await api('stocks/quotes', { symbol: 'NVDA', quantity: '1', wallet: accounts.otherHolder }, 'holder', 400);
    await api('admin/stocks/overview', undefined, 'operator');
    const forgedAdmin = await fetch(`${url}/api/v1/admin/stocks/overview`, { headers: {
      'x-operator-token': 'TEST_HARNESS_ONLY_LEGACY_OPERATOR', 'x-role': 'admin', 'x-wallet': accounts.operator,
    } });
    assert.equal(forgedAdmin.status, 403);
    for (const route of ['stocks/mint', 'stocks/confirm', 'stocks/refund', 'stocks/redeem', 'admin/stocks/retry'])
      await api(route, { amount: '999999' }, 'operator', 404);
    passed('Actual buildApp legacy health/catalog/SIWE, signed actor scope, and named read-only administrator authorization');
    assert.equal((await chain.network()).checkpointHash, manifest.checkpointHash);
    for (const target of [manifest.cashToken, manifest.stockToken, manifest.fundingVault, manifest.mintController, manifest.redemptionEscrow]) {
      assert.equal(await chain.codeHash(target, manifest.checkpointNumber), manifest.codeHashes[target]);
    }
    assert.equal(await observer.coverage(), null);
    assert.equal(await observer.runOnce(), 'CURRENT');
    assert.ok(await observer.coverage());
    passed('Five deployed runtime code hashes and real PostgreSQL observer checkpoint');

    await send(accounts.faucetOperator, manifest.cashToken, tokenAbi, 'faucet', [accounts.holder, 2000000000n]);
    const initialCash = await currentBalance(manifest.cashToken, accounts.holder);
    const first = await buy('2', 'first');
    await api(`stocks/orders/${first.id}`, undefined, 'otherHolder', 404);
    const replayOrder = await api('stocks/orders', { quoteId: first.quoteId, idempotencyKey: 'local-buy-first' });
    assert.equal(replayOrder.id, first.id);
    const fundingHash = await deposit(first);

    // Crash after recording one funding fact but before advancing cursor; a second
    // observer must see BUSY while the first owns its PostgreSQL advisory lock.
    let enter; const entered = new Promise(resolve => { enter = resolve; });
    let release; const held = new Promise(resolve => { release = resolve; });
    const failing = new StocksFinalizedObserver(pool, manifest, digest, chain, transport, { ...hooks,
      observeFunding: async hash => { await service.observeFunding(hash); enter(); await held; throw new Error('TEST_CRASH_AFTER_FACT'); } });
    const failedRun = failing.runOnce();
    const failedHandled = failedRun.then(() => assert.fail('Expected injected observer failure'), error => assert.match(error.message, /TEST_CRASH_AFTER_FACT/));
    let beforeReplay;
    try {
      await Promise.race([entered, delay(5000).then(() => { throw new Error('Observer hook did not run'); })]);
      assert.equal(await observer.runOnce(), 'BUSY');
      beforeReplay = await observer.coverage();
    } finally { release(); }
    await failedHandled;
    assert.deepEqual(await observer.coverage(), beforeReplay);
    await observer.runOnce();
    assert.equal((await pool.query('SELECT COUNT(*)::text AS n FROM arco_evm."StocksFunding" WHERE "txHash"=$1', [fundingHash])).rows[0].n, '1');
    await drain(async () => await buyState(first.id) === 'COMPLETED', 'buying and minting first position');
    assert.equal(await currentBalance(manifest.stockToken, accounts.holder), '2000000000');
    assert.equal(await currentBalance(manifest.cashToken, manifest.fundingVault), '240000000');
    passed('Observer concurrent lock, crash after durable fact, replay without double credit');
    passed('HTTP BUY -> actual funding receipt -> durable mock fill -> actual mint -> finalized holding');

    const partial = await sell('0.5', 'partial');
    await escrow(partial);
    await observer.runOnce();
    await drain(async () => await sellState(partial.id) === 'COMPLETED', 'redeeming a partial holding');
    assert.equal(await currentBalance(manifest.stockToken, accounts.holder), '1500000000');
    assert.equal(await chain.tokenSupply(manifest.stockToken, (await chain.block('finalized')).number), '1500000000');
    assert.equal(await currentBalance(manifest.cashToken, manifest.fundingVault), '180000000');
    assert.equal(await currentBalance(manifest.cashToken, accounts.holder), (BigInt(initialCash) - 180000000n).toString());
    const afterSell = (await api('stocks/portfolio')).holdings[0];
    assert.equal(afterSell.walletQuantity, '1500000000'); assert.equal(afterSell.escrowedQuantity, '0');
    passed('Partial SELL -> actual escrow -> mock fill -> atomic burn/payout -> portfolio conservation');

    // A lost response after the local node accepted the mint leaves a durable
    // PREPARED original nonce. Restart the signer and recover by sender+nonce.
    const lost = await buy('1', 'lost-ack');
    await deposit(lost); await observer.runOnce();
    await worker().runOne(); // durable broker fill queues the mint
    signerServer.controls.loseNextBroadcastAcknowledgement = true;
    await worker().runOne();
    assert.equal(await buyState(lost.id), 'MINT_UNKNOWN');
    const prepared = (await pool.query('SELECT * FROM stocks_local_harness.signer_operations WHERE id=$1', [`mint:${lost.id}`])).rows[0];
    assert.equal(prepared.state, 'PREPARED'); assert.equal(prepared.tx_hash, null);
    const alternateManifest = freezeManifest({ ...manifest, deploymentId: `${manifest.deploymentId}-nonce-probe` });
    const alternateDigest = manifestDigest(alternateManifest);
    const alternateServer = await localSigner({ pool, rpc, manifest: alternateManifest, deploymentDigest: alternateDigest, token: signerToken });
    const alternateSigner = externalStocksSigner({ url: alternateServer.url, authorization: signerToken,
      deploymentDigest: alternateDigest, manifest: alternateManifest, localHarness: true });
    try {
      await alternateSigner.probe();
      const beforeBlockedNonce = await rpc('eth_getTransactionCount', [manifest.signerAddress, 'pending']);
      const blockedCall = authorizedCall(alternateManifest, 'nonce-probe:blocked', 'MINT', accounts.holder, '1');
      await assert.rejects(() => alternateSigner.submit(blockedCall));
      assert.equal(alternateServer.controls.submissionRequests, 1, 'Canonical call must reach the signer over HTTP');
      assert.equal(alternateServer.controls.unresolvedBlocks, 1, 'Physical-account unresolved guard must reject the call');
      assert.equal(alternateServer.controls.submissions, 0);
      assert.equal(await rpc('eth_getTransactionCount', [manifest.signerAddress, 'pending']), beforeBlockedNonce);
      assert.equal((await pool.query('SELECT COUNT(*)::text AS n FROM stocks_local_harness.signer_operations WHERE id=$1', ['nonce-probe:blocked'])).rows[0].n, '0');
    } finally { await alternateServer.close(); }
    await resetSigner();
    await drain(async () => await buyState(lost.id) === 'COMPLETED', 'recovering original mint after signer restart');
    assert.equal(signerServer.controls.submissions, 0);
    assert.equal(signerServer.controls.recoveries, 1);
    const recovered = (await pool.query('SELECT * FROM stocks_local_harness.signer_operations WHERE id=$1', [`mint:${lost.id}`])).rows[0];
    assert.equal(recovered.nonce, prepared.nonce); assert.ok(recovered.tx_hash);
    assert.equal(await currentBalance(manifest.stockToken, accounts.holder), '2500000000');
    passed('Lost broadcast acknowledgement and signer restart recover original nonce/hash without resubmission');

    const concurrent = await Promise.all([buy('0.25', 'concurrent-a'), buy('0.25', 'concurrent-b')]);
    for (const order of concurrent) await deposit(order);
    await observer.runOnce();
    await Promise.all([worker().runOne(), worker().runOne()]); // two distinct broker jobs
    await Promise.all([worker().runOne(), worker().runOne()]); // two distinct signed operations
    await drain(async () => (await Promise.all(concurrent.map(order => buyState(order.id)))).every(state => state === 'COMPLETED'), 'processing concurrent mint nonces');
    const records = (await pool.query('SELECT * FROM stocks_local_harness.signer_operations WHERE id=ANY($1::text[]) ORDER BY nonce', [concurrent.map(o => `mint:${o.id}`)])).rows;
    assert.equal(records.length, 2); assert.equal(BigInt(records[1].nonce), BigInt(records[0].nonce) + 1n);
    const beforeReplayNonce = await rpc('eth_getTransactionCount', [manifest.signerAddress, 'pending']);
    const repeated = await Promise.all([signer.submit(records[0].payload), signer.submit(records[0].payload)]);
    assert.equal(repeated[0].txHash, records[0].tx_hash); assert.deepEqual(repeated[0], repeated[1]);
    assert.equal(await rpc('eth_getTransactionCount', [manifest.signerAddress, 'pending']), beforeReplayNonce);
    await assert.rejects(() => signer.submit({ ...records[0].payload, data: records[1].payload.data }));
    assert.equal(await currentBalance(manifest.stockToken, accounts.holder), '3000000000');
    passed('Concurrent operation nonce serialization, exact replay, and altered-payload rejection');

    // This explicit LOCAL signer-protocol client tests nonce storage only. It
    // deliberately bypasses the product adapter's operationId/calldata policy:
    // both calls replay an already-completed on-chain operation, consuming two
    // nonces with zero value movement. Do not use this client for product flows.
    const crossServer = await localSigner({ pool, rpc, manifest: alternateManifest, deploymentDigest: alternateDigest, token: signerToken });
    try {
      const nonceProtocolProbe = async (server, deploymentDigest, call) => {
        assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1');
        assert.equal(new URL(server.url).hostname, '127.0.0.1');
        const response = await fetch(`${server.url}/v1/operations/${encodeURIComponent(call.operationId)}`, {
          method: 'PUT', redirect: 'error', headers: { authorization: `Bearer ${signerToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ protocol: 'ARCO_STOCKS_SIGNER_V1', deploymentDigest, call, callDigest: callDigest(call) }),
        });
        assert.equal(response.status, 200, 'Local nonce-store probe must reach and succeed at HTTP signer');
        const result = await response.json();
        assert.equal(result.operationId, call.operationId); assert.equal(result.callDigest, callDigest(call));
        return result;
      };
      const calls = [
        { ...records[0].payload, operationId: 'nonce-probe:original-deployment' },
        { ...records[0].payload, operationId: 'nonce-probe:alternate-deployment', deploymentId: alternateManifest.deploymentId },
      ];
      const requestsBefore = signerServer.controls.submissionRequests;
      const results = await Promise.all([nonceProtocolProbe(signerServer, digest, calls[0]), nonceProtocolProbe(crossServer, alternateDigest, calls[1])]);
      assert.equal(signerServer.controls.submissionRequests, requestsBefore + 1);
      assert.equal(crossServer.controls.submissionRequests, 1);
      for (const result of results) assert.equal((await waitReceipt(result.txHash)).logs.length, 0);
      const physical = (await pool.query('SELECT nonce FROM stocks_local_harness.signer_operations WHERE id=ANY($1::text[]) ORDER BY nonce', [calls.map(call => call.operationId)])).rows;
      assert.equal(physical.length, 2); assert.equal(BigInt(physical[1].nonce), BigInt(physical[0].nonce) + 1n);
      assert.equal(await currentBalance(manifest.stockToken, accounts.holder), '3000000000');
    } finally { await crossServer.close(); }
    passed('Different deployment digests share physical-account nonce lock and unresolved-operation blocking');

    const abnormal = await buy('1', 'abnormal');
    const abnormalHash = await deposit(abnormal, '119000000');
    await observer.runOnce();
    const abnormalFact = (await pool.query('SELECT * FROM arco_evm."StocksFunding" WHERE "txHash"=$1', [abnormalHash])).rows[0];
    assert.equal(abnormalFact.reason, 'AMOUNT_MISMATCH');
    await service.requestRefund(abnormalFact.id);
    await drain(async () => await buyState(abnormal.id) === 'REFUNDED', 'returning abnormal funding');
    assert.equal(await currentBalance(manifest.stockToken, accounts.holder), '3000000000');
    passed('Abnormal actual funding remains suspense until authorized exact refund is finalized');

    // The actual runtime factory verifies the deployment, signer and DB binding.
    // Each managed app owns a fresh real pool; the original pool remains open for
    // independent assertions and the remaining abnormal-inclusion scenarios.
    const signerCount = async () => (await pool.query('SELECT COUNT(*)::text AS n FROM stocks_local_harness.signer_operations')).rows[0].n;
    const cursorVersion = async () => (await pool.query('SELECT version FROM arco_evm."StocksObserverCursor" WHERE "deploymentDigest"=$1', [digest])).rows[0]?.version;
    async function managedApp(autodispatch) {
      const runtimePool = new Pool({ connectionString: databaseUrl, max: 8 });
      let runtime;
      let managedUrl;
      const managed = await startManagedStocksServer({
        createRuntime: async () => {
          try {
            runtime = await createStocksRuntime({ manifest, pool: runtimePool, transport, signer, autodispatch, paused: false, operators });
            return runtime;
          } catch (error) {
            await runtimePool.end(); // Factory transfers ownership only after successful return.
            throw error;
          }
        },
        buildApp: configured => buildApp(appEnv, { ...legacy, stocks: {
          service: configured.service, ...resolvers, reconciliationCoverage: configured.reconciliationCoverage,
        } }),
        listen: async instance => { managedUrl = await instance.listen({ host: '127.0.0.1', port: 0 }); },
        closeDatabase: async () => {}, // The fixture's separate original pool is not owned by this app.
        autodispatch,
        // No scheduler override: use the production lifecycle's native 2s timer.
      });
      const request = async (path, body, status = 200, actor = 'holder') => {
        const response = await fetch(`${managedUrl}/api/v1/${path}`, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[actor]}` },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const row = await response.json();
        assert.equal(response.status, status, JSON.stringify({ path, row }));
        return row.data ?? row;
      };
      return { app: managed, pool: runtimePool, runtime, request };
    }

    const noDispatchBefore = { signerCount: await signerCount(), cursorVersion: await cursorVersion() };
    const idle = await managedApp(false);
    try {
      assert.equal(idle.runtime.status().newOrdersPaused, true);
      await idle.request('stocks/quotes', { symbol: 'NVDA', quantity: '0.125' }, 503);
      await idle.request('stocks/sell-quotes', { symbol: 'NVDA', quantity: '0.125' }, 503);
      await Promise.all([idle.runtime.tick(), idle.runtime.tick()]);
      assert.equal(idle.runtime.status().newOrdersPaused, true);
      assert.equal(await signerCount(), noDispatchBefore.signerCount);
      assert.equal(await cursorVersion(), noDispatchBefore.cursorVersion);
    } finally { await idle.app.close(); }
    await assert.rejects(() => idle.pool.query('SELECT 1'), /Cannot use a pool after calling end/);
    passed('Actual runtime autodispatch disabled keeps quotes paused and tick inert, then closes its owned pool');

    const automaticBefore = await signerCount();
    const automatic = await managedApp(true);
    try {
      assert.equal(automatic.runtime.status().newOrdersPaused, false);
      const waitForOrder = async (path, label) => {
        const deadline = Date.now() + 60000;
        let state;
        while (Date.now() < deadline) {
          state = (await automatic.request(path)).state;
          // Projection may finish just before the same tick refreshes observer
          // health; wait for admission readiness before submitting the next quote.
          if (state === 'COMPLETED' && !automatic.runtime.status().newOrdersPaused) return;
          assert.ok(!state.includes('REVIEW'), `${label}: ${state}`);
          await delay(200);
        }
        throw new Error(`Native runtime timer did not complete ${label}: ${state}`);
      };
      const buyQuote = await automatic.request('stocks/quotes', { symbol: 'NVDA', quantity: '0.125' });
      const automaticBuy = await automatic.request('stocks/orders', { quoteId: buyQuote.id, idempotencyKey: 'local-native-timer-buy' });
      await deposit(automaticBuy);
      // Only HTTP polling follows wallet submissions. No manual worker, observer
      // or tick calls are allowed anywhere in this automatic trading phase.
      await waitForOrder(`stocks/orders/${automaticBuy.id}`, 'BUY 0.125');
      assert.equal(await currentBalance(manifest.stockToken, accounts.holder), '3125000000');
      assert.equal(await currentBalance(manifest.cashToken, manifest.fundingVault), '375000000');
      const sellQuote = await automatic.request('stocks/sell-quotes', { symbol: 'NVDA', quantity: '0.125' });
      const automaticSell = await automatic.request('stocks/sell-orders', { quoteId: sellQuote.id, idempotencyKey: 'local-native-timer-sell' });
      await escrow(automaticSell);
      await waitForOrder(`stocks/sell-orders/${automaticSell.id}`, 'SELL 0.125');
      assert.equal(await currentBalance(manifest.stockToken, accounts.holder), '3000000000');
      assert.equal(await currentBalance(manifest.stockToken, manifest.redemptionEscrow), '0');
      assert.equal(await currentBalance(manifest.cashToken, manifest.fundingVault), '360000000');
      const position = (await automatic.request('stocks/portfolio')).holdings[0];
      assert.equal(position.walletQuantity, '3000000000');
      assert.equal(position.escrowedQuantity, '0');
      assert.equal(position.reservedQuantity, '0');
      assert.equal(BigInt(await signerCount()) - BigInt(automaticBefore), 2n);
      await automatic.request('admin/stocks/overview', undefined, 200, 'operator');
    } finally { await automatic.app.close(); }
    await assert.rejects(() => automatic.pool.query('SELECT 1'), /Cannot use a pool after calling end/);
    assert.equal((await api('stocks/portfolio')).holdings[0].walletQuantity, '3000000000');
    passed('Actual runtime factory and native managed-server timer complete HTTP BUY/SELL 0.125 without manual dispatch');

    // Both orders are created while quotes are fresh. Only inclusion time is then
    // advanced; database quote snapshots are never edited to fabricate expiry.
    const lateBuy = await buy('1', 'late');
    const lateSell = await sell('0.25', 'late');
    const expires = Math.max(new Date(lateBuy.quoteExpiresAt).getTime(), new Date(lateSell.quoteExpiresAt).getTime());
    await rpc('evm_setNextBlockTimestamp', [Math.ceil(expires / 1000) + 5]);
    const lateFundingHash = await deposit(lateBuy);
    const lateEscrowHash = await escrow(lateSell);
    await observer.runOnce();
    const lateFunding = (await pool.query('SELECT * FROM arco_evm."StocksFunding" WHERE "txHash"=$1', [lateFundingHash])).rows[0];
    const lateCustody = (await pool.query('SELECT * FROM arco_evm."StocksCustody" WHERE "txHash"=$1', [lateEscrowHash])).rows[0];
    assert.equal(lateFunding.reason, 'QUOTE_EXPIRED'); assert.equal(lateCustody.reason, 'QUOTE_EXPIRED');
    await service.requestRefund(lateFunding.id); await service.sell.requestReturn(lateCustody.id);
    await drain(async () => await buyState(lateBuy.id) === 'REFUNDED' && await sellState(lateSell.id) === 'RETURNED', 'returning late funding and escrow');
    assert.equal(await currentBalance(manifest.stockToken, accounts.holder), '3000000000');
    assert.equal(await currentBalance(manifest.stockToken, manifest.redemptionEscrow), '0');
    assert.equal(await chain.tokenSupply(manifest.stockToken, (await chain.block('finalized')).number), '3000000000');
    assert.equal(await currentBalance(manifest.cashToken, manifest.fundingVault), '360000000');
    passed('Late inclusion recorded durably and exact original-payer funding/custody return');

    await observer.runOnce();
    const portfolio = await api('stocks/portfolio');
    assert.equal(portfolio.holdings[0].walletQuantity, '3000000000');
    assert.equal(portfolio.holdings[0].escrowedQuantity, '0');
    assert.equal(portfolio.holdings[0].reservedQuantity, '0');
    assert.equal(portfolio.holdings[0].availableQuantity, '3000000000');
    const reconciliation = await reconcileStocks(service, () => observer.coverage());
    assert.equal(reconciliation.status, 'MATCHED_AT_CUTOFF', JSON.stringify(reconciliation));
    assert.equal((await pool.query(`SELECT COUNT(*)::text AS n FROM arco_evm."StocksOutbox" WHERE status <> 'DONE'`)).rows[0].n, '0');
    const allSignerRows = (await pool.query('SELECT id,nonce,tx_hash FROM stocks_local_harness.signer_operations ORDER BY nonce')).rows;
    assert.equal(allSignerRows.length, 12, 'Original scenarios plus the native timer roundtrip produce twelve durable signer operations');
    assert.equal(new Set(allSignerRows.map(r => r.nonce)).size, allSignerRows.length);
    assert.ok(allSignerRows.every(r => r.tx_hash));
    passed('Common-cutoff reconciliation agrees with independent cash, stock supply and wallet/escrow reads');
    report.final = { stockWalletUnits: '3000000000', stockEscrowUnits: '0', stockSupplyUnits: '3000000000',
      cashVaultUnits: '360000000', reconciliation: reconciliation.status, durableSignerOperations: allSignerRows.length };
    report.result = 'PASS';
    return report;
  } finally {
    await app.close();
    if (signerServer) await signerServer.close();
    await pool.end();
  }
}
