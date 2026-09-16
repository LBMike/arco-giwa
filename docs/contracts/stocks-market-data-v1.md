# Stocks market data v1 — display only

Approved boundary: Massive provides **underlying US stocks/ETF display data**. The current GIWA testnet Stocks broker remains a separate fixed mock-price engine. No module in this task may import or mutate trading, settlement, wallet, contract, journal, or database services. The existing `/api/v1/stocks/catalog` remains the sole trading catalog; display listing does not imply buy/sell support.

## HTTP boundary

Optional Fastify plugin, routes under `/api/v1/stocks/market`:

- `GET /catalog`: selected display securities and provenance. Start with NVDA explicitly labeled PILOT, not SEIBro verified. Accept a server-injected validated catalog of up to 40; each entry has symbol, name, and optional exchange/ISIN/rank. Catalog provenance has source URL, ranking metric, period, as-of date, verification status. No user-supplied arbitrary ticker universe.
- `GET /quotes`: one bounded batched snapshot call for the catalog. Return each requested symbol including explicit unavailable items when omitted by the provider. No query permits arbitrary symbols or all-market enumeration.
- `GET /:symbol/profile`: company name, description, exchange, type (stock/ETF/etc), currency, market cap, website, industry, and a same-origin icon URL when safely available. Missing fields are null. No vendor URL containing credentials.
- `GET /:symbol/chart?range=1D|1W|1M|3M|1Y`: normalized ascending OHLCV bars, range and interval, split-adjusted basis, bar timestamps, complete/truncated result indication. No invented continuity or timestamps. Bounded date ranges computed server-side; no arbitrary date or interval amplification. Missing/partial history explicit.
- `GET /:symbol/logo`: bounded cached safe raster icon proxy, or 404 if missing; no SVG/HTML, no arbitrary remote URL. No credential-bearing redirects.

The plugin/factory export names and exact TypeScript DTO fields must be documented in the final handoff. Preserve this endpoint boundary; discuss any change with commander before implementing it. Dividends/market calendar may follow later; missing yield/volume semantics must not be invented for UI parity.

## Response semantics

Every JSON endpoint carries `schemaVersion: 1`, `profile: DEMO_TESTNET`, `chainId: 91342`, `purpose: DISPLAY_ONLY`, `priceBasis: UNDERLYING_SECURITY`, `provider: MASSIVE`, and `executionPriceSource: FIXED_MOCK_PRICE` to make the separation machine-readable.

Service responses carry explicit `status` (`AVAILABLE`, `STALE`, `UNAVAILABLE`, `UNCONFIGURED`), sanitized `reason`, `fetchedAt` (transport/cache observation), source timestamps on values/bars, and configured `feedDelay` (`UNKNOWN`, `DELAYED_15_MIN`, `END_OF_DAY`, `REALTIME`). Default UNKNOWN, never infer REALTIME from a successful response or key. A recent fetch does not make old trade timestamps live. Empty chart bars mean no returned observations, not zero prices. Decimal values (including price, change, marketCap and volumes) must be exact strings parsed from provider numeric lexemes, with bounded precision/magnitude; use bigint for comparisons/arithmetic. Numeric timestamps/counters are permitted when checked safe integers. No floating-point money arithmetic.

Do not map a static provider error body directly into HTTP responses/logs. Unavailable provider data should be represented as data availability; malformed route inputs get 400/404. No backend stack traces, credential-bearing URLs or raw upstream response bodies. No invented company logo from unrelated sources.

## Credentials and request policy

Factory accepts server-only injected API key and feed delay; keys are never returned or put in browser bundles/URLs. Default missing key returns UNCONFIGURED without network I/O. Use HTTPS `api.massive.com` and Authorization Bearer header, redirect error, bounded response bytes and total elapsed deadline including body read. Company branding host/path is explicitly restricted; proxy PNG/JPEG/WebP only with signature/type validation. Public API responses use same-origin logo path. Singleflight refresh and bounded cache/cooldown/request budget must work across request keys; a 429 should cool down provider calls globally rather than amplify into per-symbol retry storms. Document that a multi-process deployment needs shared quotas/cache externally.

## Provider sources (accessed 2026-09-17)

- [Full market snapshot](https://www.massive.com/docs/rest/stocks/snapshots/full-market-snapshot): `/v2/snapshot/locale/us/markets/stocks/tickers?tickers=...`; specify nonempty bounded selection. Snapshots reset daily, so zero/missing fields are possible. Snapshot entitlement is plan-dependent.
- [Ticker overview](https://www.massive.com/docs/rest/stocks/tickers/ticker-overview): `/v3/reference/tickers/{ticker}`, reference fields and `branding.icon_url`.
- [Custom OHLC bars](https://www.massive.com/docs/rest/stocks/aggregates/custom-bars): `/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}`, split adjustment, ascending order, constrained output. No eligible trades means no bar.
- [API quickstart](https://www.massive.com/docs/rest/quickstart): API authentication and plan access.

No keys are currently available. Live response compatibility and purchased feed/redistribution entitlement remain unverified. Fixture-based tests establish adapter behavior only. Public customer display requires confirming Massive business/display rights before enabling the feed. This is an activation constraint, not a claim that the provider is unavailable for local development.
