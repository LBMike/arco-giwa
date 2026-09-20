# Alpaca display data integration — 2026-09-21

User requested delegation to a backend agent for stock price, market capitalization and volume retrieval through Alpaca. Implemented in the current UI integration clone, baseline `1b0fbf2`.

## Delivered

- Backend agent implemented server-only Alpaca snapshots and split-adjusted historical bars, configurable IEX/SIP feed, fixed-host header authentication, provider-specific provenance, and a static 40-security catalog opt-in.
- Parent integrated browser envelope validation, truthful provider/feed labels and tooltips, runtime documentation and the credential-free environment template.
- Market cap and ETF AUM retain the existing independent Massive / ETF Global enrichment. These are not fields in the implemented Alpaca snapshot API. Enrichment availability does not block Alpaca quote/chart reads.
- Reused bounded transport/cache/singleflight/request controls; retained source timestamp high-water protection. Prices/volume retain exact provider decimal lexemes. Previous-close logic accounts for premarket daily-bar rollover. Extreme derived percentage overflow becomes null rather than an invalid monetary DTO.
- Added a real Fastify plugin → browser market client integration test, with only external provider responses mocked. It checks decimal fidelity, hybrid profile provenance, credential isolation, shared quote cache, and catalog parity with the existing UI 40.

## Validation

- Typecheck, production build and server build passed.
- Frontend suite: 827 total, 808 passed, 19 existing gated skips, zero failures.
- Server suite: 417 total, 345 passed, 72 existing gated skips, zero failures; includes 12 new Alpaca tests.
- Final focused integration/market checks passed after the premarket refinement.
- Security checks passed. Design token check reports only the seven documented pre-existing violations; story structure has no hard violations.
- Official batch Snapshot / single-symbol Bars endpoint docs and official SDK/OpenAPI were checked; references are in the runtime guide.

## Activation state

No real credentials were read, provided or used. No subscription, live market request, deployment, order, contract or registry change occurred. Default MASSIVE/PILOT settings remain compatible. The port-4392 verification page continues to show offline fixture data.

To activate, follow [server configuration](../contracts/stocks-market-runtime-v1.md#alpaca-activation): configure ALPACA with the CURATED_40 preset and server-only credentials; choose IEX or entitled SIP explicitly. Fundamentals need their separate Massive key/entitlement. Live response compatibility and actual account entitlements remain to be verified.
