# Stocks market display data — 2026-09-17

Status: ASSIGNED. The user authorized Ondo-level data with approximate testnet swaps and chose Massive preparation without an existing API account. The coordinating task `01a0aae1-20be-7a42-9672-dbcd305033dd` confirmed exclusive ownership of this module and reserves shared app/index/UI integration.

Scope correction: the user clarified SEIBro is only a stock-selection reference and explicitly prohibited further access. The catalog research task was interrupted immediately. No SEIBro scraping, synchronization, runtime integration, or collected ranking snapshot is included in this task. Initial selection is a separate curated input; market data comes from Massive only.

Base SHA: `bc67cf2a8ae98d3e5f820627afe8f25046a0891a`.
Branch: `codex/giwa-stocks-market-data-20260917`.
Checkout: `/private/tmp/arco-giwa-stocks-market-data-20260917` (independent same-product clone).

Roles: commander `/root`; builder `/root/stocks_market_data_builder`; reviewer `/root/giwa_stocks_builder` (a separate identity from this task's builder, read-only review); catalog researcher `/root/seibro_catalog_research` (interrupted; no further access).

Allowed files: `server/src/stocks-market-data/**`, this document, `docs/contracts/stocks-market-data-v1.md`, `docs/evidence/stocks-market-data-20260917.md`. Commander owns documents; builder owns module source/tests. Review is read-only in a separate checkout after a candidate commit.

Forbidden: dependency/lock/schema/migration changes, existing Stocks trading modules, contracts, registry, other product code, secrets/environment files, frontend/shared app/index entrypoints. No signing, transaction broadcasts, vendor account purchases, push, main merge, public deployment. No money state changes or database required.

Objective: a dependency-free optional Fastify plugin and factory supplying Massive underlying-equity snapshots, chart bars, company metadata, and safely proxied company icons. Values are display-only, USD decimal strings; provider delays and availability are explicit. Existing mock execution and chain test flows are untouched. Configuration is injected server-side; unconfigured is a supported state.

Acceptance: exact numeric parsing; source identity and data consistency validated; no fake current prices; finite bounded catalog up to 40 with provenance; default catalog is existing NVDA pilot, never falsely a verified SEIBro top40; batched snapshots and singleflight bounded cache; fresh/cache-age/source timestamps distinct; failed refresh marked stale within finite bounds and unavailable afterward; failures/429/403/timeout/oversize/malformed responses sanitized and retried with bounded cooldown; deadlines cover body reads and ignore late results; only allowlisted Massive HTTPS destinations and no redirects/URL key leakage; raster icons only with size/type checks. API keys stay out of responses/logs/browser URLs. Charts have explicit range/interval, split-adjustment, underlying asset basis, incomplete-history indicators; no fabricated bars/gap filling. Trade eligibility and token price are not inferred from a market-data listing.

Verification: `npm run build:server`; `node --test server/dist/stocks-market-data/*.test.js`; `npm run test:security`; relevant generic server baseline; `npm run typecheck`. Independent exact-SHA review and rerun are mandatory. Tests use explicit synthetic fixtures, never claim live data verification. No DB/chain tests needed for isolated read-only display module. If `scripts/check-independence.sh` exists, execute it; otherwise record that this GIWA baseline has none.

Failure cases: provider absent or unauthorized; plan lacks snapshots/history; timeout even if fetch ignores abort; stalled/oversized body; missing ticker/zero snapshot; duplicate or mismatched ticker; future/nonmonotonic timestamps; out-of-order bars and impossible OHLC; exact large integers/exponent decimals; URL injection and redirect; concurrency stampede; stale cached data vs fresh transport; bounded symbol/range/cache keys and request budget. Source dates never use a fetch time to imply a live trade.
