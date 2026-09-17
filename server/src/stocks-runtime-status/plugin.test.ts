import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { StocksError, type Operator } from '../stocks/contracts.js';
import { stocksRuntimeStatusPlugin } from './plugin.js';
import type { StocksRuntimeSnapshot } from './contracts.js';
const url='/api/v1/admin/stocks/runtime',headers={authorization:'Bearer signed-fixture'};
function snapshot():StocksRuntimeSnapshot{return {enabled:true,runtimeState:'RUNNING',deploymentId:'fixture-deployment',deploymentDigest:'a'.repeat(64),autodispatch:true,configuredPause:false,observerStatus:'CURRENT',lastObservationAt:'2026-09-17T00:00:00.000Z',lastCurrentAt:'2026-09-17T00:00:00.000Z',lastCurrentAgeMs:1000,freshnessLimitMs:60000,tickInFlight:false,newOrdersPaused:false,pauseReasons:[],executionAuthorization:false,observedAt:'2026-09-17T00:00:01.000Z'};}
const named:Operator={operatorId:'named-operator',permissions:['stocks:read']};
function appWith(getSnapshot:()=>StocksRuntimeSnapshot,resolveOperator?:()=>Promise<Operator|null>){const app=Fastify();app.register(stocksRuntimeStatusPlugin,{getSnapshot,resolveOperator:resolveOperator??(async request=>request.headers.authorization===headers.authorization?named:null)});return app;}
function noStore(response:{headers:Record<string,unknown>}){assert.equal(response.headers['cache-control'],'no-store')}
test('runtime diagnostic whitelists exactly one synchronous snapshot and never grants execution permission',async t=>{
 let calls=0;const raw={...snapshot(),rpcUrl:'SECRET_URL',privateConfig:{token:'DO_NOT_LEAK'},error:new Error('PRIVATE')};Object.defineProperty(raw,'privateGetter',{get(){throw new Error('MUST_NOT_READ')}});
 const app=appWith(()=>{calls++;return raw});t.after(()=>app.close());const response=await app.inject({url,headers});assert.equal(response.statusCode,200);noStore(response);assert.equal(calls,1);
 const result=response.json();assert.deepEqual(Object.keys(result).sort(),['profile','valuePolicy','brokerMode','chainId','priceSource','observedAt','data'].sort());
 assert.deepEqual(Object.keys(result.data).sort(),Object.keys(snapshot()).filter(k=>k!=='observedAt').sort());assert.equal(result.data.executionAuthorization,false);assert.equal(result.observedAt,snapshot().observedAt);assert.ok(!response.body.includes('SECRET'));assert.ok(!response.body.includes('PRIVATE'));assert.ok(!response.body.includes('DO_NOT_LEAK'));
 const head=await app.inject({method:'HEAD',url,headers});assert.notEqual(head.statusCode,200);assert.equal(calls,1);
});
test('authentication precedes malformed body/query and ignores shared tokens or browser role',async t=>{
 let calls=0;const app=appWith(()=>{calls++;return snapshot()});t.after(()=>app.close());
 for(const request of [{url:`${url}?operatorId=admin`},{url,headers:{'x-operator-token':'legacy','x-role':'admin'}},{url,headers:{authorization:'Bearer browser-role'}},{url,headers:{'content-type':'application/json'},payload:'{invalid'}]){
  const r=await app.inject({method:'GET',...request});assert.equal(r.statusCode,403);assert.equal(r.json().error,'OPERATOR_FORBIDDEN');noStore(r);
 }assert.equal(calls,0);
});
for(const [name,operator] of [['missing',null],['empty name',{operatorId:'',permissions:['stocks:read']}],['blank name',{operatorId:'   ',permissions:['stocks:read']}],['unnamed',{permissions:['stocks:read']}],['missing permission',{operatorId:'named',permissions:[]}],['invalid permissions',{operatorId:'named',permissions:'stocks:read'}]] as const)test(`operator ${name} is forbidden without source access`,async t=>{
 let calls=0;const app=appWith(()=>{calls++;return snapshot()},async()=>operator as Operator|null);t.after(()=>app.close());const r=await app.inject({url,headers});assert.equal(r.statusCode,403);noStore(r);assert.equal(calls,0);
});
test('absent resolver and resolver exception are fixed forbidden errors',async t=>{
 const none=Fastify();none.register(stocksRuntimeStatusPlugin,{getSnapshot:()=>{throw new Error('MUST_NOT_READ')}});t.after(()=>none.close());const r=await none.inject({url,headers});assert.equal(r.statusCode,403);noStore(r);
 const failed=appWith(snapshot,async()=>{throw new Error('SECRET_SESSION_URL')});t.after(()=>failed.close());const e=await failed.inject({url,headers});assert.equal(e.statusCode,403);assert.ok(!e.body.includes('SECRET'));noStore(e);
});
test('authorized query strings and bodies are rejected before snapshot',async t=>{
 let calls=0;const app=appWith(()=>{calls++;return snapshot()});t.after(()=>app.close());
 for(const request of [{url:`${url}?tick=true`},{url,headers:{...headers,'content-type':'application/json'},payload:'{invalid'},{url,payload:{operatorId:'other'}},{url,headers:{...headers,'transfer-encoding':'chunked'},payload:'x'}]){
  const r=await app.inject({method:'GET',headers,...request});assert.equal(r.statusCode,400);assert.equal(r.json().error,'INVALID_RUNTIME_STATUS_INPUT');noStore(r);
 }assert.equal(calls,0);
});
test('source failures are unavailable even if an exception tries to choose another HTTP status',async t=>{
 for(const error of [new Error('RPC_SECRET'),new StocksError('OPERATOR_FORBIDDEN',403),Object.assign(new Error('PRIVATE'),{statusCode:400})]){
  const app=appWith(()=>{throw error});t.after(()=>app.close());const r=await app.inject({url,headers});assert.equal(r.statusCode,503);assert.equal(r.json().error,'RUNTIME_STATUS_UNAVAILABLE');assert.ok(!r.body.includes('PRIVATE'));noStore(r);
 }
});
const invalid:Record<string,Partial<StocksRuntimeSnapshot>>={
 enabled:{enabled:false as true},authorization:{executionAuthorization:true as false},freshness:{freshnessLimitMs:60001 as 60000},deployment:{deploymentId:'bad id'},digest:{deploymentDigest:'A'.repeat(64)},boolean:{autodispatch:'yes' as unknown as boolean},status:{observerStatus:'UNKNOWN' as never},clock:{observedAt:'invalid'},noncanonicalClock:{observedAt:'2026-09-17T00:00:01Z'},futureCurrent:{lastCurrentAt:'2026-09-17T00:00:02.000Z'},missingCurrent:{lastCurrentAt:null},missingObservation:{lastObservationAt:null},underreportedAge:{lastCurrentAgeMs:999},negativeAge:{lastCurrentAgeMs:-1},infiniteAge:{lastCurrentAgeMs:Infinity},nanAge:{lastCurrentAgeMs:NaN},missingAge:{lastCurrentAgeMs:null},staleAge:{lastCurrentAgeMs:60001},staleWall:{observedAt:'2026-09-17T00:01:01.000Z'},stoppedMismatch:{runtimeState:'STOPPED'},observerStoppedMismatch:{observerStatus:'STOPPED'},pauseFlag:{newOrdersPaused:true},pauseReasons:{pauseReasons:['CONFIGURED_PAUSE']},reorderedReasons:{autodispatch:false,configuredPause:true,newOrdersPaused:true,pauseReasons:['CONFIGURED_PAUSE','AUTODISPATCH_DISABLED']},missingReason:{autodispatch:false,newOrdersPaused:true,pauseReasons:[]},observationBeforeCurrent:{lastObservationAt:'2026-09-16T23:59:59.000Z'},
};
for(const [name,patch] of Object.entries(invalid))test(`inconsistent snapshot ${name} cannot escape as success`,async t=>{
 const app=appWith(()=>({...snapshot(),...patch}));t.after(()=>app.close());const r=await app.inject({url,headers});assert.equal(r.statusCode,503);assert.equal(r.json().error,'RUNTIME_STATUS_UNAVAILABLE');noStore(r);
});
test('stopped and invalid-clock history remain diagnostic with deterministic pause order',async t=>{
 const stopped:StocksRuntimeSnapshot={...snapshot(),runtimeState:'STOPPED',observerStatus:'STOPPED',autodispatch:false,configuredPause:true,newOrdersPaused:true,pauseReasons:['RUNTIME_STOPPED','AUTODISPATCH_DISABLED','CONFIGURED_PAUSE','OBSERVER_NOT_CURRENT']};
 const invalidClock:StocksRuntimeSnapshot={...snapshot(),observedAt:'1970-01-01T00:00:00.000Z',observerStatus:'UNAVAILABLE_OR_REVIEW_REQUIRED',lastCurrentAgeMs:null,newOrdersPaused:true,pauseReasons:['OBSERVER_NOT_CURRENT']};
 for(const state of [stopped,invalidClock,{...snapshot(),lastCurrentAgeMs:60000,observedAt:'2026-09-17T00:01:00.000Z'}]){const app=appWith(()=>state);t.after(()=>app.close());const r=await app.inject({url,headers});assert.equal(r.statusCode,200);assert.equal(r.json().data.executionAuthorization,false);noStore(r);}
});
