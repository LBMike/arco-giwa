# Stocks display API server wiring

`buildApp(env, services)` accepts optional `services.stocksMarketData`. Supplying it registers the independently reviewed display plugin once; omitting it preserves existing callers and leaves display routes absent. Trading routes still require their separate Stocks runtime. This does not enable trading.

The real `startServer` constructs `configuredStocksMarketData(envSource)` before allocating Prisma and passes the single instance into app composition. Construction does not fetch data. The instance shares the upstream cache, singleflight and request budget across all five display endpoints. It adds no worker, timer loop or new database.

Server-only settings:

| Variable | Behavior |
| --- | --- |
| `STOCKS_MARKET_DATA_PROVIDER` | `MASSIVE` (default) or `ALPACA`; exact uppercase selection. |
| `STOCKS_MARKET_DATA_CATALOG` | `PILOT` (default NVDA) or `CURATED_40` (the current display catalog). Does not expand order capability. |
| `MASSIVE_API_KEY` | Default price provider credential. In ALPACA mode, optional independent company profile / market cap / ETF AUM / logo enrichment. Authorization header only. |
| `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` | Both server-only credentials are needed in ALPACA mode. No credential is accepted from the browser. |
| `ALPACA_DATA_FEED` | `iex` (default; single exchange) or `sip` (consolidated US exchanges, requires the relevant entitlement). |
| `STOCKS_MARKET_DATA_FEED_DELAY` | Optional exact `UNKNOWN`, `DELAYED_15_MIN`, `END_OF_DAY`, or `REALTIME`; default UNKNOWN. A configured label is not proof of live entitlement or source freshness. |

No secret file is read by this integration. Invalid settings use a fixed error string without values. The reviewed transport retains a default budget of 5 requests/minute per provider and a 4-second per-request timeout. Its cache/rate controls are process-local; a multi-process deployment must provide external shared quotas.

Keyless startup exposes NVDA PILOT through `/api/v1/stocks/market/catalog`. Quotes, profile and chart return UNCONFIGURED, null/missing observations remain unavailable rather than zero, and an unavailable logo returns404. This performs zero provider requests. Existing server startup still has its normal database/readiness configuration; keyless mode does not claim the entire pre-existing application is DB-free.

A bounded curated catalog can be supplied by trusted server composition through the factory's `catalog` port, or selected from the fixed `CURATED_40` runtime preset. No environment JSON, browser symbol list, URL fetch or SEIBro dependency is added. The current real entrypoint uses default NVDA PILOT. Display selection does not grant order capability, and displayed USD prices do not replace the existing server-issued fixed mock execution quote.

Source semantics and UI requirements remain in [stocks-market-data-v1.md](./stocks-market-data-v1.md). Actual provider credentials, live response compatibility and display entitlement are unverified. This commit is local integration, not public activation.


## Alpaca activation

Set these **server** settings in the deployment secret/configuration manager (the committed `.env.example` contains empty credential slots):

```text
STOCKS_MARKET_DATA_PROVIDER=ALPACA
STOCKS_MARKET_DATA_CATALOG=CURATED_40
ALPACA_DATA_FEED=iex
STOCKS_MARKET_DATA_FEED_DELAY=UNKNOWN
```

Supply `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` through the server secret store. Supply `MASSIVE_API_KEY` if market cap and ETF AUM enrichment is required. Keep latency UNKNOWN until the entitlement is known; feed coverage is exposed independently as `marketFeed: IEX|SIP`.

- Snapshot prices and session share volume come from Alpaca. The UI's Volume (USD) remains a **price × shares estimate**, not the exchange-reported sum of trade values.
- The snapshot and public asset APIs do not expose market capitalization or ETF AUM. The existing Massive profile/ETF Global enrichment remains independent; absent credentials or entitlements leave these fields unavailable rather than inventing values.
- The runtime preserves vendor provenance: Alpaca catalog/quotes/charts report ALPACA and the selected marketFeed; profile/logo results report MASSIVE.
- The browser calls the existing backend `/api/v1/stocks/market/*` routes. Provider credentials never appear in its API requests, returned JSON or bundles.
- To show backend data, run the normal application against that backend. The current `/investor-shell/verification/` page on port 4392 is an offline fixture preview and deliberately does not turn into a live-data service when keys are configured.
- This change adds no orders, subscriptions or deployment. Live activation still requires valid server credentials; SIP and fundamentals availability depend on provider entitlements.

Official references checked September 21, 2026: [snapshot](https://docs.alpaca.markets/us/reference/stocksnapshots-1), [historical bars](https://docs.alpaca.markets/us/reference/stockbarsingle-1), [feed coverage and authentication](https://docs.alpaca.markets/us/docs/market-data-faq), [public asset fields](https://alpaca.markets/sdks/python/api_reference/trading/models.html#alpaca.trading.models.Asset).
