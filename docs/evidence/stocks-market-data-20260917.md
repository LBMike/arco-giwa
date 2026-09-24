# Stocks Massive display module — verification evidence

Date: 2026-09-17. User scope: Ondo-like stock display data, approximate GIWA testnet execution permitted. Massive selected; no account/API key available. SEIBro was a stock-selection reference only; access was explicitly stopped and no fetched ranking is applied.

## Candidate and ownership

- Base: `bc67cf2a8ae98d3e5f820627afe8f25046a0891a`.
- Task/contract: `23e0a13`, followed by user-scope/UI handoff clarification `5313f53`.
- Initial source candidate: `19529bccdacd69d0c72be6d621ce564fb06f2336`.
- Chart-density candidate: `6af24b9b4d8030b4983fcc3266c292d13db82bf5` (adds range-based chart-density limits and a regression test).
- Final source candidate: `6008f10429b5fd6d5805ac329b4a1e536c3bc8e9` (preserves accepted per-symbol timestamps across missing snapshots).
- Checkout: `/private/tmp/arco-giwa-stocks-market-data-20260917`, branch `codex/giwa-stocks-market-data-20260917`.
- Commander: `/root`. Builder: `/root/stocks_market_data_builder`. Independent reviewer: `/root/giwa_stocks_builder` (read-only role for this distinct task).
- Scope: 8 new source/test files in `server/src/stocks-market-data/**` and dedicated task/contract/evidence documents only.

No shared server entrypoints, frontend files, trade pricing, wallets, existing contracts, live registry, dependencies, lockfiles, schemas, migrations or secret files changed. Original GIWA checkout remains at `8160f354b55dfe9a525565e30ddc007f51448f3d` with its pre-existing user changes preserved.

## Implemented behavior

Dependency-free exact-number JSON parser; Massive filtered snapshot batch; company profile normalization; five bounded chart periods with OHLC consistency and source-identity checks; strict same-origin raster icon proxy; optional Fastify plugin and injected factory. Missing keys return UNCONFIGURED with no network I/O. Errors and oversized/stalled responses fail to sanitized availability states. Bounded singleflight cache, fallback expiry, 429 cooldown and request budget protect provider access. Source-age thresholds are separate from fetch/cache timestamps. The module has no path into order settlement or signing.

The static default catalog is an explicitly labeled NVDA pilot. A separately supplied curated catalog supports up to 40 display securities without granting trading capability. No selected 40-security catalog is claimed complete by this task.

## Executed checks

Builder at the initial source candidate:

- `npm run build:server` — PASS.
- `node --test server/dist/stocks-market-data/*.test.js` — 30 passed, 0 failed.
- Generic server suite — 125 passed, 32 existing database-dependent tests skipped, 0 failed. No new tests were skipped.
- `npm run test:security` — environment exposure and GIWA EVM-version checks passed.
- `npm run typecheck` — PASS.

Commander independently reran server compilation, generic server suite (125 passed / 32 database skips / 0 failed), focused suite (30/30), and `git diff --check`; all passed. Earlier commander frontend typecheck and security checks passed. Eleven additional exact-number/parser smoke assertions passed without network I/O. Local logs: `/private/tmp/stocks-market-data-commander-server-20260917.log` and `/private/tmp/stocks-market-data-commander-focused-20260917.log`.

The chart-density concern justified an additional source fix: retained bar counts are bounded by the selected range/interval, and impossible intraday spacing is rejected; daily spacing allows ET daylight-saving changes. Builder rebuilt and passed 31 focused tests. Commander rebuilt that candidate and reran the generic server suite: 126 passed, 32 existing database-dependent skips, 0 failed.

Independent review then reproduced the missing-snapshot timestamp regression below. Builder added separate bounded accepted-time records with atomic batch validation and two regression tests, and rebuilt with **33 focused tests passed**. Commander rebuilt `6008f104` and reran the generic server suite: **128 passed, 32 existing database-dependent skips, 0 failed**. The server log above now records this final run. No unrelated test expansion was required.

The tests exercise 40-symbol batching, missing data, numeric precision/exponents, malformed JSON, duplicate identities, stale/late/out-of-order data, concurrent refreshes, exhausted quotas, failed authentication, total deadlines including stalled bodies, oversized responses, unsafe branding URLs, impossible bars, partial/empty history, private-key-like query injection and sanitized error responses. All observations are explicitly synthetic fixtures.

`scripts/check-independence.sh` is absent from this GIWA baseline; no pass is claimed for that unavailable script. This isolated read-only module has no database or money-state mutation. Database/chain integration tests are therefore not a new task requirement and were not represented as freshly executed.

## Independent review

Read-only reviewer reproduced a P2 in the initial candidate: a successful snapshot omitting a symbol cleared the only stored observation timestamp, allowing a subsequent older observation to pass the monotonic guard. Reproduction: new quote → empty snapshot → older quote; also relevant to mixed-symbol partial snapshots. Fix `6008f104` maintains separate per-symbol accepted-time records and advances them only after the entire batch validates. Added tests cover empty/partial omissions and prove a rejected mixed batch does not advance another symbol's record.

Independent final review: **PASS**, no unresolved P0/P1/P2 findings. Reviewer fixed the separate checkout `/private/tmp/arco-giwa-market-data-review-20260917` to `6008f10429b5fd6d5805ac329b4a1e536c3bc8e9`, reran both independent P2 reproductions and confirmed the fix. Build, 33/33 focused tests, generic server tests (existing 32 PG skips), security, typecheck and diff-format checks passed. Review checkout was clean. Only the 8 new module files and 2 approved documents differed from the base at that source candidate; this evidence/status commit adds documentation only. The module is accepted for the coordinating task's isolated integration and its own app/UI verification, not public activation.

## Activation limits and handoff

No real Massive key or live response was used; feed entitlements, actual branding responses, customer display rights and live compatibility remain to be checked at activation. The module intentionally does not invent data when a plan lacks snapshots or history. Conservative source-age labels apply outside market hours because an exchange calendar is deferred. Chart `complete` only describes the absence of explicit pagination/base-limit truncation signals, not proof of all exchange history.

Shared application registration and frontend mounting belong to the coordinating task `01a0aae1-20be-7a42-9672-dbcd305033dd`. Use the exact factory/plugin/DTO exports and integration instructions in `docs/contracts/stocks-market-data-v1.md`. This candidate has not been merged into the user's main checkout, pushed, publicly deployed, or connected to a real API. Existing testnet order pricing remains the server's fixed mock price. Dividends, token NAV/ratio, total-return token charts and the final 40-security selection are not implemented by this display adapter.
