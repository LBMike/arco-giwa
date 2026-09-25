import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeInitialLocalTrading, localReadinessFailureHint } from './local-readiness.mjs';
import { LOCAL_CUSTOMER_ADMIN, LOCAL_CUSTOMER_MANIFEST } from '../../server/dist/stocks-runtime/local-customer.js';

function fixture({ version=0, paused=true, observer='CURRENT' }={}) {
  let state={version,paused}, changes=[];
  const status={deploymentDigest:LOCAL_CUSTOMER_MANIFEST,configuredPause:false,autodispatch:true,runtimeState:'RUNNING',observerStatus:observer};
  const runtime={operators:[{wallet:LOCAL_CUSTOMER_ADMIN,operatorId:'local-admin',permissions:['stocks:control']}],
    tick:async()=>{},status:()=>status,control:{read:async()=>({...state}),isPaused:async()=>state.paused,
      change:async(op,command)=>{changes.push(command);state={paused:command.paused,version:1};}}};
  const reconcile=async()=>({status:'MATCHED_AT_CUTOFF',differences:[],cutoff:{deploymentDigest:LOCAL_CUSTOMER_MANIFEST}});
  return{runtime,changes,reconcile,status};
}
test('an unreviewed deployment digest cannot tick, reconcile or resume local trading',async()=>{
  const f=fixture();f.runtime.tick=async()=>assert.fail('unreviewed must not tick');
  await assert.rejects(resumeInitialLocalTrading(f.runtime,{reviewedManifestDigest:'f'.repeat(64),reconcile:async()=>assert.fail('unreviewed must not reconcile')}),/LOCAL_RUNTIME_CONFIGURATION_INVALID/);
  assert.equal(f.changes.length,0);
});
test('first resume uses stable idempotent version-zero command; restart never overrides a later pause',async()=>{
  const a=fixture();await resumeInitialLocalTrading(a.runtime,{reconcile:a.reconcile});
  assert.equal(a.changes.length,1);assert.equal(a.changes[0].expectedVersion,0);
  await resumeInitialLocalTrading(a.runtime,{reconcile:a.reconcile});assert.equal(a.changes.length,1);
  const b=fixture({version:2,paused:true});await assert.rejects(resumeInitialLocalTrading(b.runtime,{reconcile:b.reconcile}),/EXISTING_OPERATOR_PAUSE/);assert.equal(b.changes.length,0);
});
test('mismatch, stale observation, wrong deployment and cancellation never resume',async()=>{
  for(const failure of ['mismatch','stale','foreign','cancel']){
    const f=fixture();const abort=new AbortController();
    const reconcile=async()=>{const r=await f.reconcile();if(failure==='mismatch')r.differences=[{}];if(failure==='foreign')r.cutoff.deploymentDigest='f'.repeat(64);if(failure==='stale')f.status.observerStatus='STALE';if(failure==='cancel')abort.abort();return r;};
    await assert.rejects(resumeInitialLocalTrading(f.runtime,{reconcile,signal:abort.signal}),/NOT_READY/);assert.equal(f.changes.length,0);
  }
});
test('cancellation while final operator state is loading prevents its mutation',async()=>{
  const f=fixture(),abort=new AbortController();let reads=0;
  const original=f.runtime.control.read;
  f.runtime.control.read=async()=>{const state=await original();if(++reads===2)abort.abort();return state;};
  await assert.rejects(resumeInitialLocalTrading(f.runtime,{reconcile:f.reconcile,signal:abort.signal}),/NOT_READY/);
  assert.equal(f.changes.length,0);
});
test('observation expiring during the final state read never resumes',async()=>{
  const f=fixture();let reads=0;const original=f.runtime.control.read;
  f.runtime.control.read=async()=>{const state=await original();if(++reads===2)f.status.observerStatus='STALE';return state;};
  await assert.rejects(resumeInitialLocalTrading(f.runtime,{reconcile:f.reconcile}),/NOT_READY/);
  assert.equal(f.changes.length,0);
});

test('a failed catch-up tick recovers with delay before reconciliation or resume',async()=>{
  const f=fixture(),states=['CATCHING_UP','UNAVAILABLE_OR_REVIEW_REQUIRED','BUSY','CURRENT'];
  const delays=[],messages=[];let ticks=0,reconciled=0;
  f.runtime.tick=async()=>{ticks++;f.status.observerStatus=states.shift();assert.equal(f.changes.length,0);};
  await resumeInitialLocalTrading(f.runtime,{sleep:async ms=>{delays.push(ms);assert.equal(reconciled,0);assert.equal(f.changes.length,0);},
    report:message=>messages.push(message),reconcile:async()=>{reconciled++;assert.equal(f.status.observerStatus,'CURRENT');return f.reconcile();}});
  assert.equal(ticks,4);assert.deepEqual(delays,[2000,5000]);assert.equal(reconciled,1);assert.equal(f.changes.length,1);
  assert.ok(messages.some(message=>message.includes('잔액과 기록을 대조')));
});

test('persistent observer failure stops after three delayed retries without reconciliation or resume',async()=>{
  for(const observer of ['UNAVAILABLE_OR_REVIEW_REQUIRED','BUSY']){
    const f=fixture({observer}),delays=[];let ticks=0;
    f.runtime.tick=async()=>{ticks++;};
    await assert.rejects(resumeInitialLocalTrading(f.runtime,{sleep:async ms=>delays.push(ms),reconcile:async()=>assert.fail('must not reconcile')}),/LOCAL_OBSERVER_RETRY_EXHAUSTED/);
    assert.deepEqual(delays,[2000,5000,10000]);assert.equal(ticks,4);assert.equal(f.changes.length,0);
  }
});

test('cancellation during observer backoff and a later operator pause prevent resume',async()=>{
  const f=fixture({observer:'UNAVAILABLE_OR_REVIEW_REQUIRED'}),abort=new AbortController();let ticks=0;
  f.runtime.tick=async()=>{ticks++;};
  await assert.rejects(resumeInitialLocalTrading(f.runtime,{signal:abort.signal,sleep:async()=>abort.abort(),reconcile:async()=>assert.fail('must not reconcile')}),/NOT_READY/);
  assert.equal(ticks,1);assert.equal(f.changes.length,0);
  const p=fixture({observer:'UNAVAILABLE_OR_REVIEW_REQUIRED'});let pTicks=0;
  p.runtime.tick=async()=>{if(++pTicks===2)p.status.observerStatus='CURRENT';};
  await assert.rejects(resumeInitialLocalTrading(p.runtime,{sleep:async()=>{p.runtime.control.read=async()=>({paused:true,version:2});},reconcile:p.reconcile}),/LOCAL_EXISTING_OPERATOR_PAUSE/);
  assert.equal(p.changes.length,0);
});

test('retry never bypasses configuration, projection, stale coverage or balance mismatch gates',async()=>{
  for(const failure of ['digest','configuredPause','autodispatch','runtimeState','WAITING_PROJECTION','STALE','MISMATCH']){
    const f=fixture({observer:'UNAVAILABLE_OR_REVIEW_REQUIRED'});let ticks=0;
    f.runtime.tick=async()=>{if(++ticks===2){f.status.observerStatus='CURRENT';
      if(failure==='digest')f.status.deploymentDigest='f'.repeat(64);
      if(failure==='configuredPause')f.status.configuredPause=true;
      if(failure==='autodispatch')f.status.autodispatch=false;
      if(failure==='runtimeState')f.status.runtimeState='STOPPED';
      if(['WAITING_PROJECTION','STALE'].includes(failure))f.status.observerStatus=failure;
    }};
    await assert.rejects(resumeInitialLocalTrading(f.runtime,{sleep:async()=>{},reconcile:async()=>({status:'MISMATCH',differences:[{}]})}));
    assert.equal(f.changes.length,0);assert.equal(ticks,2);
  }
});

test('readiness diagnostics expose only fixed categories and never arbitrary errors',()=>{
  const secret='postgresql://sensitive-user:fake-password@example.invalid/postgres';
  for(const error of [Error(secret),new TypeError(secret),{message:secret},Error('toString'),null]){
    const hint=localReadinessFailureHint(error);
    assert.ok(hint.startsWith('[LOCAL_READINESS_UNAVAILABLE]'));assert.ok(!hint.includes(secret));
  }
  assert.ok(localReadinessFailureHint(Error('LOCAL_OBSERVER_RETRY_EXHAUSTED')).startsWith('[LOCAL_OBSERVER_RETRY_EXHAUSTED]'));
  assert.ok(localReadinessFailureHint(Error('LOCAL_RECONCILIATION_MISMATCH')).includes('일치하지'));
});

test('cancellation or stale observation during the last pause read cannot report success',async()=>{
  for(const failure of ['cancel','stale']){
    const f=fixture({version:1,paused:false}),abort=new AbortController(),messages=[];
    f.runtime.control.isPaused=async()=>{if(failure==='cancel')abort.abort();else f.status.observerStatus='STALE';return false;};
    await assert.rejects(resumeInitialLocalTrading(f.runtime,{signal:abort.signal,reconcile:f.reconcile,report:m=>messages.push(m)}),/LOCAL_TRADING_NOT_READY/);
    assert.ok(!messages.some(m=>m.includes('거래를 시작할 수')));assert.equal(f.changes.length,0);
  }
});
