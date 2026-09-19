import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PROFILE, StocksError, type Operator } from '../stocks/contracts.js';
import { OBSERVER_STATES, type StocksRuntimeSnapshot } from './contracts.js';
import type { OperatorControlStatus } from '../stocks-trading-control/contracts.js';
export type StocksRuntimeStatusPluginOptions = {
  getSnapshot: () => StocksRuntimeSnapshot;
  resolveOperator?: (request: FastifyRequest) => Promise<Operator | null>;
};
const unavailable = () => { throw new StocksError('RUNTIME_STATUS_UNAVAILABLE',503); };
function requireSnapshot(condition: unknown): asserts condition { if(!condition)unavailable(); }
function iso(value:unknown): value is string {
  return typeof value==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value;
}
function publicOperatorControl(raw: unknown): OperatorControlStatus | undefined {
  if (raw === undefined) return undefined;
  requireSnapshot(raw !== null && typeof raw === 'object' && !Array.isArray(raw));
  const { status, version } = raw as OperatorControlStatus;
  requireSnapshot(status === 'PAUSED' || status === 'RESUMED' || status === 'UNAVAILABLE');
  requireSnapshot(status === 'UNAVAILABLE' ? version === null : typeof version === 'number' && Number.isInteger(version) && version >= 0 && version <= 2147483647);
  return { status, version };
}
function envelope(raw: StocksRuntimeSnapshot) {
  requireSnapshot(raw!==null && typeof raw==='object' && !Array.isArray(raw));
  // Read only public fields once; arbitrary metadata/getters are never enumerated.
  const {enabled,runtimeState,deploymentId,deploymentDigest,autodispatch,configuredPause,operatorControl:sourceControl,observerStatus,lastObservationAt,lastCurrentAt,lastCurrentAgeMs,freshnessLimitMs,tickInFlight,newOrdersPaused,pauseReasons,executionAuthorization,observedAt}=raw;
  const operatorControl = publicOperatorControl(sourceControl);
  requireSnapshot(enabled===true&&freshnessLimitMs===60000&&executionAuthorization===false);
  requireSnapshot(runtimeState==='RUNNING'||runtimeState==='STOPPED');
  requireSnapshot(typeof deploymentId==='string'&&/^[a-zA-Z0-9:_-]{8,128}$/.test(deploymentId)&&typeof deploymentDigest==='string'&&/^[0-9a-f]{64}$/.test(deploymentDigest));
  requireSnapshot(typeof autodispatch==='boolean'&&typeof configuredPause==='boolean'&&typeof tickInFlight==='boolean'&&typeof newOrdersPaused==='boolean');
  requireSnapshot(OBSERVER_STATES.includes(observerStatus)&&iso(observedAt)&&(lastObservationAt===null||iso(lastObservationAt))&&(lastCurrentAt===null||iso(lastCurrentAt)));
  requireSnapshot(lastCurrentAgeMs===null||(typeof lastCurrentAgeMs==='number'&&Number.isFinite(lastCurrentAgeMs)&&lastCurrentAgeMs>=0));
  requireSnapshot(lastCurrentAt!==null||lastCurrentAgeMs===null);
  requireSnapshot((runtimeState==='STOPPED')===(observerStatus==='STOPPED'));
  if(observerStatus==='CURRENT') {
    requireSnapshot(lastCurrentAt!==null&&lastObservationAt!==null&&lastCurrentAgeMs!==null&&lastCurrentAgeMs<=freshnessLimitMs);
    const elapsed=Date.parse(observedAt)-Date.parse(lastCurrentAt);
    requireSnapshot(elapsed>=0&&elapsed<=freshnessLimitMs&&lastCurrentAgeMs>=elapsed&&Date.parse(lastObservationAt)>=Date.parse(lastCurrentAt)&&Date.parse(lastObservationAt)<=Date.parse(observedAt));
  }
  const expected=[...(runtimeState==='STOPPED'?['RUNTIME_STOPPED']:[]),...(!autodispatch?['AUTODISPATCH_DISABLED']:[]),...(configuredPause?['CONFIGURED_PAUSE']:[]),...(operatorControl?.status==='PAUSED'?['OPERATOR_PAUSE']:[]),...(operatorControl?.status==='UNAVAILABLE'?['OPERATOR_CONTROL_UNAVAILABLE']:[]),...(observerStatus!=='CURRENT'?['OBSERVER_NOT_CURRENT']:[])];
  requireSnapshot(Array.isArray(pauseReasons)&&pauseReasons.length===expected.length&&pauseReasons.every((reason,index)=>reason===expected[index])&&newOrdersPaused===(expected.length>0));
  return {...PROFILE,observedAt,data:{enabled,runtimeState,deploymentId,deploymentDigest,autodispatch,configuredPause,...(operatorControl===undefined?{}:{operatorControl}),observerStatus,lastObservationAt,lastCurrentAt,lastCurrentAgeMs,freshnessLimitMs,tickInFlight,newOrdersPaused,pauseReasons:[...expected],executionAuthorization}};
}
export async function stocksRuntimeStatusPlugin(app: FastifyInstance, options: StocksRuntimeStatusPluginOptions): Promise<void> {
  app.addHook('onRequest',async request=>{
    let authorized=false;
    try {
      const operator=await options.resolveOperator?.(request);
      authorized=!!operator&&typeof operator.operatorId==='string'&&operator.operatorId.trim().length>0&&operator.operatorId.length<=128&&Array.isArray(operator.permissions)&&operator.permissions.includes('stocks:read');
    }catch{/* No resolver details or credentials escape. */}
    if(!authorized)throw new StocksError('OPERATOR_FORBIDDEN',403);
    if(request.raw.url?.includes('?')||Object.keys(request.query as object).length>0||request.headers['transfer-encoding']!==undefined||(request.headers['content-length']!==undefined&&request.headers['content-length']!=='0'))throw new StocksError('INVALID_RUNTIME_STATUS_INPUT',400);
  });
  app.addHook('onSend',async(_request,reply)=>{reply.header('cache-control','no-store');});
  app.setErrorHandler((error,_request,reply)=>{
    if(error instanceof StocksError&&['OPERATOR_FORBIDDEN','INVALID_RUNTIME_STATUS_INPUT'].includes(error.code))return reply.code(error.code==='OPERATOR_FORBIDDEN'?403:400).send({error:error.code,...PROFILE});
    const input=(error as {statusCode?:number}).statusCode;
    if(!(error instanceof StocksError)&&input&&input>=400&&input<500)return reply.code(400).send({error:'INVALID_RUNTIME_STATUS_INPUT',...PROFILE});
    return reply.code(503).send({error:'RUNTIME_STATUS_UNAVAILABLE',...PROFILE});
  });
  app.get('/api/v1/admin/stocks/runtime',{exposeHeadRoute:false},async request=>{
    if(request.body!==undefined)throw new StocksError('INVALID_RUNTIME_STATUS_INPUT',400);
    // The source is synchronous and read-only. It is called exactly once after authorization.
    try{return envelope(options.getSnapshot());}catch{throw new StocksError('RUNTIME_STATUS_UNAVAILABLE',503);}
  });
}
