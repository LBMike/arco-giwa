# STOCKS-GIWA-003 — SELL backend evidence

Base `3cd4f7bb789944e30998b208d456a6e04e6f2295`; builder `/root/giwa_stocks_builder`, branch `codex/stocks-giwa-sell-20260916`, own worktree `/private/tmp/arco-giwa-stocks-sell-20260916`. Commander `/root`; independent verifier `/root/rwa_reviewer`. Latest user-appointed verifier supersedes the earlier Claude-specific gate. Builder does not approve itself.

Scope: owned Stocks backend, existing Stocks test harness, additive Stocks Prisma models/new migration and two approved docs. Existing migrations, Savings/Funds runtime, app/index, contracts, live registry, dependencies/locks, UI and secrets are unchanged. No sibling source, public RPC, broadcast or deployment used. Same-GIWA generated dependencies/artifacts copied locally for tests.

Implemented manifest v2, frozen escrow/atomic redemption/return ABI, SELL quote/order quantity reservations, finalized custody with signed wallet/escrow/supply projection, globally serialized cash reservation against independent chain/journal minimum minus liabilities, durable mock SELL provider receipt, rejection/partial/unknown policies, original-intent recovery, atomic burn+payout verification, actor-scoped APIs, read-only combined admin views and independent multi-balance reconciliation. Added processed observer cursor schema and transaction-projection correlation hook for separately owned runtime integration. Same physical chain ID/vault/cash cannot activate a second independent deployment ledger.

Verification:
- Existing BUY PostgreSQL 20/20 preserved.
- New SELL PostgreSQL 12/12; complete fresh migration history, 32/32 total, no skips.
- Actual subprocess SIGKILL after durable SELL provider acceptance recovers exactly one redemption intent; lost signer acknowledgement is looked up without resubmission.
- Concurrent oversell and liquidity contention; active reservations; suspense and unfinished BUY exclusion; stale snapshot/current-journal interleaving; same-vault manifest isolation; partial/rejected outcomes; late/wrong-wallet custody; malformed atomic payout; replay; wallet/escrow/supply/cash conservation and cutoff reconciliation are covered.
- Expiry requires processed finalized cursor: absence/version0 retain reservation, version1 covered cutoff allows expiry, later actual escrow remains held for return.
- Unit/HTTP/raw receipt checks: 13/13 passed, including old-manifest rejection and atomic burn+payout pair enforcement.
- Typecheck and frontend production build passed (existing dependency/chunk warnings).
- Server baseline and new unit tests:75 passed; PG suite is explicitly skipped in generic server command and run separately against actual PostgreSQL18.6.
- Security, Prisma client generation, migration inspection passed.
- Task-local PG runs were explicitly unsandboxed and sequential, socket-only, one cluster at a time after root IPC-slot coordination. Every run confirmed shutdown before removing only its own temp directory.

Narrow separately authorized inspector fix: commit `6b8874e4c24615ec644089124771c06a11e10990` changes only scripts/prisma/inspect-migrations.mjs and its tests. First reproduced a failing qualified ALTER TABLE DROP CONSTRAINT regression, then exempted only that action at top-level clause starts in an already checked table statement. Standalone/foreign/unqualified/later-statement/routine-boundary cases remain guarded. Inspector26/26 and actual complete migration history pass. No historical SQL was edited or guard disabled.

Remaining: independent final verification, separately built actual-bytecode contract/local-stack evidence, root-owned observer/signer/runtime composition, and explicit public-testnet activation. No public GIWA execution is claimed from these database/raw-receipt fixtures. XRPL and UI remain deferred/outside this task.

Independent reviewer follow-up: networkInstance was a caller-selected alias and allowed one physical vault to bind separate deployment ledgers when renamed. The regression first failed against the prior code (31/32 PG passed; physical-vault alias case lacked its expected rejection). Binding and reservation serialization now share one `liquidityScope()` helper based only on chain ID and normalized vault/cash addresses. Changing deployment ID, network alias or checkpoint cannot create another ledger; identical addresses after a chain reset remain conservatively blocked. Fixtures now isolate scenarios with different physical cash/vault addresses. Fixed full real-PG suite32/32 and focused unit14/14 passed, including binding/reservation key equality; server build, typecheck and diff checks passed. Both red and green disposable PG clusters stopped successfully. No migration or deployed data was changed by this follow-up; existing alias-key bindings would fail closed and require a separately reviewed migration before reuse.
