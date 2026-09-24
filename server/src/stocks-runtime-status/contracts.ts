import type { OperatorControlStatus } from '../stocks-trading-control/contracts.js';

export const OBSERVER_STATES = ['STARTING', 'CURRENT', 'STALE', 'CATCHING_UP', 'WAITING_PROJECTION', 'BUSY', 'UNAVAILABLE_OR_REVIEW_REQUIRED', 'STOPPED'] as const;
export type ObserverStatus = typeof OBSERVER_STATES[number];
export const PAUSE_REASONS = ['RUNTIME_STOPPED', 'AUTODISPATCH_DISABLED', 'CONFIGURED_PAUSE', 'OPERATOR_PAUSE', 'OPERATOR_CONTROL_UNAVAILABLE', 'OBSERVER_NOT_CURRENT'] as const;
export type PauseReason = typeof PAUSE_REASONS[number];

/** Read-only process-local diagnostic, never permission to submit a transaction. */
export type StocksRuntimeSnapshot = {
    enabled: true;
    runtimeState: 'RUNNING' | 'STOPPED';
    deploymentId: string;
    deploymentDigest: string;
    autodispatch: boolean;
    configuredPause: boolean;
    /** Omitted when operator control is disabled; cached diagnostic, never authorization. */
    operatorControl?: OperatorControlStatus;
    observerStatus: ObserverStatus;
    lastObservationAt: string | null;
    lastCurrentAt: string | null;
    lastCurrentAgeMs: number | null;
    freshnessLimitMs: 60000;
    tickInFlight: boolean;
    newOrdersPaused: boolean;
    pauseReasons: PauseReason[];
    executionAuthorization: false;
    observedAt: string;
};
