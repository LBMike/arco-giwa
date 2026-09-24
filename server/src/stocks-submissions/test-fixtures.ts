import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { manifestDigest, type Actor, type SqlPool } from '../stocks/contracts.js';
import { a, ACTOR, TestChain, testManifest } from '../stocks/test-fixtures.js';
import { ReceiptVerifier } from '../stocks/chain.js';
import { StocksRepository } from '../stocks/repository.js';
import { StocksService } from '../stocks/service.js';
import { StocksSubmissionsService } from './service.js';
import { deriveOrder, digest, type Side, type Stage } from './contracts.js';
const require=createRequire(import.meta.url);
const pg=require('pg') as { Pool:new(options:unknown)=>SqlPool & {end():Promise<void>} };
export const enabled=process.env.STOCKS_SUBMISSIONS_TEST_ONLY==='1' && !!process.env.STOCKS_SUBMISSIONS_TEST_DATABASE_URL;
let next=Number.parseInt(randomUUID().replace(/-/g,'').slice(0,12),16);
export async function fixture() {
 if(!enabled)throw new Error('FRESH_PG_HARNESS_REQUIRED');
 const pool=new pg.Pool({connectionString:process.env.STOCKS_SUBMISSIONS_TEST_DATABASE_URL,max:8});
 const manifest=testManifest();manifest.deploymentId=`SUBMISSIONS_${randomUUID()}`;manifest.networkInstance=`NETWORK_${randomUUID()}`;
 for(const key of ['cashToken','fundingVault'] as const){const old=manifest[key];manifest[key]=a(next++);manifest.codeHashes[manifest[key]]=manifest.codeHashes[old];delete manifest.codeHashes[old];}
 const repo=new StocksRepository(pool,manifestDigest(manifest));let paused=false;
 const stocks=new StocksService(repo,manifest,new ReceiptVerifier(manifest,new TestChain(manifest)),{manifestDigest:manifestDigest(manifest),contractPolicyVerified:true},async()=>paused);
 const actor:Actor={...ACTOR,actorId:`actor:${randomUUID()}`};
 const service=new StocksSubmissionsService(stocks);
 const order=async(orderSide:Side='BUY')=>{
  if(orderSide==='BUY'){const q=await stocks.quote(actor,'NVDA','1');return stocks.createOrder(actor,q.id,`order:${randomUUID()}`);}
  await pool.query('INSERT INTO arco_evm."StocksQuantityMovement" (id,"deploymentDigest",wallet,"walletDelta","escrowDelta","supplyDelta","blockNumber","blockHash","txHash") VALUES($1,$2,$3,1000000000,0,1000000000,1,\'fixture-block\',\'fixture-tx\')',[randomUUID(),stocks.digest,actor.wallet]);
  const q=await stocks.sell.quote(actor,'NVDA','1');return stocks.sell.createOrder(actor,q.id,`order:${randomUUID()}`);
 };
 const request=(row:Record<string,any>,orderSide:Side='BUY',requestedStage:Stage='TRANSFER')=>{const plan=deriveOrder(manifest,row,orderSide);const tx=requestedStage==='APPROVAL'?plan.approval:plan.transfer;return {side:orderSide,orderId:row.id,intentKey:plan.intentKey,stage:requestedStage,transactionDigest:digest(tx),transaction:tx,deploymentDigest:stocks.digest};};
 return {pool,manifest,repo,stocks,actor,service,order,request,pause:(value:boolean)=>{paused=value;}};
}
