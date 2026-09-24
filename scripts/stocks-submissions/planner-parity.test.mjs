import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { deriveOrder, digest } from '../../server/dist/stocks-submissions/contracts.js';
import { ACTOR,testManifest } from '../../server/dist/stocks/test-fixtures.js';
import { manifestDigest,operationKey } from '../../server/dist/stocks/contracts.js';
const {planOrder,digest:clientDigest}=await tsImport('../../src/demo/giwa/stocks-wallet/planner.ts',import.meta.url);
test('server exact calldata and canonical digests match reviewed browser planner for BUY and SELL',()=>{
 const m=testManifest(),now=Date.now(),deploymentDigest=manifestDigest(m);
 const context={session:{id:'test-session',accessToken:'SYNTHETIC_ONLY',walletAddress:ACTOR.wallet,chainId:91342,createdAt:now-1000,expiresAt:now+10000},walletAddress:ACTOR.wallet,chainId:91342,walletEpoch:'fixture',apiBase:'https://offline.test',deployment:{status:'VERIFIED',evidenceId:'fixture-evidence',manifestDigest:deploymentDigest,manifest:m,verifiedAt:now-1000,validUntil:now+10000}};
 for(const side of ['BUY','SELL']){
 const row={id:'fixture-order',quoteId:'fixture-quote',actorId:ACTOR.actorId,wallet:ACTOR.wallet,symbol:'NVDA',quantity:'1000000000',cashAmount:'120000000',deploymentId:m.deploymentId,deploymentDigest,quoteExpiresAt:new Date(now+5000).toISOString(),state:side==='BUY'?'AWAITING_FUNDING':'AWAITING_ESCROW',version:0,idempotencyKey:'fixture-idempotency',orderKey:operationKey(`${side==='SELL'?'sell:':''}${m.networkInstance}:fixture-order`)};
 const server=deriveOrder(m,row,side),client=planOrder({side,order:row},context,now);
 assert.deepEqual(server.approval,client.approval);assert.deepEqual(server.transfer,client.transfer);assert.equal(server.intentKey,client.intentKey);assert.equal(digest(server.approval),clientDigest(client.approval));assert.equal(digest(server.transfer),clientDigest(client.transfer));
 }
});
