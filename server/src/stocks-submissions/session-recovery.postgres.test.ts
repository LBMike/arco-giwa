import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { StocksRepository } from '../stocks/repository.js';
import { StocksService } from '../stocks/service.js';
import { a, h, TestChain } from '../stocks/test-fixtures.js';
import { stocksSessionResolvers } from '../stocks-runtime/session.js';
import { StocksSubmissionsService } from './service.js';
import { stocksSubmissionsPlugin } from './plugin.js';
import { createSubmissionReceiptVerifier } from './receipts.js';
import { addSubmission } from './receipts-fixtures.js';
import { enabled, fixture } from './test-fixtures.js';
import type { Side } from './contracts.js';
import type { SqlPool } from '../stocks/contracts.js';

const require = createRequire(import.meta.url);
const { sign } = require('jsonwebtoken') as typeof import('jsonwebtoken');
const SECRET = 'TEST_ONLY_session_recovery_contract_never_deployed';
const DOMAIN = 'session-recovery.fixture';
const options = { skip: !enabled };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Fixture = Awaited<ReturnType<typeof fixture>>;

function token(wallet: string, expired = false): string {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: wallet.toLowerCase(), domain: DOMAIN, chainId: 91342, jti: randomUUID(),
    iat: expired ? now - 600 : now, exp: expired ? now - 1 : now + 600 }, SECRET, { algorithm: 'HS256' });
}
// A fresh short-lived quote is inserted BEFORE createOrder. Existing quote/order deadlines are never edited.
// The real createOrder path inserts both the order and trusted enrollment in its transaction.
async function shortOrder(f: Fixture, side: Side) {
  if (side === 'SELL') await f.pool.query('INSERT INTO arco_evm."StocksQuantityMovement" (id,"deploymentDigest",wallet,"walletDelta","escrowDelta","supplyDelta","blockNumber","blockHash","txHash") VALUES($1,$2,$3,1000000000,0,1000000000,1,\'fixture-block\',\'fixture-tx\')', [randomUUID(), f.stocks.digest, f.actor.wallet]);
  const service = side === 'BUY' ? f.stocks : f.stocks.sell;
  const source = await service.quote(f.actor, 'NVDA', '1'), id = randomUUID();
  const table = side === 'BUY' ? 'StocksQuote' : 'StocksSellQuote';
  await f.pool.query(`INSERT INTO arco_evm."${table}" (id,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest","expiresAt") SELECT $2,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest",clock_timestamp()+interval '1500 milliseconds' FROM arco_evm."${table}" WHERE id=$1`, [source.id, id]);
  return service.createOrder(f.actor, id, `recovery:${randomUUID()}`);
}
async function facts(f: Fixture) {
  const result: Record<string, unknown> = {};
  for (const table of ['StocksWalletSubmission', 'StocksWalletSubmissionProof', 'StocksWalletSubmissionEnrollment', 'StocksAudit', 'StocksOrder', 'StocksSellOrder']) {
    result[table] = (await f.pool.query(`SELECT to_jsonb(t) AS value FROM arco_evm."${table}" t WHERE "deploymentDigest"=$1 ORDER BY to_jsonb(t)::text`, [f.stocks.digest])).rows;
  }
  return result;
}

for (const side of ['BUY', 'SELL'] as const) for (const stage of ['APPROVAL', 'TRANSFER'] as const) test(`real PG ${side} ${stage}: fresh signed owner recovers a known late hash after session/order expiry and pause without a new claim`, options, async t => {
  const f = await fixture(); t.after(() => f.pool.end());
  // Fixture orders use exactly the actor identity emitted by the real signed-session resolver.
  f.actor.actorId = `evm:${f.actor.wallet.toLowerCase()}`;
  let sqlCalls = 0, rpcCalls = 0;
  const tracked: SqlPool = {
    query: async (text, values) => { sqlCalls++; return f.pool.query(text, values); },
    connect: async () => { sqlCalls++; const db = await f.pool.connect(); return {
      release: () => db.release(), query: async (text, values) => { sqlCalls++; return db.query(text, values); },
    }; },
  };
  const stocks = new StocksService(new StocksRepository(tracked, f.stocks.digest), f.manifest, f.stocks.verifier,
    { manifestDigest: f.stocks.digest, contractPolicyVerified: true }, f.stocks.paused);
  const chain = new TestChain(f.manifest), network = chain.network.bind(chain);
  chain.network = async () => { rpcCalls++; return network(); };
  const service = new StocksSubmissionsService(stocks, createSubmissionReceiptVerifier(f.manifest, chain));
  const app = Fastify({ logger: false }); t.after(() => app.close());
  await app.register(stocksSubmissionsPlugin, { service, resolveActor: stocksSessionResolvers(SECRET, [DOMAIN], []).resolveActor });
  await app.ready();
  const order = await shortOrder(f, side), path = `/api/v1/stocks/wallet-submissions/${side}/${order.id}`;
  const originalToken = token(f.actor.wallet), freshToken = token(f.actor.wallet), expiredToken = token(f.actor.wallet, true), otherToken = token(a(999));
  assert.notEqual(originalToken, freshToken, 'renewed credentials remain the same actor, not the original bearer token');
  const post = (suffix: string, payload: unknown, bearer = freshToken) => app.inject({ method: 'POST', url: `/api/v1/stocks/wallet-submissions/${suffix}`, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  const inspect = (bearer = freshToken) => app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${bearer}` } });
  const claimResponse = await post('claims', f.request(order, side, stage), originalToken);
  assert.equal(claimResponse.statusCode, 200); const claim = claimResponse.json().data;
  assert.equal(claim.status, 'REQUEST_MAY_START');
  const outcome = { ...claim, status: 'SUBMITTED', txHash: h(970) };
  const receipt = { claimId: claim.claimId, intentKey: claim.intentKey, stage: claim.stage, transactionDigest: claim.transactionDigest, txHash: h(970) };

  // Actual expired JWT: reject in onRequest before malformed body parsing, SQL or trusted RPC.
  const beforeDenied = await facts(f), queriesBefore = sqlCalls, rpcBefore = rpcCalls;
  for (const response of [await inspect(expiredToken), await post('outcomes', outcome, expiredToken), await post('reconcile', receipt, expiredToken), await post('outcomes', '{', expiredToken)]) {
    assert.equal(response.statusCode, 401); assert.equal(response.json().error, 'UNAUTHORIZED'); assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(sqlCalls, queriesBefore); assert.equal(rpcCalls, rpcBefore); assert.deepEqual(await facts(f), beforeDenied);

  await sleep(Math.max(0, new Date(order.quoteExpiresAt).getTime() - Date.now() + 50));
  assert.equal((await f.pool.query('SELECT $1::timestamptz<=clock_timestamp() AS expired', [order.quoteExpiresAt])).rows[0].expired, true);
  f.pause(true);
  const observedResponse = await inspect(); assert.equal(observedResponse.statusCode, 200);
  const observed = observedResponse.json().data[stage === 'APPROVAL' ? 'approval' : 'transfer'];
  assert.equal(observed.claimId, claim.claimId); assert.equal(observed.status, 'REQUEST_MAY_START'); assert.equal(observed.txHash, undefined);
  assert.equal((await inspect(otherToken)).statusCode, 404);
  assert.equal((await post('outcomes', outcome, otherToken)).statusCode, 404);
  assert.equal((await post('reconcile', receipt, otherToken)).statusCode, 404);

  const recorded = await post('outcomes', outcome); assert.equal(recorded.statusCode, 200);
  assert.equal(recorded.json().data.status, 'SUBMITTED'); assert.equal(recorded.json().data.claimId, claim.claimId);
  const once = await facts(f);
  const duplicate = await post('outcomes', outcome); assert.equal(duplicate.statusCode, 200);
  assert.deepEqual(duplicate.json().data, recorded.json().data); assert.deepEqual(await facts(f), once, 'duplicate record must not rewrite timestamp or append audit');
  const conflicting = await post('outcomes', { ...outcome, txHash: h(971) });
  assert.equal(conflicting.statusCode, 409); assert.equal(conflicting.json().error, 'SUBMISSION_HASH_CONFLICT');
  const clientTerminal = await post('outcomes', { ...outcome, status: 'CONFIRMED' });
  assert.equal(clientTerminal.statusCode, 409); assert.equal(clientTerminal.json().error, 'RECEIPT_VERIFICATION_REQUIRED');
  assert.deepEqual(await facts(f), once);

  const pending = await post('reconcile', receipt); assert.equal(pending.statusCode, 200); assert.equal(pending.json().data.status, 'SUBMITTED');
  assert.equal((await f.pool.query('SELECT * FROM arco_evm."StocksWalletSubmissionProof" WHERE "claimId"=$1', [claim.claimId])).rowCount, 0);
  addSubmission(chain, f.manifest, order, side, stage, h(970));
  const confirmed = await post('reconcile', receipt); assert.equal(confirmed.statusCode, 200); assert.equal(confirmed.json().data.status, 'CONFIRMED');
  const terminalFacts = await facts(f);
  const lateUnknown = await post('outcomes', { ...claim, status: 'UNKNOWN' }); assert.equal(lateUnknown.statusCode, 200); assert.equal(lateUnknown.json().data.status, 'CONFIRMED');
  assert.equal((await post('reconcile', receipt)).json().data.status, 'CONFIRMED'); assert.deepEqual(await facts(f), terminalFacts);
  const proof = (await f.pool.query('SELECT * FROM arco_evm."StocksWalletSubmissionProof" WHERE "claimId"=$1', [claim.claimId])).rows[0];
  assert.equal(proof.status, 'CONFIRMED'); assert.equal(proof.txHash, h(970));
  const table = side === 'BUY' ? 'StocksOrder' : 'StocksSellOrder';
  const stored = (await f.pool.query(`SELECT state,"quoteExpiresAt" FROM arco_evm."${table}" WHERE id=$1`, [order.id])).rows[0];
  assert.equal(stored.state, side === 'BUY' ? 'AWAITING_FUNDING' : 'AWAITING_ESCROW');
  assert.equal(new Date(stored.quoteExpiresAt).getTime(), new Date(order.quoteExpiresAt).getTime());

  if (stage === 'APPROVAL') {
    const pausedClaim = await post('claims', f.request(order, side, 'TRANSFER')); assert.equal(pausedClaim.statusCode, 503); assert.equal(pausedClaim.json().error, 'STOCKS_PAUSED');
    f.pause(false);
    const expiredClaim = await post('claims', f.request(order, side, 'TRANSFER')); assert.equal(expiredClaim.statusCode, 409); assert.equal(expiredClaim.json().error, 'ORDER_EXPIRED');
  } else f.pause(false);
  const replay = await post('claims', f.request(order, side, stage)); assert.equal(replay.statusCode, 200); assert.equal(replay.json().data, null);
  assert.equal((await f.pool.query('SELECT * FROM arco_evm."StocksWalletSubmission" WHERE "intentKey"=$1', [claim.intentKey])).rowCount, 1);
  assert.deepEqual(await facts(f), terminalFacts, 'recovery and rejected/replayed claim never create fresh wallet permission');
});
