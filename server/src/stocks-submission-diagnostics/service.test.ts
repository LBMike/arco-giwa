import assert from 'node:assert/strict';
import test from 'node:test';
import { operationKey, manifestDigest, type SqlClient, type SqlPool } from '../stocks/contracts.js';
import { testManifest, ACTOR, h } from '../stocks/test-fixtures.js';
import { deriveOrder, digest, type Side } from '../stocks-submissions/contracts.js';
import { orderBinding } from '../stocks-submissions/enrollment.js';
import type { StocksService } from '../stocks/service.js';
import { StocksSubmissionDiagnosticsService } from './service.js';
import { publicSnapshot } from './public.js';

function fixture(side:Side='BUY') {
  const manifest=testManifest(),deploymentDigest=manifestDigest(manifest),at=new Date('2026-09-17T00:00:00.000Z');
  const order:any={id:'diagnostic-order',orderKey:operationKey(`${side==='SELL'?'sell:':''}${manifest.networkInstance}:diagnostic-order`),quoteId:'diagnostic-quote',actorId:ACTOR.actorId,wallet:ACTOR.wallet,symbol:'NVDA',quantity:'1000000000',cashAmount:'120000000',deploymentId:manifest.deploymentId,deploymentDigest,quoteExpiresAt:new Date(at.getTime()-1000),observedAt:at,state:side==='BUY'?'AWAITING_FUNDING':'AWAITING_ESCROW',version:0};
  const plan=deriveOrder(manifest,order,side);
  const enrollment:any[]=[{side,orderId:order.id,intentKey:plan.intentKey,actorId:order.actorId,wallet:order.wallet,deploymentDigest,orderBinding:orderBinding(order,side)}];
  const rows:any[]=[{claimId:'diagnostic-claim',intentKey:plan.intentKey,stage:'APPROVAL',transactionDigest:digest(plan.approval),transaction:plan.approval,actorId:order.actorId,wallet:order.wallet,side,orderId:order.id,deploymentDigest,status:'UNKNOWN',txHash:null,createdAt:new Date(at.getTime()-3000),updatedAt:new Date(at.getTime()-2000)}];
  const proofs:any[]=[],queries:string[]=[];let releases=0,absent=false,connectHook=async()=>{},queryHook=async(_sql:string)=>{};
  const db:SqlClient={release:()=>{releases++;},query:async(sql)=>{
    queries.push(sql);await queryHook(sql);
    const data=sql.includes('"StocksWalletSubmissionEnrollment"')?enrollment:sql.includes('"StocksWalletSubmissionProof"')?proofs:sql.includes('"StocksWalletSubmission"')?rows:sql.includes(`"${side==='BUY'?'StocksOrder':'StocksSellOrder'}"`)?absent?[]:[order]:[];
    return {rows:data,rowCount:data.length};
  }};
  const stocks={manifest,digest:deploymentDigest,repo:{pool:{connect:async()=>{await connectHook();return db;},query:async()=>{throw new Error('OUTSIDE_TRANSACTION_FORBIDDEN');}} as SqlPool}} as StocksService;
  const service=new StocksSubmissionDiagnosticsService(stocks);
  const confirm=()=>{
    rows[0].status='CONFIRMED';rows[0].txHash=h(900);
    const evidence={version:1,claimId:rows[0].claimId,intentKey:plan.intentKey,transactionDigest:rows[0].transactionDigest,deploymentDigest,txHash:h(900),status:'CONFIRMED',blockNumber:'10',blockHash:h(10)};
    proofs.push({...evidence,proofDigest:digest(evidence),evidence,createdAt:new Date(at.getTime()-2500)});
  };
  return {service,order,enrollment,rows,proofs,plan,queries,confirm,releases:()=>releases,setAbsent:()=>{absent=true;},connectHook:(fn:()=>Promise<void>)=>{connectHook=fn;},queryHook:(fn:(sql:string)=>Promise<void>)=>{queryHook=fn;}};
}

for(const side of ['BUY','SELL'] as const)test(`${side} diagnostics return expired immutable facts and public fields only`,async()=>{
  const f=fixture(side);f.confirm();f.order.secret='ORDER_SECRET';f.rows[0].secret='ROW_SECRET';f.proofs[0].secret='PROOF_SECRET';
  const value=await f.service.inspect(side,f.order.id);
  assert.equal(value.data.order.quoteExpired,true);assert.equal(value.data.approval?.receipt?.status,'CONFIRMED');assert.equal(value.data.order.state,side==='BUY'?'AWAITING_FUNDING':'AWAITING_ESCROW');
  assert.equal(value.data.readOnly,true);assert.equal(value.data.executionAuthorization,false);assert.equal(value.data.resubmissionAllowed,false);
  assert.doesNotMatch(JSON.stringify(value),/SECRET|actorId|"transaction"|"evidence"|proofDigest/);
  assert.match(f.queries[0],/REPEATABLE READ READ ONLY/);assert.ok(f.queries.every(sql=>!/INSERT|UPDATE|DELETE|FOR SHARE|advisory/.test(sql)));assert.equal(f.releases(),1);
});
test('historical unenrolled order is readable without creating permission or rows',async()=>{
  const f=fixture();f.enrollment.length=0;f.rows.length=0;
  const d=(await f.service.inspect('BUY',f.order.id)).data;
  assert.equal(d.enrollment,'NOT_ENROLLED');assert.equal(d.approval,null);assert.equal(d.transfer,null);assert.equal(d.resubmissionAllowed,false);
});
test('absent order has sanitized 404 and stops before related record queries',async()=>{
  const f=fixture();f.setAbsent();await assert.rejects(f.service.inspect('BUY',f.order.id),{code:'ORDER_NOT_FOUND',status:404});
  assert.ok(!f.queries.some(q=>q.includes('StocksWallet')));assert.equal(f.queries[f.queries.length-1],'ROLLBACK');assert.equal(f.releases(),1);
});
const corruptions:[string,(f:ReturnType<typeof fixture>)=>void][]=[
  ['same-order wrong intent',f=>{f.rows[0].intentKey='f'.repeat(64);} ],
  ['physical intent wrong owner',f=>{f.rows[0].actorId='other';}],
  ['physical intent wrong wallet',f=>{f.rows[0].wallet='0x'+'1'.repeat(40);}],
  ['physical intent wrong deployment',f=>{f.rows[0].deploymentDigest='f'.repeat(64);}],
  ['physical intent wrong side',f=>{f.rows[0].side='SELL';}],
  ['transaction differs',f=>{f.rows[0].transaction={...f.rows[0].transaction,value:'1'};}],
  ['transaction digest differs',f=>{f.rows[0].transactionDigest='f'.repeat(64);}],
  ['enrollment differs',f=>{f.enrollment[0].orderBinding='f'.repeat(64);}],
  ['physical enrollment alias',f=>{f.enrollment.push({...f.enrollment[0],orderId:'other'});}],
  ['claim without enrollment',f=>{f.enrollment.length=0;}],
  ['duplicate stage',f=>{f.rows.push({...f.rows[0],claimId:'another'});}],
  ['third submission row',f=>{f.rows.push({...f.rows[0]},{...f.rows[0]});}],
  ['missing terminal proof',f=>{f.confirm();f.proofs.length=0;}],
  ['proof for nonterminal row',f=>{f.confirm();f.rows[0].status='SUBMITTED';}],
  ['proof wrong hash',f=>{f.confirm();f.proofs[0].txHash=h(901);}],
  ['proof wrong digest',f=>{f.confirm();f.proofs[0].proofDigest='f'.repeat(64);}],
  ['proof contradictory evidence',f=>{f.confirm();f.proofs[0].evidence.status='REVERTED';f.proofs[0].proofDigest=digest(f.proofs[0].evidence);}],
  ['oversized or missing evidence',f=>{f.confirm();f.proofs[0].evidence=null;}],
  ['unknown extra proof',f=>{f.confirm();f.proofs[0].claimId='other';}],
];
for(const [name,change] of corruptions)test(`conflicting persisted ${name} fails closed without returning data`,async()=>{
  const f=fixture();change(f);await assert.rejects(f.service.inspect('BUY',f.order.id),{code:'SUBMISSION_DIAGNOSTICS_UNAVAILABLE',status:503});assert.equal(f.releases(),1);
});
test('related identity queries search both physical intent and order, instead of hiding conflicts',async()=>{
  const f=fixture();await f.service.inspect('BUY',f.order.id);
  for(const table of ['StocksWalletSubmissionEnrollment','StocksWalletSubmission'])assert.match(f.queries.find(q=>q.includes(`"${table}"`))!,/"intentKey"=\$1 OR \(side=\$2 AND "orderId"=\$3\)/);
});
test('bad parameters cannot acquire a database connection',async()=>{
  const f=fixture();await assert.rejects(f.service.inspect('BAD' as Side,'order'));await assert.rejects(f.service.inspect('BUY',"id' OR 1=1"));assert.equal(f.queries.length,0);assert.equal(f.releases(),0);
});
test('database/provider exceptions are replaced with a fixed unavailable error',async()=>{
  const f=fixture();f.queryHook(async()=>{throw new Error('SECRET_DATABASE_URL');});await assert.rejects(f.service.inspect('BUY',f.order.id),{message:'SUBMISSION_DIAGNOSTICS_UNAVAILABLE',status:503});assert.equal(f.releases(),1);
});
test('monotonic budget checks late query even before timer callback and permits only rollback',async t=>{
  const f=fixture();let mono=0;t.mock.method(performance,'now',()=>mono);
  f.queryHook(async(sql)=>{if(sql.includes('"StocksOrder"'))mono=2501;});
  await assert.rejects(f.service.inspect('BUY',f.order.id),{code:'SUBMISSION_DIAGNOSTICS_UNAVAILABLE'});
  assert.equal(f.queries[f.queries.length-1],'ROLLBACK');assert.ok(!f.queries.some(q=>q.includes('StocksWallet')));assert.equal(f.releases(),1);
});
test('timeout of pending pool acquisition returns bounded error and releases eventual client without SQL',async t=>{
  const f=fixture();t.mock.timers.enable({apis:['setTimeout']});let release!:()=>void;
  f.connectHook(()=>new Promise<void>(resolve=>{release=resolve;}));
  const work=assert.rejects(f.service.inspect('BUY',f.order.id),{code:'SUBMISSION_DIAGNOSTICS_UNAVAILABLE'});
  t.mock.timers.tick(2501);await work;release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.queries.length,0);assert.equal(f.releases(),1);
});
test('public projection rejects malformed and contradictory snapshots and drops arbitrary metadata',async()=>{
  const f=fixture(),valid=await f.service.inspect('BUY',f.order.id);
  const injected:any=structuredClone(valid);injected.secret='SECRET';injected.data.secret='SECRET';injected.data.order.secret='SECRET';injected.data.approval.secret='SECRET';
  assert.deepEqual(publicSnapshot(injected),valid);
  for(const mutate of [(v:any)=>{v.data.executionAuthorization=true;},(v:any)=>{v.data.resubmissionAllowed=true;},(v:any)=>{v.data.order.quoteExpired=false;},(v:any)=>{v.data.order.side='BAD';},(v:any)=>{v.data.approval.txHash='malformed';},(v:any)=>{v.data.approval.updatedAt='2099-01-01T00:00:00.000Z';},(v:any)=>{v.data.enrollment='NOT_ENROLLED';}]){
    const bad=structuredClone(valid);mutate(bad);assert.throws(()=>publicSnapshot(bad),{code:'SUBMISSION_DIAGNOSTICS_UNAVAILABLE'});
  }
});
