import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tsImport } from 'tsx/esm/api';
import { buildApp } from '../../server/dist/app.js';
import { StocksRepository } from '../../server/dist/stocks/repository.js';
import { StocksService } from '../../server/dist/stocks/service.js';
import { ReceiptVerifier } from '../../server/dist/stocks/chain.js';
import { testManifest, TestChain, a, h } from '../../server/dist/stocks/test-fixtures.js';
import { manifestDigest } from '../../server/dist/stocks/contracts.js';
import { StocksSubmissionsService } from '../../server/dist/stocks-submissions/service.js';
import { stocksSessionResolvers } from '../../server/dist/stocks-runtime/session.js';
const { createSubmissionGate } = await tsImport('../../src/demo/giwa/stocks-wallet-submissions/client.ts', import.meta.url);
const { planOrder, digest } = await tsImport('../../src/demo/giwa/stocks-wallet/planner.ts', import.meta.url);
const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const { sign } = require('jsonwebtoken');
const enabled = process.env.STOCKS_TEST_HARNESS_ONLY === '1' && process.env.STOCKS_TEST_DATABASE_URL;
assert.ok(enabled, 'This test requires an explicitly owned fresh PostgreSQL harness');
const domain = 'submission-roundtrip.test';
const env = { corsAllowedOrigins: [`https://${domain}`], authNonceTtlSeconds: 60, authJwtSecret: 'LOCAL_ROUNDTRIP_TEST_ONLY', adminOperatorToken: 'LOCAL_UNUSED_OPERATOR', registryPath: '/NO_DEPLOYED_REGISTRY' };
async function scenario(run) {
  const pool = new Pool({ connectionString: process.env.STOCKS_TEST_DATABASE_URL, max: 8 });
  let app;
  try {
  const manifest = testManifest();
  manifest.deploymentId = `TEST_${randomUUID()}`;
  manifest.networkInstance = `TEST_${randomUUID()}`;
  // Every scenario owns a distinct physical vault; never mutate a prior binding.
  const old = manifest.fundingVault;
  manifest.fundingVault = `0x${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 40)}`;
  manifest.codeHashes[manifest.fundingVault] = manifest.codeHashes[old]; delete manifest.codeHashes[old];
  const deploymentDigest = manifestDigest(manifest), wallet = a(42);
  const actor = { actorId: `evm:${wallet}`, wallet, chainId: 91342, scope: 'STOCKS_TESTNET', verified: true };
  const stocks = new StocksService(new StocksRepository(pool, deploymentDigest), manifest, new ReceiptVerifier(manifest, new TestChain(manifest)), { manifestDigest: deploymentDigest, contractPolicyVerified: true }, async () => false);
  const quote = await stocks.quote(actor, 'NVDA', '1');
  const order = JSON.parse(JSON.stringify(await stocks.createOrder(actor, quote.id, `key:${randomUUID()}`)));
  const now = Date.now();
  const session = { id: randomUUID(), walletAddress: wallet, chainId: 91342, accessToken: sign({ sub: wallet, domain, chainId: 91342 }, env.authJwtSecret, { expiresIn: '15m' }), createdAt: now - 1000, expiresAt: now + 600000 };
  const context = { session, walletAddress: wallet, chainId: 91342, walletEpoch: 'TEST1', apiBase: `https://${domain}`, deployment: { status: 'VERIFIED', evidenceId: 'TEST_ONLY', manifestDigest: deploymentDigest, manifest, verifiedAt: now - 1000, validUntil: now + 600000 } };
  const plan = planOrder({ side: 'BUY', order }, context, now);
  app = buildApp(env, { arco: {}, registry: {}, portfolio: {}, readiness: { check: async () => ({ ok: true, checks: {} }) }, stocksSubmissions: { service: new StocksSubmissionsService(stocks), ...stocksSessionResolvers(env.authJwtSecret, [domain], []) } });
  const calls = [];
  const transport = async (url, init) => {
    const request = new URL(String(url)); calls.push(request.pathname);
    const result = await app.inject({ method: init.method, url: request.pathname + request.search, headers: init.headers, payload: init.body });
    return new Response(result.body, { status: result.statusCode, headers: result.headers });
  };
  const client = (fetcher = transport, owner = session) => createSubmissionGate({ apiBase: context.apiBase, session: owner, side: 'BUY', orderId: order.id, deploymentDigest, fetch: fetcher });
  const claim = stage => { const transaction = stage === 'APPROVAL' ? plan.approval : plan.transfer; return { intentKey: plan.intentKey, stage, transaction, transactionDigest: digest(transaction), orderId: order.id, deploymentDigest }; };
  await run({ pool, app, stocks, order, session, plan, client, claim, transport, calls });
  } finally { await app?.close(); await pool.end(); }
}
test('real app + PostgreSQL + browser adapter: lost claim response stays blocked across client recreation', async () => scenario(async f => {
  let dropped = false;
  const first = f.client(async (url, init) => { const response = await f.transport(url, init); if (String(url).endsWith('/claims') && !dropped) { dropped = true; throw new Error('SIMULATED_RESPONSE_LOSS_AFTER_COMMIT'); } return response; });
  await assert.rejects(() => first.claim(f.claim('TRANSFER')));
  const recovered = f.client();
  const prior = await recovered.inspect(f.plan.intentKey);
  assert.equal(prior.transfer.status, 'REQUEST_MAY_START');
  assert.equal(await recovered.claim(f.claim('TRANSFER')), null);
  await recovered.record({ ...prior.transfer, status: 'SUBMITTED', txHash: h(678) });
  const recreated = f.client();
  const persisted = await recreated.inspect(f.plan.intentKey);
  assert.equal(persisted.transfer.txHash, h(678));
  const { txHash: ignoredHash, ...withoutHash } = persisted.transfer;
  await recreated.record({ ...withoutHash, status: 'UNKNOWN' });
  assert.equal((await recreated.inspect(f.plan.intentKey)).transfer.txHash, h(678));
  await assert.rejects(() => recreated.record({ ...persisted.transfer, status: 'CONFIRMED' }));
  assert.equal(await recreated.claim(f.claim('TRANSFER')), null);
}));
test('real app + PostgreSQL + browser adapter: simultaneous clients receive one permission; other wallet cannot inspect', async () => scenario(async f => {
  const results = await Promise.all(Array.from({ length: 6 }, () => f.client().claim(f.claim('APPROVAL'))));
  assert.equal(results.filter(Boolean).length, 1);
  const blocked = await Promise.allSettled([f.client().claim(f.claim('TRANSFER'))]);
  if (blocked[0].status === 'fulfilled') assert.equal(blocked[0].value, null);
  assert.equal((await f.client().inspect(f.plan.intentKey)).transfer, null);
  const other = { ...f.session, id: randomUUID(), walletAddress: a(43), accessToken: sign({ sub: a(43), domain, chainId: 91342 }, env.authJwtSecret, { expiresIn: '15m' }) };
  await assert.rejects(() => f.client(undefined, other).inspect(f.plan.intentKey));
}));
