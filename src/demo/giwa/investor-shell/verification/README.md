# Investor shell preview

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
