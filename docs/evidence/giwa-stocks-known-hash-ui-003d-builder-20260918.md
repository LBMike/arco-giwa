# GIWA-STOCKS-KNOWN-HASH-UI-003D — builder evidence

This is a local builder candidate for Codex's integration and independent review. It is **not** integration approval, a real wallet, public-network trading, or recovery after a reload.

- **Nothing external was used:** no push, merge, deployment, wallet signature, transfer, public RPC, database, dependency install or real wallet.
- **Test environment:** every wallet is a fake EIP-1193 object on a fake chain. Every server is the real Stocks, execution and submission plugins, run in-process over the test-only memory SQL (`app.inject`).
- **No server API was added.** The server, DB, Solidity, deployment registry, auth/JWT policy, quote deadline and the existing wallet request path are unchanged.

Task prompt: `docs/tasks/giwa-stocks-known-hash-ui-003d-20260918.md`. Builder plan (recorded before code): `docs/tasks/giwa-stocks-known-hash-ui-003d-plan-20260918.md`.

## Bases, roles, environment

| Item | Value |
| --- | --- |
| Base | `/private/tmp/arco-giwa-003d-recovery-20260918` @ `a805b26cf531ca1102894e8d7510fb4ca6b9f1c4`, branch `codex/giwa-003d-recovery-20260918`. Clean (0 files) at the start (`base.txt`) and at the end (`final/untouched.txt`) |
| Work clone / branch | `/private/tmp/arco-giwa-known-hash-ui-20260918`, `codex/giwa-known-hash-ui-20260918` (push URL disabled) |
| Final commit | The commit that contains this file; its SHA is in the handoff. The code and tests are those of `2e1b8f4`, where the final checks ran |
| Commander | user / conductor (003D prompt) |
| Builder | Claude Code, `claude-opus-5`, the same builder session as 003B/003B-1 |
| Independent reviewer | Codex (pending): backend contract and the PostgreSQL/EVM/Chrome integration of these buttons |

Environment (untracked):
- `node_modules` is a symlink to `/private/tmp/arco-giwa-preflight-20260917/node_modules` (lockfile byte-identical).
- `packages/contracts/artifacts` is copied.
- jsdom comes from `/private/tmp/arco-rwa-ui-independent-review-20260917`.
- Node v24.14.0. Node 22 (CI) was not verified.

Evidence directory: `/private/tmp/arco-giwa-known-hash-ui-evidence-20260918/`. It contains `mutation/`, `mutation-round2/`, `mutation-round3/`, `final/`, `final-stopped-59bb316/` (a run stopped on purpose; see Final checks) and the `dev-*.log` development runs.

## Commits

| Commit | Content |
| --- | --- |
| `6c251cb` | Plan |
| `63a9f5a` | Implementation and tests |
| `59bb316` | Review round 1 fixes (copy, notice scope) plus tests for mutation survivors |
| `3b70d19` | Review round 2 fixes (copy) and the test gaps it found |
| `2e1b8f4` | Test flake fix: the fixture's JWT is deterministic per second |
| (this commit) | Evidence and task results |

## Changed files (19 in code/test/docs before this file; `final/changed-vs-base.txt`)

New module `src/demo/giwa/stocks-known-hash-recovery/`:

| File | Role |
| --- | --- |
| `store.ts` | In-memory candidate store |
| `capture.ts` | Original-gate wrapper |
| `recover.ts` | Explicit recovery run |
| `KnownHashRecoveryCard.tsx` | The card |
| `index.ts`, `README.md` | Exports and module docs |
| `store.test.tsx`, `capture.test.tsx`, `recover.test.tsx`, `KnownHashRecoveryCard.test.tsx` | Tests |

`src/demo/giwa/stocks-execution-host/`:

| File | Change |
| --- | --- |
| `registry.ts` | Wraps each owner's gate; new `knownHashes` and `origin` options |
| `StocksExecutionProvider.tsx` | Store and origin props; owner scope; recovery cards on the order slot; two notice variants |
| `testing/in-process-stocks.ts` | TEST-ONLY. Records a SHA-256 fingerprint of each request's Bearer token; the token itself is not stored |
| `page.dom.test.tsx` | Scenarios 11–12 reworked, 13–20 new |
| `known-hash.dom.test.tsx`, `scope.test.tsx` | New |
| `README.md` | Updated |

Also:
- `src/demo/giwa/stocks-market/StocksPages.tsx`: a `knownHashes` page-environment seam, passed to the provider. The product default is the tab's module store.
- `docs/tasks/giwa-stocks-known-hash-ui-003d-plan-20260918.md`: the plan and results.

**Not changed** (`final/forbidden-paths-diff.txt` lists only the test harness):
- `server/`, `packages/`, `deployments/`, `scripts/`, dependencies, Vite, `index.html`, `main.tsx`;
- providers, config, contracts, `wallet.tsx`;
- `stocks-wallet`, `stocks-wallet-submissions`, `stocks-wallet-http`, `stocks-wallet-source`, `stocks-wallet-ui`, `stocks-host`, `stocks-investor`, `stocks-admin`.

No product module imports `testing/`. The one match in `final/product-imports-of-testing.txt` is a comment in `stocks-execution-host/index.ts`.

## What the user gets

1. **The original request.** An owner's wallet request is open when its Stocks session ends (expiry or logout), or when its original outcome record fails for another reason. The wallet then returns a transaction hash.
   - The owner's **original** submission gate is called exactly as before and fails as before. An expired session is refused before any HTTP request, and the controller sees the identical failure.
   - The wrapper keeps the hash in this tab's memory only in that case, with the original claim binding and scope. The binding is `claimId`, `intentKey`, `stage` and `transactionDigest`; the scope is side, order, deployment, wallet, chain 91342, API base and frontend origin.
   - No hash is kept for an UNKNOWN wallet result (no answer, an error or an invalid hash), and none for a record the original session completed.
2. **While signed out with the same wallet**, the session-end notice uses the kept-hash variant:
   - "This tab kept a transaction hash the server may not have recorded";
   - the hash is recorded only by the owner's action after signing in again, in this tab;
   - reloading or closing the page loses it;
   - never send again; operations only if recording fails or the order still shows unknown after it.

   Without a kept hash, the 003B-1 no-hash copy is unchanged. Neither variant names an order, amount or hash.
3. **After signing in again**, the same owner's order shows a card with the step and the hash. The card is filtered during render by session wallet = shown wallet, chain, API base, origin, order and deployment. "Record this hash" runs one explicit recovery:
   - a new gate pinned to the current session;
   - inspect the original binding;
   - record only the original hash;
   - reconcile.

   The card shows what the server answered:
   - RECORDED, when the receipt is not final yet ("Check the receipt again");
   - VERIFIED CONFIRMED or REVERTED ("not the order result"; "an approval does not fund or complete the order");
   - CONFLICT, NO_CLAIM or binding mismatch, each with operations guidance;
   - a hedged failure with an explicit "Check again".
4. **Never:** a claim, a wallet request, a policy, evidence or deadline check, an automatic retry, or a new session adopted for an old callback. Recovery works after quote expiry and while trading is paused. New transfers keep their own rules: an expired approval-only order offers no deposit, and the server refuses a new TRANSFER claim.

## Requirement → implementation → test

| Prompt item | Implementation | Tests |
| --- | --- | --- |
| 1 Candidates only from the original controller → captured gate record path, with the exact binding and scope; UNKNOWN is not a candidate; no empty claim or user input | `capture.ts`: won-claim map and record binding check; kept only when the original record fails | `capture.test`, `recover.test` (4 combinations, completed original record, wallet error), mutations M01, M03, M04 |
| 2 No bypass of the original refusal; old callbacks never adopt a new token; the original `record` is called unchanged and its failure propagated; controller unchanged | The same promise is returned; no session access in the wrapper; controller untouched | `capture.test` (identical promise and error), `recover.test` "original callback arriving after the same owner signed in again / while B is shown" (0 requests with any token), page scenario 20; M02, M31 |
| 3 No credentials in the store; scoped, bounded, no expiry release | `store.ts` (plain data, 16 entries, no timers) | `store.test` (copied fields, static no-storage/no-credential check, bounds, no expiry); M11, M12 |
| 4 No first-render exposure to another wallet, network, API or deployment; A→B→A; StrictMode; late answers | Render-time `ownerScope` and `forOrder`; notice scope; stop on identity change or unmount | `known-hash.dom` (first commits: deployment, origin, API base, chain, wallet B, B signed in with A's row, back to A); page 13, 17, 20; M14, M16, M18, M19, M23 |
| 5 Button only for the signed-in same owner and exact order; a new pinned gate; inspect first; stop on binding mismatch | `StocksOrderExecution` filter; `recoverKnownHash` steps 1–3 | `recover.test` (other owner, no claim, binding mismatch), `scope.test`; M05 (equivalent, see below), M06 |
| 6 Record only the original hash; state only from the server; ownership after every await; 401 with the pinned session ID | `recover.ts` steps 4–5, `live()` after each await, gate `onSessionRejected` | `recover.test` (exact bodies, owner change during inspect, record and reconcile answers, 401), page 17, 18 (S1's 401 after S2 signed in); M07–M09, M24, M25, M27 |
| 7 Same hash: no re-record. Different hash: conflict, never overwrite. Lost answer: kept, explicit re-check only. No loops | Inspect decides; failures keep KEPT; BUSY lock; no timers | `recover.test` (original lost answer, conflict, server error, lost recovery answer, busy), page 13 (double activation); M06, M08, M10 |
| 8 Never claim, requestTransaction, approve, submit or a wallet request; no policy or deadline precondition; works after expiry and pause; new transfers keep their policy | `recover.ts` has none of these (static check) | `store.test` static check; `recover.test` (0 claims, 0 wallet calls of any kind; expiry + pause; TRANSFER claim refused 503/409); page 13, 14 |
| 9 A receipt is not order completion; an expired approval-only order allows no new deposit | Card copy; the existing panel deadline rule | Card test (no completion claim); page 13 (panel "Quote deadline passed", no deposit), 15 (order stays BROKER_PENDING) |
| 10 Notice variants; do-not-resend and operations kept for the no-hash case; tokens and components | Two variants, existing `Notice` and button tokens | Page 11–12 (no-hash exact copy), 13–18 (kept-hash exact copy), `known-hash.dom` (other network keeps the kept variant); M15, M22, M30; design tokens 7 known |
| Required: server already CONFIRMED/REVERTED | Terminal row reported as it is | `recover.test` (1 inspect, 0 outcomes, 0 reconciles); M26 |

## Request counts (real `/stocks` page, scenarios 13–16 and 20; `page.dom.test.tsx`)

For each explicit "Record this hash", activated twice in one act:

| Request | Count |
| --- | --- |
| GET `/wallet-submissions/:side/:orderId` (inspect) | 1 |
| POST `/wallet-submissions/outcomes` | 1. Body exactly `{claimId, intentKey, stage, transactionDigest, status: "SUBMITTED", txHash: original}` |
| POST `/wallet-submissions/reconcile` | 1 |
| POST `/wallet-submissions/claims` | 0 |
| Wallet calls of any kind (`eth_sendTransaction`, `wallet_sendTransaction`, `eth_sendRawTransaction`, reads) | 0 |

- **Tokens:** all recovery requests carry one Bearer fingerprint, which differs from the original claim's.
- **Server row:** `CONFIRMED` with the original hash. The business order state is unchanged (AWAITING_*, or BROKER_PENDING in scenario 15).
- **Before recovery:** in every late-hash case the original gate made 0 outcome requests, and the server kept `REQUEST_MAY_START` without a hash.

The module-level test (`recover.test`, real registry, controller, gate and ports) shows the same for BUY/SELL × APPROVAL/TRANSFER: exactly GET, POST outcomes and POST reconcile, all with the new session's token and never the original one.

## Builder-side review (not independent review)

Two read-only workflows ran. Each had an authority/safety lens, a test-adequacy lens and a UI lens, with one skeptic verifier per lens.

| Round | Target | Result | Resolution |
| --- | --- | --- | --- |
| 1 | `63a9f5a` | Only the UI lens completed; the other two lenses and its verifier failed with an API certificate error. 3 UI findings, which the builder checked against the code: failure copy "Nothing was sent from your wallet"; a timing claim in the notice title; another network switched the notice to the no-hash wording | Fixed in `59bb316` |
| 2 | `59bb316` | All 6 agents completed. Confirmed: KH-AUTH-1 (P3) = TA-2 (P3), TA-1 (P2), TA-3, TA-4, TA-5 (P3), KH-UI-FIX-01, -03 (P3). Plausible: TA-6, KH-UI-FIX-02 (P3). Refuted: KH-AUTH-2 | Fixed in `3b70d19` (below) |

Round 2 findings and fixes:
- **KH-UI-FIX-01:** an approval card told the user not to send the deposit or escrow. The never-again and operations lines now name only the card's own step.
- **KH-UI-FIX-02:** a failed record said the action sent nothing, though the server may have stored the hash. The copy now hedges on the server and speaks only for the wallet.
- **KH-UI-FIX-03:** the notice sent an unknown result to operations before recovery was tried. Operations now follow a failed or ineffective recording, and the kept card says the order's own check may show unknown until then.
- **TA-1:** a callback arriving after a new same-owner session, or while B is signed in, had no test. Tests added.
- **TA-2 / KH-AUTH-1:** ownership checks after the record and reconcile answers had no test. Tests added.
- **TA-3:** a 401 arriving while a newer session exists had no page test. Scenario 18 now covers it.
- **TA-4:** a server row already terminal had no test. Tests added.
- **TA-5:** the old `authorization` presence check was vacuous. Replaced by bearer fingerprints; the tests also assert that no wallet call of any kind happens.
- **TA-6:** first-commit checks now include B signed in with A's order row, and B's notice.

## Mutation checks (disposable copy `/private/tmp/arco-giwa-known-hash-ui-mutation-20260918`; each file restored and compared with the work clone)

| Round | Target | Result |
| --- | --- | --- |
| 1 (`mutation/summary.txt`) | `63a9f5a` | 19 mutations, 16 killed. **M05 survived, equivalent:** without the recovery's own `transactionDigest` comparison, the new gate's `record` binding check refuses the mismatch before any request, so result and requests are identical. **M16** (owner scope without the shown-wallet check) and **M18** (no card-mounted check) survived for lack of a test and were killed in round 2 |
| 2 (`mutation-round2/summary.txt`) | `59bb316` | 6/6 killed: M16, M18, M20 card "nothing was sent", M21 card without never-again, M22 notice timing title, M23 notice requires chain |
| 3 (`mutation-round3/summary.txt`) | `3b70d19` | 8/8 killed. The tests in parentheses kill each one: M24/M25 no ownership check after record/reconcile (recover.test owner change); M26 terminal status swapped (already-terminal test); M27 page invalidates the live session instead of the pinned one (scenario 18); M28 generic never-again (card test); M29 "send anything" failure copy (card test); M30 notice operations before recording (page 13–18); M31 a fallback gate using the live session after refusal (callback test) |

M27's first round-3 run also failed page scenario 20. That was an assertion flake of the test itself: the fixture's deterministic JWT gave two sign-ins in the same second an identical token. It was fixed in `2e1b8f4`, and M27 was rerun (`mutation-round3/m27-rerun/`): killed by scenario 18 only.

## Final checks (`final/`, HEAD `2e1b8f4`)

| Check | Exit | Result |
| --- | --- | --- |
| Focused: known-hash module, card, scope, first-commit DOM (DOM + artifacts) | 0 | 36/36 |
| Focused: registry, full-stack, page DOM, harness | 0 | 64/64 |
| Page DOM repeated | 0 | 21/21 (gate + 20 scenarios) |
| `npm run typecheck` | 0 | no errors |
| `npm run build` | 0 | built; the existing chunk-size warning only |
| `npm run test:frontend` with DOM runtime + ABI artifacts | 0 | **707/707** (Codex's 003D baseline: 663) |
| `npm run test:frontend` CI-like (both gates unset) | 0 | 657 tests: 652 pass, 5 skipped (4 DOM gates including the new `known-hash.dom`, 1 artifact gate) |
| `npm run test:server` | 0 | 402 tests: **330 pass, 72 DB-gated skips**, 0 fail |
| `npm run test:security` | 0 | env exposure and evmVersion checks pass |
| design tokens `--all` | 1 | the 7 known baseline findings, none new |
| design stories `--all` | 0 | no hard violations |
| `.mjs` DOM regressions (market routes, admin scope-render, investor delayed-sell) | 0 | 23/23 |
| `git diff --check a805b26 HEAD` | 0 | clean |

A first final run on `59bb316` (`final-stopped-59bb316/`) was stopped on purpose after review round 2 found copy issues. Only its first step had finished (36/36); it is superseded by the run above.

Codex's `scripts/stocks-local/known-hash-driver.mjs` (backend and HTTP-adapter acceptance with `page.evaluate`) was not run or changed here. It does not click these buttons; wiring it to them is Codex's follow-up.

## Limits and remaining connection work

**Not implemented (by scope):**
- recovery after a reload, in another tab or on another device (memory only);
- a hash the application never received (no manual entry, wallet transaction search or guess);
- an UNKNOWN wallet result (it stays recovery-only);
- Dynamic mode (no execution, so no candidates).

**Known behaviour:**
- **Store size.** The store keeps 16 entries; eviction only forgets this tab's copy.
- **Conflicts that race in.** The existing gate reports a 409 conflict as `SUBMISSION_HTTP_ERROR`. A conflict that raced in after the inspect therefore shows as a failure first, and an explicit "Check again" then shows the conflict.
- **Stale RECORDED card.** When the panel's own reconcile verifies an approval, a RECORDED (receipt pending) card is not refreshed on its own; it stays until its own "Check the receipt again".
- **READY capability required.** The card renders in the order slot, which needs the READY capability (session, injected wallet, same wallet).

**Harness limits (test-only):**
- Memory SQL, not PostgreSQL.
- The fake chain finalizes immediately unless told otherwise.
- Envelope `observedAt` uses real time while the fixture's server clock is shifted, so panel evidence goes stale under large clock offsets. Recovery is unaffected. The quote-deadline panel check was therefore verified at the server level (503 paused, 409 expired) and through the panel's deadline copy.
- JWTs are deterministic per second.

**Not verified:** real PostgreSQL, EVM or Chrome (Codex follow-up), a real wallet or extension, a public network, Node 22, an accessibility audit.

**Remaining connection work (Codex):**
- Drive "Record this hash" and "Check the receipt again" in the local Chrome, PostgreSQL and EVM stack instead of the `page.evaluate` probe.
- Confirm real receipts for BUY/SELL × APPROVAL/TRANSFER after a genuinely expired JWT, then run an independent review.
