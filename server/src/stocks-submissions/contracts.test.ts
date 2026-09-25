import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { decodeFunctionData, erc20Abi } from 'viem';
import { operationKey, manifestDigest, ABI } from '../stocks/contracts.js';
import { ACTOR, testManifest } from '../stocks/test-fixtures.js';
import { deriveOrder, digest } from './contracts.js';
import { stocksSubmissionsPlugin } from './plugin.js';
import type { StocksSubmissionsService } from './service.js';

test('BUY/SELL planner derives bounded exact approval and target operation using physical lower-case identity',()=>{
 const m=testManifest();
 for(const side of ['BUY','SELL'] as const){const row={id:'test-order',symbol:'NVDA',wallet:ACTOR.wallet,quantity:'1000000000',cashAmount:'120000000',orderKey:operationKey(`${side==='SELL'?'sell:':''}${m.networkInstance}:test-order`)};
 const plan=deriveOrder(m,row,side);const approval=decodeFunctionData({abi:erc20Abi,data:plan.approval.data});
 assert.equal(approval.functionName,'approve');assert.equal(approval.args?.[1],side==='BUY'?120000000n:1000000000n);
 assert.equal(decodeFunctionData({abi:ABI,data:plan.transfer.data}).functionName,side==='BUY'?'depositForOrder':'escrowForOrder');
 assert.equal(plan.intentKey,digest([91342,(side==='BUY'?m.fundingVault:m.redemptionEscrow).toLowerCase(),(side==='BUY'?m.cashToken:m.stockToken).toLowerCase(),row.wallet.toLowerCase(),row.orderKey]));
 assert.equal(deriveOrder({...m,deploymentId:'DIFFERENT_ALIAS'},row,side).intentKey,plan.intentKey);
 assert.notEqual(manifestDigest({...m,deploymentId:'DIFFERENT_ALIAS'}),manifestDigest(m));
 // Each quote fixes its own price, so any positive bounded amount derives; an unbounded one does not.
 assert.doesNotThrow(()=>deriveOrder(m,{...row,cashAmount:'1'},side));
 assert.throws(()=>deriveOrder(m,{...row,cashAmount:`1${'0'.repeat(31)}`},side),/ORDER_PRICE_MISMATCH/);
 }
});

test('plugin authentication occurs before parsing, query rejection and internal failures expose no private data',async t=>{
 let calls=0;
 const service={inspect:async()=>{calls++;throw new Error('PRIVATE_SQL_AND_SECRET')},claim:async()=>{calls++;throw new Error('PRIVATE_SQL_AND_SECRET')},record:async()=>{calls++;throw new Error('PRIVATE_SQL_AND_SECRET')}} as unknown as StocksSubmissionsService;
 const app=Fastify();app.register(stocksSubmissionsPlugin,{service,resolveActor:async r=>r.headers.authorization==='Bearer test'?ACTOR:null});t.after(()=>app.close());
 for(const payload of ['{bad','{}']){const denied=await app.inject({method:'POST',url:'/api/v1/stocks/wallet-submissions/claims',headers:{'content-type':'application/json'},payload});assert.equal(denied.statusCode,401);assert.equal(denied.json().error,'UNAUTHORIZED');}
 assert.equal(calls,0);
 const malformed=await app.inject({method:'POST',url:'/api/v1/stocks/wallet-submissions/claims',headers:{authorization:'Bearer test','content-type':'application/json'},payload:'{bad'});assert.equal(malformed.statusCode,400);assert.equal(calls,0);
 const query=await app.inject({url:'/api/v1/stocks/wallet-submissions/BUY/id?wallet=fake',headers:{authorization:'Bearer test'}});assert.equal(query.statusCode,400);assert.equal(calls,0);
 const error=await app.inject({url:'/api/v1/stocks/wallet-submissions/BUY/id',headers:{authorization:'Bearer test'}});assert.equal(error.statusCode,500);assert.equal(error.json().error,'INTERNAL_ERROR');assert.ok(!error.body.includes('PRIVATE'));assert.equal(error.headers['cache-control'],'no-store');
});
