# GIWA Stocks market UI integration — builder evidence

Date: 2026-09-17. Builder checks; independent review of this final UI candidate is required.

Base: `fe9a0c8e28054ed471becdad149e818d4f2b66bc`. Separate clone `/private/tmp/arco-giwa-stocks-market-ui-20260917`, branch `codex/giwa-stocks-market-ui-20260917`. Investor/admin imported commits are recorded in the task plan. Their independently accepted source fixes are d5bf1a8 and9c0a34c. Root owns the separate market server registration7b37ee9; this frontend does not import or modify that server integration. User chart direction54d6c932 was read; root owns its documentation import.

## Result

- Real `/stocks` and `/admin/stocks` route objects are registered in main.tsx. Stocks admin is a top-level sibling, outside legacy RequireGiwaAdmin and its operator-token layout. Existing providers stay above all routes. Desktop and mobile navigation include Stocks; existing Saving/Funds components are unchanged apart from that header link.
- Stocks pages compose market display, shared sign-in and the existing investor/admin features. Trading client is memoized by API base/transport. Session rejection captures the issuing session.id before calling host invalidation. Moving between these routes retains the common login; account changes hide prior data on their first committed DOM.
- Display client validates the fixed5 endpoint contracts and exact symbol correspondence. It uses only the ARCO API, public GET, no bearer/cookies, bounded response size, cancellation and a monotonic deadline checked after body/parse. Invalid data fails visibly; source timestamps remain distinct from fetch timestamps. Safe logos use only the matching symbol's API-origin proxy path; unavailable images use neutral initials.
- Default NVDA PILOT listing and keyless UNCONFIGURED have explicit labels and `—` values. No synthetic runtime chart, claimed40-security selection, SEIBro request, arbitrary provider URL or browser key. A future server-curated catalog can display other symbols, but selecting them does not change the separately labeled NVDA order panel.
- ARCO-owned Recharts line/area uses actual returned closes only, gaps become separate segments, no smoothing/synthetic observations, exact OHLCV table. Five periods; 1D explicitly rolling24h. Mouse/keyboard/touch select a real observation, exact close and bar-start time. All timestamps use New York with DST. Numeric conversions occur only for drawing coordinates; exact decimal/bigint computes returned-window percentage, distinct from snapshot daily change. Snapshot/list labels round to two decimals with integers and retain exact source in title; selected observation/underlying data retain exact strings.
- EMPTY, one observation, TRUNCATED, STALE, unavailable and unconfigured remain distinct. Quote source age and chart observation window are visible. Corporate metadata has its own availability, fetchedAt and sourceDate labels: stale metadata cannot borrow a fresh quote's timestamp.
- NVDA mock execution remains fixed120 in the existing test-cash trading catalog; market price never feeds quote/order logic. Wallet funding/escrow signing remains explicitly unconnected.

## Scope

New `src/demo/giwa/stocks-market/**`; minimal nav changes in `components.tsx` and `GiwaHeaderMenu.tsx`; route constants and main registration. No edits to imported investor/admin internals, host/provider/wallet, server/contracts, theme, package/lockfiles. Original working copies untouched. Isolated Vite server owned only `127.0.0.1:5724`; never reused user services5173/5418. Local browser/server required sandbox escalation for loopback/process launch, approved automatically. No public API, real wallet, signing or database exercised.

## Tests

Logs and screenshots: `/private/tmp/arco-giwa-market-ui-evidence-20260917/`.

- `market.test.tsx`:10/10, strict contract/decimal/profile URL/chart/precise return/keyless/public fetch/bounded transport/main-thread deadline/visual-state rendering.
- `routes.dom.test.mjs`:12/12 using actual production route factory, real Stocks pages/host/investor/admin, explicit injected fake transports. Keyless, no client, server403, one login across navigation, account-change first commit, stale/partial/empty/one chart, range response races, stale profile with fresh quote, API-change late401 and explicit error separation. jsdom has no real layout; its chart-size warnings are expected and not counted as visual proof.
- Full frontend with existing host DOM runtime:340/340, no skips, including existing Saving/Funds regressions and host lifecycle tests. Separate market route .mjs suite is not included in this count.
- Typecheck, production build, security and story checks: exit0. Existing large bundle warning remains.
- Design token hook: exit1 for exactly7 inherited raw-color findings; new module0. Existing components.tsx line positions move with the new nav link.
- Diff whitespace: exit0.

Commands:

```sh
node --import tsx --test src/demo/giwa/stocks-market/market.test.tsx
GIWA_MARKET_DOM_RUNTIME=/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json node --import tsx --test src/demo/giwa/stocks-market/routes.dom.test.mjs
GIWA_HOST_DOM_RUNTIME=/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json npm run test:frontend
npm run typecheck
npm run build
npm run test:security
node .claude/hooks/check-design-tokens.mjs --all
node .claude/hooks/check-story-exists.mjs --all
git diff --check
```

Existing matching-lock dependency tree was copied from the investor fix clone; no install. External jsdom26.1.0 and existing bundled Playwright were reused. The committed DOM test explicitly requires GIWA_MARKET_DOM_RUNTIME and does not silently skip. Early harness failures from mixed CommonJS/ESM router contexts, StrictMode replay counting and an open mobile menu were corrected in the harness; no product workaround was introduced.

## Actual browser evidence

Headless Google Chrome with a fresh isolated profile loads **actual main.tsx and browser routes** from the owned Vite server. Every non-loopback request is blocked except localhost8080 API requests, which receive explicit in-memory JSON fixtures. No live data is fetched.

15 scenarios: keyless, partial, stale, one observation, empty ×375/768/1440. Each has zero page errors and zero document horizontal overflow. All15 navigate to real `/admin/stocks` and show its signed-out state, without the legacy operator gate. Mobile Stocks menu, keyboard period change and touch observation selection are checked. 17 PNGs include15 states and keyboard/touch selections. `browser-results.json` preserves counts, route checks and interactions.

Visually inspected `partial-375.png`, `partial-1440.png`, `keyless-768.png`: restrained white surfaces, readable stacked small layout, separated chart gaps, no horizontal clipping, no keyless fabricated graph. Fixtures label their synthetic corporate data explicitly; screenshot prices and times are not market evidence.

## Remaining boundaries

The server+frontend combination will be tested separately by root after importing this UI commit. Provider keys, live Massive compatibility/entitlement, complete40-symbol catalog, actual wallet transactions, production deployment and settlement are not enabled or claimed. Same-key unknown order recovery limitations from d5bf1a8 remain. Saving/Funds have regression-test coverage and unchanged source, not a new real-chain end-to-end test. No push, merge or deployment.
