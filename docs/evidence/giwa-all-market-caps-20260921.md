# Complete curated-market fundamentals coverage

## Request

Populate market capitalization/AUM for all listed stocks and ETFs while retaining free API limits.

## Findings and implementation

- An audit against the running shared backend loaded all 40 Massive profiles, bounded by the existing four-requests/minute budget. All 26 stocks supplied market cap; 12 ETFs supplied outstanding units for the existing explicitly labelled market-price AUM approximation.
- DRAM and RAM supplied neither market cap nor outstanding units in Massive. Their official issuer website links to daily public CSV files containing outstanding units and net assets.
- Added an opt-in issuer fallback enabled by the local live-preview composition. It only reads the two fixed official files, never sends Alpaca/Massive credentials, never requests paid ETF Global endpoints, and preserves the original profile when the issuer is unavailable.
- Issuer reads share a separate two-requests/minute budget, request deduplication, a 24-hour cache, four-second deadlines, 128 KiB body bounds, redirect rejection, and a seven-day source-date freshness limit. Cached values older than seven days are omitted even within the cache TTL.
- CSV validation binds ticker and CUSIP, checks duplicate rows, dates and positive exact decimal amounts. The frontend retains issuer source/date in the AUM tooltip. Official issuer AUM takes precedence over the market-price approximation.
- Runtime enabling is local-preview only (`issuerFundamentalsEnabled` composition option). No deployment or paid subscription was made.

## Official source observations

As of 2026-09-18:

| ETF | Outstanding units | Official net assets (USD) | Source |
| --- | ---: | ---: | --- |
| DRAM | 434,730,000 | 25,855,926,611.57 | Roundhill |
| RAM | 45,000,000 | 607,882,500.70 | REX Shares via the Roundhill website |

- DRAM page: https://www.roundhillinvestments.com/etf/dram/
- Daily file: https://www.roundhillinvestments.com/assets/data/filepointroundhill.40ru.ru_dailynav.csv
- RAM page: https://www.rexshares.com/ram/
- Roundhill RAM page: https://www.roundhillinvestments.com/etf/ram/
- Daily file linked by Roundhill's page script: https://www.roundhillinvestments.com/assets/data/rex_data/getrexnav.php

## Validation

- Server suite: 420 total, 348 pass, 72 gated skips, zero failures.
- Frontend suite: 835 total, 816 pass, 19 existing gated skips, zero failures; the subsequently added issuer-source rendering/validation test also passed in the seven-test targeted suite.
- Production build, typecheck and security checks passed. Token check retains seven baseline findings; story structure has no hard violations.
- Cache is in memory: a preview restart requires refilling fundamentals under the free-plan budget (about ten minutes for 40 cold profiles). Within 24 hours, repeated client requests reuse accepted profiles.

## Final live acceptance

- Final running-backend audit: **40/40 populated**, zero pending or missing values; 26 stock market caps, 12 explicitly estimated ETF AUMs, two official issuer AUMs.
- Final snapshot is recorded in `giwa-market-caps-20260921.csv`; stock market-cap observation dates are not supplied by Massive and are left blank (retrieval time is separate).
- Roundhill redirects its mixed-case daily filename to the lowercase canonical filename. The adapter now uses the observed lowercase address directly, retaining redirect rejection. Both actual issuer-file reads and the dedicated regression suite passed after this correction.
