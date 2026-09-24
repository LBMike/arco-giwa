# ETF outstanding units × market price

User requested a free-data AUM approximation using ETF outstanding units times price.

## Result

- Massive Basic ticker overview returns SOXL `share_class_shares_outstanding=175700060` despite `market_cap` being absent. A single authenticated probe returned HTTP 200; no credentials were printed or committed.
- Added optional decimal-string `sharesOutstanding` to the backend profile and frontend validation. Uses the recorded share-class count only; no substitution of weighted shares or trading volume.
- Home/full stock tables and the detail statistics share one calculation: reported ETF AUM first, otherwise outstanding units × the displayed last market price, visibly labelled `추정 AUM`. Stocks retain provider market cap.
- Exact decimal arithmetic; missing/zero inputs, unavailable prices and mismatched symbols do not produce estimates. Last-known prices retain their timestamp and stale qualifier in the tooltip.
- This is ETF market capitalization used as an AUM approximation, **not official NAV-based net assets**. The tooltip explains the formula, price timestamp, and that Massive does not supply the outstanding-unit observation date. Share count and price may refer to different dates; creations/redemptions or splits between dates can distort the approximation.
- Reuses existing profile fetches and 24-hour in-memory cache. No extra periodic requests, no paid ETF Global calls; Massive remains capped at four calls/minute. All eligible ETFs use the same path; coverage is conditional on provider fields, not promised for all listings.

## Verification

- Live browser list and SOXL detail both show `$21.73B` with `추정 AUM`.
- Observed calculation: `175700060 × 123.67 = 21728826420.20 USD`; price timestamp `2026-09-18T20:46:01.151Z`, last-known market price.
- Frontend: 835 total / 816 pass / 19 existing gated skips / 0 failures.
- Server: 417 total / 345 pass / 72 gated skips / 0 failures.
- Typecheck, production build, security checks pass; token check retains seven baseline findings, no hard story-structure violations.
- Added regression coverage for exact large-number arithmetic, reported-AUM precedence, zero/missing/mismatched data, stale timestamps, backend/frontend validation, and home/list/detail rendering.

Reference: https://massive.com/docs/rest/stocks/tickers/ticker-overview
