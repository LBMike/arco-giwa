# Stocks detail + trade UI — the three review fixes (2026-09-20)

Builder: Claude (UI). Review under answer: `review-results/20260920/stocks-detail-trade-review.md`
(DONE_WITH_CONCERNS on `26b326d`, three items: P2 sign-in side intent, P3 signed-out CTA below the fold,
P3 mobile dock over the footer). Evidence and screenshots: `/private/tmp/arco-giwa-stocks-detail-trade-fixes-evidence-20260920/` (`$E`).

## Base
- UI candidate `/private/tmp/arco-giwa-stocks-detail-trade-20260920` at `26b326d884acda0a98c1cb8192b5b73a4ef8b222`,
  clean and untouched. No newer UI work exists (only Codex's review clone `…-review-20260920`).
- Work clone `/private/tmp/arco-giwa-stocks-detail-trade-fixes-20260920`, branch
  `claude/giwa-stocks-detail-trade-fixes-20260920`, push URL `DISABLED`. No merge, push or deploy; no real wallet,
  public RPC or real asset; no `.env*` other than `.env.example` and no `.secrets` read.
- Server, Prisma, contracts, `deployments/91342`, `scripts/stocks-local/**` and `package.json` are untouched.

## 1 · P2 — the Sell a user chose survives the sign-in they started
`controller.ts` — a note that the user THEMSELF started a sign-in from the trade panel, and where:
`{ identityKey, clientId, deploymentId }`. It is deliberately **not** a copy of the side. `sideFor()` consumes it at the
first identity change and returns `this.state.side` — the side on screen when the sign-in lands — only when all of these
hold, otherwise `"BUY"` exactly as before: the new session is verified, the previous one was signed out, the client id and
deployment id are unchanged, the note was made in the identity being left, and no order attempt was restored for the new
owner (recovery wins). Everything else `enterIdentity` clears — quantity, quote, attempt, orders, holdings, generation —
is untouched. Because the live side is used, a Buy or Sell pressed *after* the sign-in press is still the user's last word.

`GiwaStocksFeature.tsx` — `forgetSignInIntent()` runs from a layout effect **declared before** `setContext`, whenever the
NVDA trade view is not showing (`tab !== "stocks"`, detail closed), the wallet is not `"ready"`, or the host reports the
sign-in as failed (`access.host === "error"`). Declaring it first is what makes a commit that both closes the detail and
delivers the session drop the note before the identity is entered. The Sell form's portfolio read now also counts a new
generation as a new appearance, so signing in on Sell reads the holdings of the wallet that just signed in — once.

`TradePanel.tsx` — the sign-in action notes it and then calls the host's `signIn()`. Nothing else was wired.

Residual, stated plainly: swapping the wallet **account** mid-SIWE while staying connected on the right chain is not
observable here (`walletStatus` stays `"ready"`, and the host reports a wallet change only once it has had a sign-in), so
in that one case the Buy/Sell toggle the user set stays set. Nothing else carries over: the form is cleared and the Sell
form then reads the holdings of the wallet that actually signed in.

## 2 · P3 — the whole next-step button in the first screen
- `StocksPages.tsx`: in detail mode the page's own header is a compact label (`px-4 py-3 sm:px-6`, `text-sm`), keeping the
  same `h2` text, the same first-child position and the same explanation after the panel. The list keeps the full header.
- `TradePanel.tsx`: the access step (connect · switch network · sign in · signing in · wallet cannot sign) renders its
  action and hint **with its reason, above the disabled form**. A trading action (Get quote / Place order / Get a new
  quote) stays the form's own submit at the foot of the panel, as in the GIWA panel.
- `TradePanel.tsx`: "Order capability" moved into the existing "Order details" disclosure. "Price … (fixed, test)" stays
  on the front of the panel, and the block notice still states when trading is not activated.

Measured in a real browser, 1440×900, after clicking the NVDA row in the table (`$E/measure/`):

| state | CTA before | CTA after |
|---|---|---|
| signed out, wallet disconnected | top 999 · bottom 1043 (below the 900 fold) | top 548 · bottom 592 |
| connected, not signed in | 999 · 1043 | 548 · 592 |
| wrong network | 999 · 1043 | 548 · 592 |
| signed in ("Get quote") | 917 (derived) | 828 |

Row entry and `?symbol=NVDA` deep link give the same numbers. The four access states were measured on the execution-host
fixture page (fixture wallet and fixture auth) and are reported panel-relative; that page's panel top is also 346, so the
numbers are directly comparable.

## 3 · P3 — the mobile dock no longer covers the footer
A spacer appended to `<body>` cannot work (`html, body, #root { height: 100% }`, so it lands one viewport down, not at the
end of the page) and `pb-*` inside `<main>` cannot either (the footer follows main). While the dock is mounted,
`MobileTrade` publishes `--giwa-dock-space: calc(env(safe-area-inset-bottom) + 4.5rem)` on `document.documentElement`
next to the existing `scroll-padding-bottom`, and the shell column that holds the sticky bar, `<main>` and the `<footer>`
consumes it as `pb-[var(--giwa-dock-space,0px)]`. Unset everywhere else, so every other page and the legacy surface are
byte-identical. The existing `max-lg:has-[#giwa-stocks-detail-title]:pb-28` gate is unchanged.

375×812, scrolled to the page end (`$E/measure/footer.json`):

| | before | after |
|---|---|---|
| document height | 3397 | 3453 |
| Terms of Use | 748.31 – 788.31 | 676 – 716 |
| dock | 741 – 812 | 741 – 812 |
| Terms hit test at its centre | covered by the dock's button | the link itself |
| keyboard focus on Terms | — | visible, above the dock, hit-testable |

22/22 checks: every footer link clear and clickable at the page end; `0px` reserved on the Stocks list, the INTC detail,
Home, Funds, Savings, Portfolio and the NVDA detail at lg; released on "목록으로", on a route change and at lg.

## Regression tests (red before, green after)
Run against `26b326d` with only the new/changed test files copied in (`$E/red/`):

| test | before | after |
|---|---|---|
| `trade-sheet.dom.test.tsx` "the side the user chose before signing in" | FAIL | PASS |
| `trade-sheet.dom.test.tsx` "the Sell chosen for a sign-in is kept through that one step only" (6 sub-cases) | FAIL | PASS |
| `trade-sheet.dom.test.tsx` "the dock's height is reserved for the shell while it is mounted" (+ at lg, + back below lg, + teardown) | FAIL | PASS |
| `trade-panel.test.tsx` "the step before the form … above the form" | FAIL | PASS |
| `trade-panel.test.tsx` "the order's small print is folded into 'Order details'" | FAIL | PASS |
| `shell-routes.test.tsx` "a page's fixed bottom bar reserves its room after the footer" | FAIL | PASS |

The DOM sub-cases of "the Sell chosen for a sign-in is kept through that one step only" cover: **kept** (the user's own
sign-in, same view, same wallet; the holdings are read once; the next quote goes to `POST /api/v1/stocks/sell-quotes`);
**dropped** (left the trade view, wallet gone, a sign-in the panel did not start, a sign-in the host reported as failed);
**re-noted** (a fresh press after a failed one is kept); **overridden** (a Buy pressed after the sign-in press wins);
**unchanged** (a refreshed token on the same wallet still starts on Buy).

## Review of this change
Five adversarial lenses (trade safety, driver compatibility, a11y/focus, layout/shell, honesty/scope), one skeptic per
finding: 12 findings, 8 verdicts "real" covering 4 distinct defects, all fixed. Each fix was then mutation-tested — the
fix is reverted and the suite must fail:

| defect | fix | mutation → test that catches it |
|---|---|---|
| the note copied the side at press time, so a Buy pressed afterwards was silently overridden when the sign-in landed | the note carries no side; `sideFor` returns the live `state.side` | restore the snapshot → "the later choice wins over the earlier sign-in press" fails |
| a cancelled/failed sign-in left the note armed for any later session | `access.host === "error"` drops it | drop the condition → "a session that lands after a failed sign-in starts on Buy" fails |
| the new CTA-ordering assertion was vacuous (`indexOf('id="')` matched the panel's own `data-testid`) | anchor on the `-notice` id and on the notice text | render the CTA above the notice → "the reason comes first" fails |
| the new shell assertion was a file-order regex that would pass with the footer outside the padded column | walk to the column's closing tag and assert the footer is inside it | move `<Footer>` out of the column → "the footer is inside the padded column" fails |

Refuted by the skeptics: a restored REJECTED attempt "discarding" the note (pre-existing behaviour, not this diff), the
note reaching a session from a different account *during* SIWE (an account swap kills that sign-in), and the signed-in
"Get quote" being clipped on a deep link (measured in Chrome: it is not).

## Checks (Node 24.14.0, jsdom 26.1.0, Chrome 153)
| Check | Result |
|---|---|
| `npm run typecheck` / `npm run build` | exit 0 / exit 0 |
| `test:frontend` (CI default) | 796: 779 pass, 17 skip (gated DOM suites), 0 fail |
| `test:frontend` with the DOM runtimes + `GIWA_STOCKS_ARTIFACTS` | 898/898 |
| `.mjs` suites (routes.dom, scope-render, delayed-sell) | 32/32 |
| `chart.browser.test.mjs` (own Vite origin) | 2/2 |
| `test:server` / `test:security` | 402: 330 pass, 72 DB-gated skip, 0 fail / exit 0 |
| design tokens / stories | the same 7 known-debt findings / no hard violation |
| browser e2e: full detail + trade flow (1440 and 375) | 22/22 (on a freshly started fixture server — that page's own preview bar grows with its request log, which shifts absolute offsets) |
| browser e2e: Sell → sign-in → still selling, CTA in the first screen | 15/15 |
| browser: footer vs dock, reservation released everywhere else | 22/22 |
| overflow sweep: list, NVDA, INTC, VOO, Home, Funds, Savings, Portfolio × 375/768/1440/1920 | 32/32 clean (0 px, 0 page errors, 0 off-origin) |
| Codex harness, unchanged scripts, real PostgreSQL + local EVM + Chrome | default 19, operator-diagnostics 19 (`knownFindings []`), known-hash-ui 31, known-hash 28 — all PASS |

`invest-panel-ui.tsx`, `components.tsx`, `GiwaInvestPanel` and `GiwaInvestDock` are not in the diff, so Savings and Funds
render exactly as before; the only shared file touched is the shell, with a padding that is `0px` unless a page publishes
the property.

## Not run
Real API/DB-backed market data in the detail, real wallets, public networks, the real Dynamic wallet modal (fixtures
only), Node 22, and CI itself (it still does not set the DOM runtimes, so the new DOM assertions skip there).
