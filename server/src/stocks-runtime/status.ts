import { ensure, PROFILE } from '../stocks/contracts.js';
import type { PauseReason, StocksRuntimeSnapshot } from '../stocks-runtime-status/contracts.js';
import type { ObservationSnapshot } from './health.js';

export function runtimeSnapshot(input: {
  deploymentId: string; deploymentDigest: string; autodispatch: boolean;
  configuredPause: boolean; stopped: boolean; tickInFlight: boolean;
  health: ObservationSnapshot;
}): StocksRuntimeSnapshot & typeof PROFILE {
  const h = input.health;
  ensure(h.observedAt !== null, 'RUNTIME_STATUS_UNAVAILABLE', 503);
  const observerStatus = input.stopped ? 'STOPPED' : h.observerStatus;
  const pauseReasons: PauseReason[] = [];
  if (input.stopped) pauseReasons.push('RUNTIME_STOPPED');
  if (!input.autodispatch) pauseReasons.push('AUTODISPATCH_DISABLED');
  if (input.configuredPause) pauseReasons.push('CONFIGURED_PAUSE');
  if (observerStatus !== 'CURRENT') pauseReasons.push('OBSERVER_NOT_CURRENT');
  return {
    ...PROFILE, enabled: true, runtimeState: input.stopped ? 'STOPPED' : 'RUNNING',
    deploymentId: input.deploymentId, deploymentDigest: input.deploymentDigest,
    autodispatch: input.autodispatch, configuredPause: input.configuredPause,
    observerStatus, lastObservationAt: h.lastObservationAt, lastCurrentAt: h.lastCurrentAt,
    lastCurrentAgeMs: h.lastCurrentAgeMs, freshnessLimitMs: 60000,
    tickInFlight: input.tickInFlight, newOrdersPaused: pauseReasons.length > 0,
    pauseReasons, executionAuthorization: false, observedAt: h.observedAt,
  };
}
