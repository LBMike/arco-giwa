# GIWA Stocks server + screen integration

Date: 2026-09-17. Root integration checkout `/private/tmp/arco-giwa-market-integration-20260917`, branch `codex/giwa-market-integration-20260917`.

## Frozen code

Original combined implementation `9c00ae4bd46d750ae9b2f256f9aa77cf01e651cf`; final code with the two chart display fixes `03d3a2e3f2233c8848a375f5f49a996a25f4d84d`.

- Market app/index registration: independently accepted `7b37ee9c0160a53803a44a3589bef8c459185e81`.
- UI source: `a79b196a37152aefe0c51c196fcdca20a7088af0`, imported as `9c00ae4`.
- Investor original + refusal fix + independent recovery fix imported as `577a361`, `2c400d3`, `8174fce`; accepted source recovery `d5bf1a848eda40f1b95e1192f2606746d224a770`.
- Admin plan/module/evidence/scope fix imported as `ebb250f`, `9cccfe3`, `351a7d1`, `fd9ce6d`; accepted scope source `9c0a34c0c6fab48f592b380feecba053c62d92dc`.
- Chart follow-up source `a5d74a7d66806d27afa54298dfe6ef1459c8f28a` imported as `03d3a2e`; final `git diff a5d74a7 -- src` empty. Root reran market10/10, route12/12, typecheck and whitespace successfully after import. Server unchanged, so its full suite was not repeated.
- Before that follow-up, `git diff a79b196 -- src` and `git diff 7b37ee9 -- server` both empty. No integration edits to either reviewed implementation.
- Actual routes `/stocks` and `/admin/stocks`, common login and main navigation are connected. Market display remains distinct from fixed-price NVDA test-cash trading. Wallet funding/escrow adapter is not activated.

## Root checks on combined code

| Check | Result |
| --- | --- |
| Full frontend with existing host DOM runtime | 340 passed, 0 skipped |
| Actual Stocks route/host DOM | 12 passed |
| Full server | 135 passed, 32 existing DB-dependent skipped |
| Typecheck, production build, security, whitespace | Passed |
| Actual compiled API to production browser | Passed: 3 viewports, 2 routes, 5 chart periods |

Logs `/private/tmp/giwa-market-combined-{frontend,dom,server,typecheck,build,security,preview-build}.log`. Existing seven design-token findings are unchanged; UI builder evidence records them separately. Root did not rerun chain or database suites.

## Actual API and browser check

Root constructed the real compiled `buildApp` with the real keyless market service. Other legacy services were explicit inert local fixtures. The Stocks trading service was intentionally omitted: its catalog returned 404 and the investor screen correctly displayed unavailable. This is an API integration check for the market routes, not a live trading test.

The production bundle was built with a temporary loopback API base and served on dedicated loopback5437. Browser requests reached actual compiled Fastify handlers; no JSON interception was used for market data. All external browser requests were blocked. Existing wallet SDK attempted its static wallet-book download13 times; these were blocked, not successful external requests. The backend provider fetch counter remained0.

At375/768/1440: Stocks catalog visible, quote/profile/chart UNCONFIGURED, no chart SVG, no document horizontal overflow, admin route signed-out state available without the legacy gate. All five period requests were observed. Page errors0; application resource failures0 except the three expected omitted-trading catalog404 responses. Six screenshots and exact response records: `/private/tmp/giwa-market-combined-evidence-20260917/browser.json` and adjacent PNG files. Root visually inspected narrow and desktop captures. Both owned loopback servers were stopped.

Harness corrections: an initial missing bundled Chromium executable was resolved by using the already-installed Google Chrome; the duplicate Stocks heading selector was narrowed. A dev-server font403 caused by linked dependency paths prompted a production-preview rerun. The final production-preview run loaded resources successfully. No product code changes were needed for these harness/environment issues.

Dependency provenance correction to the earlier server evidence: the copied `node_modules` entry is a symlink resolving to `/private/tmp/arco-giwa-stocks-command-20260916/node_modules`, not an independent physical package tree. Lockfile equality had been checked; no installation or dependency edit occurred. Existing compiled ABI artifacts were reused as documented in the server evidence.

## Independent review and boundaries

Server independent PASS: `/private/tmp/arco-giwa-market-runtime-review-evidence-20260917/README.md`. Original UI a79b196 independent verdict: PASS with two P3 concerns, no P0–P2 findings. Direct checks78 passed plus12 Chrome states; report `/private/tmp/arco-giwa-stocks-market-ui-review-evidence-20260917/README.md`. Both concerns are fixed in source a5d74a7 (combined03d3a2e); final independent follow-up PASS: module10/10 and four original browser boundaries pass, both375/1440 render two isolated dots and dismiss touch selection on outside click/focus; keyboard behavior remains valid. Report `/private/tmp/arco-giwa-stocks-market-ui-review-evidence-20260917/followup-a5d74a7/README.md`. No remaining confirmed findings from this review.

Massive account/key, live feed compatibility and display entitlement remain unverified. No SEIBro access or import occurred. Default catalog is NVDA PILOT; no claim of a completed40-symbol selection. No real wallet signature, DB, RPC, public deployment, main-branch merge or settlement was performed. Existing unknown-order recovery limitations and missing production wallet adapters remain. This is a locally validated integration candidate, not an Ondo-equivalent publicly operating trading environment.
