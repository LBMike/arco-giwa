# GIWA-STOCKS-PREFLIGHT-001 — backend completed

Code: `7e431da7c595be70e49d24f712b54c63c84f8433`, branch `codex/giwa-preflight-20260917`, base `323e94b` (accepted local order recovery increment).

Checkout: `/private/tmp/arco-giwa-preflight-20260917`.

## Delivered

Operator CLI aggregates fixed-code, redacted readiness findings. Default offline mode does not initialize external clients. Explicit online mode checks migrated Stocks table presence/read privileges, all repository migration checksums/statuses, physical vault binding, existing full deployment verification and external signer capabilities. Required paused-start configuration is checked before probes. The tool never starts the runtime or returns trading authorization.

Database checking is read-only with statement/lock/phase deadlines and late-result cleanup. The operator pool is closed on success/failure. A late connection performs no SQL; a late query permits only rollback/release. Unbound vaults are reported without creating a binding. CLI rejects malformed arguments, never loads dotenv, and prints no input URL, credential or raw error.

Only new backend/CLI files and dedicated documents are changed. UI, application entrypoints, existing runtime behavior, contracts, deployment registry, migrations, dependency manifests and lockfiles are unchanged. No merge into the original checkout, push or public deployment was performed. This increment was implemented and verified in this task, without a new independent subagent review.

## Verification

| Check | Result |
| --- | --- |
| Full server | 230 passed, 60 gated DB cases skipped, 0 failed |
| Fresh PostgreSQL | 60/60 passed, 0 skipped: prior55 + preflight5 |
| Actual DB stop/start + new Node process | BUY/SELL recovery and existing terminal proof persistence passed |
| Existing frontend with DOM and compiled ABI gates | 402/402 passed, 0 skipped |
| Server compilation, typecheck, frontend build, security | Passed |
| Whitespace | Passed |
| Design tokens | Existing 7 findings unchanged |
| Story structure | Passed, inherited soft warnings |

New coverage is 17 non-DB tests plus 5 PostgreSQL tests. It covers offline/disabled zero external initialization; aggregated missing settings; invalid manifest/signer URL/operators/pause/DB schema; no secret echo; independent synchronous/asynchronous probe failures; no trading authorization on success; timeout and synchronous late-result denial; late DB acquisition and query cleanup; real PostgreSQL READ ONLY; missing/readable tables; missing/changed/unfinished/duplicate/unknown/rolled-back migration histories; unbound/matching/conflicting vaults; table-lock timeout; real adapter pool termination; actual CLI output/exit codes.

The PostgreSQL harness applies Stocks migrations directly. Prisma history entries are explicit test fixtures with repository checksums; this is not a run of Prisma migrate deploy or proof of an operating database's migration history. These diagnostics are not a complete schema/trigger diff, write-privilege verification, signer durability audit, live observer check or ledger reconciliation. The contract documents these limits and the later paused-start/observation sequence.

Dependencies and ignored compiled contract artifacts reuse the prior accepted checkout; source and lockfiles match. No installation was needed. The unchanged frontend build retains the existing large-chunk warning. No live GIWA RPC, real signer, user wallet, production DB or secret file was accessed. Local EVM scenarios were not rerun for this diagnostic-only increment; the full server suite includes the existing deployment-verifier regressions.

## Commands and evidence

```sh
npm run test:server
node scripts/stocks-submissions/test-postgres.mjs server/dist/stocks/stocks.postgres.test.js server/dist/stocks-execution/service.postgres.test.js server/dist/stocks/order-recovery.postgres.test.js server/dist/stocks-preflight/database.postgres.test.js
GIWA_HOST_DOM_RUNTIME=/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json GIWA_STOCKS_ARTIFACTS=/private/tmp/arco-giwa-preflight-20260917/packages/contracts/artifacts/stocks npm run test:frontend
npm run typecheck
npm run build
npm run test:security
npm run design:tokens
npm run design:stories
git diff 323e94b --check
```

Logs: `/private/tmp/giwa-preflight-{server,postgres,frontend,build-server,typecheck,build,security,tokens,stories}.log`. Earlier focused log has 17 passes and 4 DB skips before the fifth DB case was added; final counts above use the complete final server and PostgreSQL runs.

Final owned PostgreSQL evidence: `/private/tmp/stocks-submissions-pg-n4sijK/harness-evidence.json`; TCP disabled, started=true, stopped=true, restarts=1, owned initial/restart PIDs 48925/49103. Absence of postmaster.pid verified. All invoked test processes completed and the temporary database was stopped; unrelated services were not managed.

Usage and limitations: [stocks-preflight-v1.md](../contracts/stocks-preflight-v1.md).
