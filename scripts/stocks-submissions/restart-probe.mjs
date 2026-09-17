import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fixture } from '../../server/dist/stocks-submissions/test-fixtures.js';
import { StocksSubmissionsService } from '../../server/dist/stocks-submissions/service.js';
import { StocksRepository } from '../../server/dist/stocks/repository.js';
import { StocksService } from '../../server/dist/stocks/service.js';
import { ReceiptVerifier } from '../../server/dist/stocks/chain.js';
import { createSubmissionReceiptVerifier } from '../../server/dist/stocks-submissions/receipts.js';
import { addSubmission } from '../../server/dist/stocks-submissions/receipts-fixtures.js';
import { h, TestChain } from '../../server/dist/stocks/test-fixtures.js';
import { manifestDigest } from '../../server/dist/stocks/contracts.js';
if(process.env.STOCKS_SUBMISSIONS_TEST_ONLY!=='1'||!process.env.STOCKS_SUBMISSIONS_RESTART_FILE)throw new Error('FRESH_PG_HARNESS_ONLY');
if(process.argv[2]==='seed'){
 const f=await fixture();try{const order=await f.order();const sellOrder=await f.order('SELL');const request=f.request(order);let claim=await f.service.claim(f.actor,request);const chain=new TestChain(f.manifest);addSubmission(chain,f.manifest,order,'BUY','TRANSFER',h(901));const service=new StocksSubmissionsService(f.stocks,createSubmissionReceiptVerifier(f.manifest,chain));await service.record(f.actor,{...claim,status:'SUBMITTED',txHash:h(901)});claim=await service.reconcile(f.actor,{claimId:claim.claimId,intentKey:claim.intentKey,stage:claim.stage,transactionDigest:claim.transactionDigest,txHash:h(901)});writeFileSync(process.env.STOCKS_SUBMISSIONS_RESTART_FILE,JSON.stringify({manifest:f.manifest,actor:f.actor,order,sellOrder,request,claim}));}finally{await f.pool.end()}
}else if(process.argv[2]==='verify'){
 const data=JSON.parse(readFileSync(process.env.STOCKS_SUBMISSIONS_RESTART_FILE,'utf8'));const {Pool}=createRequire(import.meta.url)('pg');const pool=new Pool({connectionString:process.env.STOCKS_SUBMISSIONS_TEST_DATABASE_URL});
 try{const digest=manifestDigest(data.manifest);const stocks=new StocksService(new StocksRepository(pool,digest),data.manifest,new ReceiptVerifier(data.manifest,new TestChain(data.manifest)),{manifestDigest:digest,contractPolicyVerified:true},async()=>false);const service=new StocksSubmissionsService(stocks);assert.deepEqual((await service.inspect(data.actor,'BUY',data.order.id)).transfer,data.claim);assert.equal(data.claim.status,'CONFIRMED');assert.equal((await pool.query('SELECT * FROM arco_evm."StocksWalletSubmissionProof" WHERE "claimId"=$1',[data.claim.claimId])).rowCount,1);assert.equal(await service.claim(data.actor,data.request),null);assert.equal((await service.record(data.actor,{...data.claim,status:'UNKNOWN'})).status,'CONFIRMED');assert.equal((await stocks.recoverOrder(data.actor,data.order.quoteId,data.order.idempotencyKey)).id,data.order.id);assert.equal((await stocks.sell.recoverOrder(data.actor,data.sellOrder.quoteId,data.sellOrder.idempotencyKey)).id,data.sellOrder.id);console.log('BUY_SELL_ORDER_RECOVERY_AFTER_RESTART_PASS');console.log('PROCESS_AND_POSTGRES_RESTART_PERSISTENCE_PASS')}finally{await pool.end()}
}else throw new Error('INVALID_RESTART_PHASE');
