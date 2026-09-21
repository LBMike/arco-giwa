# Stocks detail + GIWA-style trade UI — builder evidence (2026-09-20)

Builder: Claude (UI). Plan committed before code (`b12011d`): [`docs/tasks/giwa-stocks-detail-trade-20260920.md`](../tasks/giwa-stocks-detail-trade-20260920.md).
Evidence: `/private/tmp/arco-giwa-stocks-detail-trade-evidence-20260920/` (`$E`).

## Base
- Source `/private/tmp/arco-giwa-investor-shell-fixes-20260919` at `c91b4b4baf81389ace11b4c5ec5d70601e6d1434`, clean,
  untouched. No newer UI work existed (only Codex's review copies).
- Work clone `/private/tmp/arco-giwa-stocks-detail-trade-20260920`, branch `claude/giwa-stocks-detail-trade-20260920`,
  push URL `DISABLED`. No merge, push or deployment; no real wallet, public RPC or real asset.

## Flow
List → one row (or "View NVDA") → that symbol's detail with its trade entry, on the same `/stocks` page (`?symbol=X`).
- Before (`?symbol=NVDA`, 1440): detail heading y=3795, "View NVDA" y=5325; 375: 7314 (`$E/before/offsets.txt`).
- After: the list shows only the 40-row table; a row opens the detail at the top of the page. At 1343px content the columns
  are exactly 831 / 488 (Figma 10:3843). Host fixture page at 1440×900 after "View NVDA": quantity field at viewport y
  467–495 signed out / 325–353 signed in, CTA 701–745 / "Get quote" 559–603 (`$E/fix-T2/`).
- Back ("Stocks & ETFs 목록으로") returns to the list with focus on the opened row; filter/search/sort survive; Back/Forward
  and `?symbol` deep links (Home rows, reload) work; unknown symbols show a neutral not-found/unverified state.

## Trade UI
- One investor controller, one `StocksExecutionProvider`, exactly one `TradePanel` mounted: inline in the right column from
  `lg`, inside a bottom sheet opened from a fixed Buy/Sell dock below `lg` (media-query hook, not CSS copies).
- GIWA presentational pieces extracted to `src/demo/giwa/invest-panel-ui.tsx` (AmountBlock, AmountField, InfoRow, tab/CTA/
  card/notice classes); `components.tsx` uses them. GiwaInvestPanel/GiwaInvestDock output: 625/625 goldens byte-identical
  (recorded before the extraction, re-checked on the final code).
- `BottomSheet.tsx`: focus to Close, Tab trap, Escape, focus return to the dock button, keys of another layer (wallet
  modal, shadow root) left alone, scroll lock, reduced motion, closes at `lg`; open state survives sign-in.
- Panel: Buy/Sell segment (same `role=radio` + `data-side`), You pay / You receive blocks — the NVDA quantity is the only
  input (9 dp), cash is display-only from the server quote with the catalog symbol and a TEST marker; Sell shows
  "Available to sell" + MAX only from a loaded positive `availableQuantity`; info rows (fixed mock price 120, order
  capability, quote validity, order details). One CTA shows the next step: Connect wallet → Switch to GIWA Sepolia → Sign in
  to trade → Get quote → Place buy/sell order (no confirmation step, double click = one POST). Session expired / rejected /
  wallet changed, pause, quote expiry, insufficient sell availability and unsupported wallet each have their own message.
  Existing attempt/order card/execution slot/known-hash flows unchanged.
- Host commands: `stocks-host/wallet-commands.tsx` (connect, switch) provided by `GiwaStocksHost`; `stocks-investor/access.ts`
  carries wallet/network/sign-in state into the panel; `stocks-market/page-access.ts` builds it (incl. WALLET_CHANGED).
- NVDA only: other symbols show "조회 전용 · {SYM}은 시장정보 조회만 지원합니다…", no dock, no order/quote requests.

## Detail (Figma 10:3843 / 10:3866 / 10:3927 / 10:4059)
Header (logo, name + ticker, order-capability badge), price card (price, ▲/▼ change vs previous close with up-text/down
tokens, quote time + feed label, stale marker, 1D–1Y segmented periods with a selected ring, Recharts area chart with
whole-cent right Y ticks, dotted grid, direction-coloured stroke/fill, slider + raw OHLCV table kept), About (2-line clamp +
Show More, rows: underlying name/ticker, category, industry, exchange, website, ISIN — rows without data hidden), Statistics
(underlying 24H open/high/low from an AVAILABLE ≥2-bar 1D series only, previous close, session volume, market cap compact
with exact title, source line). Kept: 1D sparkline-cache invalidation, `--color-arco-up-text` for rising text.
Not copied: "…on" tickers, Asset Open/Off-Hours, Shares per Token, addresses, chains, protections, mint/redeem, dividends,
venues, legal text, footnotes, company copy, all values; no ALL range; white card instead of tinted (would need tokens).
Side-by-side: `$E/after/figma-compare/figma-vs-impl-nvda-detail.png`.

## Review
Six-lens adversarial review (trade safety, harness compatibility, a11y, data honesty, GIWA reuse, design/layout), one skeptic
per finding: 27 findings, 18 confirmed (16 distinct), all fixed with a test that fails when its fix is reverted
(`$E/fix-T2/mutation.log`, `$E/fix-M2/mutate.out`). No harness-compatibility or GIWA-reuse defect was confirmed.

## Checks (Node 24.14.0, jsdom 26.1.0, Chrome 153)
| Check | Result |
|---|---|
| typecheck / build | exit 0 / exit 0 |
| `test:frontend` default | 793: 776 pass, 17 skip (gated DOM suites), 0 fail |
| `test:frontend` with DOM runtimes + artifacts | 894/894 |
| `.mjs` suites (routes.dom 21, scope-render, delayed-sell) | 32/32 |
| `chart.browser.test.mjs` (Vite dev server of this clone) | 2/2 |
| `test:server` / `test:security` | 402: 330 pass, 72 DB-gated skip, 0 fail / exit 0 |
| design tokens / stories | the same 7 known-debt findings / no hard violation |
| GIWA golden renders | 625/625 byte-identical |
| e2e (host fixture page, isolated server, market via Playwright route) | 22/22 (`$E/after/e2e/trade-e2e.json`) |
| overflow, preview: list, NVDA, INTC, VOO, NBIS, Home, Funds, Savings × 375/768/1440/1920 | 0 px, 0 page errors, 0 off-origin requests |
| Codex harness baseline on `c91b4b4` (default, known-hash) | PASS 19 / PASS 28 steps |
| Codex harness after implementation (all four cases) | default 19, operator-diagnostics 19 (`knownFindings []`), known-hash-ui 31, known-hash 28 — all PASS |
| Codex harness on the final code (all four cases, unchanged scripts, real PostgreSQL + local EVM + Chrome) | default 19, operator-diagnostics 19 (`knownFindings []`), known-hash-ui 31, known-hash 28 — all PASS (`$E/harness-final/`) |

e2e highlights: 1440 list → NVDA row → detail with "Sign in to trade" (0 wallet calls, 0 quote/order requests on open);
sign-in, Get quote, "240 ARCO_TEST_USDC · TEST", double-click → exactly one order POST; Back focuses the NVDA row; INTC
detail 0 quote/order requests and no quantity input. 375: no input before the sheet; Sell opens the sheet with Sell
checked; focus inside, Tab trapped, Escape returns focus to "Sell"; sheet + tabs 0 wallet calls; sign-in + quote inside the
sheet; switching to 1440 closes the sheet and keeps quantity and quote with no new request.

## Not done / remaining
- Server 40-symbol catalog and any non-NVDA trading: Codex (unchanged). The 40 rows are preview fixture data only.
- Opening NVDA from a market row while signed out: the CTA sits ~100 px below a 900 px viewport (row entry scrolls to the
  detail heading); signed in it is visible.
- After sign-in the controller resets the side to Buy (existing controller behaviour).
- At the very bottom of the mobile NVDA page the fixed dock overlaps the footer links (same as the GIWA product page).
- CI does not set the DOM runtimes, so the new DOM suites (sheet, detail, page-access) skip there like the existing ones.
- Data fields the detail cannot show (for Codex): market session state, 24h token OHLC, average volume, dividends,
  on-chain token address, shares per token, a batch 1D series for list sparklines.
