import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fixture } from '../../server/dist/stocks-submissions/test-fixtures.js';
import { StocksSubmissionsService } from '../../server/dist/stocks-submissions/service.js';
import { StocksRepository } from '../../server/dist/stocks/repository.js';
import { StocksService } from '../../server/dist/stocks/service.js';
import { ReceiptVerifier } from '../../server/dist/stocks/chain.js';
import { TestChain } from '../../server/dist/stocks/test-fixtures.js';
import { manifestDigest } from '../../server/dist/stocks/contracts.js';
if(process.env.STOCKS_SUBMISSIONS_TEST_ONLY!=='1'||!process.env.STOCKS_SUBMISSIONS_RESTART_FILE)throw new Error('FRESH_PG_HARNESS_ONLY');
if(process.argv[2]==='seed'){
 const f=await fixture();try{const order=await f.order();const request=f.request(order);const claim=await f.service.claim(f.actor,request);writeFileSync(process.env.STOCKS_SUBMISSIONS_RESTART_FILE,JSON.stringify({manifest:f.manifest,actor:f.actor,order,request,claim}));}finally{await f.pool.end()}
}else if(process.argv[2]==='verify'){
 const data=JSON.parse(readFileSync(process.env.STOCKS_SUBMISSIONS_RESTART_FILE,'utf8'));const {Pool}=createRequire(import.meta.url)('pg');const pool=new Pool({connectionString:process.env.STOCKS_SUBMISSIONS_TEST_DATABASE_URL});
 try{const digest=manifestDigest(data.manifest);const stocks=new StocksService(new StocksRepository(pool,digest),data.manifest,new ReceiptVerifier(data.manifest,new TestChain(data.manifest)),{manifestDigest:digest,contractPolicyVerified:true},async()=>false);const service=new StocksSubmissionsService(stocks);assert.deepEqual((await service.inspect(data.actor,'BUY',data.order.id)).transfer,data.claim);assert.equal(await service.claim(data.actor,data.request),null);console.log('PROCESS_AND_POSTGRES_RESTART_PERSISTENCE_PASS')}finally{await pool.end()}
}else throw new Error('INVALID_RESTART_PHASE');
