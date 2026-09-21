# GIWA investor shell + Ondo Stocks table — builder evidence (2026-09-19)

Builder: Claude (UI). Plan (committed before code): [`docs/tasks/giwa-investor-shell-stocks-table-20260919.md`](../tasks/giwa-investor-shell-stocks-table-20260919.md).
Screenshots, logs and harness output: `/private/tmp/arco-giwa-investor-shell-evidence-20260919/` (below: `$E`).

## Base
- Base repo `/private/tmp/arco-giwa-operator-diagnostics-copy-verified-20260919`: HEAD `1951782`, clean, contains `b6646fd`.
- Continued from the UI review commit `3fb0e82` (clean, contains `1951782`) as instructed; its accessibility/copy fixes are kept.
- Clone `/private/tmp/arco-giwa-investor-shell-20260919`, branch `claude/giwa-investor-shell-stocks-table-20260919`, push
  URL `DISABLED`. No merge, push or deployment.

## Shell, menu, routes
- Left sidebar (224px) from `xl` (1280px); below `xl` a sticky 76px top bar with an accessible left drawer (focus to Close,
  Tab trap, Escape, focus return, route-change close, keys of a layer opened on top are left alone, focus to `main` if the
  drawer closes at `xl`). Main content `max-w-[1512px]`, 16px gutters below 768px, 32px above. Skip-to-content control.
- Menu: Home · Invest (Savings, Funds, Stocks) · Manage (Portfolio, Send). Links carry `aria-current="page"`. Send has no
  feature or route anywhere in the repo, so it is a disabled row with "Coming soon". Admin appears only for allowlisted
  wallets (visibility only; routes keep their guards).
- Routes: `/` is the new Home; `/funds` renders the existing Funds page (`Investor.tsx`, unchanged). `/savings`,
  `/portfolio`, `/product/:id`, `/stocks`, `/admin/*`, `/admin/stocks`, `/app/*` redirects and the catch-all are unchanged.
  "Back to products" / "Browse products" links now go to `/funds`. `/app` and `/app/giwa-preprod` now land on Home.
- `xl`, not `lg`, because a sidebar at 1024px leaves Product detail's `lg:grid-cols-[1fr_360px]` a 352px left column.
  Trade-off: at 1280–1327px the Funds table (min 1040px) scrolls inside its card, as it already did below ~1136px.

## Savings and Funds — reused unchanged
`Investor.tsx` (`GiwaFeaturedCarousel`, `GiwaStrategyCards`, `GiwaFilterBar`, `GiwaCatalogTable` with Product / Base Asset /
Asset Manager / Issuer / AUM / APY / Network), `SavingsPage.tsx` (`SavingsAccountSelector`, `useGiwaVaultDetail`,
`useGiwaProductOperation`, `GiwaInvestPanel`), `ProductDetailPage.tsx`, `PortfolioPage.tsx`: no logic or data-source change.
Outer-layout edits only: `SectionNav` gutter bleed follows the new gutters, two loading skeleton rows clip instead of widening
the page, the Footer follows the shell width/gutters, the test-funds result popover fits the drawer. Home reads the same
react-query keys, so its counts share the Funds/Savings cache.

## Stocks table (Figma `2v7vb7Waf62RLoGLEhO4or` node `9:2`)
- Columns in Figma order and wording: `#`, `Asset Name`, `Price¹`, `24h ($)`, `24H (%)`, `24H Volume`, `Asset Status`,
  `24h Chart`. ARIA table on a CSS grid; below 768px rows become two-line cards (name, price, 24H %, status); horizontal
  scroll stays inside the table region with `#`/Asset Name pinned.
- Toolbar: "Stocks & ETFs" + count of rows actually served, chips All assets / Stocks / ETF (kind from the curated list),
  search ("Search asset name or ticker"), sort (Rank, Top Gainer, Top Loser, Price: High to Low / Low to High; value sorts
  disabled without values). `#` always shows the server rank; filters/sorts never renumber.
- Values follow the market contract: Price = underlying USD quote; 24h ($)/(%) = provider change vs previous close;
  24H Volume = session share count (`주`, never `$`); a footnote states this on `/stocks` and Home. Missing values show `—`.
- Asset Status = ARCO order capability from the public `/api/v1/stocks/catalog` (`모의 주문`, `미활성`, `시장정보만`,
  `확인 중`, `상태 확인 불가`). No "Asset Open", "Market Closed" or "24/7".
- 24h Chart draws only an AVAILABLE 1D series the detail view already loaded (no per-row chart requests; contract + 5 req/min
  budget). Other rows show `—`.
- Selection is `?symbol=` (default first row, so the NVDA pilot still shows its detail); activation focuses the detail
  heading; "목록으로" returns focus to the row. The NVDA-only order section is unchanged and still says other symbols are
  display-only.

Measured at a 1273px table (viewport 1609): column starts 0 / 56 / 303 / 462 / 622 / 782 / 941 / 1101 vs Figma 12(pad) / 72
/ 303.3 / 462.84 / 622.38 / 781.92 / 941.46 / 1101; header 48px; rows 73px; logo 40px; chart cell 160×48 (plot 148×48).
Side-by-side: `$E/after/figma-compare/figma-vs-impl-top-5-rows.png`.

Deliberate differences: Geist instead of Gellix/A2; token colours (`chip-ink` for #626262, `ink` for black, `border` for
#dedede, `up`/`down`, `chip` backgrounds); badge text in ink (Figma green text) for contrast; no Off-Hours pill, category
chips, list/grid toggle, pagination or "452"; search always open (Figma collapsed icon); sort is a native select; change
values follow the repo number rule (max 2 decimals, no forced trailing zero: `$3.6`); a selected row is tinted.

## Curated 40 and logos
- `stocks-market/curated.ts`: 40 rows (rank 1–40, ticker, name, kind, ISIN, logo file) and the selection note: KSD SEIBro
  overseas TOP50, buy-settlement top 40, 2026-08-16~2026-09-15, retrieved 2026-09-16 — reference only, not re-queried, not
  a recommendation. No settlement figure, no runtime import of the research JSON. Display metadata only; the server owns the
  list.
- `public/logos/stocks/`: 34 PNG + `manifest.json` copied byte for byte (sha256 verified in `curated.test.tsx`), README with
  provenance and caveats. 40 instruments → 34 files (Direxion ×3, iShares ×2, ProShares ×2, Invesco ×2, Roundhill ×2). ETFs use
  the manager's mark. Served same-origin; API `logoUrl` validation (`safeLogo`) unchanged. Licence/trademark terms are not
  recorded — review before any public release.
- Browser audit (preview, 40-symbol fixture): 40 rows, ranks 1–40, 40/40 logos loaded, 0 letter fallbacks, 34 distinct files
  (`$E/after/stocks/stocks-evidence.json`, `stocks-all-40-rows-{1440,375}.png`). Detail examples: stock TSLA, ETF VOO, no-data
  NBIS, NVDA (`$E/after/stocks/detail-*.png`).
- The real server still returns only the NVDA PILOT. The 40-row list is shown only by the preview fixture.

## Previews
- Real app: `npm run dev` (5173) or any Vite port; real paths; needs the API for data (none was running: pages show their
  existing error/empty states). Used for routing/keyboard checks on port 5183.
- Fixture preview (not the app): `src/demo/giwa/investor-shell/verification/` served by the existing
  `stocks-execution-host/verification/serve.ts`; real shell/pages, hash router, GIWA API and market data from in-page
  fixtures, `/api/v1/stocks/*` from the in-process harness, every other off-origin request blocked and logged.

## Before / after
- Before (header layout, `3fb0e82`): `$E/before/app/*.png` (/, /savings, /stocks, /portfolio at 375/768/1440/1920).
- After, real app: `$E/after/app/*.png` (+ /funds, /product/unknown-id, /admin/stocks). After, preview: `$E/after/preview/`.
- Keyboard/routing (real app): `$E/after/keyboard/keyboard-report.json` — 47/47.

## Checks (Node 24.14.0, Chrome 153)
| Check | Result |
|---|---|
| typecheck / build | exit 0 / exit 0 |
| `test:frontend` default | 751: 739 pass, 12 skip (gated DOM suites), 0 fail |
| `test:frontend` with DOM runtimes + artifacts | 836/836, 0 skip |
| `.mjs` suites (routes.dom, scope-render, delayed-sell) | 27/27 |
| `chart.browser.test.mjs` (real app on Vite 5183) | 2/2 |
| `test:server` / `test:security` | 402: 330 pass, 72 DB-gated skip, 0 fail / exit 0 |
| design tokens | the same 7 known-debt findings (components.tsx lines shifted) |
| stories | no hard violation |
| Chrome: overflow at 375/768/1440/1920, real app 7 routes + preview 5 routes | 0 px everywhere |
| Chrome: keyboard, drawer, direct entry, reload, back/forward, legacy redirects | 47/47 |
| Codex harness (unchanged scripts) | see below |

The first `test:server` run failed 50 tests with ENOENT on `packages/contracts/artifacts/*.json` (the new clone had no
compiled artifacts). After copying the gitignored build artifacts from the previous clone: 330/0.

Codex harness (`scripts/stocks-local`, unchanged; real PostgreSQL 18.6 + local EVM + Chrome; `LC_ALL=en_US.UTF-8`;
`STOCKS_LOCAL_STACK_ONLY=1`):
- Final code: `operator-diagnostics` PASS (19 investor groups + diagnostics cases, `knownFindings []`, `pageErrors []`);
  `known-hash-ui` PASS (31/31 groups). Owned services stopped. Evidence `$E/harness-operator-diagnostics/`,
  `$E/harness-known-hash-ui/`, logs `$E/logs/harness-*.log`.
- Before the review fixes: `operator-diagnostics` PASS; `known-hash-ui` attempt 1 FAILED at
  "Browser timeout: expired-session no-hash notice" in the 4th case (SELL TRANSFER) after 22 passing steps, rerun PASS
  31/31 with no code change (`$E/harness-known-hash-ui-attempt1/`, `$E/harness-prefix-fix/`). On the failure page the market
  section was in its error state, so the new table code had not run; the notice comes from the unchanged execution host.
  Treated as a timing flake and handed to Codex.

## Review
Five-lens adversarial review (behaviour, accessibility, data honesty, design/layout, tests), one skeptic per finding:
31 findings, 16 confirmed, 15 fixed with tests, 1 kept (the 1280–1327px Funds scroll above). Fixed: skip target under the
sticky bar, drawer trapping a modal opened from it, focus lost when the drawer closes at `xl`, section-label contrast,
empty-state row inside the table, Home footnote missing column meanings, "당일" wording, invented ranks for partially
ranked catalogs, toolbar wrap at 768–808px, name weight and badge colours, Footer width/gutters, popover width in the drawer,
missing tests (1D-only sparkline, drawer route close, `changeParts`). Also: STALE 1D series no longer feed the sparkline.

## Remaining UI items
- `--color-arco-up` (#179386) is 3.78:1 on white for 14px change text; an AA green (e.g. Figma #007a4b) needs token approval.
- Stock detail for a symbol with no quote repeats "시세를 불러올 수 없습니다" three times and colours the empty window change
  green (existing detail code, unchanged).
- Funds page title stays "Products" under the "Funds" menu item; Portfolio still has no h1; Footer overflows below ~372px
  (320px) and `/arco-wordmark.png` is missing from `public/` (all pre-existing).
- Savings/product detail show a legacy mTBILL fee sentence from `useGiwaVaultDetail` legacy data (pre-existing).
- `aria-disabled` on the Send `<span>` may not be announced by every screen reader; "Coming soon" is.

## Codex handoff (backend / harness)
1. Server-owned curated 40 market catalog (symbol, name, exchange, ISIN, rank; provenance CURATED with period/as-of; not
   VERIFIED, no SEIBro access). Update `stocks-market-runtime/app-integration.test.ts` (NVDA-only deep-equal, AAPL 404).
2. Row mini charts: a batch downsampled 1D series (or a configurable request budget) — today only detail-loaded series draw.
3. Logos: optionally serve the curated PNGs through the existing `/:symbol/logo` route so `logoUrl` carries them; licence review.
4. Order capability stays NVDA-only in `/api/v1/stocks/catalog`; the table reads it as is. A market-session source would be
   needed before any open/closed status.
5. Harness: no assertions yet for the shell (sidebar/drawer), Home or the Stocks table; `known-hash-ui` SELL TRANSFER
   expired-session notice timed out once (see above).
6. Still open from the UI review: portfolio `quoteExpiresAt`, evidence lease length, admin 401 semantics, persistent real-stack
   preview, DOM suites skipped in CI (now 12 skips).
7. The Dynamic SDK fetches `dynamic-static-assets.com` on every page load, even without an environment ID (pre-existing).
