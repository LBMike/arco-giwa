// Deterministic trusted-transport fixtures only; never runtime composed.
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Hex } from 'viem';
import { operationKey, type Manifest } from '../stocks/contracts.js';
import { TestChain, ACTOR, h } from '../stocks/test-fixtures.js';
import { deriveOrder, digest, type Side, type Stage } from './contracts.js';
import type { SubmissionReceiptRequest } from './receipts.js';
import type { Row } from '../stocks/repository.js';
export function addSubmission(chain:TestChain,m:Manifest,row:Row,side:Side='BUY',stage:Stage='APPROVAL',txHash:Hex=h(900)):SubmissionReceiptRequest {
 const plan=deriveOrder(m,row,side),transaction=stage==='APPROVAL'?plan.approval:plan.transfer;
 const request={claimId:'fixture-claim',intentKey:plan.intentKey,transactionDigest:digest(transaction),txHash,side,stage,transaction};
 if(stage==='APPROVAL'){
  const spender=side==='BUY'?m.fundingVault:m.redemptionEscrow;
  const log={address:side==='BUY'?m.cashToken:m.stockToken,topics:encodeEventTopics({abi:erc20Abi,eventName:'Approval',args:{owner:row.wallet,spender}}) as [Hex,...Hex[]],data:encodeAbiParameters([{type:'uint256'}],[BigInt(side==='BUY'?row.cashAmount:row.quantity)]),logIndex:0,removed:false};
  chain.add({hash:txHash,from:row.wallet,to:transaction.to as Hex,input:transaction.data,value:'0'},[log]);
 }else if(side==='BUY')chain.funding(row.orderKey,row.cashAmount,row.wallet,txHash);else chain.escrow(row.orderKey,row.quantity,row.wallet,txHash);
 return request;
}
export function receiptOrder(m:Manifest,side:Side='BUY') {return {id:'receipt-order',symbol:'NVDA',wallet:ACTOR.wallet,quantity:'1000000000',cashAmount:'120000000',orderKey:operationKey(`${side==='SELL'?'sell:':''}${m.networkInstance}:receipt-order`)};}
