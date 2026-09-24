# Stocks runtime status API v1

GET `/api/v1/admin/stocks/runtime` provides process-local operator diagnostics. Root composes the optional plugin only when Stocks runtime exists; absent runtime means route absent. No UI, database, RPC, signer, tick, timer or pause mutation is introduced by this endpoint.

The operator plugin authenticates in onRequest before input parsing/source access, rejects query/body inputs, and whitelists one synchronous snapshot into the existing envelope. Snapshot validation lives in `snapshot.ts` and is shared with the coarse infrastructure probe below. The operator route's authentication and wire format remain unchanged.

The plugin accepts `getSnapshot: () => StocksRuntimeSnapshot` and optional `resolveOperator(request): Promise<Operator|null>`. The resolver must be the existing signed named-operator session resolver. A nonempty operatorId and `stocks:read` permission are required. Shared legacy tokens, headers, browser role and request payload cannot grant permission. Missing/invalid/failed resolution returns fixed 403 OPERATOR_FORBIDDEN before snapshot access or body handling.

Query parameters and nonempty GET request bodies are not accepted. Invalid input is 400 INVALID_RUNTIME_STATUS_INPUT. Snapshot failure, malformed source data or inconsistent state is fixed 503 RUNTIME_STATUS_UNAVAILABLE. Every endpoint success/error is Cache-Control: no-store. HEAD is not automatically exposed. Existing explicit CORS belongs to app integration.

Success uses exactly PROFILE's five fields, outer ISO observedAt, and data. data whitelists enabled, runtimeState, deploymentId, deploymentDigest, autodispatch, configuredPause, observerStatus, lastObservationAt, lastCurrentAt, lastCurrentAgeMs, freshnessLimitMs, tickInFlight, newOrdersPaused, pauseReasons, executionAuthorization. observedAt appears only in the outer envelope. Extra internal source/config/error properties are neither returned nor needed to create the response.

The fixed values are enabled=true, freshnessLimitMs=60000 and executionAuthorization=false. STOPPED runtime and STOPPED observer must agree. Pause reasons have deterministic order: RUNTIME_STOPPED, AUTODISPATCH_DISABLED, CONFIGURED_PAUSE, OBSERVER_NOT_CURRENT, including each exactly when its corresponding predicate holds. newOrdersPaused equals whether this list is nonempty. CURRENT requires valid last-current time and finite nonnegative reported age at most60000; its observed wall time must independently be within60000 of last-current time, and reported age cannot be less than this wall age. Runtime age is ceil(max(wall elapsed, monotonic elapsed)); exactly60000 is permitted. The runtime source owns monotonic freshness; this adapter cannot reconstruct a process monotonic clock from ISO timestamps. Non-current diagnostics can retain historical timestamps after an invalid clock without granting CURRENT. The root runtime latches stale state on invalid/backward clocks until a new valid CURRENT observation. lastObservationAt is the last observer/tick result or caught failure time; GET and stop do not refresh it. STOPPED with tickInFlight=true is valid while shutdown awaits a running tick.

This is process-local status, not database/canonical-chain health or evidence of reconciliation/settlement, permission to place orders or send a transaction, or an activation mechanism. A CURRENT observer may still have other pause reasons, and no successful diagnostic response grants execution authorization.

## Optional persistent operator control

With `operatorControls: true`, data also includes `operatorControl: { status, version }`.
`PAUSED` and `RESUMED` require an integer version 0–2147483647; `UNAVAILABLE` requires null.
Without this option the property is absent and the original wire shape is unchanged.
The ordered pause reasons become `RUNTIME_STOPPED`, `AUTODISPATCH_DISABLED`,
`CONFIGURED_PAUSE`, `OPERATOR_PAUSE` or `OPERATOR_CONTROL_UNAVAILABLE`, then
`OBSERVER_NOT_CURRENT`. A resumed manual gate cannot remove any other reason.

This field is a process-local snapshot refreshed by runtime ticks and control
reads/changes. It expires after 5000 ms using both wall and monotonic clocks;
clock reversal or an unreadable control store makes it unavailable. This endpoint
continues to perform no database/RPC reads. Another process's change may appear
at its next refresh; read the [control endpoint](stocks-trading-control-api.md)
for authoritative DB state. New admissions always read the control store and do
not use this diagnostic cache as permission. `configuredPause` still reports
only the fixed startup setting.

## Infrastructure readiness

GET/HEAD `/ready/stocks` is a separate, unauthenticated, coarse probe registered only
when the Stocks runtime exists. It does not use the operator resolver or expose the
operator diagnostic envelope. Every valid probe reads and validates exactly one
synchronous runtime snapshot; its fixed response is
`{ "ok": true|false, "service": "arco-giwa-stocks", "executionAuthorization": false }`.
All responses are `Cache-Control: no-store`. Query/body inputs return 400 before
reading the source. Source errors and invalid snapshots return fixed 503 without
exception details. Other HTTP methods do not trigger the snapshot source.

200 requires RUNNING, autodispatch enabled, CURRENT observation and no UNAVAILABLE
operator-control cache. Configured/manual pause and an in-flight tick do not by
themselves fail readiness. An omitted operator-control cache is supported for
runtimes without that optional feature. All other valid states return 503.
Freshness is recalculated by the existing runtime source on every call, including
the observer's 60-second and optional control cache's 5-second limits. Requests
do not refresh those clocks, perform dependency I/O, or trigger a tick.

This is not a full dependency health check or trading authorization. Keep `/health`
for liveness and retain `/ready` for legacy readiness. See the
[container guide](stocks-backend-container.md#상태-확인과-종료) for deployment scope
and why a shared API must not lose operator access during a Stocks outage.
