# GIWA investor shell + Ondo Stocks table — file plan (2026-09-19)

Base: `3fb0e82` (UI review, clean; contains `1951782` and `b6646fd`). Clone `/private/tmp/arco-giwa-investor-shell-20260919`,
branch `claude/giwa-investor-shell-stocks-table-20260919`, push disabled. Plan recorded before any UI code change.

Figma: `2v7vb7Waf62RLoGLEhO4or` node `9:2` (header `9:123`, NVIDIA row `9:217`). Measured spec and exports:
`/private/tmp/arco-giwa-investor-shell-evidence-20260919/figma/NOTES.md`.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Sidebar breakpoint | Persistent 224px sidebar from `xl` (1280). Below `xl`: sticky top bar + accessible left drawer | At 1024 a sidebar leaves a 736px column; Product detail's `lg:grid-cols-[1fr_360px]` would squeeze its left column to 352px. `xl` keeps existing Savings/Funds/detail layouts intact. 1440/1920 get the sidebar, 375/768 the drawer |
| Content width | `main`: `max-w-[1512px]`, `px-4` (<768) / `md:px-8` | User direction (1512 max, 32/16 gutters). Arbitrary max-width on the shell wrapper, no new token |
| Top bar | Keeps 76px sticky height at all widths | `SectionNav sticky top-[76px]`, invest panel `sticky top-[104px]` and `scroll-mt-[140px]` stay valid |
| Routes | `/` = new Home, `/funds` = existing Funds page (`Investor.tsx`, unchanged). `GIWA_PREPROD_ROUTE` stays `/`; new `GIWA_FUNDS_ROUTE` | Links that meant "the products list" move to `/funds`; `/product/:id`, `/savings`, `/portfolio`, `/stocks`, `/admin/*`, `/app/*` unchanged |
| Send | Shown under Manage as a non-link, `aria-disabled` item with "Coming soon" | No Send feature/route exists anywhere; a dead page or active link would misrepresent it |
| Funds page title | Stays "Products" (existing screen, reused as-is); menu label is "Funds" | Savings/Funds screens are reused unchanged |
| Tokens | No token added. Ondo colors mapped to existing tokens (below) | Token edits need separate approval; deltas recorded |
| Fonts | Geist Variable (app font) instead of Gellix/A2 | New fonts are forbidden by DESIGN.md |
| Logos | Same-origin static files `public/logos/stocks/*.png` + display-only map joined by symbol. API `logoUrl` validation unchanged | User requirement; contract doc prefers server `logoUrl` — recorded as a Codex handoff option |
| Stock list | Server owns the list (`/api/v1/stocks/market/catalog`, today NVDA PILOT). A curated 40 constant supplies display metadata (logo, kind) and selection provenance only. No silent fixture fallback in runtime | Market contract + user instruction |
| 24h Chart column | Draws only 1D series already loaded by the detail view (in-page cache). Other rows show `—` | Contract forbids 40 chart loops; server budget is 5 req/min. Batch sparkline = Codex handoff |
| Asset Status | ARCO order capability from the existing public `/api/v1/stocks/catalog` (`CHECK_PAUSE_AT_ORDER` → "모의 주문", `NOT_ACTIVATED` → "미활성", absent → "시장정보만") | No market-session source exists; Ondo "Asset Open"/"24/7" are not copied |
| Copy language | Figma labels verbatim in English (headers, chips, sort names); data states Korean like the rest of the Stocks module | |

Ondo → token map: #626262 → `--color-arco-chip-ink` (#5b6472, AA 5.98:1); black → `--color-arco-ink`; #dedede →
`--color-arco-border`; up #007a4b → `--color-arco-up` (#179386, only 3.78:1 — needs an approved token for AA); down #c23a3a →
`--color-arco-down`; badge/chip bg → `--color-arco-chip`; sup "1" → `--color-arco-muted`.

## Files

### Shell, menu, routes, Home
- `src/demo/giwa/routes.ts` — add `GIWA_FUNDS_ROUTE = "/funds"`.
- `src/demo/giwa/investor-nav.ts` (new) — nav model: Home; Invest: Savings, Funds, Stocks; Manage: Portfolio, Send (disabled);
  Admin (allowlisted wallets only). Pure `isActive(pathname)` (Funds also on `/product/*`; Stocks also on `/admin/stocks`).
- `src/demo/giwa/GiwaSidebarNav.tsx` (new) — `<nav aria-label="Main">` list of `Link`s with `aria-current="page"`, lucide icons,
  44px rows; used by the sidebar and the drawer.
- `src/demo/giwa/GiwaPreprodApp.tsx` — grid shell: sidebar (xl) + column (top bar, `main`, footer). Same shell for admin.
- `src/demo/giwa/components.tsx` (`GiwaHeader` only) — becomes the top bar: menu button + logo below `xl`, wallet and test
  funds on the right. Desktop header links removed (they live in the sidebar).
- `src/demo/giwa/GiwaHeaderMenu.tsx` — bottom sheet → left drawer: `aria-controls`, initial focus, focus trap, Escape,
  focus return, non-focusable backdrop, links with `aria-current`, reduced motion, route-change close.
- `src/demo/components/SectionNav.tsx` — gutter bleed follows the new gutters (`-mx-4 px-4 md:-mx-8 md:px-8`).
- `src/demo/giwa/GiwaSkeleton.tsx` — loading rows that overflow narrow screens get `overflow-hidden` (pre-existing).
- `src/main.tsx` — index → Home, add `funds`. Source-guarded strings kept.
- `src/demo/giwa/HomePage.tsx` (new) — h1 "Home"; Savings card → `/savings`, Funds card → `/funds` (counts from the shared
  catalog/market query keys, `buildSavingsAccounts`); Stocks section = `StocksHomeList` + "View all stocks" → `/stocks`.
- `ProductDetailPage.tsx`, `PortfolioPage.tsx`, `RequireGiwaAdmin.tsx` — "products" links → `/funds`.
- `CLAUDE.md` — route list line.

### Stocks table, curated 40, logos
- `public/logos/stocks/*.png` (34 files) + `manifest.json` + `README.md` — copied from the earlier RWA demo, sha256-verified.
- `src/demo/giwa/stocks-market/curated.ts` (new) — 40 rows (rank, symbol, display name, kind, ISIN, logo file) + selection
  provenance (SEIBro overseas TOP50 buy-settlement top 40, 2026-08-16~2026-09-15, retrieved 2026-09-16; not re-queried).
- `src/demo/giwa/stocks-market/StockLogo.tsx` (new) — 40px round logo, letter fallback marked `data-logo-fallback`.
- `src/demo/giwa/stocks-market/StocksMarketTable.tsx` (new) — tab title + count, All assets/Stocks/ETF chips, search, sort
  select (Rank, Top Gainer, Top Loser, Price: High to Low / Low to High; value sorts disabled without values), 8 columns in
  Figma order and labels, footnote, sparkline, mobile stacked rows, horizontal scroll confined to the table.
- `src/demo/giwa/stocks-market/environment.ts` (new) — `StocksPageEnvironment` + api-base hook moved here, re-exported from
  `StocksPages.tsx` (same export names).
- `src/demo/giwa/stocks-market/StocksMarketFeature.tsx` — table replaces the vertical list; `?symbol=` selection (default
  first row), detail below with focus/scroll on activation and "목록으로"; detail logo from the same map; 1D series cache.
- `src/demo/giwa/stocks-market/StocksPages.tsx` — pass order capabilities to the market feature. Session/execution wiring
  unchanged.
- `src/demo/giwa/stocks-market/StocksHomeList.tsx` (new) — first 10 rows, rows link to `/stocks?symbol=…`.
- `src/demo/giwa/stocks-market/fixtures.ts` — 40-symbol synthetic fixture (tests/preview only).
- `src/demo/giwa/stocks-investor/StocksViews.tsx` — "NV" text avatar → `StockLogo` (list, detail, holdings).

### Preview (not the app)
- `src/demo/giwa/investor-shell/verification/` (new: `index.html`, `main.tsx`, `fixtures.ts`, `README.md`) — real shell and
  pages in a hash router; GIWA API and market data from in-page fixtures; `/api/v1/stocks/*` from the existing in-process
  harness in `serve.ts`; every other off-origin request blocked and logged (no public RPC).

### Tests
- New: `investor-nav.test.tsx`, `home.test.tsx`, `shell-routes.test.tsx` (source guards for `main.tsx`), `shell.dom.test.tsx`
  (drawer focus/Escape/return, gated by `GIWA_HOST_DOM_RUNTIME`), `stocks-market/curated.test.tsx` (40 rows, logo files +
  sha256), `stocks-market/table.test.tsx` (static markup), `stocks-market/table.dom.test.tsx` (gated by
  `GIWA_MARKET_DOM_RUNTIME`).
- Updated deliberately: `stocks-market/routes.dom.test.mjs` (list selector → table).

## Not changed
Server, DB, contracts, CI, `scripts/stocks-local`, Savings/Funds business logic and data sources, order/approval/transfer/
recovery flows, 003D-1/003E-1 copy, `.claude/**`, tokens, `package.json`.

## Verify
typecheck · build · `test:frontend` (default and with DOM runtimes) · `.mjs` suites · `test:server` · `test:security` · token
hook (7 known-debt) · story hook · Chrome at 375/768/1440/1920 (+1561 for a 1273px table vs Figma) · keyboard/drawer/back/
reload/direct entry · Codex harness `operator-diagnostics` and `known-hash-ui` (unchanged scripts).
