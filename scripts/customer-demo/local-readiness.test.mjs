import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeInitialLocalTrading } from './local-readiness.mjs';
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
