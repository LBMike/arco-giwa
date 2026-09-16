# Stocks display API server wiring

`buildApp(env, services)` accepts optional `services.stocksMarketData`. Supplying it registers the independently reviewed display plugin once; omitting it preserves existing callers and leaves display routes absent. Trading routes still require their separate Stocks runtime. This does not enable trading.

The real `startServer` constructs `configuredStocksMarketData(envSource)` before allocating Prisma and passes the single instance into app composition. Construction does not fetch data. The instance shares the upstream cache, singleflight and request budget across all five display endpoints. It adds no worker, timer loop or new database.

Server-only settings:

| Variable | Behavior |
| --- | --- |
| `MASSIVE_API_KEY` | Missing/empty uses keyless mode. Nonempty keys are validated by the existing service and are sent only in the provider Authorization header. No `VITE_*` key. |
| `STOCKS_MARKET_DATA_FEED_DELAY` | Optional exact `UNKNOWN`, `DELAYED_15_MIN`, `END_OF_DAY`, or `REALTIME`; default UNKNOWN. A configured label is not proof of live entitlement or source freshness. |

No secret file is read by this integration. Invalid settings use a fixed error string without values. The reviewed service retains its 5 requests/minute and 4-second per-request defaults. Its cache/rate controls are process-local; a multi-process deployment must provide external shared quotas.

Keyless startup exposes NVDA PILOT through `/api/v1/stocks/market/catalog`. Quotes, profile and chart return UNCONFIGURED, null/missing observations remain unavailable rather than zero, and an unavailable logo returns404. This performs zero provider requests. Existing server startup still has its normal database/readiness configuration; keyless mode does not claim the entire pre-existing application is DB-free.

A bounded curated catalog can be supplied by trusted server composition through the factory's `catalog` port. No environment JSON, browser symbol list, URL fetch or SEIBro dependency is added. The current real entrypoint uses default NVDA PILOT. Display selection does not grant order capability, and displayed USD prices do not replace the existing server-issued fixed mock execution quote.

Source semantics and UI requirements remain in [stocks-market-data-v1.md](./stocks-market-data-v1.md). Actual Massive credentials, response compatibility and display entitlement are unverified. This commit is local integration, not public activation.
