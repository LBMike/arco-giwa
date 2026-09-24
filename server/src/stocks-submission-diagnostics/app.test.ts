import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildApp, type AppEnv, type ArcoAppServices } from '../app.js';
import { stocksSessionResolvers } from '../stocks-runtime/session.js';
import { a } from '../stocks/test-fixtures.js';
import type { SubmissionDiagnosticsSnapshot } from './contracts.js';
const { sign } = createRequire(import.meta.url)('jsonwebtoken') as typeof import('jsonwebtoken');
const domain='diagnostics.local.test',wallet=a(42);
const env:AppEnv={corsAllowedOrigins:[`https://${domain}`],authNonceTtlSeconds:60,authJwtSecret:'TEST_ONLY_DIAGNOSTICS_AUTH_SECRET',adminOperatorToken:'TEST_ONLY_LEGACY_OPERATOR',registryPath:'/NO_REGISTRY'};
const token=(fields={})=>sign({sub:wallet,domain,chainId:91342,...fields},env.authJwtSecret,{expiresIn:'15m'});
const path='/api/v1/admin/stocks/wallet-submissions/BUY/diagnostic-order';
function fixture(enabled=true){
  let reads=0;
  const base={arco:{},registry:{listNetworks:async()=>[]},portfolio:{},readiness:{check:async()=>({ok:true,checks:{}})}} as unknown as ArcoAppServices;
  const app=buildApp(env,{...base,stocksSubmissionDiagnostics:enabled?{
    ...stocksSessionResolvers(env.authJwtSecret,[domain],[{wallet,operatorId:'named-reader',permissions:['stocks:read']}]),
    service:{inspect:async(side,id):Promise<SubmissionDiagnosticsSnapshot>=>{reads++;return {observedAt:'2026-09-17T00:00:00.000Z',data:{deploymentId:'test-deployment',deploymentDigest:'a'.repeat(64),order:{id,side,state:side==='BUY'?'AWAITING_FUNDING':'AWAITING_ESCROW',wallet,version:0,quoteExpiresAt:'2026-09-16T00:00:00.000Z',quoteExpired:true},enrollment:'NOT_ENROLLED',intentKey:'b'.repeat(64),approval:null,transfer:null,readOnly:true,executionAuthorization:false,resubmissionAllowed:false}};}},
  }:undefined});
  return {app,reads:()=>reads};
}
test('diagnostics route remains absent without service and legacy app routes still work',async t=>{
  const f=fixture(false);t.after(()=>f.app.close());
  assert.equal((await f.app.inject(path)).statusCode,404);assert.equal((await f.app.inject('/api/v1/evm/networks')).statusCode,200);
});
test('actual signed app operator auth rejects forged role, legacy token, wrong chain/domain before database access',async t=>{
  const f=fixture();t.after(()=>f.app.close());
  for(const headers of [{},{'x-operator-token':env.adminOperatorToken},{authorization:`Bearer ${env.adminOperatorToken}`},{authorization:`Bearer ${token({sub:a(43),role:'admin',permissions:['stocks:read']})}`},{authorization:`Bearer ${token({chainId:1})}`},{authorization:`Bearer ${token({domain:'other.test'})}`}]){
    const response=await f.app.inject({url:path,headers});assert.equal(response.statusCode,403);assert.equal(response.headers['cache-control'],'no-store');
  }
  assert.equal(f.reads(),0);
  for(const side of ['BUY','SELL']){
    const response=await f.app.inject({url:path.replace('/BUY/',`/${side}/`),headers:{authorization:`Bearer ${token()}`}});
    assert.equal(response.statusCode,200);assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.json().data.order.side,side);assert.equal(response.json().data.resubmissionAllowed,false);assert.equal(response.json().profile,'DEMO_TESTNET');
  }
  assert.equal(f.reads(),2);
});
test('actual app diagnostics applies explicit CORS and rejects query/body without a read',async t=>{
  const f=fixture();t.after(()=>f.app.close());
  for(const origin of [`https://${domain}`,'https://evil.test']){
    const response=await f.app.inject({method:'OPTIONS',url:path,headers:{origin,'access-control-request-method':'GET'}});
    assert.notEqual(response.headers['access-control-allow-origin'],'*');
    if(origin===`https://${domain}`)assert.equal(response.headers['access-control-allow-origin'],origin);else assert.notEqual(response.headers['access-control-allow-origin'],origin);
  }
  const headers={authorization:`Bearer ${token()}`};
  for(const request of [{url:`${path}?refresh=true`,headers},{url:path,headers,payload:{}}]){
    const response=await f.app.inject({method:'GET',...request});assert.equal(response.statusCode,400);assert.equal(response.headers['cache-control'],'no-store');
  }
  assert.equal(f.reads(),0);
});
