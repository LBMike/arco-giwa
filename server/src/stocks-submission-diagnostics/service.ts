import { address, StocksError, type SqlClient } from '../stocks/contracts.js';
import type { StocksService } from '../stocks/service.js';
import type { Row } from '../stocks/repository.js';
import { deriveOrder, digest, label, side, type Side } from '../stocks-submissions/contracts.js';
import { orderBinding } from '../stocks-submissions/enrollment.js';
import { publicSnapshot, requireDiagnostic } from './public.js';
import type { SubmissionDiagnostic, SubmissionDiagnosticsSnapshot } from './contracts.js';

const DB_BUDGET=2500;
const timestamp=(value:unknown):string=>{
  requireDiagnostic(value instanceof Date || typeof value==='string');
  const date=new Date(value); requireDiagnostic(Number.isFinite(date.getTime()));return date.toISOString();
};

/** Persisted facts at one database snapshot. This service cannot claim, reconcile or sign. */
export class StocksSubmissionDiagnosticsService {
  constructor(private readonly stocks:StocksService) {}

  async inspect(rawSide:Side,rawOrderId:string):Promise<SubmissionDiagnosticsSnapshot> {
    const orderSide=side(rawSide),id=label(rawOrderId);
    let closed=false,timer:ReturnType<typeof setTimeout>;
    const started=performance.now();
    const check=()=>requireDiagnostic(!closed&&performance.now()-started<DB_BUDGET);
    const work=async()=>{
      check();const db=await this.stocks.repo.pool.connect();
      try{check();}catch(error){db.release();throw error;}
      const query=async(sql:string,values?:unknown[])=>{check();const result=await db.query(sql,values);check();return result;};
      try{
        await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await query("SET LOCAL statement_timeout='2000ms'");
        await query("SET LOCAL lock_timeout='2000ms'");
        await query("SET LOCAL idle_in_transaction_session_timeout='3000ms'");
        const result=await this.read(query,orderSide,id);
        await query('COMMIT');check();return result;
      }catch(error){try{await db.query('ROLLBACK');}catch{/* Fixed error remains authoritative. */}throw error;}
      finally{db.release();}
    };
    try{
      return await Promise.race([work(),new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{closed=true;reject(new StocksError('SUBMISSION_DIAGNOSTICS_UNAVAILABLE',503));},DB_BUDGET);
      })]);
    }catch(error){
      if(error instanceof StocksError&&error.code==='ORDER_NOT_FOUND'&&error.status===404)throw error;
      throw new StocksError('SUBMISSION_DIAGNOSTICS_UNAVAILABLE',503);
    }finally{closed=true;clearTimeout(timer!);}
  }

  private async read(query:SqlClient['query'],orderSide:Side,id:string):Promise<SubmissionDiagnosticsSnapshot> {
    const {manifest,digest:deploymentDigest}=this.stocks;
    const table=orderSide==='BUY'?'StocksOrder':'StocksSellOrder';
    const orders=(await query(`SELECT id,"orderKey","quoteId","actorId",wallet,symbol,quantity::text,"cashAmount"::text,"deploymentId","deploymentDigest","quoteExpiresAt",state,version,statement_timestamp() AS "observedAt" FROM arco_evm."${table}" WHERE id=$1 AND "deploymentDigest"=$2`,[id,deploymentDigest])).rows;
    if(!orders.length)throw new StocksError('ORDER_NOT_FOUND',404);
    requireDiagnostic(orders.length===1);
    const order=orders[0],observedAt=timestamp(order.observedAt),quoteExpiresAt=timestamp(order.quoteExpiresAt);
    requireDiagnostic(order.id===id&&order.deploymentDigest===deploymentDigest&&order.deploymentId===manifest.deploymentId);
    requireDiagnostic(typeof order.actorId==='string'&&order.actorId.length>0);
    const wallet=address(order.wallet),plan=deriveOrder(manifest,order,orderSide);
    // A conflicting physical intent or a wrong intent on this order must not be hidden as absence.
    const enrollment=(await query('SELECT side,"orderId","intentKey","actorId",wallet,"deploymentDigest","orderBinding" FROM arco_evm."StocksWalletSubmissionEnrollment" WHERE "intentKey"=$1 OR (side=$2 AND "orderId"=$3) LIMIT 2',[plan.intentKey,orderSide,id])).rows;
    requireDiagnostic(enrollment.length<=1);
    if(enrollment.length){
      const row=enrollment[0];
      requireDiagnostic(row.side===orderSide&&row.orderId===id&&row.intentKey===plan.intentKey&&row.actorId===order.actorId&&row.wallet===wallet&&row.deploymentDigest===deploymentDigest&&row.orderBinding===orderBinding(order,orderSide));
    }
    const rows=(await query('SELECT "claimId","intentKey",stage,"transactionDigest",transaction,"actorId",wallet,side,"orderId","deploymentDigest",status,"txHash","createdAt","updatedAt" FROM arco_evm."StocksWalletSubmission" WHERE "intentKey"=$1 OR (side=$2 AND "orderId"=$3) LIMIT 3',[plan.intentKey,orderSide,id])).rows;
    requireDiagnostic(rows.length<=2&&(!rows.length||enrollment.length===1));
    const stages=new Set(),claims=new Set();
    for(const row of rows){
      requireDiagnostic(row.stage==='APPROVAL'||row.stage==='TRANSFER');
      requireDiagnostic(!stages.has(row.stage)&&!claims.has(row.claimId));stages.add(row.stage);claims.add(row.claimId);
      requireDiagnostic(row.intentKey===plan.intentKey&&row.side===orderSide&&row.orderId===id&&row.actorId===order.actorId&&row.wallet===wallet&&row.deploymentDigest===deploymentDigest);
      const expected=row.stage==='APPROVAL'?plan.approval:plan.transfer;
      requireDiagnostic(row.transactionDigest===digest(expected)&&digest(row.transaction)===digest(expected));
    }
    const proofs=rows.length?(await query('SELECT "claimId","intentKey","transactionDigest","deploymentDigest","txHash",status,"blockNumber"::text,"blockHash","createdAt","proofDigest",CASE WHEN octet_length(evidence::text)<=262144 THEN evidence ELSE NULL END AS evidence FROM arco_evm."StocksWalletSubmissionProof" WHERE "claimId"=ANY($1::text[]) LIMIT 3',[rows.map(r=>r.claimId)])).rows:[];
    requireDiagnostic(proofs.length<=rows.length);
    const summary=(row:Row|undefined):SubmissionDiagnostic|null=>{
      if(!row)return null;
      const matches=proofs.filter(p=>p.claimId===row.claimId);requireDiagnostic(matches.length<=1);
      const proof=matches[0],terminal=row.status==='CONFIRMED'||row.status==='REVERTED';
      requireDiagnostic(terminal===!!proof);
      if(proof){
        requireDiagnostic(proof.intentKey===plan.intentKey&&proof.transactionDigest===row.transactionDigest&&proof.deploymentDigest===deploymentDigest&&proof.txHash===row.txHash&&proof.status===row.status);
        const evidence=proof.evidence;
        requireDiagnostic(evidence&&typeof evidence==='object'&&!Array.isArray(evidence)&&proof.proofDigest===digest(evidence));
        requireDiagnostic(evidence.version===1&&evidence.claimId===row.claimId&&evidence.intentKey===plan.intentKey&&evidence.transactionDigest===row.transactionDigest&&evidence.deploymentDigest===deploymentDigest&&evidence.txHash===row.txHash&&evidence.status===row.status&&evidence.blockNumber===proof.blockNumber&&evidence.blockHash===proof.blockHash);
      }
      return {claimId:row.claimId,intentKey:row.intentKey,stage:row.stage,transactionDigest:row.transactionDigest,status:row.status,txHash:row.txHash??null,createdAt:timestamp(row.createdAt),updatedAt:timestamp(row.updatedAt),receipt:proof?{status:proof.status,blockNumber:proof.blockNumber,blockHash:proof.blockHash,verifiedAt:timestamp(proof.createdAt)}:null};
    };
    requireDiagnostic(proofs.every(p=>claims.has(p.claimId)));
    return publicSnapshot({observedAt,data:{deploymentId:manifest.deploymentId,deploymentDigest,order:{id,side:orderSide,state:order.state,wallet,version:order.version,quoteExpiresAt,quoteExpired:Date.parse(quoteExpiresAt)<=Date.parse(observedAt)},enrollment:enrollment.length?'ENROLLED':'NOT_ENROLLED',intentKey:plan.intentKey,approval:summary(rows.find(r=>r.stage==='APPROVAL')),transfer:summary(rows.find(r=>r.stage==='TRANSFER')),readOnly:true,executionAuthorization:false,resubmissionAllowed:false}});
  }
}
