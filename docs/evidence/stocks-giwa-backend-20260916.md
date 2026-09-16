# STOCKS-GIWA-001 implementation evidence

Base: `8160f354b55dfe9a525565e30ddc007f51448f3d`.
Commander `/root`; builder `/root/giwa_stocks_builder`, branch `codex/stocks-giwa-backend-20260916`; independent reviewer `/root/rwa_reviewer` in a separate review checkout. Claude counter-review remains required before integration/release. Canonical approved task: commander worktree `docs/tasks/stocks-giwa-backend-20260916.md`.

Scope changed only within allowed new Stocks backend/scripts/docs and additive Prisma Stocks models/migration. No runtime entrypoint, frontend, dependency/lockfile, existing model/migration, contract source, deployment registry, environment/credential or sibling source was edited. Local generated node_modules/artifacts copied only from the same GIWA repository for verification. No broadcast, deploy, broker/network request or existing database access.

Implemented: exact actor-bound quote/order, durable scoped outbox/mock-provider receipt, raw finalized RPC receipt verification, mint confirmation/holding projection, received-funding suspense/refund flow, read-only admin detail/reconciliation, SQL immutable balanced journal pairs and concurrency constraints. Composition remains unactivated and externally injected; no UI or full stock sell implementation.

Final verification:
- Typecheck and frontend production build passed; existing dependency/chunk warnings unchanged.
- Frontend: 175/175 passed.
- Server baseline plus Stocks unit/HTTP: 73 passed; dedicated PostgreSQL cases are explicitly skipped in the generic server command because it receives no database environment. They passed separately in the real disposable PostgreSQL harness.
- Stocks unit/HTTP: 11/11 passed, including JSON-RPC adapter → verifier mint receipt with zero sender topic, and canonical call digest stability across PostgreSQL JSONB key ordering with every call identity field bound.
- Security env-exposure and GIWA EVM-version checks passed.
- Prisma client generation passed with additive FK relations.
- Reviewed DB-001 inspector at `329a3f6c672d324cc93615393253a9b1b8ee7182` passes full base history + Stocks migration, including BEFORE TRUNCATE guards. DB-001 is a separately owned prerequisite and is not copied into this implementation branch.
- Real PostgreSQL 18.6: dedicated complete migration-history harness passed 20/20, zero skips, including explicit expired-quote rejection. Own server shutdown confirmed.

The first real database execution exposed a concrete bug: JSONB reordered authorized call fields, changing naive JSON.stringify hashes. Recursive canonical JSON now binds manifest, signer call and durable mock broker request identities independently of object property order. Unit and real-PG buy/mint/refund tests cover this boundary.

The harness initially could not start because PATH initdb was libpq-only and sandbox initialization left one proven task-owned unattached shared-memory shim. Commander verified the exact IPC key/time/creator provenance and removed only that orphan slot; unrelated active clusters were untouched. Subsequent explicitly unsandboxed, sequential one-cluster runs succeeded. Cleanup confirms its postmaster stopped before deleting its directory; ambiguous start or stop failure retains the task path for recovery. No existing database/credentials or TCP listener is used.

Dedicated harness command: `STOCKS_PG_BIN=/opt/homebrew/Cellar/postgresql@18/18.6/bin node scripts/stocks/test-postgres.mjs`. It applies all base migrations plus Stocks on one fresh disposable database, builds server, runs Stocks PG tests, and stops/removes its own cluster in finally.

Real-PG evidence includes duplicate/concurrent order/event/worker operations; actual child-process SIGKILL after a durable broker receipt and before local completion, followed by new-worker original-operation recovery; signer UNKNOWN lookup without resubmission; pause with recovery polling; actor isolation; wrong-wallet dust; late/under/over/second/unallocated funding; independently finalized refunds; completed-order preservation; rejected partial/mismatched evidence; append-only UPDATE/DELETE/TRUNCATE, exact numeric constraints, CAS and atomic rollback; deployment reset; independent chain reconciliation; mutating port adapters; and an independent deterministic five-order cash/holding conservation oracle across reordered funding, replay and refund outcomes.

Remaining gates: independent reviewer acceptance, Claude counter-review, approved runtime integration/observer coverage/signing activation and new Stocks contract deployment. No implementation self-approval or actual GIWA on-chain validation is claimed from fixtures. No UI/full sell/Alpaca/XRPL implementation is included.
