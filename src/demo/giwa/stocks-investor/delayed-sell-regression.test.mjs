// Offline integration: actual plugin + SELL service; SQL/storage ports are in-memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(`${repo}/package.json`);
const Fastify = require('fastify');
const { createHarness, flush, WALLET_A } = await import(`${repo}/src/demo/giwa/stocks-investor/fixtures/controller-harness.ts`);
const { createGiwaStocksHttpClient } = await import(`${repo}/src/demo/giwa/stocks-investor/client.ts`);
const { StocksSellService } = await import(`${repo}/server/src/stocks/sell-service.ts`);
const { stocksPlugin } = await import(`${repo}/server/src/stocks/plugin.ts`);


test('unknown SELL stays unresolved when an overtaking retry reports temporarily insufficient stock', async () => {
 const h = createHarness();
 const actor = { actorId: `evm:${WALLET_A}`, wallet: WALLET_A, verified: true, chainId: 91342, scope: 'STOCKS_TESTNET' };
 const quotes = new Map(); const orders = []; const sqlLog = [];
 let available = 0n, calls = 0, releaseFirst, firstReady;
 const held = new Promise(resolve => { releaseFirst = resolve; });
 const readyEntered = new Promise(resolve => { firstReady = resolve; });
 const db = { async query(sql, v = []) {
   sqlLog.push(sql);
   if (sql.startsWith('SELECT pg_advisory')) return { rows: [], rowCount: 1 };
   if (sql.startsWith('SELECT * FROM arco_evm."StocksSellOrder"')) return { rows: orders.filter(o => o.actorId === v[0] && o.idempotencyKey === v[1]), rowCount: 0 };
   if (sql.includes('FROM arco_evm."StocksSellQuote"')) return { rows: quotes.has(v[0]) ? [{ ...quotes.get(v[0]), valid: true }] : [], rowCount: 0 };
   if (sql.startsWith('SELECT id FROM arco_evm."StocksSellOrder"')) return { rows: orders.filter(o => o.quoteId === v[0]), rowCount: 0 };
   if (sql.startsWith('INSERT INTO arco_evm."StocksSellOrder"')) {
     const now = new Date(); const row = { id:v[0],orderKey:v[1],quoteId:v[2],actorId:v[3],wallet:v[4],symbol:'NVDA',quantity:v[5],cashAmount:v[6],idempotencyKey:v[7],deploymentId:v[8],deploymentDigest:v[9],quoteExpiresAt:v[10],state:'AWAITING_ESCROW',version:0,createdAt:now,updatedAt:now };
     orders.push(row); available -= BigInt(row.quantity); return { rows:[row],rowCount:1 };
   }
   if (sql.startsWith('INSERT INTO arco_evm."StocksQuantityReservation"')) return { rows: [], rowCount: 1 };
   throw Error(`Unexpected SQL: ${sql}`);
 } };
 const parent = { digest:'digest-fixture-stocks-deployment-a', manifest:{ deploymentId:'fixture-stocks-deployment-a', networkInstance:'test-instance' }, async ready() { if (++calls === 1) { firstReady(); await held; } }, repo:{ tx: async work => work(db), walletPosition: async () => ({availableQuantity:available.toString()}), audit: async () => {} } };
 parent.sell = new StocksSellService(parent);
 const app = Fastify({ logger:false });
 await app.register(stocksPlugin, { service:parent, resolveActor:async () => actor });
 await app.ready();
 let posts = 0, originalResponse;
 const actualHttp = createGiwaStocksHttpClient({baseUrl:'http://fixture.invalid', fetch: async (url, init) => {
   const response = app.inject({ method:init.method, url:new URL(url).pathname, headers:init.headers, payload:init.body });
   if (++posts === 1) {
     originalResponse = response;
     await readyEntered;
     throw new TypeError('Simulated dropped connection; original server work continues');
   }
   const r = await response; return new Response(r.payload, {status:r.statusCode});
 }});
 const client = { ...h.client, createOrder:actualHttp.createOrder, createQuote:async (...args) => { const r = await h.client.createQuote(...args); quotes.set(r.data.id, r.data); return r; } };
 try {
   h.controller.setContext({...h.context(h.session(WALLET_A)),client}); await flush();
   await h.quote('1','SELL');
   await h.controller.placeOrder();
   assert.equal(h.controller.getState().attempt.status, 'UNCONFIRMED');
   await h.controller.retryOrder();
   const afterRetry = h.controller.getState().attempt;
   available = 3000000000n; // A later finalized credit changes the mutable availability predicate.
   releaseFirst();
   const original = await originalResponse;
   assert.equal(original.statusCode,200);
   h.controller.startNewOrder();
   await h.quote('1','SELL');
   await h.controller.placeOrder();

   assert.equal(afterRetry.status,'UNCONFIRMED','mutable stock refusal must not resolve a still-running earlier POST');
   assert.equal(orders.length,1,'the offered flow must not create a new-key order');
   assert.equal(new Set(orders.map(o=>o.idempotencyKey)).size,1);
   assert.equal(h.controller.getState().attempt.body.idempotencyKey,orders[0].idempotencyKey);
   await h.controller.retryOrder();
   assert.equal(h.controller.getState().attempt.status,'ACCEPTED');
   assert.equal(orders.length,1);
 } finally { releaseFirst(); h.controller.suspend(); await app.close(); }
});
