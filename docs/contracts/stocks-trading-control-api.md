# Stocks operator trading control API

This API controls a persisted manual admission gate for the current Stocks deployment. It is a DEMO_TESTNET feature and does not authorize a wallet transaction or broker execution. The runtime exposes these routes only when operator controls are explicitly enabled; without the service all three routes are absent (404).

## Optional activation and storage

The Stocks runtime configuration adds the optional boolean `operatorControls`. Omitted or `false` preserves the existing runtime behavior: no control routes are composed and the persisted manual gate is not consulted. Setting it to `true` enables both the manual gate and these routes. This configuration switch is therefore an activation decision, not an operator pause/resume command.

Apply `prisma/migrations/20260920000000_stocks_trading_control/migration.sql` through the existing migration workflow before enabling the feature. Startup verifies access to the control table and fails if it is unavailable; it never creates tables or a control row automatically. An enabled deployment with no row starts manually paused at version 0. A previously recorded state survives runtime restart. Server configuration must separately assign the intended named operator permissions.

Control state and audit events persist in PostgreSQL. This feature implements no age-based deletion or retention timer; database guards reject event modification, deletion and truncation. They are not CI artifacts, so any separately configured test-artifact retention window, such as seven days, does not delete this audit history. Archival or retention changes would require a separate reviewed database operation.

## Authority and transport

The existing signed wallet session resolver must identify a named operator from the server's configured directory. `GET` requires `stocks:read`; `POST` independently requires `stocks:control`. Neither permission implies the other. JWT role/permission claims, request body identity fields, `x-role`, and the legacy shared operator token grant no authority.

Authorization runs before parsing or validating the route's input and before any service call. A missing, invalid, expired, wrong-domain, or wrong-chain session receives `403 OPERATOR_FORBIDDEN`. Existing explicit CORS origins still apply.

Every matched-route response, including errors, includes `Cache-Control: no-store` and the fixed profile fields:

```json
{
  "profile": "DEMO_TESTNET",
  "valuePolicy": "TEST_VALUE_ONLY",
  "brokerMode": "MOCK_BROKER",
  "chainId": 91342,
  "priceSource": "FIXED_MOCK_PRICE",
  "observedAt": "2026-09-19T00:00:00.000Z",
  "data": {}
}
```

`observedAt` is the API response observation time, not the last control-change time. Every successful `data` object additionally contains `executionAuthorization: false` and `inFlightMayContinue: true`. Error envelopes have `data: null` and an `error` code. Public fields are copied explicitly; database metadata, idempotency keys, credentials, raw errors and additional service fields are not returned. Invalid service output becomes a fixed 503 response.

## Read current state

`GET /api/v1/admin/stocks/trading-control`

No query or body is allowed. `data` is `{ state, executionAuthorization: false, inFlightMayContinue: true }`. `state` contains exactly:

| Field | Meaning |
| --- | --- |
| `deploymentDigest` | Current deployment's lowercase 64-character hexadecimal digest. |
| `paused` | Manual admission gate; this is not the effective aggregate runtime pause. |
| `version` | Nonnegative integer from 0 through 2147483647. |
| `updatedAt` | Last recorded change time in UTC ISO format, or null initially. |
| `operatorId` | Server-resolved named operator responsible for the last change, or null initially. |
| `reason` | Recorded reason for the last change, or null initially. |

With no persisted row, reads return `paused: true`, `version: 0`, and null change metadata without creating a row. Enabling controls therefore starts closed until an authorized operator explicitly resumes the manual gate.

## Change the manual gate

`POST /api/v1/admin/stocks/trading-control`

Query parameters are forbidden. Send one JSON object with exactly these four fields; the request body limit is 4096 bytes:

```json
{
  "paused": false,
  "expectedVersion": 0,
  "idempotencyKey": "resume-control-1",
  "reason": "Verified local reconciliation"
}
```

| Field | Validation |
| --- | --- |
| `paused` | JSON boolean. `true` pauses; `false` resumes the manual gate. |
| `expectedVersion` | JSON integer from 0 through 2147483646 matching the currently read version for a new command. |
| `idempotencyKey` | 8–128 ASCII letters, digits, colon, underscore or hyphen. |
| `reason` | Nonempty string, 1–500 JavaScript UTF-16 code units; already trimmed; C0/C1 control characters and unpaired UTF-16 surrogates prohibited; valid surrogate pairs such as emoji are preserved. |

Server-resolved operator IDs also require well-formed UTF-16 with no unpaired surrogates. Invalid input is rejected before any control-store write, preserving exact text for idempotency.

The request does not accept `operatorId`, deployment identifiers, roles, permission overrides or timestamps. The server supplies identity and scope. A new accepted command atomically updates state and appends an audit event at `expectedVersion + 1`, including when the requested boolean already matches the current state. An identical retry using the same deployment-scoped idempotency key and operator returns the original event without another update. Reusing that key with another operator, command, reason or expected version produces an idempotency conflict.

`data` is `{ state, change, replayed, executionAuthorization: false, inFlightMayContinue: true }`:

- `state` is the observed current manual control state.
- `change` is the event recorded for this command.
- `replayed` is true when the event already existed.

The event's fields are `id`, `deploymentDigest`, `version`, `previousPaused`, `paused`, `operatorId`, `reason`, and `createdAt`. Its deployment must match `state`, and its requested values and operator must match the accepted command. `state.version` can be greater than `change.version` when later activity exists. In particular, replaying an old resume after a later pause reports the old resume event and the current paused state; it does not resume again. When the versions match, their paused value, operator, reason and change timestamp must agree.

## Read audit history

`GET /api/v1/admin/stocks/trading-control/history?limit=50&beforeVersion=10`

No body is allowed. Only the following optional query keys are accepted:

- `limit`: canonical decimal integer 1–100, default 50.
- `beforeVersion`: canonical decimal integer 1–2147483647; exclusive upper bound on event version.

Unknown or duplicate keys, arrays, signs, whitespace, leading zeros, exponent notation, fractions and out-of-range values are rejected. `data` is `{ items, nextBeforeVersion, executionAuthorization: false, inFlightMayContinue: true }`. Events use the same public fields as `change`, stay within one deployment, and are ordered by descending version. `nextBeforeVersion` is the last returned version when a further page exists, otherwise null. Use it as the next request's `beforeVersion`; each page is an observation rather than a transactionally frozen multi-page snapshot.

## Error contract

| HTTP | `error` | Caller action |
| --- | --- | --- |
| 400 | `INVALID_TRADING_CONTROL_INPUT` | Correct the request; no control-service call occurs for route-level validation errors. |
| 403 | `OPERATOR_FORBIDDEN` | Use a valid named operator session with the required server-assigned permission. |
| 409 | `CONTROL_VERSION_CONFLICT` | Read current state and review it before issuing a new command. |
| 409 | `CONTROL_IDEMPOTENCY_CONFLICT` | Reuse a key only for the identical command; review the intended action before assigning a new key. |
| 503 | `TRADING_CONTROL_UNAVAILABLE` | Control result is unavailable. Read/reconcile and retry the identical command/key if appropriate. |

Only exact recognized service error code/status pairs are public. An arbitrary error with a `statusCode`, SQL exception, serialization failure or malformed service result becomes `503 TRADING_CONTROL_UNAVAILABLE`. JSON parser, unsupported content type and body-size failures map to fixed 400 after authorization. A response failure after a committed write does not prove the change failed; preserve the idempotency key when reconciling it.

## Scope of pause and resume

A pause blocks subsequent admission checks that consult the manual gate. It does not undo an already admitted operation, revoke a previously issued wallet submission claim, invalidate an already issued 15-second execution policy, cancel a wallet prompt, or stop in-flight work. The control response always warns about this through `inFlightMayContinue: true`.

A resume clears only the persisted manual gate. It cannot override configured pause, disabled automatic dispatch, a stopped runtime, unavailable control storage, or reconciliation that is not current. Clients must read runtime status for the aggregate pause reasons. Cached runtime diagnostics are observations; they are not execution authorization. No control request changes session lifetime, order deadlines, signing policy, chain contracts, balances, refunds or escrow returns.

`GET /api/v1/admin/stocks/runtime` remains a synchronous diagnostic read. When controls are enabled it adds `operatorControl: { status, version }`, where status is `PAUSED`, `RESUMED`, or `UNAVAILABLE`. The process caches successful control observations for at most 5000 milliseconds, checked against both wall and monotonic clocks; expired or failed evidence becomes unavailable. A runtime-status request itself does not query or refresh the control database. The control-state endpoint reads the database, while ticks and admission checks also refresh observations. A second server's change can therefore take time to appear in a previously cached diagnostic, but subsequent admission checks consult shared database state rather than granting access from the cache.

Each admission check validates its own database result and read age. A slow, malformed, older, or contradictory result cannot borrow authority from a different concurrent successful read. The process retains the highest observed revision even after diagnostic-cache expiry; contradictory values for one revision stay unavailable until a higher revision is observed. Base runtime gates are checked again after an asynchronous control read, so a stop or loss of current observation during that read still blocks admission.

This API is not a hard emergency cutoff. Atomic cancellation of all in-flight workers, revocation of issued wallet claims or policies, and on-chain transaction blocking are outside this change. Operators must not infer those capabilities from either a successful pause response or the runtime diagnostic.

## Verification ownership

`server/src/stocks-trading-control/plugin.test.ts` verifies route permission ordering, strict bounds, no-store success/errors, output whitelisting, fixed error mapping and event/state consistency using Fastify injection. `app.test.ts` verifies actual application wiring and the signed-session resolver without opening a socket or database. Service and PostgreSQL tests separately verify persistence, concurrency, replay and deployment isolation.
