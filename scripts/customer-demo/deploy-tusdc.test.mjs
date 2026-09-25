import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { TUSDC_DEPLOYMENT_PLAN,TUSDC_DEPLOYMENT_LIMITS,requireTusdcDeploymentInput,requirePriorHostsStopped,
  runTusdcDeploymentFlow,finalizeTusdcDeployment,tusdcDeploymentFailure,retryTusdcDeploymentReads } from './deploy-tusdc.mjs';

const prior='4327e1459e77c9a15b4b2b3e6d156a30ddd73b16dd4b45836969c23128390247';
const admin='0xfdcf58e2954988e5bf0446aaf1284a1069136f29';
const plan={kind:'ARCO_GIWA_STOCKS_EXTERNAL_CASH_UNSIGNED_DEPLOYMENT_V1',planDigest:TUSDC_DEPLOYMENT_PLAN,
  input:{deployer:admin,operator:admin,startingNonce:'232'},steps:Array.from({length:4},(_,i)=>({index:i,transaction:{nonce:`0x${(232+i).toString(16)}`}}))};
const approval={expectedPlanDigest:TUSDC_DEPLOYMENT_PLAN,genesisHash:'0x'+'1'.repeat(64),...TUSDC_DEPLOYMENT_LIMITS};
const started={schemaVersion:1,purpose:'GIWA_TUSDC_DEPLOYMENT_STARTED_025',planDigest:TUSDC_DEPLOYMENT_PLAN,
  priorManifestDigest:prior,priorInitialNonce:'232',firstCreateNonce:'232'};
const entry=i=>({planDigest:TUSDC_DEPLOYMENT_PLAN,index:i,transactionHash:'0x'+String(i+1).repeat(64)});
const result={confirmationPolicy:'L2_INCLUDED'};
const finalizedResult={manifest:{schemaVersion:3,deploymentId:'fixture-tusdc-deployment'}};
function fixture({marker=null,entries=[]}={}) {
  const calls=[],rows=[...entries], reports=[];
  let savedMarker=marker;
  const log=(name,value)=>async()=>{calls.push(name);return value;};
  const ports={stopped:log('stopped'),entries:async()=>[...rows],marker:async()=>savedMarker,
    unused:log('unused'),frozen:log('frozen'),pause:log('pause'),
    predeployment:log('predeployment',{priorInitialNonce:'232',firstCreateNonce:'232'}),
    inspect:async()=>{calls.push('inspect');return {next:rows.length===4?null:{index:rows.length},entries:[...rows]};},
    createMarker:async value=>{calls.push('marker');assert.equal(rows.length,0);savedMarker=structuredClone(value);},
    send:async()=>{calls.push(`send:${rows.length}`);assert.deepEqual(savedMarker,started);const value=entry(rows.length);rows.push(value);return value;},
    closeSigning:()=>calls.push('closeSigning'),saveIncluded:log('saveIncluded',result),
    verifyFinalized:log('verifyFinalized',finalizedResult),saveFinalized:log('saveFinalized')};
  const run=options=>runTusdcDeploymentFlow({plan,approval,ports,report:event=>reports.push(event),...options});
  return {ports,calls,rows,reports,run};
}

test('pins the exact four CREATE plan and all four fee ceilings before side effects',async()=>{
  requireTusdcDeploymentInput(plan,approval);
  for(const changed of [{...approval,maxGas:'5000001'},{...approval,maxFeePerGas:'1000000000'},
    {...approval,maxPriorityFeePerGas:'1000001'},{...approval,maxTotalFeeWei:'50000000000001'},
    {...approval,genesisHash:'0x'+'0'.repeat(64)},{...approval,extra:true}])assert.throws(()=>requireTusdcDeploymentInput(plan,changed),/NOT_REVIEWED/);
  const f=fixture();
  await assert.rejects(f.run({plan:{...plan,planDigest:'a'.repeat(64)}}),/NOT_REVIEWED/);
  assert.deepEqual(f.calls,[]);
});

test('requires stopped hosts, empty exposure, audited pause and durable marker before any signing',async()=>{
  const f=fixture();assert.deepEqual(await f.run(),result);
  for(const [a,b] of [['stopped','unused'],['unused','pause'],['pause','predeployment'],['predeployment','marker'],['marker','send:0'],['send:3','closeSigning'],['closeSigning','saveIncluded']])
    assert.ok(f.calls.indexOf(a)<f.calls.indexOf(b),`${a} before ${b}`);
  assert.deepEqual(f.calls.filter(c=>c.startsWith('send:')),['send:0','send:1','send:2','send:3']);
  assert.equal(f.calls.filter(c=>c==='pause').length,1);
});

test('any pre-pause exposure or input/nonce inspection failure prevents pause, marker and signing',async()=>{
  for(const method of ['stopped','unused','inspect']){
    const f=fixture();f.ports[method]=async()=>{throw Error('BLOCKED');};
    await assert.rejects(f.run(),/BLOCKED/);
    assert.ok(!f.calls.includes('pause')&&!f.calls.includes('marker')&&!f.calls.some(c=>c.startsWith('send:')));
  }
});

test('failed audited pause, strict paused gate or marker persistence cannot reach signing',async()=>{
  for(const method of ['pause','predeployment','createMarker']){
    const f=fixture();f.ports[method]=async()=>{throw Error('BLOCKED');};
    await assert.rejects(f.run(),/BLOCKED/);assert.ok(!f.calls.some(c=>c.startsWith('send:')));
  }
  const f=fixture();f.ports.predeployment=async()=>({priorInitialNonce:'231',firstCreateNonce:'232'});
  await assert.rejects(f.run(),/PRIOR_NONCE_CHANGED/);assert.ok(!f.calls.includes('marker'));
});

test('durable marker with no transaction requires fresh original nonce 232 without repausing',async()=>{
  const f=fixture({marker:started});await f.run();
  assert.equal(f.calls.includes('pause'),false);assert.equal(f.calls.includes('marker'),false);
  assert.ok(f.calls.indexOf('predeployment')<f.calls.indexOf('send:0'));
});

test('midway recovery retains the original hash across inclusion and both transport waits',async()=>{
 for(const code of ['LOCAL_DEPLOYMENT_ORIGINAL_NOT_INCLUDED','LOCAL_DEPLOYMENT_RPC_UNAVAILABLE','DEPLOYMENT_RPC_UNAVAILABLE']) {
  const f=fixture({marker:started,entries:[entry(0)]});let reads=0,time=0;
  const original=f.ports.inspect;
  f.ports.inspect=async()=>{if(reads++===0)throw Error(code);return original();};
  await f.run({now:()=>time,wait:async ms=>{assert.equal(ms,2000);time+=ms;}});
  assert.deepEqual(f.calls.filter(c=>c.startsWith('send:')),['send:1','send:2','send:3']);
  assert.equal(f.calls.includes('predeployment'),false);assert.equal(f.calls.includes('pause'),false);
  assert.equal(f.reports.find(e=>e.status==='WAITING_FOR_ORIGINAL').originalTransactionHash,entry(0).transactionHash);
 }
});

test('uncertain first broadcast inspects its durable original instead of signing or broadcasting it again',async()=>{
  const f=fixture();const send=f.ports.send;let first=true;
  f.ports.send=async()=>{const value=await send();if(first){first=false;throw Error('LOCAL_DEPLOYMENT_BROADCAST_UNCERTAIN_USE_RECOVER');}return value;};
  await f.run();assert.deepEqual(f.calls.filter(c=>c.startsWith('send:')),['send:0','send:1','send:2','send:3']);
  assert.equal(f.reports.filter(e=>e.status==='RECOVER_ORIGINAL').length,1);
});

test('missing/conflicting marker fails before resuming any existing intent',async()=>{
  const missing=fixture({entries:[entry(0)]});await assert.rejects(missing.run(),/MARKER_REQUIRED/);
  const conflict=fixture({marker:{...started,firstCreateNonce:'233'},entries:[entry(0)]});await assert.rejects(conflict.run(),/MARKER_CONFLICT/);
  assert.deepEqual(missing.calls,['stopped']);assert.deepEqual(conflict.calls,['stopped']);
});

test('unknown original times out after 10 minutes with no sign, send or journal reset',async()=>{
  const f=fixture({marker:started,entries:[entry(0)]});let time=0;
  f.ports.inspect=async()=>{throw Error('LOCAL_DEPLOYMENT_ORIGINAL_UNRESOLVED');};
  await assert.rejects(f.run({now:()=>time,wait:async()=>{time+=10*60*1000;}}),/INCLUSION_TIMEOUT/);
  assert.deepEqual(f.rows,[entry(0)]);assert.ok(!f.calls.includes('saveIncluded')&&!f.calls.some(c=>c.startsWith('send:')));
});

test('changed original proof or failed inclusion save never produces finalized artifacts',async()=>{
  for(const method of ['inspect','saveIncluded']){
    const f=fixture({marker:started,entries:[entry(0),entry(1),entry(2),entry(3)]});
    f.ports[method]=async()=>{throw Error('LOCAL_DEPLOYMENT_ORIGINAL_CHANGED');};
    await assert.rejects(f.run(),/ORIGINAL_CHANGED/);assert.equal(f.calls.includes('saveFinalized'),false);
  }
});

test('abort before any step or during original confirmation exits without a new signature',async()=>{
  const a=fixture(),before=new AbortController();before.abort();
  await assert.rejects(a.run({signal:before.signal}),/STOPPED/);assert.deepEqual(a.calls,[]);
  const b=fixture({marker:started,entries:[entry(0)]}),during=new AbortController();
  b.ports.inspect=async()=>{throw Error('LOCAL_DEPLOYMENT_ORIGINAL_UNRESOLVED');};
  await assert.rejects(b.run({signal:during.signal,wait:async()=>{during.abort();}}),/STOPPED/);
  assert.ok(!b.calls.some(c=>c.startsWith('send:')));
});

test('host checks accept only connection refused and fail closed on active or unknown ports',async()=>{
  const connection=event=>()=>{const socket=new EventEmitter();socket.destroy=()=>{};socket.setTimeout=(_ms,fn)=>{if(event==='timeout')queueMicrotask(fn);};
    queueMicrotask(()=>{if(event==='connect')socket.emit('connect');else if(event!=='timeout')socket.emit('error',{code:event});});return socket;};
  await requirePriorHostsStopped(connection('ECONNREFUSED'));
  await assert.rejects(requirePriorHostsStopped(connection('connect')),/STILL_RUNNING/);
  for(const event of ['timeout','EACCES','ENOTFOUND'])await assert.rejects(requirePriorHostsStopped(connection(event)),/STATE_UNKNOWN/);
});

test('public failure text explains old-host Ctrl+C and redacts arbitrary provider/DB/key strings',()=>{
  for(const error of [{code:'EADDRINUSE'},Error('TUSDC_PRIOR_HOST_STILL_RUNNING')])assert.match(tusdcDeploymentFailure(error),/Ctrl\+C/);
  assert.doesNotMatch(tusdcDeploymentFailure(Error('postgresql://private-secret@host')),/private-secret|postgresql/);
  assert.match(tusdcDeploymentFailure(Error('DEPLOYMENT_RPC_UNAVAILABLE')),/^DEPLOYMENT_RPC_UNAVAILABLE/);
  assert.match(tusdcDeploymentFailure(Error('DEPLOYMENT_RPC_RESPONSE_INVALID')),/^DEPLOYMENT_RPC_RESPONSE_INVALID/);
  assert.doesNotMatch(tusdcDeploymentFailure(Error('LOCAL_DEPLOYMENT_EXTERNAL_CASH_CHANGED')),/같은 명령/);
});

test('actual launcher rejects non-TTY and unknown arguments before loading credentials, databases or keystore',()=>{
  for(const args of [[],['--deploy'],['--deploy','INPUT_MUST_NOT_LEAK']]){
    const r=spawnSync(process.execPath,['scripts/customer-demo/deploy-tusdc.mjs',...args],{cwd:new URL('../../',import.meta.url),encoding:'utf8',timeout:10000,
      env:{PATH:process.env.PATH,HOME:process.env.HOME},input:'SENSITIVE_INPUT_MUST_NOT_LEAK\n'});
    assert.equal(r.status,1);assert.match(r.stderr,/TUSDC_USER_TTY_REQUIRED/);
    assert.doesNotMatch(r.stdout+r.stderr,/INPUT_MUST_NOT_LEAK|postgresql:|ENOTFOUND|keystore|비밀번호/);
  }
});


test('default deployment completes on L2 inclusion without requesting a finalized proof',async()=>{
  const f=fixture();
  f.ports.verifyFinalized=async()=>assert.fail('L1 must not block --deploy');
  f.ports.saveFinalized=async()=>assert.fail('included evidence cannot authorize activation');
  assert.deepEqual(await f.run(),{confirmationPolicy:'L2_INCLUDED'});
  assert.equal(f.reports.at(-1).status,'L2_INCLUDED');
  assert.deepEqual(f.reports.at(-1).transactionHashes,[0,1,2,3].map(i=>entry(i).transactionHash));
});

test('four previously included originals are checked without unlocking or signing again',async()=>{
  const f=fixture({marker:started,entries:[0,1,2,3].map(entry)});
  f.ports.send=async()=>assert.fail('no remaining CREATE');
  await f.run();
  assert.ok(f.calls.includes('closeSigning'));assert.ok(f.calls.includes('saveIncluded'));
  assert.ok(!f.calls.includes('predeployment')&&!f.calls.includes('pause'));
});

test('separate finalization never sends or unlocks and still requires full finalized verification',async()=>{
  const f=fixture({marker:started,entries:[0,1,2,3].map(entry)});
  f.ports.send=async()=>assert.fail('read-only verification');
  const run=()=>finalizeTusdcDeployment({plan,approval,ports:f.ports});
  assert.deepEqual(await run(),finalizedResult);
  assert.ok(f.calls.indexOf('verifyFinalized')<f.calls.indexOf('saveFinalized'));
  f.calls.length=0;
  f.ports.verifyFinalized=async()=>{throw Error('FINALIZED_EVIDENCE_REQUIRED');};
  await assert.rejects(run(),/FINALIZED_EVIDENCE_REQUIRED/);
  assert.ok(!f.calls.includes('saveFinalized'));
});

test('finalization refuses missing deployment marker and partial CREATE journal',async()=>{
  for(const f of [fixture({entries:[0,1,2,3].map(entry)}),fixture({marker:started,entries:[entry(0)]})]){
    await assert.rejects(finalizeTusdcDeployment({plan,approval,ports:f.ports}),/MARKER_REQUIRED|INCOMPLETE/);
    assert.ok(!f.calls.includes('verifyFinalized')&&!f.calls.includes('saveFinalized'));
  }
});

test('individual read recovery before and after signing preserves one signature and one broadcast',async()=>{
  const f=fixture({marker:started,entries:[0,1,2].map(entry)}),counts=new Map(),waits=[];
  const read=retryTusdcDeploymentReads(async method=>{
    const count=(counts.get(method)??0)+1;counts.set(method,count);
    if(count===1)throw Error(method==='eth_chainId'?'DEPLOYMENT_RPC_UNAVAILABLE':'LOCAL_DEPLOYMENT_RPC_UNAVAILABLE');
    return method==='eth_chainId'?'0x164ce':'0xeb';
  },{wait:async ms=>waits.push(ms)});
  let signatures=0,broadcasts=0;
  const send=f.ports.send;
  f.ports.send=async()=>{
    assert.equal(await read('eth_chainId',[]),'0x164ce');
    signatures++;
    assert.equal(await read('eth_getTransactionCount',[admin,'pending']),'0xeb');
    broadcasts++;
    return send();
  };
  await f.run();
  assert.equal(signatures,1);assert.equal(broadcasts,1);
  assert.deepEqual(waits,[2000,2000]);
  assert.deepEqual(f.calls.filter(c=>c.startsWith('send:')),['send:3']);
});

test('exhausted post-signing reads stop after three attempts without persisting or broadcasting',async()=>{
  for(const code of ['DEPLOYMENT_RPC_UNAVAILABLE','LOCAL_DEPLOYMENT_RPC_UNAVAILABLE']) {
    const f=fixture({marker:started,entries:[0,1,2].map(entry)}),waits=[];
    let signatures=0,reads=0,broadcasts=0;
    const read=retryTusdcDeploymentReads(async()=>{reads++;throw Error(code);},{wait:async ms=>waits.push(ms)});
    f.ports.send=async()=>{signatures++;await read('eth_getCode',[admin,'pending']);broadcasts++;};
    await assert.rejects(f.run(),new RegExp(code));
    assert.equal(signatures,1);assert.equal(reads,3);assert.equal(broadcasts,0);
    assert.deepEqual(waits,[2000,5000]);assert.deepEqual(f.rows,[0,1,2].map(entry));
  }
});

test('read retry rejects broadcasts and semantic failures without a retry',async()=>{
  let calls=0;
  const read=retryTusdcDeploymentReads(async()=>{calls++;},{wait:async()=>assert.fail('no retry')});
  for(const method of ['eth_sendRawTransaction','eth_sendTransaction','personal_sign','unknown'])
    await assert.rejects(read(method,[]),/TUSDC_RPC_READ_REQUIRED/);
  assert.equal(calls,0);
  for(const code of ['DEPLOYMENT_RPC_RESPONSE_INVALID','LOCAL_DEPLOYMENT_NONCE_CHANGED','LOCAL_DEPLOYMENT_RUNTIME_CHANGED']) {
    calls=0;
    const rejected=retryTusdcDeploymentReads(async()=>{calls++;throw Error(code);},{wait:async()=>assert.fail('no retry')});
    await assert.rejects(rejected('eth_chainId',[]),new RegExp(code));assert.equal(calls,1);
  }
});

test('read retries retain identical parameters despite mutations between attempts',async()=>{
  const params=[{to:admin,data:'0x1234'},'0x42'];let calls=0;
  const read=retryTusdcDeploymentReads(async(_method,input)=>{
    calls++;assert.deepEqual(input,[{to:admin,data:'0x1234'},'0x42']);
    if(calls===1){input[0].data='0xffff';params[1]='latest';throw Error('DEPLOYMENT_RPC_UNAVAILABLE');}
    return '0x01';
  },{wait:async()=>{}});
  assert.equal(await read('eth_call',params),'0x01');assert.equal(calls,2);
});

test('abort before a read, during backoff or before a result prevents further work',async()=>{
  const before=new AbortController();before.abort();
  await assert.rejects(retryTusdcDeploymentReads(async()=>assert.fail('no read'),{signal:before.signal})('eth_chainId',[]),/STOPPED/);
  const during=new AbortController();let calls=0;
  const read=retryTusdcDeploymentReads(async()=>{calls++;throw Error('DEPLOYMENT_RPC_UNAVAILABLE');},
    {signal:during.signal,wait:async()=>during.abort()});
  await assert.rejects(read('eth_chainId',[]),/STOPPED/);assert.equal(calls,1);
  const late=new AbortController();
  await assert.rejects(retryTusdcDeploymentReads(async()=>{late.abort();return '0x164ce';},{signal:late.signal})('eth_chainId',[]),/STOPPED/);
});

test('production read pacing serializes concurrent requests and spaces request starts',async()=>{
  let time=1000,active=0;const starts=[],waits=[];
  const read=retryTusdcDeploymentReads(async()=>{
    assert.equal(active++,0);starts.push(time);await Promise.resolve();time+=50;active--;return '0x164ce';
  },{minimumIntervalMs:500,now:()=>time,wait:async ms=>{waits.push(ms);time+=ms;}});
  await Promise.all([read('eth_chainId',[]),read('eth_chainId',[]),read('eth_chainId',[])]);
  assert.deepEqual(starts,[1000,1500,2000]);assert.deepEqual(waits,[450,450]);
});

test('paced reads release their queue on failure and abort before starting a queued call',async()=>{
  let time=1000,calls=0;const abort=new AbortController();
  const read=retryTusdcDeploymentReads(async()=>{calls++;throw Error('DEPLOYMENT_RPC_RESPONSE_INVALID');},
    {minimumIntervalMs:500,now:()=>time,signal:abort.signal,wait:async ms=>{time+=ms;abort.abort();}});
  const results=await Promise.allSettled([read('eth_chainId',[]),read('eth_chainId',[])]);
  assert.match(results[0].reason.message,/RESPONSE_INVALID/);assert.match(results[1].reason.message,/STOPPED/);
  assert.equal(calls,1);
});
