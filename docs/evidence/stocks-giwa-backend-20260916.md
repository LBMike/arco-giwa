# STOCKS-GIWA-001 implementation evidence

Base: `8160f354b55dfe9a525565e30ddc007f51448f3d`.
Commander `/root`; builder `/root/giwa_stocks_builder`, branch `codex/stocks-giwa-backend-20260916`; independent reviewer `/root/rwa_reviewer` in a separate review checkout. Claude counter-review remains required before integration/release. Canonical approved task: commander worktree `docs/tasks/stocks-giwa-backend-20260916.md`.

Scope changed only within allowed new Stocks backend/scripts/docs and additive Prisma Stocks models/migration. No runtime entrypoint, frontend, dependency/lockfile, existing model/migration, contract source, deployment registry, environment/credential or sibling source was edited. Local generated node_modules/artifacts copied only from the same GIWA repository for verification. No broadcast, deploy, broker/network request or existing database access.

Implemented: exact actor-bound quote/order, durable scoped outbox/mock-provider receipt, raw finalized RPC receipt verification, mint confirmation/holding projection, received-funding suspense/refund flow, read-only admin detail/reconciliation, SQL immutable balanced journal pairs and concurrency constraints. Composition remains unactivated and externally injected; no UI or full stock sell implementation.

Verification at checkpoint:
- Typecheck and frontend production build passed; existing dependency/chunk warnings unchanged.
- Existing server tests + Stocks unit/HTTP: 72 passed, 15 PostgreSQL tests explicitly skipped without the dedicated harness environment (subsequently expanded to 16 PG scenarios).
- Stocks unit/HTTP: 10 passed, including JSON-RPC adapter → verifier mint receipt with zero sender topic.
- Security env-exposure and GIWA EVM-version checks passed.
- Prisma client generation passed.
- DB-001 reviewed inspector passed new migration before adding BEFORE TRUNCATE protection; those trigger declarations expose an inspector false positive assigned separately to DB-001 owner. Original branch inspector prerequisite is not included in this builder commit.
- Real PostgreSQL harness: NOT YET PASSED. PATH initdb was libpq-only; selected installed PostgreSQL 18.6 server tools via STOCKS_PG_BIN. Sandbox blocks shared memory; approved escalation then reports host SysV shmget (56 bytes) No space left on device, even mmap / shared_buffers16MB / max_connections20. The harness creates and cleans only its own temp directory/cluster, opens no TCP listener and uses no existing credentials. No other cluster or IPC segment was touched. This is a blocking missing verification, not a passing substitute.

Dedicated harness command: `STOCKS_PG_BIN=/opt/homebrew/Cellar/postgresql@18/18.6/bin node scripts/stocks/test-postgres.mjs`. It applies all base migrations plus Stocks on one fresh disposable database, builds server, runs Stocks PG tests, and stops/removes its own cluster in finally. PG tests cover duplicate/concurrent order/event/worker operations, restart after provider acceptance, UNKNOWN retention, pause/recovery, actor isolation, wrong-wallet dust, late/partial/mismatched funding/refund, completed-order second-payment refund, invalid evidence, append-only constraints/atomic rollback, deployment reset, independent reconciliation and mutating port adapters.

No implementation self-approval: status is REVIEW_REQUIRED / REAL_DB_VERIFICATION_BLOCKED until independent evidence resolves these gates. Actual GIWA on-chain validation is not claimed from fixtures.
