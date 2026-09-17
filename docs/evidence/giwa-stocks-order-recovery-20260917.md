# GIWA Stocks order response-loss recovery — completed backend increment

Code: `dd8bab2` on `codex/giwa-order-recovery-20260917`, based on accepted execution API `ba8ad1e`. Checkout: `/private/tmp/arco-giwa-order-recovery-20260917`.

## Outcome

Authenticated BUY/SELL recovery endpoints locate a committed order using the original quote/key, scoped to the session actor, wallet, current deployment and side. They remain usable during a trading pause and after expiry. One parameterized SELECT performs recovery; no new order, audit, enrollment, binding, reservation, claim or chain action is created. Existing creation serialization and economic behavior are unchanged.

Authentication precedes JSON parsing. Exact request fields, no query input, no-store on success/errors, owned quote/key conflicts and sanitized errors are covered. A 404 does not establish that an in-flight creation cannot later commit. The API contract explicitly requires retaining the original pair and prevents treating recovery as execution permission.

UI, contract source, public deployment registry, schema, dependency manifests and lockfiles are unchanged. Claude Code owns the remaining UI persistence and recovery integration. This is a local backend development branch; no production/public deployment or original checkout merge was performed. No independent subagent review was run for this increment.

## Validation

| Check | Result |
| --- | --- |
| Full server suite | 213 passed, 55 gated PostgreSQL cases skipped, 0 failed |
| Fresh PostgreSQL harness | 55/55 passed, 0 skipped: legacy32 + journal8 + receipts4 + execution5 + new recovery6 |
| Actual PostgreSQL stop/start and new Node process | Existing terminal receipt proof plus BUY and SELL order recovery passed |
| Frontend regression with existing DOM runtime and compiled artifacts | 402/402 passed, 0 skipped |
| Type check, frontend build, server build, security checks | Passed |
| Whitespace check | Passed |
| Design tokens | Same 7 documented pre-existing findings; frontend unchanged |
| Story structure | Passed with inherited soft warnings |

New unit/HTTP coverage comprises 6 tests, included in the server count. PostgreSQL recovery coverage exercises both sides: 8 concurrent create requests collapse to one order; paused and genuinely expired orders remain recoverable over Fastify; actor/wallet/deployment/side mismatches remain invisible; a wrong quote produces an owned conflict; uncommitted and rolled-back creation is not visible; same-key retry after rollback succeeds; recovery does not change audit/enrollment/reservation/submission/binding counts. SELL reservation remains singular.

The initial isolated checkout lacked ignored contract artifacts, causing existing ABI-dependent server tests to fail. Existing artifacts were linked from the accepted base checkout, whose contract source is unchanged, then the complete suite passed. Dependencies reuse the accepted checkout's unchanged lockfile/runtime. There was no install or public RPC access. Local EVM scenarios were not rerun because this increment has no chain execution changes. Frontend build retains the existing chunk-size warning.

## Reproduction and evidence

```sh
npm run test:server
node scripts/stocks-submissions/test-postgres.mjs server/dist/stocks/stocks.postgres.test.js server/dist/stocks-execution/service.postgres.test.js server/dist/stocks/order-recovery.postgres.test.js
GIWA_HOST_DOM_RUNTIME=/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json GIWA_ADMIN_DOM_RUNTIME=/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json GIWA_STOCKS_ARTIFACTS=/private/tmp/arco-giwa-order-recovery-20260917/packages/contracts/artifacts/stocks npm run test:frontend
npm run typecheck
npm run build
npm run test:security
npm run design:tokens
npm run design:stories
git diff ba8ad1e --check
```

Logs: `/private/tmp/giwa-order-recovery-{server,postgres,frontend,typecheck,build,security,tokens,stories}.log`.

Final isolated database evidence: `/private/tmp/stocks-submissions-pg-MGwsXC/harness-evidence.json`, started=true, stopped=true, restarts=1; initial/restart owned PIDs 41366/41597. TCP disabled; postmaster.pid absence independently checked. Only this harness's database was managed. All test processes completed and the test database was stopped.

UI integration contract: [stocks-order-recovery-v1.md](../contracts/stocks-order-recovery-v1.md).
