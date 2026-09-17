import { address, hash, StocksError } from '../stocks/contracts.js';
import type { SubmissionDiagnostic, SubmissionDiagnosticsSnapshot } from './contracts.js';

const states = {
  BUY: ['AWAITING_FUNDING','FUNDED_QUOTE_EXPIRED','FUNDING_REVIEW_REQUIRED','BROKER_PENDING','BROKER_UNKNOWN','MINT_QUEUED','MINT_SUBMITTED','MINT_FINALITY_PENDING','MINT_UNKNOWN','COMPLETED','REFUNDED','REVIEW_REQUIRED'],
  SELL: ['AWAITING_ESCROW','EXPIRED','ESCROW_HELD','ESCROW_REVIEW_REQUIRED','LIQUIDITY_PENDING','SELL_BROKER_PENDING','SELL_BROKER_UNKNOWN','SELL_PARTIAL_HELD','REDEEM_QUEUED','RETURN_QUEUED','SETTLEMENT_PENDING','SETTLEMENT_UNKNOWN','COMPLETED','RETURNED','REVIEW_REQUIRED'],
};
export function requireDiagnostic(condition: unknown): asserts condition {
  if (!condition) throw new StocksError('SUBMISSION_DIAGNOSTICS_UNAVAILABLE',503);
}
const object = (v: any): Record<string,any> => { requireDiagnostic(v!==null && typeof v==='object' && !Array.isArray(v)); return v; };
const label = (v: any): string => { requireDiagnostic(typeof v==='string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(v)); return v; };
const digest = (v: any): string => { requireDiagnostic(typeof v==='string' && /^[0-9a-f]{64}$/.test(v)); return v; };
const iso = (v: any): string => {
  requireDiagnostic(typeof v==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString()===v);
  return v;
};

/** Copy only validated public fields; raw DB/port metadata and receipt evidence never escape. */
export function publicSnapshot(input: unknown): SubmissionDiagnosticsSnapshot {
  try {
    const raw=object(input), observedAt=iso(raw.observedAt), data=object(raw.data), order=object(data.order);
    const side=order.side; requireDiagnostic(side==='BUY'||side==='SELL');
    const state=order.state; requireDiagnostic(states[side as 'BUY'|'SELL'].includes(state));
    const wallet=address(order.wallet), expires=iso(order.quoteExpiresAt);
    requireDiagnostic(Number.isSafeInteger(order.version)&&order.version>=0);
    requireDiagnostic(typeof order.quoteExpired==='boolean'&&order.quoteExpired===(Date.parse(expires)<=Date.parse(observedAt)));
    requireDiagnostic(data.enrollment==='ENROLLED'||data.enrollment==='NOT_ENROLLED');
    requireDiagnostic(data.readOnly===true&&data.executionAuthorization===false&&data.resubmissionAllowed===false);
    const intentKey=digest(data.intentKey);
    const attempt=(value:unknown,stage:'APPROVAL'|'TRANSFER'):SubmissionDiagnostic|null=>{
      if(value===null)return null;
      const row=object(value);
      requireDiagnostic(row.stage===stage&&row.intentKey===intentKey);
      requireDiagnostic(['REQUEST_MAY_START','UNKNOWN','SUBMITTED','CONFIRMED','REVERTED'].includes(row.status));
      const createdAt=iso(row.createdAt),updatedAt=iso(row.updatedAt);
      requireDiagnostic(Date.parse(createdAt)<=Date.parse(updatedAt)&&Date.parse(updatedAt)<=Date.parse(observedAt));
      const txHash=row.txHash===null?null:hash(row.txHash);
      requireDiagnostic(row.status!=='REQUEST_MAY_START'||txHash===null);
      const terminal=row.status==='CONFIRMED'||row.status==='REVERTED';
      requireDiagnostic(!(terminal||row.status==='SUBMITTED')||txHash!==null);
      let receipt:SubmissionDiagnostic['receipt']=null;
      if(terminal){
        const proof=object(row.receipt);requireDiagnostic(proof.status===row.status);
        requireDiagnostic(typeof proof.blockNumber==='string'&&/^(0|[1-9]\d{0,77})$/.test(proof.blockNumber));
        const verifiedAt=iso(proof.verifiedAt);
        requireDiagnostic(Date.parse(createdAt)<=Date.parse(verifiedAt)&&Date.parse(verifiedAt)<=Date.parse(updatedAt));
        receipt={status:proof.status,blockNumber:proof.blockNumber,blockHash:hash(proof.blockHash),verifiedAt};
      }else requireDiagnostic(row.receipt===null);
      return {claimId:label(row.claimId),intentKey,stage,transactionDigest:digest(row.transactionDigest),status:row.status,txHash,createdAt,updatedAt,receipt};
    };
    const approval=attempt(data.approval,'APPROVAL'),transfer=attempt(data.transfer,'TRANSFER');
    requireDiagnostic(data.enrollment==='ENROLLED'||(approval===null&&transfer===null));
    requireDiagnostic(!approval||!transfer||approval.claimId!==transfer.claimId);
    return {observedAt,data:{deploymentId:label(data.deploymentId),deploymentDigest:digest(data.deploymentDigest),order:{id:label(order.id),side,state,wallet,version:order.version,quoteExpiresAt:expires,quoteExpired:order.quoteExpired},enrollment:data.enrollment,intentKey,approval,transfer,readOnly:true,executionAuthorization:false,resubmissionAllowed:false}};
  }catch{throw new StocksError('SUBMISSION_DIAGNOSTICS_UNAVAILABLE',503);}
}
