# S1 — physical signing-account address case

Recorded before implementation. Exact base: `b5eb0baa079c5dd59a292e33706f0bb16b525d17`.
Commander: `/root`; builder: `/root/giwa_stocks_builder`; independent review remains outside the builder role.
Branch: `codex/stocks-local-signer-case-20260917`; own worktree: `/private/tmp/arco-giwa-stocks-signer-case-20260917`.

Approved scope: disposable `scripts/stocks-local/local-signer.mjs`, necessary local signer regression/runner selection, and this task/evidence record. Product runtime, app entrypoints, product migrations, dependencies/lockfiles, deployed registry, public RPC and all key material are outside scope. No root/reviewer worktree edits.

Finding S1: valid lowercase/checksummed spellings of the same signer split the advisory lock, unresolved lookup, stored nonce and uniqueness scope. Recovery normalized RPC addresses but compared against unnormalized persisted values. The independent reproduction is the S1 section of `/Users/whdqkf88/.codex/worktrees/8609/arco-giwa/review-results/20260917/independent-review.md`; its read-only probes were inspected.

Invariants: one normalized physical account per node for nonce locks/lookup/storage/uniqueness/recovery; original request payload and digest preserved exactly; older mixed-case records included rather than cleared; conflicting physical nonces must prevent signer startup/submission. Unknown operations never authorize resubmission.

Acceptance: first reproduce the old failure; then real PostgreSQL/local EVM mixed-case concurrent requests across deployment digests, PREPARED blocking, lost broadcast acknowledgement plus restart/original hash recovery with zero resubmissions, legacy-case records and collisions. Run the existing13 full-stack scenarios and both SIGINT/SIGTERM cleanup probes, sequentially using the coordinated single PG slot. Never stop or modify another task's services.

Implemented: one validated lowercased physical account drives the advisory lock, new stored account, RPC sender and nonce reads. Existing account rows are queried with `lower(account)` and recovery compares both sender and target canonically. Request payload, call digest, operation ID and manifest binding remain unchanged. A case-insensitive physical nonce unique index protects new writes; existing duplicate physical nonce records stop startup before the HTTP signer opens. Non-conflicting historical checksum rows remain present and usable rather than rewritten. This index is only in the pre-existing disposable `stocks_local_harness` schema, with no product migration.

The Commander explicitly confirmed the one fixed regression selector in `scripts/stocks-local/run.mjs`: `STOCKS_LOCAL_STACK_CASE_PROBE=1` selects only the checked-in `address-case.mjs`; it accepts no arbitrary path. All runner local-node/profile/cleanup checks remain.

Observed verification, sequential with the task's coordinated PG slot:

- Red reproduction: before changing signer code, the new real-EVM/PG test failed because checksum sender/target lookup after restart returned no result although the original transaction was mined. Log: `/private/tmp/giwa-signer-case-red-20260917.log`. The failed runner confirmed owned services stopped and retained only its diagnostic directory.
- Fixed dedicated regression5/5: checksum sender/target lost-ack restart recovers the original hash with0 resubmissions; mixed-case concurrent requests across deployment digests use consecutive physical nonces and preserve request payload/digest; existing checksum row recovery and nonce maximum under a stale chain nonce read work; unresolved PREPARED blocks both spellings and replay cannot resubmit; case-insensitive uniqueness rejects a new collision and a deliberately modeled legacy collision blocks startup with all rows unchanged. Log: `/private/tmp/giwa-signer-case-green-20260917.log`.
- Existing full-stack13/13 passed through actual app/SIWE, actual runtime/native timer, local bytecode, PostgreSQL, HTTP signer and observer. Final wallet/supply3000000000 stock base units, escrow0, vault360000000 cash base units, `MATCHED_AT_CUTOFF`,12 signer operations. Log: `/private/tmp/giwa-signer-case-fullstack-20260917.log`.
- SIGTERM/SIGINT2/2 passed, explicitly confirming each owned EVM process group, PostgreSQL process and socket stopped. Log: `/private/tmp/giwa-signer-case-signals-20260917.log`.
- Server build, changed-script syntax and diff whitespace checks passed. Same-GIWA installed dependencies/generated artifacts were copied into this own worktree; new contract bytecode was compiled by the existing runner. No dependency/lockfile edits.

Commands: `STOCKS_LOCAL_STACK_ONLY=1 STOCKS_LOCAL_STACK_CASE_PROBE=1 STOCKS_PG_BIN=/opt/homebrew/Cellar/postgresql@18/18.6/bin node scripts/stocks-local/run.mjs`; the same command without the case selector runs the13 scenarios; `STOCKS_LOCAL_STACK_ONLY=1 STOCKS_PG_BIN=/opt/homebrew/Cellar/postgresql@18/18.6/bin node scripts/stocks-local/signal-check.mjs` runs the2 cleanup cases. PG slot was released after verified cleanup.

Status: builder fix and verification complete, awaiting independent exact-SHA review. This fixes the disposable local signer and its evidence only; it neither implements nor certifies an external production signing service. No public writes, key material, deployed DB changes or self-approval.
