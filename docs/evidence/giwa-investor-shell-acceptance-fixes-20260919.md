# Investor shell — acceptance fixes (2026-09-19)

Builder: Claude (UI). Input: Codex review
`/Users/whdqkf88/.codex/worktrees/8609/arco-giwa/review-results/20260919/investor-shell-stocks-table-review.md`
(and `investor-shell-review-logs/`). Evidence: `/private/tmp/arco-giwa-investor-shell-fixes-evidence-20260919/` (`$F`).

## Base
- Original clone `/private/tmp/arco-giwa-investor-shell-20260919`: HEAD `c6c097f8042ea8c0f2254c28b2f58dc885606bb5`,
  branch `claude/giwa-investor-shell-stocks-table-20260919`, clean (not modified).
- Work clone `/private/tmp/arco-giwa-investor-shell-fixes-20260919`, branch
  `claude/giwa-investor-shell-acceptance-fixes-20260919` from `c6c097f`, push URL `DISABLED`. No merge, push or deploy.

## 1. Row sparkline cache is invalidated by a finished 1D re-read
`stocks-market/StocksMarketFeature.tsx`: `ChartRead` now reports every settled 1D read of its own key —
`onSeries(symbol, chart)` when it is AVAILABLE with ≥ 2 bars, `onSeries(symbol, null)` otherwise (STALE, UNAVAILABLE,
UNCONFIGURED, empty, one bar, request error). The list cache stores or deletes that symbol's entry. 1W/1M/3M/1Y reads
never report. Unchanged: `useOwnedRead` publishes only its own key's result (late answers from an earlier symbol, range or
API base are dropped), `MarketOwner`/`MarketCatalog` keys reset the cache on API or catalog change, StrictMode double
effects are idempotent, rows request no charts.

Regression test (`stocks-market/table.dom.test.tsx`, "a finished 1D re-read that is not current clears the row
sparkline; the next valid read restores it"): for each of STALE / UNAVAILABLE / UNCONFIGURED / EMPTY / ONE_BAR / HTTP 503,
NVDA AVAILABLE → MU → NVDA(bad) must remove the SVG and show the not-loaded state, then MU → NVDA(valid) must restore the
same series; a second mount checks that 1W (failing with 503) and 1Y leave the 1D sparkline and that rows request no charts.

| Run | Command | Result |
|---|---|---|
| red: new test on `c6c097f` market code | `GIWA_MARKET_DOM_RUNTIME=<jsdom> TMPDIR=/private/tmp node --import tsx --test src/demo/giwa/stocks-market/table.dom.test.tsx` with `StocksMarketFeature.tsx` from `c6c097f` | 13 tests: 5 pass, 8 fail — all 6 outcome subtests + 2 parents (`$F/logs/red-table-dom-on-c6c097f-code.log`) |
| green: new test | same, fixed code | 13/13 (`$F/logs/green-table-dom.log`) |
| Codex probe, red | `review-probes/sparkline-cache-regression.test.tsx` on `c6c097f` | 7 tests, 7 fail (`$F/logs/red-probe-sparkline.log`) |
| Codex probe, green | same, fixed code | 7/7 (`$F/logs/green-probe-sparkline.log`) |

`<jsdom>` = `/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json` (26.1.0). The probe was
run from an untracked copy and is not committed.

## 2. Rising change text meets AA
- New theme token `--color-arco-up-text: #007a4b` (Figma's up colour) in `src/demo/theme.css`, documented next to
  `--color-arco-up`. Used for the table's rising 24h ($)/24H (%) text (`StocksMarketTable.tsx`) and the detail's rising
  window change (`MarketChart.tsx`). `--color-arco-up` (#179386) stays for graphics: sparkline stroke/fill, status dot.
- Meaning unchanged: rising = up-text + ▲ + sr "상승", falling = `--color-arco-down` + ▼ + sr "하락", zero and missing =
  `--color-arco-text-soft` without a direction cue. The detail's colour condition is unchanged (only the up token).

| Background (actual) | `--color-arco-up` #179386 (before) | `--color-arco-up-text` #007a4b (after) |
|---|---|---|
| row `--color-arco-surface` #ffffff | 3.7809 | 5.4048 |
| selected row `--color-arco-page` #f8f8f8 | 3.5602 | 5.0892 |
| hover `--color-row-hover-weak` 6% over #fff (#f3f3f4) | 3.4096 | 4.8740 (Chrome computed: 4.8909) |

Chrome (computed `color` and composited ancestor backgrounds on the preview): up 5.4048 row / 5.0892 selected / 4.8909 hover;
zero and missing 10.3547 (`$F/browser/contrast-probe.json`, `$F/browser/before-after-change-colours.png`).
Tests: `stocks-market/table.test.tsx` computes the token ratios from `theme.css` on the three backgrounds (≥ 4.5) and checks
the classes for up / down / flat / missing, the graphic dot, and the detail's window change. Red on `c6c097f`
theme/table/chart: 2 fail; green 12/12 (`$F/logs/red-contrast-on-c6c097f.log`, `green-contrast.log`).

Measured, not changed (outside this item): `--color-arco-down` #dc2626 is 4.8294 on the row, 4.5474 selected and 4.3702 under
the hover overlay.

## 3. Shell DOM test is isolated from the Dynamic SDK's load-time request
Cause: `@dynamic-labs/wallet-book` starts `fetchWalletBook()` when its module is evaluated
(`hooks/useWalletBookCdn.js`: "Initiate wallet book fetch immediately"; 3 retries, then its bundled list). The test imported
`GiwaPreprodApp`/`./wallet` statically, so the first request ran before the test's fetch guard existed (on the real global
fetch) and retries could land in the guard at any time during a leaf test.

Fix (`src/demo/giwa/shell.dom.test.tsx` only): the guard is installed first and the app modules are imported after it. The
exact URL `https://dynamic-static-assets.com/wallet-book/v1/stable/wallet-book.json` gets a documented offline `503` stub and
is counted separately; every other request is still recorded and the three `fetchCalls.length === 0` assertions stand. No
skip, no guard removal, no blanket ignore, no SDK/product change.

| Run | Result |
|---|---|
| `GIWA_HOST_DOM_RUNTIME=<jsdom> TMPDIR=/private/tmp node --import tsx --test src/demo/giwa/shell.dom.test.tsx`, 3 runs | 4/4 each; diagnostic "wallet-book answered offline: 4; other requests: 0" |
| same with `/private/tmp/arco-rwa-ui-session-isolation-20260917/node_modules/jsdom/package.json` | 4/4 |
| red reproduction: `c6c097f` test with `--import $F/slow-offline-fetch.mjs` (fetch that rejects after 300 ms, no real request) | 0/4, `actual: 3` at each of the 3 leaf assertions (= Codex's failure); 1 call reached the pre-test fetch |
| same preload, new test | 4/4; 0 calls reached the pre-test fetch |
| guard still bites: SDK URL constant changed to another URL | 0/4 |

## Checks
Node 24.14.0, jsdom 26.1.0 at the Codex path above, Chrome 153. Logs in `$F/logs/`.

| Check | Result |
|---|---|
| `npm run typecheck` / `npm run build` | exit 0 / exit 0 |
| `npm run test:frontend` (default, CI style) | 753: 741 pass, 12 skip (gated DOM suites), 0 fail |
| `test:frontend` with `GIWA_{HOST,ADMIN,MARKET}_DOM_RUNTIME=<jsdom>` + `GIWA_STOCKS_ARTIFACTS` | 845/845, 0 skip |
| `.mjs` suites (routes.dom, scope-render, delayed-sell-regression) with DOM runtimes | 27/27 |
| `chart.browser.test.mjs` (Vite dev server of this clone, Playwright, Chrome) | 2/2 |
| `npm run test:server` / `npm run test:security` | 402: 330 pass, 72 DB-gated skip, 0 fail / exit 0 |
| `check-design-tokens.mjs --all` | the same 7 known-debt findings (a first run showed 12: the contrast test named a helper `rgb(`; renamed) |
| `check-story-exists.mjs --all` | no hard violation |
| Chrome on the fixture preview | contrast and sparkline results above |

## Not changed / not run
- Server 40-symbol catalog (Codex), detail copy, footer and other existing debts: untouched.
- The Codex local harness (`scripts/stocks-local`) was not rerun this round: its page renders the market section without
  market data, so the changed chart-cache path and table colours do not execute there.
