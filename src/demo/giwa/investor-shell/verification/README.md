# Investor shell preview

## Editable workspace update — 2026-09-20

This workspace now displays a captured copy of the existing GIWA deployment's public product data by default.
`deployed-giwa.snapshot.json` records the public API source and capture time. Catalog, market, featured cards and
each product's price history are copied without rewriting fields. Funds shows bEQTY, auMINT, aiBENJI and aCAPIX;
Savings uses the same catalog so product IDs and links stay consistent. This is a dated snapshot, not a live feed.
Stocks still uses synthetic market data. Wallet activity remains empty preview data. External fetch blocking remains.

The synthetic fixtures below are retained as test inputs; their five invented funds are no longer the default display
in this editable workspace. `deployed.ts` routes public product reads and never substitutes synthetic history.

## Original synthetic fixture reference

The remainder documents the original all-synthetic mode and its retained test data, before the update above.

**Fixture preview: not the app, not a real stack.** Nothing behind this page is a GIWA API, a database, a chain or a
wallet. Every product, rate, price and address on it is invented.

This page mounts the real investor shell and pages in a browser, so you can click through them before they ship:

- the sidebar and the menu drawer,
- Home, Funds, product detail, Savings and Portfolio,
- the 40-row Stocks list and the security detail page that replaces it (`#/stocks?symbol=…`).

A static bar above the app, labelled `PREVIEW · fixture data · not the app`, has three parts:

- a market-data switch,
- quick links to the pages,
- a request log.

## Start and stop

The page uses the existing offline verification server; nothing needs to be installed. Run this from the clone root:

```sh
TMPDIR=/private/tmp node --import tsx src/demo/giwa/stocks-execution-host/verification/serve.ts --port 4357
```

Then open:

```
http://127.0.0.1:<port>/src/demo/giwa/investor-shell/verification/index.html#/
```

- Stop the server with Ctrl-C.
- Use `127.0.0.1`, not `localhost`.
- Any free port from 1024 to 65535 works. `serve.ts` refuses 5173 (the app's dev port) and 8788, and fails rather than moving to another port.
- `serve.ts` reads no `.env*` file, because its Vite env directory contains none. So the page gets the app's defaults:
  - the API base is `http://localhost:8080`,
  - no Dynamic environment ID is set,
  - the admin allowlist is empty.

## What is real and what is fixture

| Layer | Real or fixture |
| --- | --- |
| Shell, pages and components (`GiwaPreprodApp`, `GiwaHeader`, the sidebar and drawer, Home, Funds, product detail, Savings, Portfolio, Stocks) and `GiwaPreprodProviders` | **Real** product code, mounted in React `StrictMode` with the investor route tree of `src/main.tsx` |
| GIWA API (`ARCO_API_BASE`): `GET /api/v1/evm/catalog/91342`, `/evm/market/91342`, `/evm/featured/91342`, `/evm/market/91342/<id>/history`, `/activity/<wallet>` and `/redemptions/<wallet>` | **In-page fixtures** from `./fixtures.ts`, answered by a `window.fetch` guard. The guard is installed before any product page module loads |
| Stocks market data (`/api/v1/stocks/market/*`) | **Synthetic fixture** from `stocks-market/fixtures.ts`, passed in through `StocksPageEnvironment.fetch`. Nothing in it is a real quote |
| Other `/api/v1/stocks/*` requests (order catalog, investor reads) | **Real** in-process Stocks harness from `serve.ts`, served same-origin |
| Every other off-origin request, including the public GIWA RPC | **Blocked**: the guard answers `503 {"error":"PREVIEW_BLOCKED"}` and logs the request as `BLOCKED` |
| Wallet | **None.** `window.ethereum` is whatever your browser has. This page sends no wallet request. See the note below |
| Theme | Real `src/index.css` and `src/demo/theme.css` |

**Wallet note.** The product providers do three things without sending a wallet request:

- they read `window.ethereum`,
- they subscribe to its events,
- wagmi listens for EIP-6963 wallet announcements.

A wallet request happens only when you click **Connect Wallet**, **Mint test assets** or a Stocks sign-in button.

Once a wallet is connected, some requests are blocked because the preview has no fixture for them:

- wallet-scoped reads other than activity and redemptions (faucet status, and holdings read over RPC),
- Stocks sign-in, which goes to `localhost:8080`.

### Fixture data

- **5 funds:**
  - 2 U.S. Treasuries funds. Preview Treasury Fund A is pinned and in the carousel.
  - 2 Prime Credit funds. Preview Credit Fund B has only an implied APY.
  - 1 Equity Exposure fund.
- **1 hidden fund.** Home and Funds never show it.
- **3 savings vaults:** USDC, ETH and XRP, plus `pEUR` as a disabled "coming soon" entry.
- **2 featured cards.**
- **Price history:** 9 weekly posts per product, ending one hour before the page loaded.
- **Names:** every one says "Preview", and the issuer and manager are "Preview Issuer" and "Preview Asset Manager".
- **Addresses:** synthetic placeholders such as `0x…b001`. The explorer links on the detail page lead nowhere useful.

## The request log

Open **Request log** in the bar. Newest entries come first, and the last 300 are kept. Each line shows:

- method,
- path (with the host when the request went off-origin),
- which source answered: `fixture`, `harness` or `BLOCKED`,
- status and a note.

Same-origin static assets (Vite modules, `/logos`, images) are not listed. **Clear log** empties the list.

Some `BLOCKED` lines are expected and do not mean a fixture is missing:

- **`sepolia-rpc.giwa.io` JSON-RPC calls:**
  - price feed, greenlist and redemption-vault balance, on Savings and product detail,
  - viem retries a 503, so one read can appear up to four times.
- **`dynamic-static-assets.com/wallet-book/...`:**
  - the Dynamic SDK's wallet-book fetch, which runs as soon as `providers.tsx` is imported, even with no Dynamic environment ID,
  - the SDK then uses its built-in fallback.

A blocked `localhost:8080` read that the pages make without a wallet would be a missing fixture.

## How to try it

- **Menu:**
  - At 375 and 768 px, the menu button in the top bar opens a left drawer. Try Tab, Shift+Tab and Escape.
  - At 1440 and 1920 px, a persistent sidebar is shown. It appears from 1280 px.
  - Send is shown as "Coming soon".
- **Home:**
  - The Savings card reads "3 savings accounts · 1 coming soon".
  - The Funds card reads "5 products".
  - The Stocks list shows the first 10 by rank. Each row links to `#/stocks?symbol=…`.
- **Funds:**
  - carousel, strategy cards, filters and search,
  - AUM/APY sort,
  - a row opens product detail, and **Back to products** returns to `#/funds`.
- **Savings:** the account selector, then the invest panel, Performance, Transparency and More info.
- **Stocks:**
  - `#/stocks` is the list: the **All assets / Stocks / ETF** filters, search and sort,
  - clicking a row opens that security's detail in place of the list, with its heading focused near the top: the price card with the 1D–1Y chart, About and Statistics on the left, and the NVDA mock-trading section, sign-in and session notice on the right (one column below 1024 px),
  - **← Stocks & ETFs** (목록으로) returns to the list with the same filter, search and sort, scrolled to and focused on the row you opened,
  - a symbol other than NVDA shows a view-only card in the right column; **View NVDA** in the trading section opens the NVDA detail,
  - `#/stocks?symbol=ZZZZ` (not in the list) shows a not-found state,
  - the fixture has SCHD and NBIS unavailable, SGOV stale and QQQ unchanged.
- **Navigation:**
  - Use browser back and forward.
  - Each open and close is a history entry. Back and Forward switch between the list and a detail without moving focus.
  - Reload on any hash URL, for example `#/stocks?symbol=TSLA`. The same page and selection come back.
- **Market data switch:**
  - **40-symbol fixture** (the default),
  - **NVDA pilot** (a 1-row PILOT list),
  - **Unconfigured** (the keyless state, "시세 연결 준비 중").
  - Switching re-mounts the providers and pages, so the query cache starts empty. The choice is kept for the tab in `sessionStorage`.

## Preview-only differences

- **Hash routing is preview-only.** This page is one static file served in Vite's MPA mode, so the route lives in the fragment (`#/funds`). The app uses real paths such as `/funds` and `/stocks?symbol=…`.
- **Footer links.** Their `#` placeholder links go to Home here, because the hash router owns the fragment.
- **Routes left out:**
  - the `/app/*` legacy redirects,
  - the allowlisted `/admin/*` console, since no wallet is allowlisted without an env. Unknown paths such as `#/admin/operations` fall back to Home.
- **`#/admin/stocks`.** It comes with `stocksRoutes`. Its operator sign-in would call `localhost:8080`, which is blocked.
- **Focus order.** Tab starts in the preview bar. The app's **Skip to content** button is the first stop after it.

## Content on the page that is not fixture data

- **Footer wordmark.** The Footer masks its wordmark with `/arco-wordmark.png`. That file is not in `public/`, so the console shows one 404 per page load. The app does the same.
- **Fee card note.** On Savings and product detail it reads "Full breakdown of fee structure for mTBILL". This comes from the aCAPIX legacy data in `useGiwaVaultDetail` (`ACAPIX_DETAIL.fee.note`) and is not configurable.

## Tests

`fixtures.test.tsx` runs in the default `npm run test:frontend`. It checks that:

- the fixtures pass `normalizeCatalog`, `fundsProductsOf` and `buildSavingsAccounts`,
- no fixture text names a real issuer or fund house,
- the reply router answers only the listed reads,
- the preview route tree matches the investor routes of `src/main.tsx`, using the same page modules,
- the fetch guard is installed before the page renders,
- nothing outside this directory references it.

## Not part of the app build

Nothing in `index.html`, `src/main.tsx`, the router (`src/demo/giwa/routes.ts`, `stocks-market/routes.tsx`) or `vite.config.ts`
references this directory, and product code never imports it. `npm run build` uses the root `index.html`, so this page is
never bundled.

## Customer demo presentation

The editable preview opens in customer presentation mode by default. The header shows
Connect Wallet and Mint test assets (inside the menu on mobile), without a Demo badge. It removes
the verification controls/request log and repeated
mock-price, fixture, feed-unknown and implementation notes, and removes the visible chart
observation slider and raw OHLCV table. The chart itself remains keyboard focusable:
Left/Right and Home/End select a price; Escape or leaving the chart clears the selection.

Open `index.html?debug=1#/stocks` to restore verification controls and technical explanations.
The debug market-mode choice is ignored by customer presentation, which starts with the
40-symbol catalog. The real application does not enable `DemoPresentationContext` and keeps
its existing explanations. This is a presentation switch only: it does not change fixture
prices, the captured deployed Funds/Savings catalog, wallet authentication, order requests,
execution state or the off-origin fetch guard. The preview displays the test cash unit as
`USDC`; API/token identities remain unchanged. NVDA's order price is separate from its
market-data price. Symbols without an order API have a selected-symbol Buy/Sell/Orders panel using the GIWA
Invest card, fields, buttons and mobile sheet. It shows a market-price estimate and an
explicit connect action; once connected the submit action remains disabled with `Trading
coming soon`. It never exposes NVDA trading controls or sends an order for another symbol. The investor controller stays mounted during list/detail navigation.
Actual missing-data, expired-session and transaction-error states remain visible.


### Stocks Invest panel (2026-09-20)

`StockInvestSurface` reuses the existing Invest panel tokens, amount components and
`BottomSheet`; desktop width is 360px, matching Funds. It keeps one card mounted for the
active desktop/mobile layout and reserves room after the footer for the mobile dock.
NVDA uses the existing controller/TradePanel inside this surface. Its signed-in form requests
server quotes and keeps all order/authentication boundaries. Buy quantities are entered in
the NVDA field; cash comes exclusively from the server quote.

Other listed symbols use `StockMarketInvestPanel`: Buy enters USDC, Sell enters stock units,
with decimal-string/BigInt estimates from that symbol's already-loaded market quote. These
estimates are only display values, rounded to two decimals, never execution quotes. Unknown
or stale prices produce no estimate; balances/fees are not invented. Switching symbols or
sides clears the draft. This work does not add multi-symbol order APIs or real trade support.

### Header product search (2026-09-20)

The header search follows Figma nodes 11:4945, 11:7740 and 11:7450 in the existing
GIWA light theme: a 448px search field/dropdown, grouped compact results under All,
and logo/name/value rows under Savings, Funds and Stocks. It derives its listings
from the same catalog and market clients as those pages, not a separate search fixture.
This preview currently lists 4 savings accounts, 4 funds and 40 stocks. Hidden vaults
are excluded. Stock catalog and vault loading are independent; missing/stale stock
quotes show no current price. Fund APY follows the Funds table's published/legacy/implied
priority. The existing fund detail uses published/implied APY, so its legacy fallback
can differ from the Funds table; this search change preserves those existing page policies.

Click the search field/icon or press `/` outside an editable field to open it. Match
tickers, names and fund managers, filter by category, or browse all listings. Arrow keys
and Enter select a result; Escape, outside click and leaving the search close it. Mobile
uses a search icon and a viewport-bounded scrollable panel. Savings results link to
`/savings?asset=ETH&account=real%3Aaeth%3AETH` (and the respective account), selecting
the exact account even when several vaults accept the same symbol. Older asset-only links
still work. Funds and Stocks
open their existing detail routes. Search only navigates and does not initiate transactions.

Search regression tests live alongside this dated snapshot so no application module imports
verification data. To include the DOM interaction test, set `GIWA_MARKET_DOM_RUNTIME` to
an installed jsdom package.json and run the two `product-search*.test.tsx` files here.

## Stocks list metrics (2026-09-20)

The Home and Stocks tables show Price, 24H (%), Mkt Cap, Volume (USD), and
Asset Status; Stocks also shows a per-symbol 1D sparkline. The former 24h ($) change
column is removed. Volume is an **estimate** of session turnover: exact decimal
share volume × displayed price, compacted for display, with its calculation in the title.
It is not a sum of actual trade consideration or a rolling 24-hour value.
The Mkt Cap column retains ETF AUM values; its header tooltip explains the distinction.

Stocks use profile.marketCap; ETFs use profile.aum, never marketCap as an AUM fallback.
The current offline fixture has neither value, so valuations remain —. No valuation
fixtures or market data were invented for this change. The server can enrich ETF profiles
from Massive ETF Global when the configured account has that entitlement.

The list reads each catalog symbol's profile and 1D chart using separate queues (two
chart reads and one profile read at most), waits 60 seconds on provider/budget limits,
and cancels pending work on unmount. This lets the chart feed fill sparklines while the
slower fundamentals feed waits for its independent free-plan budget. The 1D server read
looks back up to seven calendar days and returns only the latest observed New York trading
date; it therefore still shows the last actual session on weekends and holidays. It never
invents bars or fills absent data. Current fixture mode has 37 valid sparklines: SGOV is
stale and SCHD/NBIS are unavailable. Detail rereads update the same chart state, including
invalidation and later recovery. The Home list reads profiles for its ten rows and does
not load hidden charts.

## Opt-in Alpaca IEX display (2026-09-21)

The default verification page remains offline. For the user-authorized local live-data
preview, put the two Alpaca credentials in the gitignored `.secrets/alpaca.env` and run:

```sh
TMPDIR=/private/tmp node --import tsx src/demo/giwa/stocks-execution-host/verification/serve.ts --port 4392 --live-market
```

Open `/src/demo/giwa/investor-shell/verification/index.html#/stocks`.
The explicit server flag inserts a public IEX-mode marker into the HTML; the preview
selects live market reads by default. A server failure never falls back to synthetic
market prices. `?market=live` also explicitly selects live reads; debug controls can still
select fixture scenarios. No credential is included in the HTML marker.

Only market display reads use Alpaca. Execution remains the in-process simulated harness;
Savings/Funds keep their deployed catalog snapshot. The helper forces IEX, ignores SIP or Massive selection in the Alpaca credential file,
and never imports credentials into Vite env. A separate optional `.secrets/massive.env`
containing MASSIVE_API_KEY enables Basic ticker profiles and stock market capitalization.
Massive has an independent rolling budget of four requests/minute and a shared 24h
in-memory profile cache. The preview explicitly disables ETF Global requests, including
when the account happens to have a paid entitlement. Missing credentials keep profiles
unconfigured; no fabricated valuation is substituted.
The host binds loopback, blocks `.secrets` and `.env` paths, and denies cross-origin market
requests. The normal application and deployment configuration are unaffected.

Free-plan local budget: at most 60 provider requests in a rolling minute for this single
server, shared across all browser tabs. Quotes are batched for 40 symbols, read every 30s;
detail charts every 60s; list chart enrichment every 300s. The server reuses its quote/chart
cache and coalesces simultaneous reads. Background tabs pause scheduled refreshes; returning
tabs catch up once due; slow requests cannot overlap. HTTP 429 retains the existing backoff.
Other applications using the same key have their own usage, outside this local budget.

IEX volume is single-exchange volume; USD turnover is an estimate (shares × price).
The list exposes the latest observed trade timestamp, not a fabricated current time.
Stock market caps load progressively with the optional Massive key; ETF AUM remains
unconfigured in this free-plan preview. The first cold load of all 40 ticker profiles
can take about ten minutes, and reopening a page shares the existing server cache.
Restarting the server clears this in-memory cache. A rolling 1D
chart can legitimately be empty over a weekend; 1W/longer ranges retain actual observations.
