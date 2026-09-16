# GIWA-STOCKS-MARKET-UI-001 — plan

Authorized continuing development; implement locally, no further plan approval pause. Base `fe9a0c8e28054ed471becdad149e818d4f2b66bc`, separate clone `/private/tmp/arco-giwa-stocks-market-ui-20260917`, branch `codex/giwa-stocks-market-ui-20260917`.

Imported exact candidates (local fetch/cherry-pick, originals untouched):

| Source | Local commit |
| --- | --- |
| 1866ea2 investor module | d95eee9 |
| 0d07eb2 investor body-refusal correction | 06f0d19 |
| d5bf1a8 investor recovery fixes | 0c80911 |
| ea88c27 admin plan | af75185 |
| 037aeda admin module | d870f20 |
| 1f654c3 admin evidence | 594f7d1 |
| 9c0a34c admin scope fix | 5af9267 |

Investor d5bf1a8 and admin9c0a34c have separately reported independent PASS; no claim of this integration passing until its own checks/review.

## Plan before integration code

1. Runtime-validated display-only market DTO/client with bounded GET, same-origin safe logo URLs, exact decimal strings and exact symbol join. No token/key, SEIBro access, provider URLs or automatic fallback prices.
2. Owned display React feature, API/symbol/range keyed lifetimes and abort guards. Pilot/curation provenance, unavailable/keyless/stale/partial states. ARCO-owned Recharts line/area with segmented gaps, exact selected-window bigint change and OHLCV table, no fabricated bars or interpolation. Preserve white theme and existing tokens.
3. Real `/stocks` and sibling `/admin/stocks` routes outside legacy admin gate. Common host login and adapters; memoized trading client per API base; capture session.id before invalidation. Compose display separately from existing NVDA trading. Keep wallet funding/escrow unavailable guidance. Add Stocks desktop/mobile nav only.
4. Offline tests for strict parser/client, races, real route renderer with real common host/feature children and injected transports; original Savings/Funds regression suite. Screenshots at375/768/1440 if an available local browser can be used; report limits honestly.
5. Frontend/types/build/security/hooks, scoped diff, evidence and local commit. No server/provider/wallet/theme/dependency changes, live keys/wallet/RPC/DB, push/merge/deploy. Root owns server app/index integration.

Chart user direction read from source docs commit `54d6c932de0db21dee152b898603d83f68f68385`; root owns importing that documentation, not duplicated here.
