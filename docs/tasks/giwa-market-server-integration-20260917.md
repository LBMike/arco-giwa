# GIWA display market data: server integration

Base: `fe9a0c8e28054ed471becdad149e818d4f2b66bc` (independently reviewed host `bac9020a` plus market source `6008f104` / handoff `ac91155e`). User-authorized continued implementation; main/public deployment is not part of this task.

## Plan before code

- Add `server/src/stocks-market-runtime/config.ts` and actual `buildApp.inject` tests.
- Add optional `stocksMarketData` service in `app.ts` and register the encapsulated plugin once. Existing callers without this service retain their existing routes.
- Construct the service once at startup in `index.ts`, before DB allocation. Missing `MASSIVE_API_KEY` registers display routes as UNCONFIGURED without provider traffic. Server-only `STOCKS_MARKET_DATA_FEED_DELAY` is explicit and defaults UNKNOWN; no live entitlement is inferred.
- Keep service default rate/deadline policies. A curated catalog may be passed by server-owned code; no arbitrary query/environment catalog or SEIBro access. Default remains NVDA PILOT.
- Preserve trading catalog, mock execution price, auth, CORS and existing Saving/Funds behavior. Do not import frontend, mutate trading/DB/contracts, or read secret files.
- Verify keyless endpoints/network0, plugin omission, configured in-memory provider, cache reuse, malformed inputs, sanitized errors and legacy/Stocks isolation through actual app injection. Run server build/full server and security; frontend integration is delegated in another checkout.

Dependency runtime reused only after package-lock equality with the market-data builder checkout. ABI artifacts must be from the same source and recorded if needed. No public network/listener/DB calls.
