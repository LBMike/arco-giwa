# Massive Basic local connection — 2026-09-21

The user supplied a Massive API key in their Downloads/MASSIVE/MASSIVE.md file and authorized connection. The key was extracted locally without printing it and stored in gitignored .secrets/massive.env with owner-only permissions. Only official api.massive.com receives its Bearer authentication header.

- Actual NVDA ticker-detail request returned HTTP 200 with market_cap 5367153690000.
- The preview now loads the separate optional Massive credentials. Alpaca IEX remains the quote/chart provider and retains its independent 60/minute cap.
- Massive receives a distinct four-requests-per-rolling-minute limit, below the documented Basic five/minute cap, and shares the existing 24h in-memory profile cache/singleflight across browsers. Server restarts clear that cache.
- ETF Global requests are explicitly disabled for this preview. ETFs keep aum=null; stock market capitalization is not substituted for ETF AUM.
- Browser verification at the existing Stocks address displayed MU $1.15T, TSLA $1.44T and SNDK $262.36B. Other rows populate progressively under the four/minute budget; a cold full catalog can take approximately ten minutes.
- Targeted integration tests prove per-provider credential separation, four-call Massive enforcement, cached profile access after budget exhaustion, continued Alpaca quotes, no ETF paid endpoint call, and credential exclusion from responses.
- Production build/typecheck and server tests passed: 417 total, 345 passed, 72 existing gated skips. Frontend tests passed: 831 total, 812 passed, 19 existing gated skips. Security checks passed. Design checks retained only the seven documented baseline violations.

No paid plan, trading action, deployment or public endpoint was enabled. This is local display integration.
