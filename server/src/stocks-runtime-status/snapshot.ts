import { PROFILE, StocksError } from '../stocks/contracts.js';
import { OBSERVER_STATES, type StocksRuntimeSnapshot } from './contracts.js';
import type { OperatorControlStatus } from '../stocks-trading-control/contracts.js';

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
export function runtimeStatusEnvelope(raw: StocksRuntimeSnapshot) {
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
