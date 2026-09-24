# GIWA-SIGNER-RUN-004 evidence — 2026-09-24

Base `70b3c42`; branch `codex/giwa-signer-run-004`; isolated worktree `/private/tmp/arco-giwa-signer-run-004`. Root is sole builder/integrator. Implementation contract and latest user authorization are recorded in [task](../tasks/giwa-signer-run-004.md).

## Delivered

A runnable check/serve CLI composes the existing durable signer with a sign-only AWS KMS adapter. Public configuration pins manifest/digest/initial nonce, KMS key identity, GIWA RPC and fee ceilings. Server-only IAM credentials are separate from the public JSON; no wallet key or seed is configured. No automatic migrations, account seed, cloud provisioning, public deployment, resending or replacement.

Native HTTP admission and shutdown drain preserve already accepted operations before closing PG/KMS. A timeout or cancellation stops follow-up readiness reads. SDK Sign uses one attempt, an official regional endpoint and a pinned key ARN. The adapter validates public key/SPKI and DER, normalizes low-s, recovers the expected signer and verifies exact EIP-1559 fields before existing signed-hash commitment and broadcast.

## Executed verification

- New KMS/config/lifecycle unit tests: **11 passed, 0 skipped**. Includes 24 varied nonces/high-s cases, malformed signatures/SPKI, provider identity, deadlines/late results, gas ceilings, real SDK retry middleware with a throttled mock HTTP handler (one wire call), startup cancellation and cleanup failure.
- Dedicated signer PG suite: **6 passed, 0 skipped**, plus real PostgreSQL stop/start signed-intent recovery and historical migration refusal.
- Extended real TCP + PG + local EVM scenario: **1 passed, 0 skipped**. Uses the actual signer host and KMS DER adapter; only the KMS signing port is replaced with a local test account. Check mode does not sign/listen. Native HTTP verifies auth, changed readiness, occupied-port/invalid-token/aborted startup cleanup, eight simultaneous repeats without new signatures, lost broadcast acknowledgement, shutdown while KMS signing is held, and recovery through a new host/pool.
- The same scenario mints 1 NVDA each to two local wallets, then escrows and redeems 0.5 from the first. Final first-holder stock `500000000`, escrow stock `0`, holder test cash `60000000`, vault test cash `60000000`. Exactly three signatures cover the two mints and one redemption. Original-transaction recovery signs/sends nothing additional. Marker: `SIGNER_HOST_TCP_KMS_MINT_REDEEM_RECOVERY_PASSED`.
- Separate money-path PG suite: **54 passed, 0 skipped**. Concurrency, process crash/replay, conservation/property checks, actual PG restart, and backup/restore all passed; snapshot contains 21 tables/1305 rows.
- Full server: **528 passed, 92 DB-only skipped, 0 failed**. Dedicated PG results above are separate; skips are not represented as passes.
- Full frontend with existing `GIWA_HOST_DOM_RUNTIME=/private/tmp/giwa-portfolio-dom/package.json`: **1040 passed, 8 skipped, 0 failed**. Earlier run without that optional DOM runtime was908 passed/22 skipped; the final recorded run supplies it. Existing React SSR warnings remain.
- `npm run typecheck`, `npm run build`, `npm run test:security`, `git diff --check`: passed. Build retains existing chunk-size warnings.
- `npm run prisma:migration:inspect`: unchanged four legacy alias findings (`p`, `s`, `change`, `current_state`); no schema/migration edited.
- Actual CLI invalid arguments/missing public file/forbidden `.env` path: exit1, empty stdout, one fixed sanitized diagnostic; no configuration or path echoed.

Commands: task-specific unit files under `server/dist/stocks-signer`; `TMPDIR=/private/tmp STOCKS_PG_BIN=/opt/homebrew/Cellar/postgresql@18/18.6/bin node scripts/stocks-signer/test-postgres.mjs`; the existing `scripts/stocks-submissions/test-postgres.mjs` with stocks, order-recovery and session-recovery PG test files; baseline npm scripts above.

Logs: `/private/tmp/giwa-signer-004-{unit,postgres,money-postgres,server,frontend-dom,typecheck,build,security,migration}.log`. Temporary signer PG/EVM children stopped; the money-path runner also stopped its owned PostgreSQL server. The existing4392 preview remains PID96850 and was not restarted. No user-owned worktree files were changed in this task.

## Corrections caught during development

The first native-listener test found Fastify mutating a frozen listen-options object; passing a copy fixed startup. A test adapter initially mapped an HTTPS URL to loopback, triggering the existing response-origin guard; the final test uses the already-supported explicit local-harness client URL and real fetch. Independent review identified socket-close versus async-operation drain and late readiness RPC issues; both were fixed and covered directly. All reported successful checks refer to the corrected implementation.

## Not claimed

No real AWS KMS/IAM request, cloud host provisioning, public Stocks contract deployment, customer-backend activation, personal MetaMask transaction, hosted CI run, push or merge was performed. The TCP test creates fresh host instances and pools; it is not a signer-CLI child-process SIGTERM test. AWS and public account/deployment details remain missing external inputs. The new runtime and runbook do not make the public4392 Stocks demo trade-ready by themselves. See [deployment and recovery runbook](../contracts/stocks-kms-signer-host.md).
