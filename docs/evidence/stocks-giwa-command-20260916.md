# GIWA Stocks commander evidence

Date: 2026-09-16. Commander /root. User directed GIWA development first, with XRPL last.

## Baseline

Repository base: 8160f354b55dfe9a525565e30ddc007f51448f3d.
Original GIWA main contains user-owned modified/untracked documentation and assets. It is not edited by this task. Secrets and environment files were not read. Existing contracts and deployment registry remain unchanged.

Dedicated worktrees:
- Commander: codex/stocks-giwa-command-20260916.
- DB-001 builder /root/giwa_backend_inventory: codex/giwa-migration-inspector-20260916.
- Stocks builder /root/giwa_stocks_builder: codex/stocks-giwa-backend-20260916.
- Independent reviewer: /root/rwa_reviewer (read-only; final checkout created after implementation handoff).

Commander independently installed the unchanged package-lock dependencies offline into its own worktree and generated its own Prisma client. Prisma generation needed filesystem permission to update an existing engine-cache timestamp. No database connection was used by generation. Existing compiled contract artifacts were copied only from the same GIWA repository's generated artifacts for legacy baseline tests; no sibling product source/artifacts were used and no contract was deployed.

Unchanged baseline results:
- npm run typecheck — PASS.
- npm run build:server — PASS.
- npm run build — PASS, existing third-party annotation/browser-external and chunk-size warnings.
- npm run test:security — PASS (environment exposure and GIWA EVM-version guards).
- npm run test:frontend — 175/175 PASS, existing React SSR warnings.
- npm run test:server — 62/62 PASS.
- Original migration inspection — fails on six incremental migrations because it incorrectly requires each migration to create the schema; assigned DB-001, historical SQL untouched.

## Design review findings incorporated

- Testnet chain settlement uses GIWA finalized blocks; Flashblocks preconfirmation is not settlement.
- Quote deadline is tested against canonical deposit inclusion time, not delayed finality observation. Late inclusion is held. This is a fixed mock-price test policy, not real-broker price assurance.
- Actual incoming test cash without a recognized order is recorded separately in suspense; no unidentified automatic refunds.
- Manifest and activation trust must be immutable and scoped to the order/deployment/network instance.
- Worker claims and holdings are scoped to the deployment; old network-reset requests must never execute on a new deployment.
- Reconciliation requires an independent finalized chain snapshot and adequate observation coverage; otherwise status is unavailable/incomplete, not matched.
- Admin UI is a proposal informed by public Ondo capabilities. No private Ondo dashboard was accessed or claimed to be reproduced.

## Current handoff state

DB-001 source commits 7fe76fe44812af6d3d9d8fb62514a3a28fbc3a6a and d16fbe8dad0dde5a9c15e0ebf8c26602e2474c23 were independently reviewed and assembled into this local commander verification branch as b7cc167 and 44759a8. The reviewer found an executable-string inspection bypass; five failing reproductions were added before the fix, then 21/21 tests and actual history passed. The reviewed prerequisite releases only the planned additive schema implementation, not deployment or main integration.

The DB-001 trigger-event follow-up 329a3f6c672d324cc93615393253a9b1b8ee7182 was independently reviewed and assembled as 32dad87. It distinguishes a TRUNCATE event in a CREATE TRIGGER declaration from an actual TRUNCATE statement without exempting unsafe statement targets. The final parser suite passes 24/24 and the complete migration history including Stocks passes.

## Final implementation and independent verification

Stocks builder commits: 0e15c52051b1cf26ca0155b3d25ade62a4e79d8f and 2abfb9bd04aa260747500b9e8994c38bce46a297. Local commander candidate runtime head: a4422f66d137c650b2895eebde621f69c01beb8e, including the reviewed DB-001 prerequisite. Later commander edits are documentation only.

Independent reviewer /root/rwa_reviewer used clean detached /private/tmp/arco-giwa-stocks-review-20260916 at exact builder head 2abfb9bd04aa260747500b9e8994c38bce46a297. Final report: no remaining confirmed P0/P1 in the unactivated module; independent server build, Stocks unit 11/11, diff check and final complete migration inspection passed. The reviewer read the real-PG tests but did not duplicate the commander's database execution. This is source-review readiness, not deployment approval.

Commander independently verified the combined candidate in this worktree:

| Command | Result |
| --- | --- |
| `npm run prisma:generate` | PASS, unchanged dependency versions, additive Stocks client types |
| `STOCKS_PG_BIN=/opt/homebrew/Cellar/postgresql@18/18.6/bin node scripts/stocks/test-postgres.mjs` | PASS 20/20, zero skipped, full base history plus Stocks migration applied to a fresh disposable PostgreSQL 18.6 cluster |
| `npm run typecheck` | PASS |
| `npm run build` | PASS, existing external-library/browser-external/chunk-size warnings |
| `npm run test:frontend` | PASS 175/175, existing SSR warnings |
| `npm run test:server` | PASS 73; 20 PG cases explicitly skipped here because no DB is supplied, all 20 separately passed above |
| `npm run test:security` | PASS, both checks |
| `npm run prisma:migration:inspect` | PASS |
| `node --test scripts/prisma/inspect-migrations.test.mjs` | PASS 24/24 |
| `git diff --check 8160f354b55dfe9a525565e30ddc007f51448f3d HEAD` | PASS |

Real-PG coverage includes concurrent order/event replay and worker claims; immutable balanced journal pairs; integer/bound constraints and rollback; stale versions; funding exceptions and exact refunds; late versus timely included deposits; unsupported provider outcomes; UNKNOWN original-identity recovery; actual child SIGKILL after a durable provider receipt and before local result commit; deployment isolation; independent finalized snapshot reconciliation; conflicting evidence for one actual cash movement; and an independently specified five-order conservation scenario. The latter is bounded deterministic coverage, not a proof for arbitrary inputs. Chain/signer fixtures do not constitute real GIWA network evidence.

Review and real-DB execution exposed issues that were fixed before this result: mutable adapter requests could change terms; zero-address mint topics were rejected by an overstrict hash validator; unrelated/delayed/wrong-wallet cash needed distinct handling; and PostgreSQL JSONB property ordering changed request hashes. Canonical key ordering now binds the same immutable intent before and after DB persistence, with regression tests.

## Disposable database environment

Initial sandbox PostgreSQL bootstrap failed and left a 56-byte shared-memory slot. Read-only host inspection found 32 slots in use. The sole slot removed was proven to belong to this exact task by bootstrap log time 22:45:14, key 0x04315534 / 70341940, shmid 29622302, owner and a terminated creator PID 74051; it had zero attachments and had never been attached. Fresh checks preceded removal. No other shared memory or existing database cluster was changed. Subsequent task-owned PostgreSQL runs were explicitly authorized outside the sandbox, on isolated temporary sockets with no existing DB credentials. Both builder and commander runs stopped their own server and cleaned their own directory successfully. The harness retains the directory if shutdown cannot be proven.

## Claude counter-review handoff

An actual read-only Claude Code attempt used its own clean detached worktree /private/tmp/arco-giwa-stocks-claude-review-20260916 at a4422f66d137c650b2895eebde621f69c01beb8e, reviewer session f31e1a5b-02c6-4cf2-b178-7eed71ce8160. Tools were limited to Read/Glob/Grep; no shell, edit, MCP or deployment tools were enabled. The CLI returned `Not logged in · Please run /login` before any API call, and `claude auth status` independently reported loggedIn=false. No Claude review was performed and no approval is inferred. No credentials were inspected, changed or requested.

The exact reusable prompt is `docs/tasks/stocks-giwa-claude-review-20260916.md`. The repository's cross-tool review gate remains PENDING_AUTH. The combined source is preserved on codex/stocks-giwa-command-20260916 for review and has not been integrated to main.

## Remaining activation work

No process activation, real RPC/signing activation, Stocks contract deployment, token issuance, UI changes, push or release occurred. Existing Saving/Funds source and deployment registry remain unchanged. Next GIWA work is new Stocks contracts and restricted-transfer/operation-dedup proofs, signer/session/observer composition and actual testnet buy verification, then sell/escrow/burn/payout, admin controls/UI and multi-instrument expansion. XRPL starts only after GIWA completion. Real Alpaca settlement, live prices, social-wallet creation and 40 tradeable instruments are not implemented by this first slice.
