# GIWA-STOCKS-OPERATOR-DIAGNOSTICS-UI-003E — builder evidence

This is a local builder candidate for Codex's integration and independent review. It is not integration approval and not a real PostgreSQL, EVM or Chrome result.

Nothing was pushed, merged or deployed, and nothing touched a public RPC, a database, a real wallet or a dependency install. No signature or transfer was made. The server, DB schema, Solidity, registry, auth policy, quote deadline, wallet transfer path and the known-hash user recovery UI are unchanged. Only `src/demo/giwa/stocks-admin/**` and these docs changed.

Task prompt: `docs/tasks/giwa-stocks-operator-diagnostics-ui-003e-20260919.md`. Builder plan (recorded before code, commit `420fd0a`): `docs/tasks/giwa-stocks-operator-diagnostics-ui-003e-plan-20260919.md`.

## Bases, roles, environment

| Item | Value |
| --- | --- |
| Base | `/private/tmp/arco-giwa-known-hash-ui-verified-20260919` @ `a01e67071f5e66f3ebee3630b93023c109f32400`, branch `codex/giwa-known-hash-ui-verified-20260919`. Clean (0 files) at the start; see `base.txt` |
| Work clone / branch | `/private/tmp/arco-giwa-operator-diagnostics-ui-20260919`, `codex/giwa-operator-diagnostics-ui-20260919` (push URL disabled) |
| Commits | `420fd0a` plan · `0b5e050` implementation and tests · the commit that adds this file (its SHA is in the handoff) |
| Commander | user / conductor (003E prompt) |
| Builder | Claude Code, `claude-opus-5` (same builder session as 003B–003D-1) |
| Independent reviewer | Codex (pending): backend contract, local operator login, real PostgreSQL rows, EVM receipts, Chrome |

Environment (untracked):
- `node_modules` is a symlink to `/private/tmp/arco-giwa-preflight-20260917/node_modules`; the lockfile is byte-identical.
- `packages/contracts/artifacts` is copied.
- jsdom comes from `/private/tmp/arco-rwa-ui-independent-review-20260917`.
- Node v24.14.0. Node 22 (CI) was not verified.

Evidence directory: `/private/tmp/arco-giwa-operator-diagnostics-ui-evidence-20260919/` (`base.txt`, `mutation/`, `final/`).

## Changed files (`a01e670..0b5e050`, 13 source/test files + the plan)

| File | Change |
| --- | --- |
| `types.ts` | Diagnostics DTO types; `diagnostics` resource on the snapshot, keyed by `{orderId, side}` |
| `parse.ts` | `parseSubmissionDiagnostics(data, {side, orderId, observedAt})`, mirroring the server's `publicSnapshot` |
| `client.ts` | `submissionDiagnosticsPath(side, orderId)` (encoded id) |
| `store.ts` | Initial read after the detail, explicit `refreshDiagnostics()`, write rules, error mapping, detail cross-check |
| `SubmissionDiagnostics.tsx` (new) | The "Wallet submissions (read only)" card |
| `OrderDetail.tsx`, `OrdersPanel.tsx`, `GiwaStocksAdminFeature.tsx` | Props and one Refresh callback passed through; the card sits under the order detail |
| `fixtures.ts` | Test/harness-only diagnostics fixtures and the fixture route for the new path |
| `store.test.tsx`, `views.test.tsx` | 4 existing tests updated without weakening (they now take and settle the new request); new tests |
| `diagnostics-parse.test.tsx`, `diagnostics.dom.test.tsx` (new) | Parser vs the server's `publicSnapshot`; gated DOM suite against the real route |

`stocks-market/StocksPages.tsx` is unchanged: the admin page already passes `apiBase`, `session={host.admin}` and `fetch`.

## What the operator gets

Orders → select an order → the order detail loads → a **"Wallet submissions (read only)"** card appears under it.

1. **Which request.** The store reads the order's `side` from the loaded detail (the server-verified side; orders are selected by id only) and sends one `GET /api/v1/admin/stocks/wallet-submissions/:side/:orderId`.
   - It uses the existing API base and the signed SIWE `Authorization: Bearer` session only: no operator token, no role header, no owner override, no query and no body.
   - The server decides the operator permission (`stocks:read`). The console never guesses it.
2. **What is accepted.** The PROFILE envelope and the DTO are checked like the server's `publicSnapshot`:
   - exact key sets everywhere, so an extra field such as raw proof JSON, calldata or an internal error makes the whole answer invalid instead of rendered;
   - `readOnly: true`, `executionAuthorization: false` and `resubmissionAllowed: false`, exactly;
   - the requested side and order equal the answer's;
   - hash, receipt, time and enrollment invariants, and `quoteExpired` against `observedAt`;
   - the store also requires the loaded detail's deployment digest and wallet.
3. **What is shown.**
   - At the top: the server snapshot time (`observedAt`, exactly as sent) and the load time.
   - Then the order state and quote deadline *as of the snapshot*, the enrollment, the deployment, digest and intent key.
   - Then one section per stage, worded by side: **Approval** (both sides), **Deposit** (BUY) or **Escrow** (SELL). Each shows:
     - the status, and the recorded hash only when there is one (otherwise **"No recorded hash"**);
     - claim recorded / last update times, and the full claim id;
     - the transaction digest;
     - for CONFIRMED or REVERTED, the receipt status, block, block hash and when the verification was recorded.
4. **Historical, never permission.**
   - REQUEST_MAY_START: "a historical record. It is not permission to send."
   - Hashless UNKNOWN: "not entered, guessed or searched here. Do not send the approval/deposit/escrow again."
   - NOT_ENROLLED: "Nothing was recorded, and this is not permission to send."
   - CONFIRMED: "not issuance of the shares" (BUY) / "not the burn or the cash payout" (SELL); the order state shows that.
   - Footer: "Historical record only"; nothing can be executed, recorded again or resent.
5. **Only two reads.** One read after the detail loads, and the card's **Refresh** button. A detail refresh does not re-read. Refresh is disabled and ignored while a read runs. Nothing polls. There is no claim, outcome, reconcile, wallet request, signature, resend or state change, and the panel does not re-run the server's receipt verification.
6. **Errors.**
   - **401 / 403** use the console's existing global denial: all data is cleared, the same permission as every admin route.
   - **404 `ORDER_NOT_FOUND`** reads "Order not found in the current deployment (404)"; a 404 without a code reads "diagnostics are not available on this server".
   - **503**, a **network** failure and an **invalid** answer stay on the card; the rest of the console keeps working.
   - A **failed Refresh** keeps the earlier record under "The record below is from the earlier snapshot `<observedAt>`, not a current one." A record older than 60 s gets the existing stale notice.
7. **Scope.**
   - Selecting another order clears the card in the same store update.
   - A login, account, API base or deployment change re-keys the console (the existing scope owner), so the old record is gone from the first commit.
   - A token-only rotation keeps the record, and the next Refresh uses the new token.
   - Only the latest read for the same order and side writes.
   - Expired orders stay readable. The route has no pause gate; see Limits for paused orders.

## Requirement → implementation → test

| Prompt item | Implementation | Tests |
| --- | --- | --- |
| 1. real side/id, SIWE Bearer, API base; no shared token, role header or owner override | `store.ts` `fetchDetail` → `fetchDiagnostics(orderId, detail.order.side)`; `client.ts` path; `stocksAdminGet` headers `accept` + `authorization` only | store: "no request before the detail; … exactly one GET with the detail's side, the Bearer only"; parse: "through the real client"; DOM: walk-through (path per side, after its detail, same Bearer fingerprint) |
| 2. PROFILE + DTO, side/order match, the three flags, no raw proof/calldata/internal errors | `parse.ts` `parseSubmissionDiagnostics`; store cross-check (deployment digest, wallet) | parse: 8 tests incl. equality with the server's `publicSnapshot` for 64 cases (per side: 5 approval × 6 transfer statuses including null, both stages null, NOT_ENROLLED), flags, scope, extra fields, invariants; store: 10 rejected variants; DOM: 7 tampered answers + real `publicSnapshot` 503 |
| 3. order state vs wallet record; status, hash only when present, times, receipt; stage wording | `SubmissionDiagnostics.tsx` | views: BUY, SELL, NOT_ENROLLED; DOM: all 7 orders |
| 4. null / NOT_ENROLLED / REQUEST_MAY_START / UNKNOWN are historical; hashless UNKNOWN = "No recorded hash" | card copy; no input, search or send control | views + DOM copy assertions; "no command buttons" test extended to the card |
| 5. initial read + explicit refresh only; no mutation or re-verification | store: one read per selected order, `refreshDiagnostics()` ignored while loading | store: no automatic second read, detail refresh does not re-read; DOM: request log GET-only, `window.ethereum` never read |
| 6. first-render hiding; late answers; old-session errors; token rule | `selectOrder` clears in one update; existing scope re-key; latest-request + order/side check | store: selection, X → Y → X late data and 403, token/session/API/deployment; DOM: first commit after logout, operator B, API base, deployment, token rotation; late answers; old session's late 403 |
| 7. loading / empty / 403 / 404 / 503 / network / invalid; failed refresh not current; `observedAt` as sent; expired readable | card states; `diagnosticsErrorCopy`; earlier-snapshot label | store: 7 error kinds; views: every copy, earlier-snapshot label, stale notice; DOM: real-route 403, 404, 503 and client-side invalid |
| 8. tokens, components, keyboard, mobile wrapping | existing `Card`, `Field`, `Mono`, `Time`, `Pill`, `Notice`, `RefreshButton` | design tokens 7 (unchanged); visual check 375/768/1440 below |

## Request log (real admin feature, DOM suite)

From `final/14-request-counts.txt`: a transient copy of the DOM suite that logs its request log (deleted after the run; `git status` stayed clean). Every entry is what the rendered console actually sent.

| Scenario | Requests | Non-GET | With body | `window.ethereum` reads | Diagnostics statuses |
| --- | --- | --- | --- | --- | --- |
| Operator walk-through (7 orders) | 16: orders ×2 (StrictMode's first mount is aborted), detail ×7, diagnostics BUY ×4 + SELL ×3 | 0 | 0 | 0 | 200 ×7, `cache-control: no-store` |
| Permission revoked mid-session | 4 | 0 | 0 | 0 | 403 (real route) |
| Errors, retry, failed refresh | 17 (14 diagnostics) | 0 | 0 | 0 | 503 (first read), 503 (reader failure), 503 (real `publicSnapshot` refusal), 404, 200 ×7 whose bodies the client rejected (PROFILE, side, order, 3 flags, calldata), network (no status), 200 retry, 503 failed refresh |
| Scope changes (last iteration: token rotation) | 5 | 0 | 0 | 0 | 200, 200 (new Bearer) |
| Late answers (A, then B, then A2) | 20 | 0 | 0 | 0 | 200 ×5, a held 403 of the old session, 200 |
| Double clicks | 5: detail ×1, diagnostics ×2 (the initial read + one refresh for three clicks) | 0 | 0 | 0 | 200, 200 |

A regular signed user gets 403 from the server: the orders call is refused and no diagnostics request is ever sent. Directly against the real route:
- a regular user, a missing Bearer, a forged or expired token, or another domain all get 403 `OPERATOR_FORBIDDEN`, and the reader is never called;
- the signed operator gets 200 with `no-store`;
- a query string gets 400.

## Visual check (transient harness, not committed)

The real `GiwaStocksAdminFeature` with fixture data was built into a static bundle in the scratchpad.
- The two harness files were at the repo root, one of them gitignored (`*.harness.tsx`), and were deleted right after the build. `git status` stayed clean.
- The bundle was served on `127.0.0.1:4329` and opened in the app's browser pane. The user's ports 5173/8788 and the 003D-1 server on 4327 were not touched.

Results:
- **375 px:** a hashless UNKNOWN BUY, a SELL with both stages CONFIRMED, NOT_ENROLLED and a failed refresh (503 with the earlier-snapshot label). Document width stayed 375, with no element past the viewport. Hashes wrap (`break-all`).
- **768 px:** 3 orders; width 768, no overflow.
- **1440 px:** the BUY record uses the two-column field grid.
- **Keyboard:** Tab moves from the detail's "Refresh order detail" to the card's "Refresh wallet submissions". The card's only control is a native `<button>` with the existing focus ring.
  - The pane's key tool did not activate buttons with Enter or Space, including the existing order-row buttons, so activation was clicked instead. Native Enter/Space activation was not reproduced here.
- **Change from this check:** the claim id was shown shortened (`claim-…al-1`). It is now shown in full, so an operator can match server records; a views test asserts it.

## Builder-side checks (not independent review)

- **Plan deviations:** none in scope. The one addition is the full claim id (above).
- **Parser parity:** the client parser is compared with the server's own `publicSnapshot` over every BUY/SELL × approval × transfer status combination (64 cases). The server-rejected variants are also rejected by the client.
- **Real pieces in the DOM suite:**
  - the diagnostics route is the real plugin;
  - the operator decision is the real `stocksSessionResolvers` (HS256 JWT with domain, chain and time checks, plus an operator directory);
  - the rest of the page is the real feature in StrictMode.
- **Simulated pieces:** the reader returns raw snapshots (the real reader needs PostgreSQL), and the other admin routes are fixtures behind the same real operator decision. 401 is a transport stand-in, because the real route answers 403 for every unverified session.
- **Existing tests:** 4 store tests failed after the change because the new read stayed pending. They now take that read and assert it is settled or aborted, and `hasNoData` also requires empty diagnostics. No assertion was removed.

## Mutation checks

`mutation/run.py` applies one change at a time. It runs the 6 admin test files (DOM suite included) and restores the file byte for byte, which is asserted after each run.

- **Round 1:** 20 mutations, 19 killed.
  - M03 (drop the latest-request check) survived. The order/side guard hid it except when the same order is re-selected (X → Y → X).
  - A store test was added for exactly that: the first read of X answers late, with data or a 403.
- **Round 2:** M03 killed by that test.

| # | Mutation | Killed by |
| --- | --- | --- |
| M01 | side assumed BUY | DOM walk-through, store |
| M02 | selection keeps old diagnostics | DOM, store, views |
| M03 | no latest-request check | store X → Y → X (round 2) |
| M04 | 403 stays on the card | DOM revocation, store |
| M05 | refresh while loading | DOM double clicks, store |
| M06 | no detail cross-check | store variants |
| M07 | no cancel on selection | store |
| M08 | detail refresh re-reads | store |
| M09 | `resubmissionAllowed` unchecked | parse, store, DOM |
| M10 | side unchecked | parse |
| M11 / M12 | root / stage key set open | parse |
| M13 | "No recorded hash" removed | DOM, views |
| M14 | card side guard removed | views |
| M15 | card rendered for any order | views |
| M16 | failed refresh not labelled | DOM, views |
| M17 | CONFIRMED reads as completion | DOM, views |
| M18 | path not encoded | parse |
| M19 | `quoteExpired` unchecked | parse |
| M20 | UNKNOWN label weakened | views |

## Final checks

`final/run.sh` at HEAD `0b5e050`; clean before and after (0 status lines). Logs are in `final/`.

| Check | Exit | Result (pass / fail / skip) |
| --- | --- | --- |
| Focused: all 6 admin `.test.tsx` files with the DOM runtime | 0 | 77 / 0 / 0 |
| DOM suite repeated 5× | 0 | 9 / 0 / 0 each run |
| `npm run typecheck` | 0 | no errors |
| `npm run build` | 0 | built; existing chunk-size warning only |
| `npm run test:frontend` with DOM runtime + ABI artifacts | 0 | **743 / 0 / 0** (30 new tests here: store 8, parse 8, views 5, DOM 9; the admin files went from 47 to 77) |
| `npm run test:frontend` CI-like (gates unset) | 0 | 683 tests: 677 / 0 / **6 skipped** (5 DOM gates including the new diagnostics suite, 1 artifact gate) |
| `npm run test:server` | 0 | 402 tests: **330 / 0 / 72 DB-gated skips** |
| Server diagnostics contract tests alone (`server/dist/stocks-submission-diagnostics/*.test.js`) | 0 | 59 tests: 51 / 0 / **8 real-PG skips** (no database here) |
| `npm run test:security` | 0 | env exposure and evmVersion checks pass |
| `npm run design:tokens` | 1 | the same 7 known findings (`Investor.tsx`, `components.tsx`); none in `stocks-admin` |
| `npm run design:stories` | 0 | no hard violations |
| `.mjs` DOM regressions (admin scope-render, market routes, investor delayed-sell) | 0 | 23 / 0 / 0 |
| `git diff --check a01e670 HEAD` | 0 | clean |

Not run:
- `stocks-market/chart.browser.test.mjs` (it needs Playwright and a browser URL);
- the real-PG diagnostics tests (8, skipped without a database);
- `scripts/check-independence.sh` from the operator CLAUDE.md, which does not exist in this repository.

## Limits and what Codex must connect

**These results are in-memory only.** They are not real PostgreSQL, EVM or Chrome results:
- the reader returned fixture snapshots;
- the other admin routes were fixtures;
- no browser logged in with a real SIWE signature.

**Codex must connect and verify:**
1. **Operator login.** Local operator login with a real directory entry (`stocks:read`), from the real `/admin/stocks` page in Chrome:
   - a signed operator sees the card;
   - a signed regular user sees the console's 403.
2. **Real rows.** The real `StocksSubmissionDiagnosticsService` over PostgreSQL, rendering real journal rows for:
   - BUY and SELL;
   - APPROVAL and TRANSFER;
   - null, REQUEST_MAY_START, UNKNOWN with and without a hash, SUBMITTED, CONFIRMED and REVERTED receipts from the EVM;
   - NOT_ENROLLED.
3. **Timing and scope on the real stack.**
   - Paused trading and expired quotes: the route and the reader have no pause gate (from reading `plugin.ts` and `service.ts`), and the real-PG tests cover it on the server. The UI side was checked for expired orders only.
   - A deployment switch: 404 `ORDER_NOT_FOUND` for an order of another deployment.
4. **Request count in Chrome.** Chrome's network log should show 0 non-GET requests and 0 wallet prompts while reading.

**Other limits:**
- **Page-level scope.** The DOM suite mounts the admin feature that `/admin/stocks` mounts (same props), not the whole route with the host's sign-in. The route-level mount is covered by the existing `routes.dom.test.mjs`, which does not select an order.
- **Deployment key.** The page passes no `deploymentKey` (unchanged). A deployment change inside one API base and session is therefore detected by the server (404 and the digest cross-check), not by a client scope key.
- **Keyboard activation.** Enter/Space was not reproduced with the pane's key tool (see Visual check).
- **Node version.** Node 22 was not verified.
