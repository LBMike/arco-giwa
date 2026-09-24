import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {enabled,fixture} from '../stocks-submissions/test-fixtures.js';
import {enrollWalletSubmission} from '../stocks-submissions/enrollment.js';
import {StocksExecutionService} from './service.js';
import {StocksService} from '../stocks/service.js';
import {StocksRepository} from '../stocks/repository.js';
import {ReceiptVerifier} from '../stocks/chain.js';
import {TestChain,a} from '../stocks/test-fixtures.js';
import {manifestDigest,operationKey} from '../stocks/contracts.js';
const options={skip:!enabled};
const evidence=(stocks:StocksService)=>{const now=Date.now();return {status:'VERIFIED' as const,evidenceId:'fixture-evidence',manifestDigest:stocks.digest,manifest:stocks.manifest,verifiedAt:now,validUntil:now+15000}};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function shortOrder(f:Awaited<ReturnType<typeof fixture>>,ttl=700){
 const source=await f.stocks.quote(f.actor,'NVDA','1'),id=randomUUID();
 await f.pool.query('INSERT INTO arco_evm."StocksQuote" (id,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest","expiresAt") SELECT $2,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest",clock_timestamp()+($3::text||\' milliseconds\')::interval FROM arco_evm."StocksQuote" WHERE id=$1',[source.id,id,ttl]);
 return f.stocks.createOrder(f.actor,id,`execution:${randomUUID()}`);
}
for(const side of ['BUY','SELL'] as const)test(`real PG ${side} execution is read-only and preserves recovery despite existing journal`,options,async t=>{
 const f=await fixture();t.after(()=>f.pool.end());const order=await f.order(side);await f.service.claim(f.actor,f.request(order,side,'APPROVAL'));
 let proofCalls=0;
 const connect=f.pool.connect.bind(f.pool),queries:string[]=[];const connectReadOnly=async()=>{const db=await connect(),query=db.query.bind(db);return {release:()=>db.release(),query:async(sql:string,params?:unknown[])=>{queries.push(sql);const result=await query(sql,params);if(sql.startsWith('BEGIN'))assert.equal((await query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');return result;}}};
 const monitored=new StocksService(new StocksRepository({connect:connectReadOnly,query:f.pool.query.bind(f.pool)},f.stocks.digest),f.manifest,f.stocks.verifier,{manifestDigest:f.stocks.digest,contractPolicyVerified:true},f.stocks.paused);
 const service=new StocksExecutionService(monitored,{get:async()=>{proofCalls++;return evidence(f.stocks)}});
 const before=(await f.pool.query('SELECT (SELECT count(*) FROM arco_evm."StocksAudit") AS audit,(SELECT count(*) FROM arco_evm."StocksWalletSubmission") AS claims')).rows[0];
 const policy=await service.policy(f.actor,side,order.id);assert.equal(policy.allowed,true);assert.ok(policy.validUntil<=policy.observedAt+15000);
 await assert.rejects(service.policy({...f.actor,actorId:'wrong'},side,order.id),/ORDER_NOT_FOUND/);
 await assert.rejects(service.policy({...f.actor,wallet:a(999)},side,order.id),/ORDER_NOT_FOUND/);assert.equal(proofCalls,1);
 assert.deepEqual((await f.pool.query('SELECT (SELECT count(*) FROM arco_evm."StocksAudit") AS audit,(SELECT count(*) FROM arco_evm."StocksWalletSubmission") AS claims')).rows[0],before);
 assert.ok(queries.every(q=>!/INSERT|UPDATE|DELETE|FOR SHARE/.test(q)));
});
test('real PG policy rejects historical enrollment absence and unbound/wrong physical deployment',options,async t=>{
 const f=await fixture();t.after(()=>f.pool.end());
 const insert=async(stocks:StocksService,enroll:boolean)=>{const q=await f.stocks.quote(f.actor,'NVDA','1');return f.repo.tx(async db=>{
  const id=randomUUID(),row=(await db.query('INSERT INTO arco_evm."StocksOrder" (id,"orderKey","quoteId","actorId",wallet,symbol,quantity,"cashAmount","idempotencyKey","deploymentId","deploymentDigest","quoteExpiresAt") VALUES($1,$2,$3,$4,$5,\'NVDA\',$6,$7,$8,$9,$10,$11) RETURNING *',[id,operationKey(`${stocks.manifest.networkInstance}:${id}`),q.id,f.actor.actorId,f.actor.wallet,q.quantity,q.cashAmount,`fixture:${id}`,stocks.manifest.deploymentId,stocks.digest,q.expiresAt])).rows[0];
  if(enroll)await enrollWalletSubmission(db,stocks.manifest,row,'BUY');return row;
 });};
 const historical=await insert(f.stocks,false);let calls=0;
 await assert.rejects(new StocksExecutionService(f.stocks,{get:async()=>{calls++;return evidence(f.stocks)}}).policy(f.actor,'BUY',historical.id),/SUBMISSION_NOT_ENROLLED/);assert.equal(calls,0);
 for(const missing of [true,false]){
  const manifest=structuredClone(f.manifest);manifest.deploymentId=`OTHER_${randomUUID()}`;
  if(missing){const old=manifest.fundingVault;manifest.fundingVault=a(Number.parseInt(randomUUID().replace(/-/g,'').slice(0,12),16));manifest.codeHashes[manifest.fundingVault]=manifest.codeHashes[old];delete manifest.codeHashes[old];}
  const digest=manifestDigest(manifest),stocks=new StocksService(new StocksRepository(f.pool,digest),manifest,new ReceiptVerifier(manifest,new TestChain(manifest)),{manifestDigest:digest,contractPolicyVerified:true},async()=>false),row=await insert(stocks,true);
  await assert.rejects(new StocksExecutionService(stocks,{get:async()=>{calls++;return evidence(stocks)}}).policy(f.actor,'BUY',row.id),/EXECUTION_PHYSICAL_BINDING_MISMATCH/);
 }assert.equal(calls,0);
});
test('real PG table lock wait expires order; post-proof pause is checked without any journal mutation',options,async t=>{
 const f=await fixture();t.after(()=>f.pool.end());const order=await shortOrder(f),db=await f.pool.connect();let proofCalls=0;
 try{
  await db.query('BEGIN');await db.query('LOCK TABLE arco_evm."StocksOrder" IN ACCESS EXCLUSIVE MODE');
  const service=new StocksExecutionService(f.stocks,{get:async()=>{proofCalls++;return evidence(f.stocks)}});
  const pending=assert.rejects(service.policy(f.actor,'BUY',order.id),/ORDER_EXPIRED/);
  await sleep(800);await db.query('COMMIT');await pending;assert.equal(proofCalls,0);
 }finally{await db.query('ROLLBACK');db.release()}
 const current=await f.order();const service=new StocksExecutionService(f.stocks,{get:async()=>{f.pause(true);return evidence(f.stocks)}});await assert.rejects(service.policy(f.actor,'BUY',current.id),/STOCKS_PAUSED/);
});
test('real PG final query waits past expiry and long table locks have bounded denial',options,async t=>{
 const f=await fixture();t.after(()=>f.pool.end());const order=await shortOrder(f),locker=await f.pool.connect();let started!:()=>void;const locked=new Promise<void>(r=>{started=r});let released=false;
 try{
  const service=new StocksExecutionService(f.stocks,{get:async()=>{await locker.query('BEGIN');await locker.query('LOCK TABLE arco_evm."StocksOrder" IN ACCESS EXCLUSIVE MODE');started();return evidence(f.stocks)}});
  const pending=assert.rejects(service.policy(f.actor,'BUY',order.id),/ORDER_EXPIRED/);await locked;await sleep(800);await locker.query('COMMIT');released=true;await pending;
  const valid=await f.order();await locker.query('BEGIN');await locker.query('LOCK TABLE arco_evm."StocksOrder" IN ACCESS EXCLUSIVE MODE');released=false;
  const start=performance.now();await assert.rejects(new StocksExecutionService(f.stocks,{get:async()=>evidence(f.stocks)}).policy(f.actor,'BUY',valid.id),/EXECUTION_UNAVAILABLE|EXECUTION_DATABASE_TIMEOUT/);assert.ok(performance.now()-start<3000);
 }finally{if(!released)await locker.query('ROLLBACK');locker.release()}
});
