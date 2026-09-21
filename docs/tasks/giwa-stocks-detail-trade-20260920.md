# Stocks detail + GIWA-style trade UI — file plan (2026-09-20)

Base `c91b4b4` (acceptance fixes, clean). Clone `/private/tmp/arco-giwa-stocks-detail-trade-20260920`, branch
`claude/giwa-stocks-detail-trade-20260920`, push disabled. Figma `2v7vb7Waf62RLoGLEhO4or`: `10:3843` detail (831 + 24 +
488), `10:3866` price/chart card, `10:3927` About, `10:4059` Statistics, `10:4783` trade panel (position only), `9:2752`
Intel. Spec: `/private/tmp/arco-giwa-stocks-detail-trade-evidence-20260920/figma/NOTES-detail.md`.

Baseline problem (before, `?symbol=NVDA`): detail heading at y=3795 and "View NVDA" at y=5325 (1440px); 7314 (375px).

## Constraints that shape the design
- Codex's drivers (`scripts/stocks-local/*`, not editable) run the real `/stocks` page and need, unchanged: one page,
  one investor controller, tabs `#giwa-stocks-tab-*`, `button[aria-label="View NVDA"]` on plain `/stocks` that opens the
  trade form in the same click, exactly one `input[inputmode=decimal]` and one `[data-side]` toggle (hidden ones count),
  unique "Get quote" / "Place … order" / "Start a new order" / "Sign in to Stocks" / "Sign out of Stocks", no confirmation
  step between "Place …" and the POST, the accepted card inline at 1440, sign-in region + session line + session notice
  always rendered, nothing gated on market data (it 404s there), CSS-only responsiveness for Orders/Portfolio.
- Server contract: quotes by NVDA quantity (9 decimals), cash from the quote (6 decimals), cash symbol from the catalog;
  NVDA is the only tradable symbol; the server market catalog is still the NVDA PILOT.

## Architecture
- `/stocks?symbol=X` stays the detail URL (no new route). `StocksPage` owns `symbol` in React state (set inside the click,
  mirrored to the URL with a push; URL changes from Back/Forward/links flow back into state). No symbol → list.
- Same route element, same tree position for the trade section in both modes (keyed siblings), so the investor controller
  and `StocksExecutionProvider` never remount on list ↔ detail.
- Market reads (catalog, quotes, order capabilities, 1D series cache) and list UI state (filter/search/sort) are lifted to
  a page-level owner, so sparklines and list state survive a detail visit. Back returns focus to the opened row.
- Detail (desktop ≥ lg): left = header, price/period/chart card, About, Statistics (real fields only); right (488px) = trade
  section first, then sign-in and session notice. Mobile: one column; for NVDA a fixed Buy/Sell dock opens a bottom sheet.
- Trade panel: the existing `TradePanel` state/actions (one controller), restyled with GIWA presentational pieces. Exactly
  one `TradePanel` mounted: inline on desktop, inside the sheet on mobile (chosen by a media-query hook, not CSS).
  One CTA shows the next step: Connect wallet → Switch to GIWA Sepolia → Sign in to trade → Get quote → Place buy/sell order;
  quote expiry, pause, session/wallet changes, unsupported wallet and sell availability get their own messages.
- Non-NVDA detail: view-only card in the right column ("…은 시장정보 조회만 지원합니다…"), no dock, no order requests.

## Files
Shared interfaces (written first): `stocks-investor/access.ts` (`GiwaStocksAccess` + context), `stocks-host/wallet-commands.tsx`
(connect / switch context, provided by `GiwaStocksHost`), new optional `GiwaStocksFeature` props `access`, `detailOpen`,
`onDetailChange`.

Market / page (agent M): `stocks-market/StocksPages.tsx` (layout, selection, access), `StocksMarketFeature.tsx` (owner +
list view + detail view), `MarketChart.tsx` (Figma card styling, same locators), `StocksMarketTable.tsx` (controlled list
state), tests `table.dom.test.tsx`, `table.test.tsx`, `market.test.tsx`, `routes.dom.test.mjs`, `chart.browser.test.mjs`,
new `detail.test.tsx` / `detail.dom.test.tsx`.

Trade (agent T): new leaf `src/demo/giwa/invest-panel-ui.tsx` (AmountBlock, AmountField, InfoRow, tab/CTA/card classes moved
from `components.tsx`; GIWA output byte-identical), new leaf `src/demo/giwa/BottomSheet.tsx` (a11y model of the header
drawer), `stocks-investor/{TradePanel,StocksViews,GiwaStocksFeature,ui}.tsx`, tests `views.test.tsx`, `focus.dom.test.tsx`,
`stocks-execution-host/page.dom.test.tsx` (only where our own suites pin old layout), new `trade-panel.test.tsx`,
`trade-sheet.dom.test.tsx`, `invest-panel-ui.test.tsx` (byte identity).

## Not copied from Figma
NVDAon/…on tickers, "Asset Open for Trade (Off-Hours)", Shares per Token, on-chain addresses, supported chains/network
selector, collateral/protections, mint/redeem limits, dividends, other venues, legal text, footnotes, company copy and every
data value; "ALL" range (not in the contract); tinted price-card backgrounds (would need new tokens) — white card instead.

## Not changed
Server, DB, contracts, CI, `scripts/stocks-local`, Savings/Funds behaviour, controller/execution/known-hash/recovery logic,
idempotency, owner fencing, order status source of truth, 003D-1/003E-1 copy, tokens, packages.

## Verify
typecheck, build, test:frontend (default + DOM gates), .mjs suites, chart.browser, server, security, token/story hooks;
Chrome 375/768/1440/1920: list → NVDA detail → quote-ready without reselecting, non-NVDA zero order requests, open/close/tab
switches zero wallet requests, sheet focus/Escape/return, viewport switching; Codex harness cases browser (default),
operator-diagnostics, known-hash-ui, known-hash (unchanged scripts).
