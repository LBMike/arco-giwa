# GIWA Stocks UI review — builder evidence (investor /stocks and operator /admin/stocks)

This is a builder-side UI review and fix increment for Codex's independent re-verification. It covers UI, copy, layout,
accessibility and the related frontend tests only. It is not an independent review, not a real wallet and not public-network
trading. Server, DB schema, contracts, CI and the `scripts/stocks-local` harness are unchanged.

| Item | Value |
| --- | --- |
| Base | `/private/tmp/arco-giwa-operator-diagnostics-copy-verified-20260919` @ `1951782b33720d7b71642c9df0957377bb380bca` (contains verified code `b6646fd0ffd4418b0a6bd32eee5596dd673b66c9`), branch `codex/giwa-operator-diagnostics-copy-verified-20260919`, clean at the start and never edited |
| Work clone / branch | `/private/tmp/arco-giwa-stocks-ui-review-20260919`, `claude/giwa-stocks-ui-review-20260919` (push URL `DISABLED`) |
| Evidence | `/private/tmp/arco-giwa-stocks-ui-review-evidence-20260919/` (`baseline/`, `before/`, `after/`, `harness-*`) |
| Builder | Claude Code, `claude-opus-5` |

003E-1 (diagnostics 404 copy) was already closed at this base and is preserved: `diagnosticsErrorCopy` and the kept-record logic
are unchanged, and the 003E-1 tests pass.

## Method

1. Five reviewers read one surface each (investor order flow, wallet steps, known-hash card, operator diagnostics, operator
   shell + sign-in). A second, independent verifier per surface tried to refute every finding. Refuted findings were dropped.
2. The key findings were reproduced in real Chrome 153 (Playwright 1.59, headless) at 375 / 768 / 1440 px, with the real app
   shell's width and 32 px padding emulated. The page-level overflow check was extended to element level (pill text vs pill box).
3. Fixes were made in disjoint file groups. Every state/behaviour/focus change has a regression test that was run against the
   old code first and failed there.
4. A second independent review of the whole diff (safety, correctness, compatibility with `scripts/stocks-local`, design/copy)
   found one regression in the first fix set (operator sign-in focus). It was fixed with its own failing-first test.
5. Before/after browser runs used the same scripts against the unchanged base (port 4338) and the fixed clone (port 4337).

## Fixed (all verified: failing-first regression test + Chrome where observable)

| Id | Surface | Problem | Fix |
| --- | --- | --- | --- |
| A1 | admin | Long state pills (`FUNDING_REVIEW_REQUIRED`, `MINT_FINALITY_PENDING`…) ran past the pill and over the next column (375 px: 5 pills, 1440 px: 2, incl. fixture data) | Pill text `min-w-0`; line breaks after `_` (`<wbr/>`), text unchanged |
| A2 | admin | Refresh (wallet submissions / order detail / lists) was natively disabled while loading, so focus fell to `<body>` | `aria-disabled` + `aria-busy` + click guard; one read per press kept |
| A3 | admin | Overview "Open order" unmounted the focused button | One-shot focus to the Order detail heading |
| A4 | admin | A successful diagnostics refresh was silent | Snapshot line is `role="status"` (no clock text) |
| A5 | admin | No h1; detail cards at the same level as the detail heading | h1 "Stocks operations", gapless outline; sr-only h1 when the API base is unset |
| S3 | admin | "Check access again" with a repeated 403 dropped focus | Focus to the access heading (never a button) |
| H1 | page | Enabled "Sign in with operator wallet" did nothing when sign-in was impossible | Offered only when the host can sign in or a sign-in is pending |
| H2 | sign-in | "Signing in does not authorize a transaction." at 3.87:1 | `--color-arco-text-soft` |
| H3 | sign-in | "Try again" with a permanently disabled retry when no host controller exists | "Stocks sign-in is not available on this page. Reload the page; if this continues, contact operations." |
| H4 | sign-in | Focus fell to `<body>` after sign-in / retry / cancel / sign-out and while "Signing in…" was pending | Focus to the status text (never a button) |
| H5 | page | WALLET_SOURCE_UNSUPPORTED said only status lookup was possible while ordering stays enabled | Copy says orders can be placed but not funded/escrowed from this wallet (pinned prefix kept) |
| I1 | investor | After signing in again, an AUTH_REQUIRED request still said "Sign in again" | "Order request not processed" (unknown outcome keeps "Order result not confirmed") |
| I2 | investor | Live status announced raw enums ("mint unknown") and missed a passed deadline | Uses the displayed label |
| I3 | investor | Refresh status (also the 10 s poll), Check my orders, Retry, Orders/Portfolio Refresh dropped focus while busy | `aria-disabled` + guard while busy; native disabled kept for `!canResolve` |
| I5 | investor | Paused/unavailable refusal said "No quote or order was created" next to the valid quote | "No order was created." |
| I6 | investor | Second h1 "Stocks" inside an h2 section | h2 |
| I8 | investor | "View NVDA" focused the quantity field (contradicted UX-9) | Detail heading |
| K1 | known-hash | Result not announced (live region added after the content), whole card re-read on busy | Always-mounted sr-only status region with the result sentence only |
| K2 | known-hash | Focus lost when a result removes the button | Focus to the card wrapper, never on mount |
| K3 | known-hash | Inspect showed the server already had the same hash, reconcile failed, card stayed KEPT ("may not have it") | Settle RECORDED on a same-hash inspect before reconcile; no request added |
| K4 | known-hash | Verified approval said "deposit or escrow" on a one-sided order | Side-specific word |
| K5 | known-hash | While the next action runs, the previous failure was shown next to "Checking with the server…" | Previous result hidden while busy |
| W1 | wallet | 1 s countdown re-render moved focus to the state heading after a click on panel text (cut hash selection) | Focus moves only on a real state change or a stranded button |
| W2 | wallet | Past the deadline APPROVAL_SUBMITTED said "confirming" and promised a deposit/escrow step | Steps/title/first sentence promise nothing; "Approval sent — quote deadline passed" (003A RECOVERY_REQUIRED title kept) |
| W3 | wallet | `WALLET_NETWORK_INSTANCE_MISMATCH` ran through the panel border at 375 px (314 > 309) | `[overflow-wrap:anywhere]` (after: 285) |
| W4 | wallet | CHECKING showed a confirmed approval as "Not checked" | "Checking" |
| W5 | wallet | "do not approve" stop screens then said "Approve exactly …" | Descriptive "This step would approve …" |

## Refuted or left as is

- Stocks nav `aria-current` (AAA enhancement, same as the global header).
- Admin 401 vs "Signed in to Stocks." (unreachable: admin routes answer 403 for every auth failure; backend note below).
- "Wallet submissions load after the order detail" after a failed detail (a dependency statement, not a pending claim).
- Wallet panel heading nesting in the trade card (no skipped level; would need a prop change).
- "Not checked yet" after the ≤15 s evidence lease lapses (README-specified; backend/product decision).

## Remaining (not changed here)

- Portfolio pending rows past their deadline still show "Awaiting funding/escrow": the pending DTO has no `quoteExpiresAt`.
- Focus is lost when an admin session starts or ends (the console remounts per session); same-session access changes are covered.
- The investor outline is flat (feature title h2 next to its h2 sections); a nested outline needs a heading-level offset.
- The standalone investor verification page has no h1 after I6 (fixture only).

## Previews

- `/stocks` offline fixture (existing, real product modules + real in-process server plugins over in-memory SQL, fake chain and
  wallet): `src/demo/giwa/stocks-execution-host/verification/`.
- `/admin/stocks` mock data page (new): `src/demo/giwa/stocks-admin/verification/`.
- Known-hash card mock gallery (new): `src/demo/giwa/stocks-known-hash-recovery/verification/`.

All three are served by `serve.ts` (reads no `.env*`), are not in the build and prove nothing about SIWE, PostgreSQL or receipts.

## Checks (final code; Node 24.14.0, Chrome 153.0.8010.48)

| Check | Base `1951782` | This change |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | exit 0 |
| `npm run build` | — | exit 0 |
| `npm run test:frontend` (CI-like, DOM/ABI gates unset) | 689: 683 pass, 6 skip, 0 fail | 713: 703 pass, 10 skip, 0 fail |
| `test:frontend` with `GIWA_{HOST,ADMIN,MARKET}_DOM_RUNTIME` (jsdom 26.1.0) + `GIWA_STOCKS_ARTIFACTS` | 750/750 pass, 0 skip | 790/790 pass, 0 skip |
| `.mjs` suites (`routes.dom`, `scope-render`, `delayed-sell-regression`) with DOM runtimes | 23/23 | 27/27 |
| `npm run test:server` | — | 402: 330 pass, 72 DB-gated skip, 0 fail |
| `npm run test:security` | — | exit 0 |
| `check-design-tokens --all` | 7 known-debt findings | the same 7 (identical list) |
| `check-story-exists --all` | no hard violation | no hard violation |
| Before/after Chrome audit of `/stocks` fixture (21 checkpoints × 3 widths) | 0 page/element overflow | 0 page/element overflow; fixes I6/I8/I2 observed |
| Before/after Chrome audit of `/admin/stocks` mock page | 5 overflowing pills at 375 px, 2 at 1440 px; focus lost 5× | 0 pills; focus kept or moved to a heading in every case |
| `scripts/stocks-local` Chrome `operator-diagnostics` case, unchanged harness, real PostgreSQL 18.6 + local EVM | (accepted earlier by Codex) | PASS, exit 0: 19 investor groups + 24 diagnostics cases / 12 groups, `knownFindings: []`, `pageErrors: []`, owned services stopped |
| `scripts/stocks-local` Chrome `known-hash-ui` case, unchanged harness (real 30 s JWT + 60 s quote expiry, 4 BUY/SELL × APPROVAL/TRANSFER combinations) | (accepted earlier by Codex) | PASS, exit 0: 31/31 groups, owned services stopped |

The `.mjs` suites and `chart.browser.test.mjs` are outside the `test:frontend` glob; the chart browser test was not run
(it needs `GIWA_MARKET_PLAYWRIGHT`/`GIWA_MARKET_BROWSER_URL`). The first harness attempt failed before the scenario because
PostgreSQL refused to start under this shell's `ko_KR` locale ("postmaster became multithreaded during startup"); the rerun only
set `LC_ALL=en_US.UTF-8`. The harness code, the server and the DB were not modified.

## Codex handoff (backend / harness / CI; not done here)

1. **Portfolio pending deadline:** add `quoteExpiresAt` (or a server `deadlinePassed`) to `GET /api/v1/stocks/portfolio` `pending[]`
   so the Portfolio tab can stop showing "Awaiting funding/escrow" for orders past their deadline, as the Orders tab already does.
2. **Evidence lease ≤15 s:** "Approval required"/"Ready to deposit" can reset to "Not checked yet" before a person clicks
   (docs/evidence/giwa-wallet-host-integration-20260917.md finding 2). Needs a minimum remaining lifetime on the server evidence or
   a reviewed controller rule; the UI only explains it.
3. **Admin 401:** admin routes answer 403 for every auth failure. If a distinct 401 (or code) for an unverifiable session is added,
   the admin page should invalidate the host session with the captured session id (needs an approved `onSessionRejected` prop).
4. **Harness assertions to add (UI now supports them):** operator Refresh keeps focus after Enter/Space
   (`operator-diagnostics-driver.mjs` refocuses before each press); element-level overflow (pill text vs pill/cell) with a long state
   such as `FUNDING_REVIEW_REQUIRED`; known-hash `stocks-known-hash-announcement` region text and focus on the card after a result;
   the "server already has the hash, reconcile lost" RECORDED path (K3).
5. **Compatibility notes:** `operator-diagnostics-driver.mjs:154` `refresh().isDisabled()` now relies on Playwright treating
   `aria-disabled="true"` as disabled (true for 1.59 and 1.62; re-check with the pinned runtime). `known-hash-ui-driver.mjs` card
   `innerText` now also contains the sr-only result sentence; its current assertions still hold.
6. **Persistent real-stack preview:** a long-running local API + PostgreSQL + EVM with a signed `stocks:read` operator session and an
   explicit stop command would let `/admin/stocks` and the KEPT card be viewed on real data; the current harness is terminating by
   design. API CORS allows only the `:5173` origin, and host sign-in needs a secure origin (`crypto.randomUUID`), so a phone preview
   needs HTTPS or localhost forwarding plus an allowed origin.
7. **CI:** the new behavioural DOM tests (`*.dom.test.tsx`, `routes.dom.test.mjs`) run only with the DOM runtimes set; CI's
   `test:frontend` skips them (10 skips), as it already did for the existing DOM suites.
