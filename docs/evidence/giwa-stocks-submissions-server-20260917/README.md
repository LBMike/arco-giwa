# GIWA-STOCKS-SUBMISSIONS-001 backend evidence

Base: `00ddcf49f2b7f8814f9e0093d39efd449d118031`. Branch: `codex/giwa-stocks-submissions-server-20260917`. Candidate SHA is the commit containing this evidence. Independent clone `/private/tmp/arco-giwa-stocks-submissions-server-20260917`; root app/index and browser adapter unchanged here.

## Direct execution

| Command | Exit | Result |
| --- | --- | --- |
| `npm run build:server` | 0 | Server build |
| `npm run test:server` | 0 | 137 passed, 40 skipped (32 existing DB + 8 new DB gated tests) |
| `node --test scripts/stocks-submissions/planner-parity.test.mjs` | 0 | 1 passed; BUY/SELL approval/transfer/identity parity with browser planner |
| `npm run test:security` | 0 | Existing security checks |
| `npm run typecheck` | 0 | Type check |
| `node node_modules/prisma/build/index.js validate --config /private/tmp/stocks-submissions-prisma.config.mjs` | 0 | Schema validation using explicit dummy local URL, no connection or dotenv |
| `node scripts/stocks-submissions/test-postgres.mjs` | 0 | Actual fresh PG 8/8 plus separate-process and PostgreSQL restart persistence probe |
| `git diff --check` | 0 | Whitespace |

Logs in this folder record the final runs. The real PG cases cover 12 concurrent claims and one winner, loss/recreation retry denial, cross-stage concurrency, immutable binding/hash and no delete/truncate, wrong actor/wallet/side/deployment/calldata, physical unique constraint, historical-order fail-closed enrollment and idempotent retry, enrollment/claim audit rollback, expiry/pause recovery and actual Fastify SELL routes. The expiry fixture inserts a fresh synthetic short-lived quote then calls production order creation; existing immutable order/quote triggers remain unchanged.

Owned instance `/private/tmp/stocks-submissions-pg-cRHhcB`, PIDs 15493 then 15542 after restart. Unix socket only, TCP disabled. Final `harness-evidence.json`: started=true, stopped=true, restarts=1. No surviving postmaster.pid. PG slot returned to root for integration checks. Existing 32 Stocks DB cases and integrated browser roundtrip are assigned to root's next combined-candidate run, not claimed as executed here.

## Resource and fixture troubleshooting

Initial sandbox initdb failed IPC permission allocation (owned temp tIUVbW); a subsequent elevated attempt encountered host SysV segment exhaustion (owned temp GUUzmm). Root independently matched orphan IPC 43778078/key77719523 to this task's first failed initdb, verified zero attachments/dead owner and removed only that owned segment. No unrelated IPC or database was changed. Fresh elevated runs then started successfully. First two running-PG attempts exposed invalid fixture mutations of existing immutable facts; both shut down in finally. Production immutable triggers were never loosened. Corrected one-time short-lived quote insertion passed the final full suite and real restart. A mistyped preliminary build command targeting nonexistent server/package.json failed before compilation; the proper root build passed.

## Provenance and limits

`node_modules` is a read-only symlink reused from `/private/tmp/arco-giwa-market-integration-20260917` after equal lockfile comparison (resolves to existing command-validation dependency cache). Ignored ABI artifacts copied from the same market checkout after same contract-source verification. No dependencies, package scripts, lockfile or ABI source changed.

This is backend code and isolated persistence evidence, not a production rollout. Historical orders remain unenrolled; no migration backfill. No trusted terminal receipt workflow exists, so approval claims retain the stage hold. Direct raw contract calls bypass this application gate. No real RPC, actual wallet, key, signature, broadcast, existing database, listener, deploy, push or merge was used. Root handles endpoint composition and reviewer performs independent acceptance on the frozen commit.
