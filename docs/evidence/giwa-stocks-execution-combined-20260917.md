# GIWA Stocks execution API — combined verification

Status: ACCEPTED — root integration and independent final review PASS at code7e8a06c9dc90938bf02d09237e79cc65dc38ec8f. The original P3 is resolved.

User ownership: Claude Code owns UI; this Codex task owns backend only. No changes under src/, packages/contracts/, deployments/, no schema migration or journal behavior change. Isolated checkout `/private/tmp/arco-giwa-execution-api-20260917`.

## Provenance

- Base5865b97db0513aea2045e3d51fcc6b73b35baf24 (accepted receipt reconciliation).
- Contracte7372c200aec52da46f5e2bdbb6fb5c5a805a3ed.
- Root proof/composition499d8eb16806900c0d7e073a5a3cee862f514b62; whitespace fix1bf9bc2.
- Service/plugin source5b51e118081da0b6f5425d3a95b2a4cb6fc879b2 importedd15c30c.
- Intermediate409467a03d89f2b75ee7c36e3ebdd6826fbc5882 fixes two root TypeScript-only lines (unused import and intentionally hostile test fixture cast). No runtime behavior change in that commit.
- Final code7e8a06c9dc90938bf02d09237e79cc65dc38ec8f imports the two-file DB phase deadline fix from1078e89de376716ea710f3d5a08a12d1cb0f9951.

## Delivered behavior

Authenticated read-only GET `/api/v1/stocks/execution/deployment` returns freshly verified public manifest evidence. Full checks cover chain/checkpoint, five runtime code identities, constructor bindings, token scales, canonical finalized history, and final network/checkpoint/block rechecks. Only existing read-only transport is used. Concurrent requests share verification; successful cache retains its original start timestamp and expiry. Lease max15 seconds is anchored before verification; verification max8 seconds is enforced around each underlying transport await. Late results cannot publish cache or start another RPC. Runtime stop denies both pending and cached results.

Authenticated GET `/api/v1/stocks/execution/:side/:orderId` checks current actor/wallet/deployment/order, physical vault binding, immutable new-order enrollment, payable state and DB-clock expiry before requesting chain evidence, then rechecks eligibility and pause. SQL is READ ONLY, without row locks, writes or ready()/bindDeployment() calls. Lock/query waits have bounded denial; delayed pool acquisition is released. Policy lease is capped by start+15 seconds, unchanged deployment evidence and DB remaining lifetime; wall/monotonic checks cannot extend it. A small clock divergence reduces remaining lease instead of denying valid work solely for a5ms offset.

Policy is eligibility only. Existing pending submission history does not prevent the controller from inspecting/reconciling it; actual signature permission still requires the durable claim and its fresh server checks. Deployment verification can remain valid while trading is paused. Responses have no-store, strict authenticated owner scope, explicit CORS, public manifest whitelisting and fixed error codes. Runtime absent means routes are not registered.

API handoff: [stocks-execution-v1.md](../contracts/stocks-execution-v1.md). Do not use the catalog capability marker as policy, self-assert VERIFIED, or renew timestamps in UI. ISO envelope timestamps and numeric data timestamps are deliberately distinct. UI must reject expired/mismatched evidence and preserve server expiry through transport delay.

## Root validation at final code

| Check | Result |
| --- | --- |
| Full server |207 pass,49 gated DB skips,0 fail|
| Fresh PostgreSQL |56/56: legacy32+journal8+receipt4+execution5+actualAPI/browser7|
| PG and Node process restart |Existing terminal proof and journal persistence PASS|
| Real local EVM + PG + listening Fastify |17 scenarios PASS, including BUY/SELL deployment/policy endpoints and existing mint/burn/payout|
| Frontend regression, explicit DOM runtime and compiled ABI |402/402,0 skips; frontend source unchanged|
| Production build / TypeScript |PASS; existing large-chunk warning|
| Security |PASS|
| Stories |PASS with inherited soft warnings|
| Design tokens |7 inherited findings, no new; hook remains nonzero|
| Diff whitespace |PASS|

Actual local EVM policy tests check same manifest digest, unchanged lease cap, authenticated other-wallet404, verified deployment during paused runtime, and deployment denial after runtime close. The existing complete local BUY/SELL settlement and common-cutoff reconciliation remain PASS. This is a local test chain with a mock broker, not public GIWA or an actual browser wallet.

Final fresh PostgreSQL evidence: `/private/tmp/stocks-submissions-pg-QVw8BT/harness-evidence.json`, started=true/stopped=true, restart1, PIDs35924→36127. Earlier root runohHgUL was also stopped (33824→34013). The local stack runner exited0 only after its owned PG and EVM cleanup and removed its successful temp directory. Initial harness launches used require_escalated to avoid the host's sandboxed-initdb IPC leak; no unrelated databases/processes/IPC were changed.

Root logs are `/private/tmp/giwa-execution-{deployment-tests,server-final,postgres-final,local-evm-final,frontend,build,security,tokens,stories}.log`, copied to `/private/tmp/giwa-execution-combined-evidence-20260917/`. Existing matching package.json and lockfile were compared before dependency reuse; no install was needed.

## Limits and next integration

Claude can connect UI reads to this contract after accepted commits are integrated. Active wallet adapters, UI execution activation, deployment-specific production configuration and public-network acceptance are not supplied by this backend-only task. No existing GIWA deployment was changed, no existing DB was used, and no public wallet signature/transaction was sent.

The SQL read is an eligibility snapshot, not a lock preventing later changes. Durable claim remains authoritative. Deadline guards discard late results but cannot forcibly cancel a transport lacking a cancellation API; an in-flight call may finish before cleanup. Catastrophic finalized-history changes and operator recovery remain outside this change. Investor create-order response-loss recovery is still a separate task.

## Independent review follow-up

Reviewer reproduced a2.6-second synchronous stall that delayed the database phase timer and allowed a response past its advertised2.5-second phase budget. The overall15-second policy lifetime and immutable start-anchored expiry still held. Backend follow-up adds monotonic phase checks around every acquisition/query and immediately before return, preserving rollback and release. Fix1078e89/root7e8a06c adds those guards in service.ts and four unit regressions. The reviewer reran the unchanged original3-probe suite: all PASS; the original2.6-second stall now yields EXECUTION_DATABASE_TIMEOUT. Root reran fullserver207, freshPG56/restart and localEVM17 successfully at7e8a06c. Final independent narrowPG20/20 and DB/Node restart recheck passed; the original409467a HOLD report is preserved.

## Final independent acceptance

Final code7e8a06c and source fix1078e89 have identical full Git tree `b6bcd26df3e3d5b658d276d83e7571eac1439a25`. The reviewer ran63/63 on the fixed candidate:38 focused + unchanged original3 probes + actual asynchronous timeout cleanup2 + freshPG20,0 failures/0 skips. Database and new Node process restart checks passed separately. R1/P3 is closed; no unresolved actionable findings.

Independent freshPG20 comprised journal8 + receipt4 + execution5 + reviewer3. Actual late connection acquisition is released without SQL; late query cleanup schedules rollback only and no next data statement. Previous root proof review17+4 remains separately recorded; it is not added to the final63 count.

Independent report: `/private/tmp/arco-giwa-execution-review-evidence-20260917/followup-7e8a06c/README.md`. Original HOLD: `/private/tmp/arco-giwa-execution-review-evidence-20260917/combined/README.md`. Final reviewer PG `/private/tmp/stocks-submissions-pg-srS68J/harness-evidence.json`: started=true/stopped=true, restart1, PIDs36353→36484. Earlier reviewer PG RI52vY also stopped. Every temporary service owned by this milestone has been shut down.

No UI files changed. This acceptance authorizes describing the backend execution API as implemented and locally validated; it does not establish active browser-wallet integration or public GIWA readiness.
