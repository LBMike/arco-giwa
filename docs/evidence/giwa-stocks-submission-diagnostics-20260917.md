# GIWA-STOCKS-SUBMISSION-DIAGNOSTICS-001 — verification

Status: ACCEPTED for local backend integration. Code: `2256f82d235786ba23ae3e9140a80cbd3d67a145`, branch `codex/giwa-submission-diagnostics-20260917`, checkout `/private/tmp/arco-giwa-submission-diagnostics-20260917`. Base: `97b2a2ad08cbbd98b1e2404501d10d734ec9fcf5`. Root validation and independent final review passed with no confirmed unresolved finding. This is not public deployment or wallet UI acceptance.

## Delivered

GET `/api/v1/admin/stocks/wallet-submissions/:side/:orderId` is optionally wired into the existing app and server entrypoint. A configured, signed, named operator with `stocks:read` can inspect the current deployment's order, enrollment, approval/transfer claims, observed hashes and persisted trusted receipt summaries. The view works after quote expiry and during pause. It creates no receipt proof or retry permission, and a confirmed transfer receipt never becomes a completed order by inference.

The database snapshot uses REPEATABLE READ READ ONLY, with statement/lock/idle limits and a whole-operation 2.5-second monotonic bound. Conflicting physical/order/actor/wallet/deployment/transaction bindings and inconsistent or corrupt proof records fail closed. The endpoint returns a validated public whitelist, original snapshot time and fixed errors with no-store. No private evidence JSON, calldata or actor IDs are returned. The 100-character HTTP ID limit preserves the existing router behavior; 101+ characters are router414 before this route's hooks, as documented.

No frontend/Claude files, Solidity, schema/migration, deployment registry, dependencies or lockfiles changed. No new operator mutation, claim reset, refund, signer or automatic reconciliation path was added.

## Root execution

| Check | Result |
|---|---|
| Feature service/plugin/signed-app tests | 51/51, no skips |
| Full backend | 327 passed, 68 database cases skipped, 0 failed |
| Fresh local PostgreSQL | 68/68, no skips; includes 8 new diagnostics cases |
| Database restart + new Node process | Existing BUY/SELL recovery and durable terminal receipt records restored |
| Existing frontend with DOM and compiled ABI | 402/402, no skips |
| Typecheck, server/frontend build, security, whitespace | Passed |
| Design checks | Existing 7 color-token findings unchanged; no hard story-structure violations |

The feature's PostgreSQL cases cover BUY/SELL REQUEST_MAY_START, UNKNOWN, SUBMITTED, CONFIRMED and REVERTED; hash absence; confirmed transfer versus pending order; expiry/pause; historical USDC orders without enrollment; current-deployment isolation; read-only flags and unchanged persisted facts. A concurrent real transaction commits terminal receipt verification after the first order SELECT: the first diagnostics result remains the earlier pending snapshot, and the next read sees confirmation. An exclusive table lock produces a bounded503 and a successful subsequent read after release.

The 51 focused cases are service29 + plugin19 + signed-app3, already included in the full server count. Test totals overlap and must not be added as independent coverage. API builder independently ran its19 tests; database builder only compiled/gated its8 tests, and root performed the real database execution.

## Execution evidence and cleanup

Logs: `/private/tmp/arco-giwa-submission-diagnostics-evidence-20260917/{focused,server,frontend,build,postgres-retry,tokens,stories}.log`. Typecheck/security/whitespace exit0 are in the root tool trace. The frontend build retains existing dependency and chunk-size warnings.

Owned PostgreSQL evidence: `/private/tmp/stocks-submissions-pg-VLXFjJ/harness-evidence.json`, started=true, stopped=true, restarts=1, TCP=false, owned PIDs84565 and84777. postmaster.pid absence was checked after completion. No unrelated DB was used or stopped.

The first sandboxed initdb attempt failed on shared-memory permission and left one unattached56-byte IPC segment. An escalated retry revealed the host's32 shared-memory-ID limit was full. Only the segment created by that failed attempt (ID52428830, key0x04c0c133, creator83456) was removed after matching identity, zero attachments and dead creator. The fresh isolated harness then passed. Initial failure logs and stopped harness records are retained; other services/resources were untouched.

No actual EVM, public RPC, browser extension or real wallet was used in this milestone. The earlier backend's local EVM18 evidence remains historical. Existing fixtures supply trusted receipt test data to the actual persistence service; this is not public chain verification or product wallet integration.

## Independent review

Reviewer `ledger_review` checked exact code2256f82 in `/private/tmp/arco-giwa-submission-diagnostics-review-20260917`. Focused51/51 plus reviewer-authored adversarial7/7 = **58/58 passed**. Server build, security and whitespace passed; no confirmed unresolved finding. Reviewer source remained unchanged, and no DB/EVM service was started by the reviewer.

Independent probes include a real2.6-second event-loop stall, stalled pool acquisition and query completing after the2.5-second deadline, rollback/release-only behavior after late results, physical/order binding conflicts, proof integrity and actual app signed-auth-to-service-to-fake-SQL composition. Unauthorized requests perform no SQL and private errors never enter the response. These checks supplement root's real PostgreSQL evidence above; the focused51 overlap root's focused suite.

Independent report and original probes/logs: `/private/tmp/arco-giwa-submission-diagnostics-review-evidence-20260917/README.md`.

## Next boundary

Claude continues 003A frontend/controller/HTTP integration. This backend addition is optional and does not change its existing execution/order/submission contracts. The next product step remains active-wallet/source verification and mounting the execution panel, then full user-flow tests. This endpoint supports later operator troubleshooting but is not a queue/list UI or public activation gate.
