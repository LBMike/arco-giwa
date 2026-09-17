import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { a, h } from '../stocks/test-fixtures.js';
import { operationKey } from '../stocks/contracts.js';
import { StocksSubmissionsService } from './service.js';
import { stocksSubmissionsPlugin } from './plugin.js';
import { enabled, fixture } from './test-fixtures.js';
const options={skip:!enabled};

test('real PG: simultaneous same-physical claims grant exactly once and recreated service never re-grants lost response',options,async t=>{
 const f=await fixture();t.after(()=>f.pool.end());const o=await f.order();const request=f.request(o);
 const values=await Promise.all(Array.from({length:12},()=>f.service.claim(f.actor,request)));
 const winner=values.filter(Boolean);assert.equal(winner.length,1);assert.equal(values.filter(x=>x===null).length,11);
 const recreated=new StocksSubmissionsService(f.stocks);assert.deepEqual((await recreated.inspect(f.actor,'BUY',o.id)).transfer,winner[0]);
 assert.equal(await recreated.claim(f.actor,request),null);
 assert.equal((await f.pool.query('SELECT * FROM arco_evm."StocksAudit" WHERE subject=$1 AND action=\'WALLET_SUBMISSION_CLAIMED\'',[o.id])).rowCount,1);
});

test('real PG: APPROVAL and TRANSFER share one physical lock and neither can bypass the other',options,async t=>{
 for(const first of ['APPROVAL','TRANSFER'] as const){
 const f=await fixture();t.after(()=>f.pool.end());const o=await f.order();const won=await f.service.claim(f.actor,f.request(o,'BUY',first));assert.ok(won);
 await assert.rejects(f.service.claim(f.actor,f.request(o,'BUY',first==='APPROVAL'?'TRANSFER':'APPROVAL')),/SUBMISSION_STAGE_BLOCKED/);
 await f.service.record(f.actor,{...won,status:'UNKNOWN'});
 await assert.rejects(f.service.claim(f.actor,f.request(o,'BUY',first==='APPROVAL'?'TRANSFER':'APPROVAL')),/SUBMISSION_STAGE_BLOCKED/);
 }
 const f=await fixture();t.after(()=>f.pool.end());const o=await f.order();
 const race=await Promise.allSettled(['APPROVAL','TRANSFER'].map(s=>f.service.claim(f.actor,f.request(o,'BUY',s as 'APPROVAL'|'TRANSFER'))));
 assert.equal(race.filter(x=>x.status==='fulfilled'&&x.value).length,1);assert.equal(race.filter(x=>x.status==='rejected').length,1);
});

test('real PG: immutable binding and monotonic hash observations, client terminal reports never unlock',options,async t=>{
 const f=await fixture();t.after(()=>f.pool.end());const o=await f.order();const c=(await f.service.claim(f.actor,f.request(o)))!;
 assert.equal((await f.service.record(f.actor,{...c,status:'UNKNOWN'})).status,'UNKNOWN');
 const sent=await f.service.record(f.actor,{...c,status:'SUBMITTED',txHash:h(201)});assert.equal(sent.status,'SUBMITTED');
 assert.deepEqual(await f.service.record(f.actor,{...c,status:'UNKNOWN'}),sent);
 assert.deepEqual(await f.service.record(f.actor,sent),sent);
 await assert.rejects(f.service.record(f.actor,{...sent,txHash:h(202)}),/SUBMISSION_HASH_CONFLICT/);
 for(const status of ['CONFIRMED','REVERTED'])await assert.rejects(f.service.record(f.actor,{...sent,status}),/RECEIPT_VERIFICATION_REQUIRED/);
 await assert.rejects(f.pool.query('UPDATE arco_evm."StocksWalletSubmission" SET "actorId"=\'changed\' WHERE "claimId"=$1',[c.claimId]),/SUBMISSION_BINDING_IMMUTABLE/);
 await assert.rejects(f.pool.query('DELETE FROM arco_evm."StocksWalletSubmission" WHERE "claimId"=$1',[c.claimId]),/SUBMISSION_DELETE_FORBIDDEN/);
 await assert.rejects(f.pool.query('UPDATE arco_evm."StocksWalletSubmission" SET status=\'REQUEST_MAY_START\',"txHash"=NULL WHERE "claimId"=$1',[c.claimId]),/SUBMISSION_STATUS_REGRESSION/);
 await assert.rejects(f.pool.query('TRUNCATE arco_evm."StocksWalletSubmission", arco_evm."StocksWalletSubmissionEnrollment"'),/SUBMISSION_DELETE_FORBIDDEN/);
 assert.deepEqual((await f.service.inspect(f.actor,'BUY',o.id)).transfer,sent);
});

test('real PG: owner wallet side deployment and exact calldata cannot be forged',options,async t=>{
 const f=await fixture();t.after(()=>f.pool.end());const o=await f.order();const request=f.request(o);
 for(const actor of [{...f.actor,actorId:'other'},{...f.actor,wallet:a(11)}])await assert.rejects(f.service.claim(actor,request),/ORDER_NOT_FOUND/);
 await assert.rejects(f.service.claim(f.actor,{...request,side:'SELL'}),/ORDER_NOT_FOUND/);
 for(const extra of [{deploymentDigest:'f'.repeat(64)},{intentKey:'e'.repeat(64)},{transactionDigest:'d'.repeat(64)},{transaction:{...request.transaction,value:'1'}}])await assert.rejects(f.service.claim(f.actor,{...request,...extra}),/SUBMISSION_BINDING_MISMATCH/);
 const c=(await f.service.claim(f.actor,request))!;
 await assert.rejects(f.service.record({...f.actor,actorId:'other'},{...c,status:'UNKNOWN'}),/SUBMISSION_NOT_FOUND/);
 // Database physical uniqueness also excludes alternate actor/deployment bindings.
 await assert.rejects(f.pool.query('INSERT INTO arco_evm."StocksWalletSubmission" SELECT $2,"intentKey",stage,"transactionDigest",transaction,\'alias\',wallet,side,"orderId",$3,status,"txHash","createdAt","updatedAt" FROM arco_evm."StocksWalletSubmission" WHERE "claimId"=$1',[c.claimId,randomUUID(),'a'.repeat(64)]),/duplicate key/);
});

test('real PG: new orders enroll atomically; historical rows and existing-row idempotent retry never enroll',options,async t=>{
 const f=await fixture();t.after(()=>f.pool.end());const q=await f.stocks.quote(f.actor,'NVDA','1');const id=randomUUID(),key=`historical:${randomUUID()}`;
 const row=(await f.pool.query('INSERT INTO arco_evm."StocksOrder" (id,"orderKey","quoteId","actorId",wallet,symbol,quantity,"cashAmount","idempotencyKey","deploymentId","deploymentDigest","quoteExpiresAt") VALUES($1,$2,$3,$4,$5,\'NVDA\',$6,$7,$8,$9,$10,$11) RETURNING *',[id,operationKey(`${f.manifest.networkInstance}:${id}`),q.id,f.actor.actorId,f.actor.wallet,q.quantity,q.cashAmount,key,f.manifest.deploymentId,f.stocks.digest,q.expiresAt])).rows[0];
 assert.equal((await f.stocks.createOrder(f.actor,q.id,key)).id,id);
 assert.equal((await f.pool.query('SELECT * FROM arco_evm."StocksWalletSubmissionEnrollment" WHERE "orderId"=$1',[id])).rowCount,0);
 await assert.rejects(f.service.claim(f.actor,f.request(row)),/SUBMISSION_NOT_ENROLLED/);
 const current=await f.order();assert.equal((await f.pool.query('SELECT * FROM arco_evm."StocksWalletSubmissionEnrollment" WHERE "orderId"=$1',[current.id])).rowCount,1);
 await assert.rejects(f.pool.query('UPDATE arco_evm."StocksWalletSubmissionEnrollment" SET "actorId"=\'other\' WHERE "orderId"=$1',[current.id]),/ENROLLMENT_IMMUTABLE/);
});

test('real PG: audit failure rolls claim and new-order enrollment back atomically',options,async t=>{
 const f=await fixture();t.after(()=>f.pool.end());const o=await f.order();const audit=f.repo.audit.bind(f.repo);
 f.repo.audit=async()=>{throw new Error('TEST_AUDIT_FAILURE')};
 await assert.rejects(f.service.claim(f.actor,f.request(o)),/TEST_AUDIT_FAILURE/);
 assert.equal((await f.service.inspect(f.actor,'BUY',o.id)).transfer,null);
 const q=await f.stocks.quote(f.actor,'NVDA','1').catch(()=>null);assert.equal(q,null);
 f.repo.audit=audit;const quote=await f.stocks.quote(f.actor,'NVDA','1');f.repo.audit=async()=>{throw new Error('TEST_AUDIT_FAILURE')};
 await assert.rejects(f.stocks.createOrder(f.actor,quote.id,`rollback:${randomUUID()}`),/TEST_AUDIT_FAILURE/);
 assert.equal((await f.pool.query('SELECT * FROM arco_evm."StocksOrder" WHERE "quoteId"=$1',[quote.id])).rowCount,0);
 assert.equal((await f.pool.query('SELECT * FROM arco_evm."StocksWalletSubmissionEnrollment" WHERE "actorId"=$1',[f.actor.actorId])).rowCount,1);
 f.repo.audit=audit;assert.ok(await f.service.claim(f.actor,f.request(o)));
});

test('real PG: pause/expiry reject first claim but preserve inspect and outcome recovery',options,async t=>{
 const f=await fixture();t.after(()=>f.pool.end());
 // Synthetic short-lived quote is inserted once; production immutable facts remain untouched.
 const shortQuote=async()=>{
  const source=await f.stocks.quote(f.actor,'NVDA','1');const id=randomUUID();
  await f.pool.query('INSERT INTO arco_evm."StocksQuote" (id,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest","expiresAt") SELECT $2,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest",clock_timestamp()+interval \'500 milliseconds\' FROM arco_evm."StocksQuote" WHERE id=$1',[source.id,id]);
  return id;
 };
 const recoverQuoteId=await shortQuote();
 const o=await f.stocks.createOrder(f.actor,recoverQuoteId,`recover:${randomUUID()}`);f.pause(true);
 await assert.rejects(f.service.claim(f.actor,f.request(o)),/STOCKS_PAUSED/);f.pause(false);
 const c=(await f.service.claim(f.actor,f.request(o)))!;
 await new Promise(resolve=>setTimeout(resolve,600));f.pause(true);
 assert.equal((await f.service.inspect(f.actor,'BUY',o.id)).transfer?.claimId,c.claimId);
 assert.equal((await f.service.record(f.actor,{...c,status:'UNKNOWN'})).status,'UNKNOWN');
 f.pause(false);const expired=await f.stocks.createOrder(f.actor,await shortQuote(),`expire:${randomUUID()}`);
 await new Promise(resolve=>setTimeout(resolve,600));
 await assert.rejects(f.service.claim(f.actor,f.request(expired)),/ORDER_EXPIRED/);
});

test('real PG: SELL enrollment and real plugin responses; auth precedes malformed JSON',options,async t=>{
 const f=await fixture();t.after(()=>f.pool.end());const o=await f.order('SELL');
 const app=Fastify();app.register(stocksSubmissionsPlugin,{service:f.service,resolveActor:async request=>request.headers.authorization==='Bearer fixture'?f.actor:null});t.after(()=>app.close());
 const denied=await app.inject({method:'POST',url:'/api/v1/stocks/wallet-submissions/claims',headers:{'content-type':'application/json'},payload:'{bad'});assert.equal(denied.statusCode,401);
 const won=await app.inject({method:'POST',url:'/api/v1/stocks/wallet-submissions/claims',headers:{authorization:'Bearer fixture'},payload:f.request(o,'SELL')});assert.equal(won.statusCode,200);assert.equal(won.json().data.status,'REQUEST_MAY_START');assert.equal(won.headers['cache-control'],'no-store');assert.equal(Object.keys(won.json()).length,7);
 const retried=await app.inject({method:'POST',url:'/api/v1/stocks/wallet-submissions/claims',headers:{authorization:'Bearer fixture'},payload:f.request(o,'SELL')});assert.equal(retried.json().data,null);
 const recovered=await app.inject({url:`/api/v1/stocks/wallet-submissions/SELL/${o.id}`,headers:{authorization:'Bearer fixture'}});assert.equal(recovered.json().data.transfer.claimId,won.json().data.claimId);
});
