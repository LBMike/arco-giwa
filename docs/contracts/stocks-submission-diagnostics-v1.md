# Stocks wallet submission diagnostics v1

Read-only diagnostic for a named signed operator with runtime `stocks:read` permission. This endpoint does not authorize a wallet request or verify a receipt.

## HTTP contract

`GET /api/v1/admin/stocks/wallet-submissions/:side/:orderId`

- `side`: exactly `BUY` or `SELL`.
- `orderId`: `[a-zA-Z0-9:_-]{1,100}`. No other path selectors, query string (including an empty `?`) or request body. No implicit HEAD route or mutation endpoint.
- The HTTP100-character limit follows the existing default Fastify router; internal service labels remain128 characters.101+ characters receive the existing router414 (`FST_ERR_MAX_PARAM_LENGTH`) response, outside this route's authentication/error-envelope/no-store guarantees. The400 rules below apply to matched routes. No global router setting changes.
- The existing signed-session operator resolver is authoritative. A nonblank named operator and `stocks:read` permission are required. Shared operator tokens, browser role headers and request-body identities confer no authority.
- Authentication occurs in `onRequest` before input validation/body parsing or service access. Every matched route response, including errors, is `Cache-Control: no-store`. Existing application CORS applies.
- Success is the existing Stocks PROFILE envelope: `{profile:'DEMO_TESTNET',valuePolicy:'TEST_VALUE_ONLY',brokerMode:'MOCK_BROKER',chainId:91342,priceSource:'FIXED_MOCK_PRICE',observedAt,data}`. `observedAt` comes from the service's coherent database snapshot, never a replacement browser or handler timestamp.
- `data` has the frozen shape in `server/src/stocks-submission-diagnostics/contracts.ts`. `publicSnapshot` validates and constructs the public whitelist. The route also requires returned order side/id to match the requested route.

| Status | Fixed error code | Meaning |
| --- | --- | --- |
|403|`OPERATOR_FORBIDDEN`|No accepted named operator with `stocks:read`, including resolver errors.|
|400|`INVALID_SUBMISSION_DIAGNOSTICS_INPUT`|Unsupported side/id, query or body.|
|404|`ORDER_NOT_FOUND`|Service explicitly reports no order in the current deployment.|
|503|`SUBMISSION_DIAGNOSTICS_UNAVAILABLE`|Inconsistent snapshot, timeout, service failure or invalid public result.|

Errors contain only `{error,...PROFILE}`. Only `StocksError('ORDER_NOT_FOUND',404)` from the service is passed as404; arbitrary error messages/statuses and raw database/RPC/configuration values are never returned. An absent service means optional app registration is absent; that wiring is owned by the integration task.

## Public meaning

The summary includes deployment identity; order id/side/state/wallet/version/deadline and quote-expired flag; enrollment state and physical intent key; optional APPROVAL/TRANSFER records with claim/digest/status/hash/timestamps and optional receipt status/block/verification time. It excludes actorId, transaction calldata, raw proof/evidence JSON, internal configuration and raw errors.

`readOnly:true`, `executionAuthorization:false` and `resubmissionAllowed:false` always. A null stage, REQUEST_MAY_START or NOT_ENROLLED is historical diagnostic data, never permission to sign or recreate a claim. CONFIRMED is a trusted receipt result, not Stocks order completion. Expired/paused orders and historical unenrolled orders in the supported ARCO_TEST_USDC deployment remain readable without new enrollment, verification or mutation. This endpoint does not expand the wallet protocol to RLUSD.

`receipt.verifiedAt` is the existing proof row's database `createdAt`: the time its verification result was persisted, not a new RPC observation or chain block timestamp. `observedAt` is the database statement time for the first order read; quoteExpired is evaluated against that same serialized snapshot time. A request finishing after a deadline may still describe an earlier unexpired snapshot; this is never permission to execute.

The service owns current-deployment scoping, immutable order/actor/wallet/intent/transaction bindings, bounded repeatable-read read-only snapshot and proof consistency. No tick, claim, record, reconcile, signing, RPC or pause mutation is invoked by this route. Service/database behavior is verified separately from plugin tests.

The transaction is REPEATABLE READ READ ONLY with 2-second statement/lock timeouts, 3-second idle timeout and a 2.5-second whole-operation monotonic limit including pool acquisition. A delayed acquisition is released without SQL; a late in-flight query cannot trigger the next normal query or a successful response. A stalled transport may delay rollback/release until the pending query settles; the HTTP response still has its bound. Reads do not use row or advisory locks. Related enrollment/submission records are selected by both physical intent and side/order identity so a corrupt binding cannot be hidden as an empty stage.

Terminal submissions require a matching proof; nonterminal submissions must have none. Stored proof digest and envelope bindings are checked. Proof JSON over 256 KiB is rejected before transferring the evidence value to the service. Full evidence is used internally only for consistency checking and is never returned. This checks stored evidence integrity; it does not independently re-verify the chain or allow an operator to reset/retry a claim.

## Offline plugin checks

`server/src/stocks-submission-diagnostics/plugin.test.ts` uses explicit in-memory reader/resolver fixtures through Fastify injection. It covers auth-before-input/service, forbidden resolver/permission cases, input rejection, exact public whitelist, side/id binding and100-character router boundary (101+ remains the existing414), fixed error mapping, no-store and absence of implicit HEAD/mutation routes. It does not substitute for actual signed-session or PostgreSQL integration tests owned by root.
