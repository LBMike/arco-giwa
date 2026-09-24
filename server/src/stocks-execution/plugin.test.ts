import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {ACTOR} from '../stocks/test-fixtures.js';
import {StocksError} from '../stocks/contracts.js';
import {stocksExecutionPlugin} from './plugin.js';
import type {StocksExecutionService} from './service.js';
test('execution plugin authenticates before input, rejects query/body, sets no-store and sanitizes denials',async t=>{
 let calls=0;const service={deployment:async()=>{calls++;return {status:'VERIFIED'}},policy:async(_a:unknown,_s:unknown,id:string)=>{calls++;if(id==='private')throw new Error('PASSWORD_DATABASE');throw new StocksError('ORDER_NOT_FOUND',404)}} as unknown as StocksExecutionService;
 const app=Fastify();app.register(stocksExecutionPlugin,{service,resolveActor:async r=>r.headers.authorization==='Bearer fixture'?ACTOR:null});t.after(()=>app.close());
 for(const url of ['/api/v1/stocks/execution/deployment?wallet=fake','/api/v1/stocks/execution/BUY/private']){const r=await app.inject({url});assert.equal(r.statusCode,401);assert.equal(r.headers['cache-control'],'no-store');}assert.equal(calls,0);
 const headers={authorization:'Bearer fixture'};const query=await app.inject({url:'/api/v1/stocks/execution/deployment?wallet=fake',headers});assert.equal(query.statusCode,400);assert.equal(calls,0);
 const body=await app.inject({method:'GET',url:'/api/v1/stocks/execution/deployment',headers,payload:{wallet:'fake'}});assert.equal(body.statusCode,400);assert.equal(calls,0);
 const ok=await app.inject({url:'/api/v1/stocks/execution/deployment',headers});assert.equal(ok.statusCode,200);assert.equal(Object.keys(ok.json()).length,7);assert.equal(ok.headers['cache-control'],'no-store');
 const denied=await app.inject({url:'/api/v1/stocks/execution/BUY/missing',headers});assert.equal(denied.statusCode,404);assert.equal(denied.json().error,'ORDER_NOT_FOUND');
 const failed=await app.inject({url:'/api/v1/stocks/execution/BUY/private',headers});assert.equal(failed.statusCode,503);assert.equal(failed.json().error,'EXECUTION_UNAVAILABLE');assert.ok(!failed.body.includes('PASSWORD'));
});
