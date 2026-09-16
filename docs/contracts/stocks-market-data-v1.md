# Stocks market data v1 — display only

Approved boundary: Massive provides **underlying US stocks/ETF display data**. The current GIWA testnet Stocks broker remains a separate fixed mock-price engine. No module in this task may import or mutate trading, settlement, wallet, contract, journal, or database services. The existing `/api/v1/stocks/catalog` remains the sole trading catalog; display listing does not imply buy/sell support.

User clarification: SEIBro was supplied as a selection reference only, and further access is prohibited. Do not build a SEIBro data dependency or import the research snapshot. The chosen securities are a separately supplied, bounded curated catalog. Quotes, charts, profiles and logos use Massive.

## HTTP boundary

Optional Fastify plugin, routes under `/api/v1/stocks/market`:

- `GET /catalog`: selected display securities and provenance. Start with NVDA explicitly labeled PILOT, not SEIBro verified. Accept a server-injected validated catalog of up to 40; each entry has symbol, name, and optional exchange/ISIN/rank. Provenance identifies PILOT or CURATED selection and verification status; source URL, ranking metric, period and as-of date are optional context for a supplied selection, never an instruction to fetch SEIBro. No user-supplied arbitrary ticker universe.
- `GET /quotes`: one bounded batched snapshot call for the catalog. Return each requested symbol including explicit unavailable items when omitted by the provider. No query permits arbitrary symbols or all-market enumeration.
- `GET /:symbol/profile`: company name, description, exchange, type (stock/ETF/etc), currency, market cap, website, industry, and a same-origin icon URL when safely available. Missing fields are null. No vendor URL containing credentials.
- `GET /:symbol/chart?range=1D|1W|1M|3M|1Y`: normalized ascending OHLCV bars, range and interval, split-adjusted basis, bar timestamps, complete/truncated result indication. No invented continuity or timestamps. Bounded date ranges computed server-side; no arbitrary date or interval amplification. Missing/partial history explicit.
- `GET /:symbol/logo`: bounded cached safe raster icon proxy, or 404 if missing; no SVG/HTML, no arbitrary remote URL. No credential-bearing redirects.

The plugin/factory export names and exact TypeScript DTO fields must be documented in the final handoff. Preserve this endpoint boundary; discuss any change with commander before implementing it. Dividends/market calendar may follow later; missing yield/volume semantics must not be invented for UI parity.

## Response semantics

Every JSON endpoint carries `schemaVersion: 1`, `profile: DEMO_TESTNET`, `chainId: 91342`, `purpose: DISPLAY_ONLY`, `priceBasis: UNDERLYING_SECURITY`, `provider: MASSIVE`, and `executionPriceSource: FIXED_MOCK_PRICE` to make the separation machine-readable.

Service responses carry explicit `status` (`AVAILABLE`, `STALE`, `UNAVAILABLE`, `UNCONFIGURED`), sanitized `reason`, `fetchedAt` (transport/cache observation), source timestamps on values/bars, and configured `feedDelay` (`UNKNOWN`, `DELAYED_15_MIN`, `END_OF_DAY`, `REALTIME`). Default UNKNOWN, never infer REALTIME from a successful response or key. A recent fetch does not make old trade timestamps live. Empty chart bars mean no returned observations, not zero prices. Decimal values (including price, change, marketCap and volumes) must be exact strings parsed from provider numeric lexemes, with bounded precision/magnitude; use bigint for comparisons/arithmetic. Numeric timestamps/counters are permitted when checked safe integers. No floating-point money arithmetic.

Source-age policy: prices become `STALE / OLD_OBSERVATION` after 2 minutes for REALTIME, 20 minutes for DELAYED_15_MIN or UNKNOWN, and 36 hours for END_OF_DAY. This intentionally also marks old observations outside market hours; an exchange calendar is not implemented and no market-open assertion is made. Cached prices remain display-only. UI must retain the source timestamp rather than interpreting AVAILABLE as a tradeable quote.

Do not map a static provider error body directly into HTTP responses/logs. Unavailable provider data should be represented as data availability; malformed route inputs get 400/404. No backend stack traces, credential-bearing URLs or raw upstream response bodies. No invented company logo from unrelated sources.

## Credentials and request policy

Factory accepts server-only injected API key and feed delay; keys are never returned or put in browser bundles/URLs. Default missing key returns UNCONFIGURED without network I/O. Use HTTPS `api.massive.com` and Authorization Bearer header, redirect error, bounded response bytes and total elapsed deadline including body read. Company branding host/path is explicitly restricted; proxy PNG/JPEG/WebP only with signature/type validation. Public API responses use same-origin logo path. Singleflight refresh and bounded cache/cooldown/request budget must work across request keys; a 429 should cool down provider calls globally rather than amplify into per-symbol retry storms. Document that a multi-process deployment needs shared quotas/cache externally.

## Provider sources (accessed 2026-09-17)

- [Full market snapshot](https://www.massive.com/docs/rest/stocks/snapshots/full-market-snapshot): `/v2/snapshot/locale/us/markets/stocks/tickers?tickers=...`; specify nonempty bounded selection. Snapshots reset daily, so zero/missing fields are possible. Snapshot entitlement is plan-dependent.
- [Ticker overview](https://www.massive.com/docs/rest/stocks/tickers/ticker-overview): `/v3/reference/tickers/{ticker}`, reference fields and `branding.icon_url`.
- [Custom OHLC bars](https://www.massive.com/docs/rest/stocks/aggregates/custom-bars): `/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}`, split adjustment, ascending order, constrained output. No eligible trades means no bar.
- [API quickstart](https://massive.com/docs/rest/quickstart): API authentication and plan access.

No keys are currently available. Live response compatibility and purchased feed/redistribution entitlement remain unverified. Fixture-based tests establish adapter behavior only. Public customer display requires confirming Massive business/display rights before enabling the feed. This is an activation constraint, not a claim that the provider is unavailable for local development.

## Frontend integration contract

Keep the existing white theme. This module supplies data, not a new visual design.

1. Build the display list from `/market/catalog` and join `/market/quotes` by exact symbol, never by array position. These securities can be browsable even when the existing trading catalog does not allow ordering them.
2. Use profile metadata for name, exchange, security type, company description and market cap. Use the returned same-origin `logoUrl` or the existing neutral initial-letter fallback. Do not embed a Massive API URL or key in React, Vite configuration, analytics or browser requests.
3. The headline price is the underlying stock price in USD. Volume is underlying market session volume, not ARCO token trading volume or rolling crypto-style 24h volume. Do not invent token market cap, TVL, liquidity, yield or shares-per-token statistics from these fields.
4. Chart periods are exactly `1D`, `1W`, `1M`, `3M`, `1Y`. Bars describe the underlying security and split adjustment only. Do not interpolate fabricated candles across missing intervals; show incomplete-history and empty states. Reuse the existing chart library unless the frontend dependency owner approves a separate library change.
5. Render `UNCONFIGURED` as “시세 연결 준비 중”, `UNAVAILABLE` as “시세를 불러올 수 없습니다”, and `STALE` as a last-known value with “마지막 확인 시세 · 오래된 데이터” and its source observation time. Missing values are `—`, never `$0`. Respect per-symbol availability as well as response-level availability.
6. `feedDelay=DELAYED_15_MIN` displays “15분 지연”; `END_OF_DAY` displays “종가 기준”; `UNKNOWN` displays “시세 지연 정보 미확인”. `REALTIME` describes the configured feed entitlement, not a promise that every cached/old observation is current; retain stale/source-time labels.
7. The testnet order form uses the existing server-issued trading quote. Clearly label it “테스트넷 모의 체결가” separately from the underlying market price. Market-data errors must not be turned into trading prices, and market-data success must not bypass the trading capability checks.
8. No new wallet requests or chain switches are triggered by list/chart reads. GIWA and XRPL existing test flows remain untouched. A future selected 40-symbol catalog is a server-owned configuration input; this task does not obtain or synchronize a SEIBro ranking.

Deferred fields: dividends, dividend yield, exchange-session calendar, total-return-adjusted token chart, token supply/NAV/price ratio. They require a separately defined source/meaning and must not be filled with plausible-looking fixture values in normal runtime.

## Server integration (assigned integrator only)

Exports live in `server/src/stocks-market-data/index.ts`. This task supplies the module; it does not edit shared `app.ts` / `index.ts` or mount frontend routes. Register once per server instance, not once per request, so cache, request budget and cooldown are shared within that process:

```ts
import { createStocksMarketDataService, stocksMarketDataPlugin }
  from './stocks-market-data/index.js';

const stockMarketData = createStocksMarketDataService({
  // apiKey: serverOnlySecrets.massiveApiKey, // supplied by deployment owner
  feedDelay: 'UNKNOWN',
  requestsPerMinute: 5,
});
await app.register(stocksMarketDataPlugin, { service: stockMarketData });
```

Omitting `apiKey` is supported and performs no network requests. Do not add a VITE variable or write a real key into a task prompt. This module has no environment-variable loader, database connection, interval poller or startup network request. The application integrator owns the server-only secret injection and explicit optional feature composition.

Options: `apiKey?`, `catalog?`, `feedDelay?`, `requestsPerMinute?` (1–300, default 5), `timeoutMs?` (10–15000, default 4000). `fetch?` and `now?` are test seams. The injected `catalog` uses `securities: [{symbol,name,exchange?,isin?,rank?}]` and `provenance: {sourceUrl,rankingMetric,period,asOfDate,verification}`. Provenance nullable fields must be explicitly null when unknown; `verification` is PILOT, CURATED or VERIFIED. VERIFIED requires supplied source/date evidence; it never initiates a source fetch. The default pilot is NVDA, not a claim of a completed 40-security listing.

`MarketResponse<T>` adds `data: T | null`, `status`, `reason`, `fetchedAt`, `cacheAgeMs`, `feedDelay` to the common context. `/quotes` returns one data item per selected symbol even when unconfigured; each item has its own `status`/`reason` with nullable `price`, `change`, `changePercent`, `sessionVolume`, `previousClose`, `sourceTimestamp`, `observationAgeMs`, and `priceSource` (LAST_TRADE or MINUTE_CLOSE). `/profile` returns the `CompanyProfile` DTO with nullable metadata fields; a source publication date is not fabricated.

`/chart` returns `{symbol,currency,range,interval,adjustedForSplits,from,to,bars,history,complete}`. Each bar contains `timestamp,open,high,low,close,volume`. The range is rolling elapsed time: 1D=24h/5m bars, 1W=7d/1h, 1M=31d/1d, 3M=93d/1d, 1Y=366d/1d. `history` is RETURNED_WINDOW, TRUNCATED or EMPTY. `complete` means no explicit next-page/50,000-base-aggregate truncation signal was observed; it does not certify that the vendor plan covers all history or that every exchange observation exists. Chart windows include provider aggregation-boundary expansion and timestamps represent bar starts.

Cache policy: quotes 15s, fallback max 5m; charts 60s, fallback max 15m; profiles/icons 24h, fallback max 7d. Failure retry cooldown is 30s per resource; provider 429 cools down all calls for 30–300s. Budget defaults to 5 requests/minute across all resource types, which does not grant access to snapshots or intraday plans. Queries are batched by catalog; profiles/charts/icons load on demand. Fixed ranges and at most 40 symbols bound keys. Cache is process-local and clears on restart; use a separately scoped shared cache/rate-limit solution for multiple replicas. No stale cache value is used for settlement.
