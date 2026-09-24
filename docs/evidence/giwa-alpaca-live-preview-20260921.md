# Local IEX activation — 2026-09-21

User authorized connecting the UI and requested limits suitable for Alpaca's free plan.

## Delivered

- Existing loopback preview at port 4392 starts with `--live-market`, injects a non-secret IEX-mode marker and selects real display data at the existing Stocks URL. Offline startup remains the default without that flag.
- Server-only helper reads only the Alpaca key pair from the user-authorized, gitignored `.secrets/alpaca.env`. It forces IEX and no secondary fundamentals provider; credentials never enter Vite environment, HTML, API responses or logs.
- A single service instance shares the batch quote cache, per-symbol chart cache, in-flight deduplication and rolling budget of 60 requests/minute across tabs. The existing 429 cooldown is retained. Other processes using the same credentials are outside this budget.
- Visible pages refresh batch quotes at 30s, detail charts at 60s, list enrichment at 300s (after completion). Hidden tabs pause scheduled refreshes, resume when due and never overlap reads. List failures clear outdated enrichment.
- Stocks and Home display IEX provenance and the most recent trade timestamp. Actual market cap/AUM enrichment is not configured. Savings/Funds remain captured deployed data and execution remains simulated.

## Validation

- Actual backend read: 40 quote rows, provider ALPACA, feed IEX; NVDA 1W returned 40 bars. Recent trade dates are September 18; old-observation status remains intact rather than being relabeled fresh.
- Browser: SOXL list price changed from fixture $171.63 to provider $123.67; volume estimate $68.81M; IEX and latest trade timestamp visible. SOXL 1W chart rendered real bars. Rolling 24h charts contain no observations during this weekend window and are not fabricated.
- Direct and Vite /@fs secret-file paths both returned 403; a cross-origin display API request returned 403.
- Full frontend suite after polling implementation: 829 tests, 810 passed, 19 existing gated skips, no failures. Server suite: 417 total, 345 passed, 72 gated skips, no failures.
- Final targeted tests: six passed, covering hidden-tab pause/resume, no overlaps, cleanup, row cancellation, forced IEX despite SIP configuration, cache sharing, credential exclusion and no fundamentals vendor request.
- Typecheck and production build passed. Security checks passed. Design checks retain only the seven documented baseline color violations, no hard story-structure violations.

No paid subscription, deployment, public exposure or real trading was performed.
