# GIWA-STOCKS-SESSION-OUTCOME-RECOVERY-001 — verification

ACCEPTED for local backend contract verification. Tested code: `8a66ce0f09b507b165c35263a637e06cafa2114f`; base `eda0bc02bfa61fc72f4bb9305dbcf0255c4c3faa`. Verified branch `codex/giwa-session-recovery-verified-20260918`, checkout `/private/tmp/arco-giwa-session-recovery-root-20260918`. This evidence-only commit follows the tested code. The base UI 003B separately has a P3 session-notice wording correction pending; this backend acceptance does not close that UI finding.

## Delivered

Four PostgreSQL contract tests and `docs/contracts/stocks-session-outcome-recovery-v1.md`. The matrix is BUY/SELL times APPROVAL/TRANSFER. There is no new API, production behavior, UI recovery feature, migration, deadline extension, credential grace period or new claim permission.

The tests use the real signed HS256 session resolver, Fastify submission plugin/service, actual PostgreSQL migrations/constraints and receipt verifier over the labelled TestChain. A fresh short fixture quote is inserted before calling real createOrder/enrollment; existing immutable deadlines are never edited. Real JWT verification is not SIWE signature verification. TestChain is not an actual EVM or public network.

Expired credentials are rejected before malformed-body parsing, SQL or verifier RPC. Fresh same-owner credentials can inspect the existing claim and record the known original hash even while trading is paused and the order expired. Wrong owner, conflicting hash and client terminal status are rejected. Duplicate outcomes do not change timestamps or audits. Trusted proof can confirm a submission without completing the business order; new transfer admission still respects pause/deadline, and same-stage replay never re-grants permission.

## Root execution on exact tested code

| Check | Result |
| --- | --- |
| Fresh PostgreSQL, complete existing suite plus new matrix | **72/72 pass, 0 skip, 0 fail** (existing68 + new4) |
| PostgreSQL stop/start plus separate Node restart probe | BUY/SELL order recovery and durable submission/proof persistence PASS |
| Full backend default run | 330 pass / 72 DB-gated skip / 0 fail, total402 |
| Server compilation / frontend typecheck / security / whitespace | PASS |
| Frontend/build/design evidence | Reused same unchanged frontend from exact eda0bc0 root review; no additional frontend production changes |

The first full-backend invocation in this new clone lacked compiled contract artifacts and failed ENOENT in registry tests. The existing reviewed artifacts were linked without recompilation or dependency installation, then the full backend run passed as shown. The failed setup log is retained as `server.log`; the corrected result is `server-with-artifacts.log`. This environment failure is not hidden or counted as a pass.

The fresh PostgreSQL command, after server compilation:

```sh
node scripts/stocks-submissions/test-postgres.mjs server/dist/stocks/stocks.postgres.test.js server/dist/stocks/order-recovery.postgres.test.js server/dist/stocks-execution/service.postgres.test.js server/dist/stocks-preflight/database.postgres.test.js server/dist/stocks-submission-diagnostics/service.postgres.test.js server/dist/stocks-submissions/session-recovery.postgres.test.js
```

Root logs: `/private/tmp/arco-giwa-session-recovery-root-evidence-20260918/`. The new four matrix cases appear in postgres.log before the existing suites' final summary. Existing restart-probe coverage is separate; the four new scenarios themselves are not each replayed across the process restart.

Owned database evidence: `/private/tmp/stocks-submissions-pg-Cuz5KN/harness-evidence.json`. started=true, stopped=true, restarts=1, TCP=false, PIDs45369/46159. postmaster.pid absence confirmed. This disposable DB was reached only through its private local socket; no unrelated DB was used or stopped. The temporary browser fixture for the separate UI review was also stopped.

## Independent bounded review

`ledger_review` reviewed exact code8a66ce0 in `/private/tmp/arco-giwa-session-recovery-contract-review-20260918`. PASS, no confirmed defect. Independent server compilation passed; default-gate execution reported4 skips, correctly not claimed as PostgreSQL passes. Root alone ran the actual fresh database suite above. Report: `/private/tmp/arco-giwa-session-recovery-contract-review-evidence-20260918/README.md`.

The author worked independently in `/private/tmp/arco-giwa-session-recovery-contract-20260917`, branch `codex/giwa-session-recovery-contract-20260917`. Production UI/server behavior, Solidity, deployments, package locks and other source checkouts stayed untouched.

## Remaining boundary

The browser still has no explicit cross-session handoff for a known late hash. Check can inspect an existing claim and reconcile an already recorded approval hash; it cannot invent or attach a missing hash by itself. Claude 003B-1 must correct that notice and the old report's claim that a new backend endpoint is required. Actual local DB/EVM plus the mounted browser flow, response-loss/reload recovery, real-wallet compatibility and public-network finality remain separate work. No public RPC, actual wallet, signature, transfer, push, original/main merge or deployment occurred.
