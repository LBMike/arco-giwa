import assert from 'node:assert/strict';
import test from 'node:test';
import { h, a, testManifest, TestChain } from '../stocks/test-fixtures.js';
import { createSubmissionReceiptVerifier } from './receipts.js';
import { addSubmission, receiptOrder } from './receipts-fixtures.js';

for(const side of ['BUY','SELL'] as const)for(const stage of ['APPROVAL','TRANSFER'] as const){
 test(`trusted ${side} ${stage} accepts exact finalized semantics and separately bound revert`,async()=>{
  const m=testManifest(),chain=new TestChain(m),r=addSubmission(chain,m,receiptOrder(m,side),side,stage),v=createSubmissionReceiptVerifier(m,chain);
  assert.equal((await v.verify(r))?.status,'CONFIRMED');
  chain.receipts.get(r.txHash)!.status='reverted';chain.receipts.get(r.txHash)!.logs=[];
  assert.equal((await v.verify(r))?.status,'REVERTED');
  chain.transactions.get(r.txHash)!.from=a(999);await assert.rejects(v.verify(r),/SUBMISSION_RECEIPT_UNAVAILABLE/);
 });
}
const changes:Record<string,(c:TestChain)=>void>={
 network:c=>{c.wrongChain=true}, checkpoint:c=>{c.blocks.get('1')!.hash=h(555)}, code:c=>{c.wrongCode=true}, sender:c=>{c.transactions.get(h(900))!.from=a(555)}, target:c=>{c.transactions.get(h(900))!.to=a(555)}, calldata:c=>{c.transactions.get(h(900))!.input='0x1234'}, value:c=>{c.transactions.get(h(900))!.value='1'}, transactionHash:c=>{c.transactions.get(h(900))!.hash=h(555)}, receiptHash:c=>{c.receipts.get(h(900))!.transactionHash=h(555)}, blockHash:c=>{c.receipts.get(h(900))!.blockHash=h(555)}, blockNumber:c=>{c.blocks.get('10')!.number='11'}, removed:c=>{c.receipts.get(h(900))!.logs[0].removed=true}, duplicate:c=>{c.receipts.get(h(900))!.logs.push(c.receipts.get(h(900))!.logs[0])}, missingApproval:c=>{c.receipts.get(h(900))!.logs=[]}, wrongApproval:c=>{c.receipts.get(h(900))!.logs[0].data=h(44)}, wrongApprovalOwner:c=>{c.receipts.get(h(900))!.logs[0].topics[1]=h(555)}, wrongApprovalSpender:c=>{c.receipts.get(h(900))!.logs[0].topics[2]=h(555)}, wrongApprovalToken:c=>{c.receipts.get(h(900))!.logs[0].address=a(999)}, revertedLogs:c=>{c.receipts.get(h(900))!.status='reverted'}, malformedApproval:c=>{c.receipts.get(h(900))!.logs[0].data='0x12'},
};
for(const [name,change] of Object.entries(changes))test(`hostile receipt rejects ${name}`,async()=>{
 const m=testManifest(),chain=new TestChain(m),r=addSubmission(chain,m,receiptOrder(m));change(chain);
 await assert.rejects(createSubmissionReceiptVerifier(m,chain).verify(r),/SUBMISSION_RECEIPT_UNAVAILABLE/);
});
test('pending/missing finality is observational; final reorg and transport secrets fail closed',async()=>{
 const m=testManifest(),chain=new TestChain(m),r=addSubmission(chain,m,receiptOrder(m)),v=createSubmissionReceiptVerifier(m,chain);
 chain.finalizedNumber='1';assert.equal(await v.verify(r),null);chain.finalizedNumber='100';
 const block=chain.block.bind(chain);let count=0;chain.block=async n=>{const b=await block(n);return n==='10'&&++count>1&&b?{...b,hash:h(77)}:b};await assert.rejects(v.verify(r),/SUBMISSION_RECEIPT_UNAVAILABLE/);
 chain.network=async()=>{throw new Error('https://secret:token@private-rpc')};await assert.rejects(v.verify(r),error=>String(error)==='Error: SUBMISSION_RECEIPT_UNAVAILABLE');
});
test('timeout discards late result and schedules no next RPC',async()=>{
 const m=testManifest(),chain=new TestChain(m),r=addSubmission(chain,m,receiptOrder(m));let next=0,release!:()=>void;
 const deferred=new Promise<void>(resolve=>{release=resolve});const network=chain.network.bind(chain);chain.network=async()=>{await deferred;return network()};chain.transaction=async()=>{next++;return null};
 await assert.rejects(createSubmissionReceiptVerifier(m,chain,{timeoutMs:10}).verify(r),/SUBMISSION_RECEIPT_TIMEOUT/);
 release();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(next,0);
});
for(const side of ['BUY','SELL'] as const)test(`${side} transfer success cannot omit or forge economic movement`,async()=>{
 const m=testManifest(),chain=new TestChain(m),r=addSubmission(chain,m,receiptOrder(m,side),side,'TRANSFER');
 chain.receipts.get(r.txHash)!.logs.pop();await assert.rejects(createSubmissionReceiptVerifier(m,chain).verify(r),/SUBMISSION_RECEIPT_UNAVAILABLE/);
});
