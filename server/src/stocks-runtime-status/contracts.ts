export const OBSERVER_STATES = ['STARTING', 'CURRENT', 'STALE', 'CATCHING_UP', 'WAITING_PROJECTION', 'BUSY', 'UNAVAILABLE_OR_REVIEW_REQUIRED', 'STOPPED'] as const;
export type ObserverStatus = typeof OBSERVER_STATES[number];
export const PAUSE_REASONS = ['RUNTIME_STOPPED', 'AUTODISPATCH_DISABLED', 'CONFIGURED_PAUSE', 'OBSERVER_NOT_CURRENT'] as const;
export type PauseReason = typeof PAUSE_REASONS[number];

/** Read-only process-local diagnostic, never permission to submit a transaction. */
export type StocksRuntimeSnapshot = {
    enabled: true;
    runtimeState: 'RUNNING' | 'STOPPED';
    deploymentId: string;
    deploymentDigest: string;
    autodispatch: boolean;
    configuredPause: boolean;
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
