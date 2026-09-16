# STOCKS-GIWA-001 — Testnet buy-to-mint backend

Status: CONTRACT_READY, approved for bounded implementation by Commander /root under the user's explicit GIWA-first backend instruction (2026-09-16). XRPL development is deferred until GIWA is complete.

Base SHA: 8160f354b55dfe9a525565e30ddc007f51448f3d.
Commander: /root, codex/stocks-giwa-command-20260916.
Builder: /root/giwa_stocks_builder, codex/stocks-giwa-backend-20260916.
Reviewer: /root/rwa_reviewer, a separate clean review worktree after handoff.
Counter-review: Claude Code required before integration/release of new money paths.

## Scope and authority

Build one complete backend action: actor-bound NVDA test purchase, exact test-cash funding evidence, mock-broker execution, durable mint intent, verified chain mint confirmation, wallet holding projection and read-only operator APIs. Include late/abnormal funding and refund intent/confirmation so received cash is never discarded. Actual contract deployment, real RPC/signing activation, broker credentials, live price feeds, sell/escrow, investor/admin UI and XRPL are separate tasks. The code must fail closed until an explicit Stocks deployment manifest and trusted session/signer/chain ports are configured.

Do not claim on-chain testing from local fixtures. Contracts in deployments/91342 and packages/contracts are existing LIVE Savings/Funds contracts, not a Stocks deployment. Never use them implicitly for Stocks. No existing GIWA behavior is modified.

Allowed builder files: server/src/stocks/**; scripts/stocks/**; prisma/migrations/20260916000000_stocks_testnet/migration.sql; additive Stocks-only models in prisma/schema.prisma; docs/contracts/stocks-giwa-v1.md; docs/evidence/stocks-giwa-backend-20260916.md.
Forbidden: all other existing runtime files; package.json/lockfiles; .env* and .secrets; packages/contracts/**; deployments/**; src/**; server/src/app.ts and index.ts; CI/deployment files; other worktrees and sibling sources.

Database hotspot is assigned solely to this builder for new Stocks tables/models. Existing models/history cannot change. NEW SCHEMA EDITS WAIT until Commander confirms DB-001 migration-inspector repair verified. Before that, implementation of new contracts/types/domain/verifier code and tests is allowed. No dependency changes are needed: use existing Fastify, pg/Prisma and viem. Shared process integration is not authorized in this task; expose a Fastify plugin/factory for isolated inject tests and a documented composition seam.

## Frozen external behavior

- Profile: DEMO_TESTNET, TEST_VALUE_ONLY, MOCK_BROKER, GIWA chain 91342. All responses disclose this and data freshness. Local fixture ports are explicitly TEST_HARNESS_ONLY and never selected by a production default.
- Instrument NVDA initially; quantity scale 9, cash scale from the registered test token, supported first scale 6. Amounts/quantities are decimal strings and computed with bigint. No Number/parseFloat money operations.
- GET /api/v1/stocks/catalog returns instrument capability and mock-price label.
- POST /api/v1/stocks/quotes accepts symbol + quantity (human decimal string), no client price/actor/wallet/role. Trusted actor resolver supplies actorId, verified wallet, chain and session scope. Immutable quote expires after 60 seconds.
- POST /api/v1/stocks/orders accepts quoteId + idempotencyKey. Repeating the same body returns the original order; changed body under a reused key conflicts. Freeze quote, wallet and deployment identity.
- GET /api/v1/stocks/orders and GET /api/v1/stocks/orders/:id are actor-scoped; GET /api/v1/stocks/portfolio returns only server-confirmed chain holdings, with pending states separate.
- GET /api/v1/admin/stocks/overview, /orders, /orders/:id, /reconciliations and /audit require a trusted identified operator with read permission. No client-supplied actor/role and no static shared token as multiple-person identity.
- No unauthenticated funding/mint/confirm/faucet routes. No arbitrary mint, edit balance, force complete, arbitrary calldata, or unknown-outcome resubmit endpoint.
- Proposed future admin commands (pause/resume maker-checker) are documented, NOT required in this first read-only task. Domain dispatch still honors a trusted injected pause policy, default paused without deployment activation.

## State and money invariants

Order first. A finalized transfer must match the registered network instance, contract/token, verified funding wallet, recipient, order attribution and exact amount before automatic funding. Quote validity is checked at order acceptance and against the canonical deposit block timestamp (inclusion must be within the deadline). The later wait for L1 finality does not itself expire a timely included deposit; broker dispatch still waits for finalized evidence. A transfer first included after the deadline goes to FUNDED_QUOTE_EXPIRED. This timely-inclusion price guarantee is test-only under fixed mock pricing; real broker price/slippage policy is a separate prerequisite before Alpaca integration. Under/over/second distinct/wrong-wallet payments go to FUNDING_REVIEW_REQUIRED/suspense. They are recorded as received value but cannot buy. Same chain event replay credits nothing. Unidentified deposits never auto-refund. A trusted policy may create a return intent only to the verified eligible original funding wallet after the original outcome is known; return completion needs separate finalized chain evidence.

Normal buy: AWAITING_FUNDING -> BROKER_PENDING -> MINT_QUEUED -> MINT_SUBMITTED/MINT_FINALITY_PENDING -> COMPLETED. Provider ambiguity is UNKNOWN and retains funds/intent; invalid conflicting evidence enters REVIEW_REQUIRED. Never infer failure from a timeout. Mock broker may full-fill this first slice; unsupported partial/rejected broker results must be explicit held/error states, never silently mint full quantity. Preserve room for later broker partial-fill implementation.

Persist state, append-only audit/money entries and outbox atomically. Use row locks/CAS and unique intent/event/idempotency identities, mandatory transactions, exact database constraints and append-only balanced journal protection. External calls are outside DB transactions. Stable original intent is recorded before any submit; restart/timeout resolves original request/hash instead of creating another. Reconciliation includes in-flight funding/mint/refund states; chain holdings projection is not a second spendable asset balance.

The chain boundary fetches through an injected trusted read-only RPC/receipt port. Validate chain/network checkpoint, original transaction/hash/target, canonical finalized block, successful receipt, registered emitter/code identity, exact expected event fields and matching ERC20 movement. status=1 or a client callback is insufficient. No default few-block finality assumption. The manifest pins expected ABI and non-upgradeable code identity; unvalidated manifest/finality/addresses fail closed. Raw logs are decoded server-side. Test fixtures use explicit fake deployments distinct from live registry.

The first settlement policy requires the canonical finalized block. GIWA distinguishes unsafe, safe and finalized (corresponding L1 block finalized); Flashblocks provide preconfirmation and cannot settle holdings. Official references: https://docs.giwa.io/giwa-chain/en/network-information/diffs-ethereum-giwa and https://docs.giwa.io/giwa-chain/en/network-information/flashblocks . Test timely inclusion with delayed finality, late inclusion, pending/preconfirmed receipts, and canonical-block disagreement explicitly.

Signing is a port to a separately controlled signer; no private keys in API/worker/env fixtures/DB/logs. Record authorized call payload/deployment/operation ID and check returned submission identity. Submit failures without proof of non-submission are UNKNOWN. Polling can continue under pause; new irreversible dispatch cannot start under pause.

First stock-token policy is restricted transfers (issuance and approved redemption flows only), to be enforced by the future Stocks contract. External holder transfers require a separate projection implementation before enablement. Contracts/activation remain blocked until this assumption is proven.

## Verification

Unit/HTTP tests: exact scales/bounds; expired/mismatched quotes; object auth; rejected forged role/wallet; profile/mainnet/wrong-token guards; raw receipt/event/target/quantity/finality mismatch; duplicate events; pending/reorg; UNKNOWN; pause; all admin read guards; bigint JSON.

Real disposable PostgreSQL tests: migration from base history; duplicate/concurrent commands; atomic balanced append-only journal; concurrent worker claim; restart after broker/mint submission; receipt replay; stale expected version; funding/refund exception cases; reconciliation; database constraints reject malformed journal updates. No existing DB or environment credentials. Add a dedicated local harness using available initdb/pg_ctl and a temporary local socket/port; record skipped/unavailable checks as blockers.

Required baseline: typecheck, build, test:frontend, test:server, test:security, prisma:migration:inspect. Preserve original user files. Do not push/merge/deploy/broadcast. Return atomic commit, exact tests, code limitations and remaining contract/runtime activation work.

## DB-001 prerequisite

Separate assigned builder /root/giwa_backend_inventory, branch codex/giwa-migration-inspector-20260916, same exact base. Allowed only scripts/prisma/inspect-migrations.mjs, new scripts/prisma/inspect-migrations.test.mjs and docs/evidence/giwa-migration-inspector-20260916.md. Fix the false requirement that every incremental migration repeat CREATE SCHEMA. Retain forbidden-schema/waitlist checks and validate supported qualified DDL in ordered history. Add regressions for valid history and unsafe schema references, without weakening checks or modifying historical SQL. Document parser limits. Node test and actual migration inspection must pass before releasing Stocks schema work. No DB connection or migration application in this prerequisite.

### Gate update and clarifications

DB-001 final source SHA d16fbe8dad0dde5a9c15e0ebf8c26602e2474c23 (including 7fe76fe) passed independent reviewer /root/rwa_reviewer after fixing the reported executable-string bypass; 21 tests and actual migration history pass. Commander released the assigned additive schema work. This does not approve the new migration itself or activate a runtime.

Additional required edge behavior: wrong-wallet dust is recorded in suspense without changing a legitimate awaiting order; a verified refund closes an order that never bought, but refunding a second separate payment cannot undo a completed purchase. Scope all reads/claims/projections to the deployment digest. Include actual direct ERC20 transfers to the vault in unallocated observation; they do not fund an order. A reconciliation needs an independent fixed-finalized-block snapshot and adequate coverage; otherwise explicitly unavailable/incomplete.
