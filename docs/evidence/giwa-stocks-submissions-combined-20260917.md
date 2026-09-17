# Durable wallet submissions — combined verification

Date2026-09-17. Root checkout `/private/tmp/arco-giwa-submission-integration-20260917`, branch `codex/giwa-submission-integration-20260917`. Code HEAD `77cc3a9d8fe92fab787307caf86980c0266c79fc`.

## Included changes

Previous accepted screen/server integration a50e2f9 plus reviewed wallet module518bcb5/policy9389723 (local185fcbb/d4668ff). Task contract00ddcf4 and historical enrollment amendment34735a7 were written before implementation. Backend95c5fae imported as671d5f1; browser e829807 imported asbd9dfc2; root optional registration and integration tests77cc3a9.

- New orders atomically enroll in the same transaction as their creation; historical orders are not backfilled or enrolled on an idempotent retry.
- An authenticated server journal derives the physical wallet/order/token/spender identity and exact calldata. One durable claim per stage, with cross-stage serialization. Only a newly committed claim returns submission permission; a repeated request returns no new permission.
- Outcome observations preserve the original binding and known hash. A client cannot mark a receipt confirmed/reverted or clear a claim. Expiry/pause does not erase recovery history.
- The HTTP adapter captures its original session and request scope, validates responses, bounds request/body time and size, and never resends automatically or persists tokens in browser storage.
- Actual app/index wiring is optional and shares the Stocks wallet session resolver. Disabled Stocks runtime leaves these routes absent. No frontend wallet buttons or execution policy/receipt ports were activated.

## Root verification

| Check | Outcome |
| --- | --- |
| Full server, including new app authentication/CORS tests | 140 pass,40 DB-dependent skips |
| Fresh PostgreSQL: original BUY/SELL32 + new journal8 + actual API→browser adapter2 | 42 pass,0 skip |
| PostgreSQL stop/start and separate Node process recovery | PASS |
| Full frontend with host DOM runtime | 388 pass,1 ABI-environment skip |
| Exact skipped Solidity ABI round-trip with explicit Stocks artifacts | 1 pass,0 skip |
| Backend/browser planner parity | 1 pass |
| Production build (includes typecheck), security, whitespace | PASS |
| Story hook | PASS |
| Design-token hook | Existing7 findings; no new frontend view changed |

The2 roundtrip tests use real buildApp, wallet JWT resolver, PostgreSQL service and browser adapter. Fastify injection is the HTTP transport; no loopback/public listener is needed. They prove response-loss-after-commit recovery, client recreation, hash preservation, six simultaneous clients receiving one permission and cross-wallet read denial. No fake persistence is used. The32 legacy PG tests verify the enrollment hook does not regress existing buy/sell handling.

Logs `/private/tmp/giwa-submissions-combined-{server,postgres,frontend,build,security,abi-fixed,parity,tokens,stories}.log`. Initial ABI test path omitted the nested `stocks` artifacts folder and failed ENOENT; the corrected exact test passed. The initial full frontend skip is not counted as a pass in that run.

Owned PostgreSQL `/private/tmp/stocks-submissions-pg-B3xS6E`: fsync on, TCP disabled, private Unix socket, fresh database only, one restart, PIDs17301→17426. Harness evidence confirms stopped=true and no retained postmaster PID. Existing databases were not accessed. Ignored dependencies/artifacts were reused via explicit symlinks after matching lock/contract sources; no install, Solidity rebuild or migration against an existing DB.

## Independent review

Client e829807 independent PASS:21 existing+5 reviewer boundaries, build/security/diff. `/private/tmp/arco-giwa-stocks-submissions-review-evidence-20260917/client/README.md`.

Backend95c5fae independent PASS: fresh PostgreSQL11/11 (builder8 plus independent SELL historical retry, SELL enrollment/reservation rollback, deadline after lock wait), actual PG/Node restart, offline3/build/security/schema. Root77cc3a9 independent PASS: complete four-file diff review, authentication/optional registration/CORS3/3 and build:server; exact backend/client source parity with95c5fae/e829807 confirmed. No confirmed remaining findings. Independent counts are43 direct checks total (client26+backendoffline3+PG11+app3), plus restart; do not add these to root counts as unique tests. The independent database was also stopped after verification.

## Test environment recovery

The first sandboxed initdb leaked a56-byte control segment before failing. System IPC capacity then prevented the elevated retry. Root matched this task's failure log key77719523 to segment43778078, confirmed zero attachments, dead creator13435, and removed test directory. A guarded cleanup removed ONLY that owned orphan; other IPC entries and running DD/CFO databases were untouched. All subsequent PG runs began elevated and shut down their own clusters normally. Original failed logs are retained under `/private/tmp/stocks-submissions-pg*.log`.

## Remaining scope

This milestone is the durable wallet submission gate. It is distinct from investor create-order request recovery; that existing uncertainty behavior is unchanged. There is no trusted receipt reconciliation, so client CONFIRMED/REVERTED reports remain rejected and an approval claim cannot yet unlock a transfer. Verified deployment/current policy/active wallet adapters and actual UI execution remain unconnected. The gate governs cooperating application clients, not direct out-of-band contract calls. No actual signature, public RPC/provider call, public deployment, main-branch merge, or real-value trade occurred. Massive live feed/key/entitlement remains unavailable as before.
