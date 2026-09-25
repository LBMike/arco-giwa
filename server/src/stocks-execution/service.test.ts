import assert from 'node:assert/strict';
import test from 'node:test';
import {manifestDigest,operationKey,type SqlPool} from '../stocks/contracts.js';
import {ACTOR,testManifest,TestChain} from '../stocks/test-fixtures.js';
import {StocksRepository} from '../stocks/repository.js';
import {StocksService} from '../stocks/service.js';
import {ReceiptVerifier} from '../stocks/chain.js';
import {deriveOrder} from '../stocks-submissions/contracts.js';
import {orderBinding} from '../stocks-submissions/enrollment.js';
import {EXECUTION_DB_BUDGET_MS,StocksExecutionService} from './service.js';
import type {ReviewedDeployment} from './contracts.js';
function setup(){
 const m=testManifest(),digest=manifestDigest(m),queries:string[]=[];let now=1000000,mono=0,remaining=60000,paused=false,proofCalls=0,queryHook:(sql:string)=>Promise<void>=async()=>{};
 const row={id:'test-order',actorId:ACTOR.actorId,wallet:ACTOR.wallet,symbol:'NVDA',quantity:'1000000000',cashAmount:'120000000',deploymentId:m.deploymentId,deploymentDigest:digest,quoteExpiresAt:new Date(now+60000),orderKey:operationKey(`${m.networkInstance}:test-order`),state:'AWAITING_FUNDING'};
 const enrollment={side:'BUY',orderId:row.id,intentKey:deriveOrder(m,row,'BUY').intentKey,actorId:ACTOR.actorId,wallet:ACTOR.wallet,deploymentDigest:digest,orderBinding:orderBinding(row,'BUY')};
 const pool={connect:async()=>({release:()=>{},query:async(sql:string,params?:unknown[])=>{queries.push(sql);await queryHook(sql);let rows:unknown[]=[];
  if(sql.includes('"StocksOrder"'))rows=params?.[1]===row.actorId&&params?.[2]===row.wallet&&params?.[3]===row.deploymentDigest?[row]:[];
  else if(sql.includes('"StocksLiquidityBinding"'))rows=[{deploymentDigest:digest}];else if(sql.includes('"StocksWalletSubmissionEnrollment"'))rows=[enrollment];else if(sql.includes('remainingMs'))rows=[{remainingMs:remaining}];return {rows,rowCount:rows.length};}})} as unknown as SqlPool;
 const stocks=new StocksService(new StocksRepository(pool,digest),m,new ReceiptVerifier(m,new TestChain(m)),{manifestDigest:digest,contractPolicyVerified:true},async()=>paused);
 let evidence:ReviewedDeployment={status:'VERIFIED',evidenceId:'fixture-proof',manifestDigest:digest,manifest:m,verifiedAt:now,validUntil:now+15000};let proofHook=async()=>{};
 const service=new StocksExecutionService(stocks,{get:async()=>{proofCalls++;await proofHook();return evidence;}},{wallNow:()=>now,monotonicNow:()=>mono});
 return {service,queries,row,enrollment,stocks,proofCalls:()=>proofCalls,setRemaining:(v:number)=>{remaining=v},pause:()=>{paused=true},advance:(v:number)=>{now+=v;mono+=v},setMono:(v:number)=>{mono=v},setWall:(v:number)=>{now=v},setEvidence:(v:Partial<ReviewedDeployment>)=>{evidence={...evidence,...v}},setProofHook:(h:()=>Promise<void>)=>{proofHook=h},setQueryHook:(h:(sql:string)=>Promise<void>)=>{queryHook=h}};
}
test('policy is read-only, start-anchored and capped by DB deadline after evidence wait',async()=>{
 const f=setup();f.setRemaining(5000);f.setProofHook(async()=>{f.advance(2000)});
 const p=await f.service.policy(ACTOR,'BUY','test-order');assert.equal(p.observedAt,1000000);assert.equal(p.validUntil,1005000);assert.equal(p.allowed,true);assert.equal(f.proofCalls(),1);
 assert.ok(f.queries.filter(q=>q.startsWith('BEGIN')).every(q=>q.endsWith('READ ONLY')));assert.ok(f.queries.every(q=>!/INSERT|UPDATE|DELETE|FOR SHARE/.test(q)));assert.ok(!f.queries.some(q=>q.includes('"StocksWalletSubmission"')));
});
test('wrong owner fails before evidence work and historical enrollment mismatch fails closed',async()=>{
 const f=setup();await assert.rejects(f.service.policy({...ACTOR,actorId:'other'},'BUY','test-order'),/ORDER_NOT_FOUND/);assert.equal(f.proofCalls(),0);
 f.enrollment.orderBinding='f'.repeat(64);await assert.rejects(f.service.policy(ACTOR,'BUY','test-order'),/SUBMISSION_NOT_ENROLLED/);assert.equal(f.proofCalls(),0);
});
for(const kind of ['expired-proof','future-proof','extended-proof','digest','manifest','pause','event-loop','db-expiry'] as const)test(`policy denies ${kind} after awaited work`,async()=>{
 const f=setup();f.setProofHook(async()=>{
  if(kind==='expired-proof')f.advance(15001);if(kind==='future-proof')f.setEvidence({verifiedAt:1000001});if(kind==='extended-proof')f.setEvidence({validUntil:1015001});if(kind==='digest')f.setEvidence({manifestDigest:'f'.repeat(64)});if(kind==='manifest')f.setEvidence({manifest:{...testManifest(),deploymentId:'other-deployment'}});if(kind==='pause')f.pause();if(kind==='event-loop')f.setMono(15001);if(kind==='db-expiry')f.setRemaining(0);
 });await assert.rejects(f.service.policy(ACTOR,'BUY','test-order'));
});
test('pause change after final DB await is rechecked; raw DB exceptions are sanitized',async()=>{
 const f=setup();let clocks=0;f.setQueryHook(async sql=>{if(sql.includes('remainingMs')&&++clocks===2)f.pause()});await assert.rejects(f.service.policy(ACTOR,'BUY','test-order'),/STOCKS_PAUSED/);
 const g=setup();g.setQueryHook(async()=>{throw new Error('SECRET_SQL_TOKEN')});await assert.rejects(g.service.policy(ACTOR,'BUY','test-order'),error=>String(error)==='Error: EXECUTION_UNAVAILABLE');
});
test('deployment returns public evidence without renewal even when trading is paused',async()=>{
 const f=setup();f.setProofHook(async()=>f.advance(2000));const result=await f.service.deployment(ACTOR);assert.equal(result.verifiedAt,1000000);assert.equal(result.validUntil,1015000);assert.equal(f.queries.length,0);
 f.pause();assert.equal((await f.service.deployment(ACTOR)).status,'VERIFIED');
});

test('independent clocks never extend the lease and do not require exact alignment',async()=>{
 const f=setup();f.setProofHook(async()=>{f.advance(1000);f.setWall(1000990)});const policy=await f.service.policy(ACTOR,'BUY','test-order');assert.equal(policy.validUntil,1014990);
 const g=setup();g.setProofHook(async()=>g.setWall(1015001));await assert.rejects(g.service.policy(ACTOR,'BUY','test-order'),/EXECUTION_POLICY_EXPIRED/);
});

for(const point of ['first SELECT','COMMIT'] as const)test(`DB phase rejects a delayed timer at ${point} and schedules cleanup only`,async()=>{
 const f=setup();let stalled=false,after:string[]=[];
 f.setQueryHook(async sql=>{
  if(stalled)after.push(sql);
  if(!stalled&&((point==='first SELECT'&&sql.startsWith('SELECT'))||sql===point)){stalled=true;f.advance(EXECUTION_DB_BUDGET_MS)}
 });
 await assert.rejects(f.service.policy(ACTOR,'BUY','test-order'),/EXECUTION_DATABASE_TIMEOUT/);
 assert.equal(f.proofCalls(),0);assert.deepEqual(after,['ROLLBACK']);
});
test('DB phase releases a late acquired client before any SQL and rejects a backward clock',async()=>{
 const f=setup(),connect=f.stocks.repo.pool.connect.bind(f.stocks.repo.pool);let released=0;
 f.stocks.repo.pool.connect=async()=>{const client=await connect();f.advance(EXECUTION_DB_BUDGET_MS);return {...client,release:()=>{released++;client.release()}}};
 await assert.rejects(f.service.policy(ACTOR,'BUY','test-order'),/EXECUTION_DATABASE_TIMEOUT/);assert.equal(released,1);assert.deepEqual(f.queries,[]);assert.equal(f.proofCalls(),0);
 const g=setup();g.setQueryHook(async sql=>{if(sql.startsWith('SELECT'))g.setMono(-1)});
 await assert.rejects(g.service.policy(ACTOR,'BUY','test-order'),/EXECUTION_DATABASE_TIMEOUT/);assert.equal(g.proofCalls(),0);
});
test('each read phase has its own monotonic budget while policy retains original lease',async()=>{
 const f=setup();let phases=0;f.setQueryHook(async sql=>{if(sql.includes('remainingMs')){phases++;f.advance(2000)}});f.setProofHook(async()=>f.advance(2000));
 const result=await f.service.policy(ACTOR,'BUY','test-order');assert.equal(phases,2);assert.equal(result.observedAt,1000000);assert.equal(result.validUntil,1015000);
});
