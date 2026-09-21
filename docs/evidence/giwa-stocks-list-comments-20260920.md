# Stocks list browser comments — 2026-09-20

Baseline: 0c4fc32. Working clone: /private/tmp/arco-giwa-ui-editable-20260920.
Preview: http://127.0.0.1:4392/src/demo/giwa/investor-shell/verification/index.html#/stocks

## Changes

- Removed header Demo badge, restored the existing Mint test assets control on desktop and in the mobile menu. No wallet transaction was submitted.
- Replaced share volume with estimated USD session turnover (shares × displayed price), using exact decimal bigint arithmetic and compact display.
- Removed dollar change column. Inserted Market Cap / AUM immediately before Volume (USD), for both Home and Stocks. Stocks use marketCap, ETFs use aum; never substitute one for the other.
- Load each listed symbol's own profile and 1D chart with three workers, cancellation and rate-budget backoff. The default server budget remains five requests/minute. Existing list/detail focus, filters and stale-chart invalidation remain covered.
- Added optional backward-compatible profile aum/aumAsOf fields and a cached ETF Global provider read, including partial profile preservation and retryable budget errors.

## Verification

- Build and typecheck passed.
- Frontend: 814 tests, 795 passed, 19 environment-gated skipped, zero failures.
- Targeted row loading, table rendering and DOM suite: 32 passed; added background/detail race regression afterward, DOM suite rerun 15/15 passed (the preceding DOM suite had 14 tests).
- Server: 405 tests, 333 passed, 72 environment-gated skipped, zero failures. Includes exact AUM, permission failure and budget-recovery coverage.
- Security checks passed. Story structure has no hard violations.
- Token scan reports the same seven documented baseline violations; no new raw colors.
- Browser at 1587px: eight headers in intended order, restored mint button, no Demo badge, USD volume, 37 distinct per-symbol chart elements. At 390px: mint button available in the mobile menu. Viewport restored and Stocks tab kept open.
- Independent review found AUM budget propagation and background/detail chart recovery defects; both corrected and regression tested.

## Data limits

The preview remains an offline synthetic stock-data fixture. Its profiles contain no market capitalization or AUM, so that new column currently shows — for all rows. The change does not invent valuations or connect a live feed. The three absent charts are SGOV (stale), SCHD and NBIS (unavailable).

Dollar volume is an estimate of session turnover, not VWAP-weighted trade consideration or rolling 24h volume. The tooltip states the calculation. Live list loading is progressive under the account's configured provider quota.

ETF AUM requires the configured provider account to have access to [Massive ETF Global profiles](https://www.massive.com/docs/rest/partners/etf-global/profiles); no subscription was purchased or enabled. AUM retains its own effective date. Preview off-origin guards remain unchanged, and actual faucet minting was not tested.
