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

Implementation and independent verification are in progress. No integration to main, process activation, RPC/signing activation, testnet deployment, token issuance, UI changes, push or release has occurred. A local test result is not live-chain evidence. Final code SHA/results and remaining activation requirements will be recorded after independent review. Claude counter-review remains required before integration of Codex money-path changes.
