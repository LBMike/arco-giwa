import { address, ensure, freezeManifest, publicManifest, immutable, liquidityScope, manifestDigest, StocksError, validateActor, type Actor } from '../stocks/contracts.js';
import type { StocksService } from '../stocks/service.js';
import { deriveOrder, label, side } from '../stocks-submissions/contracts.js';
import { orderBinding } from '../stocks-submissions/enrollment.js';
import type { DeploymentEvidencePort, ExecutionPolicy, ReviewedDeployment } from './contracts.js';
export type ExecutionServiceClock = { wallNow(): number; monotonicNow(): number };
const systemClock: ExecutionServiceClock = {wallNow:()=>Date.now(),monotonicNow:()=>performance.now()};
// The product database can be a region away from the API: a cold pooled connection plus the phase's
// round trips took 2.5-3 s on the local demo, which read as "execution not allowed" in the wallet.
export const EXECUTION_DB_BUDGET_MS=6000;
const MAX_LEASE=15000, DB_BUDGET=EXECUTION_DB_BUDGET_MS;

export class StocksExecutionService {
  constructor(private readonly stocks: StocksService, private readonly deployments: DeploymentEvidencePort, private readonly clock: ExecutionServiceClock=systemClock) {}
  private begin(input: Actor) {
    const actor=immutable(input);validateActor(actor);this.stocks.requireActivation();
    const wall=this.clock.wallNow(),mono=this.clock.monotonicNow();
    ensure(Number.isSafeInteger(wall)&&Number.isFinite(mono),'EXECUTION_CLOCK_UNAVAILABLE',503);
    return {actor,wall,mono};
  }
  private check(start: {wall:number;mono:number},validUntil=start.wall+MAX_LEASE) {
    const wall=this.clock.wallNow(),elapsed=this.clock.monotonicNow()-start.mono;
    ensure(Number.isSafeInteger(wall)&&Number.isFinite(elapsed)&&elapsed>=0&&wall>=start.wall&&elapsed<MAX_LEASE&&wall<validUntil,'EXECUTION_POLICY_EXPIRED',503);
    // A wall-clock pause/rollback must not stretch a start-anchored lease.
    ensure(start.wall+elapsed<validUntil,'EXECUTION_POLICY_EXPIRED',503);
  }
  private evidence(input: ReviewedDeployment,start:{wall:number;mono:number}): ReviewedDeployment {
    const e=immutable(input);const m=freezeManifest(e.manifest);
    ensure(e.status==='VERIFIED'&&typeof e.evidenceId==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(e.evidenceId)&&e.manifestDigest===this.stocks.digest&&manifestDigest(m)===this.stocks.digest,'EXECUTION_DEPLOYMENT_MISMATCH',503);
    ensure(Number.isSafeInteger(e.verifiedAt)&&Number.isSafeInteger(e.validUntil)&&e.verifiedAt<=this.clock.wallNow()&&e.validUntil>e.verifiedAt&&e.validUntil-e.verifiedAt<=MAX_LEASE,'EXECUTION_DEPLOYMENT_MISMATCH',503);
    this.check(start,e.validUntil);
    // Whitelist public manifest properties even if a trusted port adds internal metadata.
    const manifest=publicManifest(m);
    ensure(manifestDigest(manifest)===this.stocks.digest,'EXECUTION_DEPLOYMENT_MISMATCH',503);
    return immutable({status:'VERIFIED',evidenceId:e.evidenceId,manifestDigest:e.manifestDigest,manifest,verifiedAt:e.verifiedAt,validUntil:e.validUntil});
  }
  private async unpaused() {ensure(!(await this.stocks.paused()),'STOCKS_PAUSED',503);}
  private async safe<T>(work:()=>Promise<T>):Promise<T> {
    let timer:ReturnType<typeof setTimeout>;
    try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new StocksError('EXECUTION_POLICY_EXPIRED',503)),MAX_LEASE);})]);}catch(error){if(error instanceof StocksError)throw error;throw new StocksError('EXECUTION_UNAVAILABLE',503);}finally{clearTimeout(timer!);}
  }
  async deployment(input:Actor):Promise<ReviewedDeployment> {return this.safe(async()=>{
    const start=this.begin(input);this.check(start);
    const evidence=this.evidence(await this.deployments.get(),start);
    this.check(start,evidence.validUntil);return evidence;
  });}
  private async eligible(actor:Actor,orderSide:'BUY'|'SELL',id:string):Promise<number> {
    // Read-only SQL and short server-side timeouts bound waits. No ready()/binding INSERT.
    let closed=false,timer:ReturnType<typeof setTimeout>;
    const phaseStarted=this.clock.monotonicNow();
    const checkPhase=()=>{
      const elapsed=this.clock.monotonicNow()-phaseStarted;
      if(!Number.isFinite(elapsed)||elapsed<0||elapsed>=DB_BUDGET)closed=true;
      ensure(!closed,'EXECUTION_DATABASE_TIMEOUT',503);
    };
    const work=async()=>{
      checkPhase();
      const acquired=await this.stocks.repo.pool.connect();
      try{checkPhase();}catch(error){acquired.release();throw error;}
      const query=async(text:string,values?:unknown[])=>{
        checkPhase();const result=await acquired.query(text,values);checkPhase();return result;
      };
      try {
        await query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
        // One round trip for all three limits.
        await query("SET LOCAL statement_timeout='2000ms';SET LOCAL lock_timeout='2000ms';SET LOCAL idle_in_transaction_session_timeout='3000ms'");
        const table=orderSide==='BUY'?'StocksOrder':'StocksSellOrder';
        const order=(await query(`SELECT * FROM arco_evm."${table}" WHERE id=$1 AND "actorId"=$2 AND wallet=$3 AND "deploymentDigest"=$4`,[id,actor.actorId,address(actor.wallet),this.stocks.digest])).rows[0];
        ensure(order,'ORDER_NOT_FOUND',404);ensure(order.deploymentId===this.stocks.manifest.deploymentId,'ORDER_DEPLOYMENT_MISMATCH',409);
        const binding=(await query('SELECT "deploymentDigest" FROM arco_evm."StocksLiquidityBinding" WHERE "scopeKey"=$1',[liquidityScope(this.stocks.manifest)])).rows[0];
        ensure(binding?.deploymentDigest===this.stocks.digest,'EXECUTION_PHYSICAL_BINDING_MISMATCH',503);
        const plan=deriveOrder(this.stocks.manifest,order,orderSide);
        const enrollment=(await query('SELECT * FROM arco_evm."StocksWalletSubmissionEnrollment" WHERE side=$1 AND "orderId"=$2',[orderSide,id])).rows[0];
        ensure(enrollment&&enrollment.intentKey===plan.intentKey&&enrollment.actorId===actor.actorId&&enrollment.wallet===address(actor.wallet)&&enrollment.deploymentDigest===this.stocks.digest&&enrollment.orderBinding===orderBinding(order,orderSide),'SUBMISSION_NOT_ENROLLED',409);
        ensure(order.state===(orderSide==='BUY'?'AWAITING_FUNDING':'AWAITING_ESCROW'),'ORDER_NOT_PAYABLE',409);
        const sampledAt=this.clock.wallNow();
        const timing=(await query('SELECT EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))*1000 AS "remainingMs"',[order.quoteExpiresAt])).rows[0];
        const remaining=Number(timing?.remainingMs);ensure(Number.isFinite(remaining)&&remaining>0,'ORDER_EXPIRED',409);
        await query('COMMIT');checkPhase();
        return sampledAt+Math.floor(remaining);
      }catch(error){try{await acquired.query('ROLLBACK');}catch{/* preserve fixed failure */}throw error;}
      finally{acquired.release();}
    };
    try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{closed=true;reject(new StocksError('EXECUTION_DATABASE_TIMEOUT',503));},DB_BUDGET);})]);}
    finally{clearTimeout(timer!);closed=true;}
  }
  async policy(input:Actor,rawSide:unknown,rawId:unknown):Promise<ExecutionPolicy> {return this.safe(async()=>{
    const start=this.begin(input),orderSide=side(rawSide),id=label(rawId);
    await this.unpaused();this.check(start);
    const initialDeadline=await this.eligible(start.actor,orderSide,id);this.check(start,initialDeadline);
    const evidence=this.evidence(await this.deployments.get(),start);
    const orderDeadline=await this.eligible(start.actor,orderSide,id);
    let validUntil=Math.floor(Math.min(start.wall+MAX_LEASE,evidence.validUntil,initialDeadline,orderDeadline));
    await this.unpaused();
    // Preserve the original budget if wall time advances less than monotonic time.
    validUntil=Math.floor(Math.min(validUntil,this.clock.wallNow()+validUntil-start.wall-(this.clock.monotonicNow()-start.mono)));
    this.check(start,validUntil);
    return immutable({allowed:true,deploymentDigest:this.stocks.digest,orderId:id,side:orderSide,observedAt:start.wall,validUntil});
  });}
}
