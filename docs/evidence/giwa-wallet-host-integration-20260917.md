# GIWA-STOCKS-WALLET-HOST-INTEGRATION-003B — evidence

Local builder candidate for independent Codex review. It is not integration approval, not a real wallet connection and not public-network trading.

No push, merge, deployment, wallet signature, transfer, public RPC, database, dependency install or real wallet was used. Every wallet is a fake EIP-1193 object on a fake chain. Every server is the real server code, running in-process over an in-memory SQL fake (`app.inject`) or on a loopback-only verification server.

Plan (written before code): `docs/tasks/giwa-wallet-host-integration-20260917.md`.

## Bases, roles, environment

| Item | Value |
| --- | --- |
| Base | `/private/tmp/arco-giwa-wallet-hardening-20260917` @ `b27b2592cb031e356eff8bfa497c161eb08ec596` (003A-1, Codex-accepted; includes backend `dc43e75` and Claude 003A). No other base was merged. At the end its HEAD was unchanged and its status clean |
| Work clone / branch | `/private/tmp/arco-giwa-wallet-host-integration-20260917`, `codex/giwa-wallet-host-integration-20260917` (new path; push URL disabled) |
| Final commit | The commit containing this file. The SHA is in the handoff, because a file cannot contain its own SHA |
| Untouched | the base checkout; `arco-giwa-wallet-api-integration` (`4e02a0e`), `arco-giwa-canonical-locale` (`dc43e75`) and `arco-giwa-submission-diagnostics` (`c97c5c9`), all at the same HEAD and clean at the end; the Codex review clones and evidence folders (the URL probe was copied, not edited) |
| Commander | user / conductor (003B prompt) |
| Builder | Claude Code, session `local_adcc4340-7e91-44cb-a754-5453f2af4e11`, conversation `beb6fdbb-2740-48ec-948b-f6ffddadbd9f`, `claude-opus-5` |
| Sub-builders | Same builder session, each in its own clone, merged with `--no-ff`: wallet-source `9d9ca1c`, api-base `90258b7`, harness `02b52f3`, browser-fixture `f1036d8`, page-dom `b0c3f31`. Builder-side, not reviewers |
| Independent reviewer | Codex (pending). The builder-side review workflow below is not independent review |

Environment (untracked):
- `node_modules` is a symlink to `/private/tmp/arco-giwa-preflight-20260917/node_modules`, whose lockfile is byte-identical.
- `packages/contracts/artifacts` is copied from the base checkout.
- DOM runtime: `/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json`.
- Node v24.14.0. The CI runtime (Node 22) is not installed locally and was not verified.

External evidence directory: `/private/tmp/arco-giwa-wallet-host-integration-evidence-20260917/`

| Directory | Contents |
| --- | --- |
| `failure-first/` | Facts about the base |
| `api-base/` | Before/after logs and regressions |
| `wallet-source/` | Tests, regression runs and mutation checks |
| `harness/` | Harness self-tests |
| `page-dom/` | DOM runs and mutation logs |
| `browser-fixture/` | Fixture smoke test |
| `browser-check/` | Builder browser observations |
| `codex-url-probe/` | The independent URL probe, run before and after |
| `mutation/` | Host and panel mutations |
| `mutation-review/` | Mutations for the review fixes |
| `final/` | Final checks and boundaries |

## Changed files (`git diff --stat b27b259`, 60 files with this one)

New:
- `src/demo/giwa/stocks-wallet-source/`: `types.ts`, `capture.ts`, `ports.ts`, `bridge.ts`, `index.ts`, `README.md`, tests, `test-support.ts` (tests only, not exported).
- `src/demo/giwa/stocks-execution-host/`:
  - `registry.ts`, `StocksExecutionProvider.tsx`, `index.ts`, `README.md`
  - `registry.test.tsx`, `full-stack.test.tsx`, `page.dom.test.tsx`
  - `testing/`: TEST-ONLY in-process server, memory SQL, fake chain, fake wallet and their self-test
  - `verification/`: an offline loopback page (`index.html`, `main.tsx`, `serve.ts`, `README.md`), not part of the app build
- `src/demo/giwa/api-base.ts` and its test; `stocks-investor/execution-slot.ts`; `stocks-admin/client-base.test.tsx`.

Modified:
- `contracts.ts`: a read-only `activeWalletSource()` accessor. `walletClient()` and every transaction function are unchanged.
- `wallet.tsx`: the context exposes `source`. For Dynamic it is present only while `signingReady`.
- `stocks-host`:
  - `StocksHostProvider` exposes `wallet` and takes an optional `walletSource`
  - `GiwaStocksHost` passes `wallet.source`
  - `session.ts` uses `resolveApiBase`
  - tests and README updated
- `stocks-investor`:
  - `client.ts` uses the common base check
  - `GiwaStocksFeature` has an optional `renderOrderExecution`
  - `OrderStatusCard` renders the slot and neutral wallet-step copy
  - tests updated
- `stocks-market`: `client.ts` uses the common check; `StocksPages.tsx` resolves one base, mounts the execution provider, and shows capability copy and the session notice.
- `stocks-admin`: `client.ts` checks the base before any authenticated request; new `configuration` error kind (`types.ts`, `ui.tsx`).
- `stocks-wallet-ui`:
  - `adapter.ts`, `StocksWalletExecutionPanel.tsx`: optional `refreshEvidence`, `evidenceFailure`, `unavailableCode`
  - `model.ts`: the check stays available while only evidence is missing; wallet steps need READY; failure notes
  - `messages.ts`: host and port codes
  - tests and README updated
- READMEs of `stocks-wallet` (the receipt port is inactive and unused) and `stocks-wallet-http` (host composition, API base limits).
- `docs/tasks/giwa-wallet-host-integration-20260917.md` and this file.

Not changed (`final/boundaries.log`; `git diff --name-status b27b259 HEAD` over these paths is empty):
- `server/`, `packages/`, `deployments/`, `package.json`, lockfile
- `vite.config.ts`, `index.html`, `src/main.tsx`
- `providers.tsx`, `config.ts`, `routes.ts`, `stocks-market/routes.tsx`
- `stocks-wallet/{controller,planner,types}.ts`
- `stocks-wallet-submissions/`, `stocks-wallet-http/{reads,transport}.ts`

No app entry references `testing/` or `verification/`, and no product module imports them.

## Connected flow and owner lifetime

1. **Page.** `/stocks` (`StocksPages.tsx`) resolves `ARCO_API_BASE` once with `resolveApiBase(value, window.location.origin)`. It gives the result to the market, investor and admin clients and to `StocksExecutionProvider`.
2. **Wallet view.** `GiwaStocksHost` passes the provider tree's active source object (the injected provider, or the Dynamic client) with the existing `sessionEpoch` to `StocksHostProvider`. `useGiwaStocksHost().wallet` exposes it.
3. **Registry.**
   - `StocksExecutionProvider` keeps one registry per identity: session ID, wallet address, chain, epoch, source object and API base.
   - It is created in a layout effect and disposed in the cleanup, which is StrictMode-safe. During render, a registry with another key is never used.
   - The registry captures the wallet source once.
4. **Card slot.** `OrderStatusCard` (the accepted order in the trade panel, and a selected order in the Orders tab) calls the host slot while the capability is READY. The slot renders `StocksOrderExecution` for AWAITING orders, and for orders this identity has already seen.
5. **Owner.** Each `side:orderId` gets one owner, built from the first row seen. It holds `createExecutionClock` with one monotonic source, `createStocksExecutionReads`, `createSubmissionGate`, `createWalletSourcePorts`, the `WalletPorts` object and `createStocksWalletController`.
   - It selects its pinned row.
   - Later investor rows only become `serverOrder`.
   - Nothing is recreated on render, tick, refresh or evidence renewal.
6. **Panel.** It receives the owner's controller and ports, the pinned selection, `serverOrder`, the card refresh, `refreshEvidence` and `evidenceFailure`.
   - **Check:** one explicit evidence read, then the read-only controller check.
   - **Approve** and **Deposit/Escrow:** separate clicks, armed after 800 ms, each opening at most one `eth_sendTransaction`.
7. **Session end.** Logout or expiry disposes the registry. A late wallet answer goes only to the original gate. While signed out with the same wallet, a generic notice (no order, amount or hash) says to sign in again, check the order and not repeat anything. No previous account's attempt is shown to a new account.

## 1. Active wallet ports

- **Capture** (`capture.ts`):
  - Injected provider only. The provider object and its raw `request` are captured.
  - Subscribing to `accountsChanged`, `chainChanged` and `disconnect` issues no request, and any event retires the capture for good.
  - `isCurrent()` also requires the `contracts.ts` accessor to still report the identical provider.
  - Dynamic mode → `WALLET_SOURCE_UNSUPPORTED`, before sign-in too, with zero client access and zero `window.ethereum` reads.
- **`readWallet`:**
  - `eth_chainId` (canonical quantity 91342), `eth_accounts[0]` = captured account.
  - `eth_getBlockByNumber(<checkpoint hex>, false)`: `number` must equal the request and `hash` must be lowercase, non-zero and equal to `manifest.checkpointHash`.
  - `eth_chainId` and `eth_accounts` again, then `isCurrent` and the digest unchanged.
  - Only the latest read may set or clear the attestation, and a read in progress clears it.
- **`readAllowance`:**
  - Scope: the reviewed (token, spender) pair, owner = captured account.
  - The same network checks; the abort signal is checked before and after them.
  - `eth_call [{to, data: allowance(owner, spender)}, "latest"]` must return an exact 32-byte word, returned as a decimal string.
  - Afterwards: abort, source, chain and account again.
- **`requestTransaction`:** non-async.
  - Synchronous checks: exact keys, chain 91342, value `"0"`, reviewed `to`, hex data, `isCurrent`, an attestation for this capture and digest, and `from` equal to it.
  - Then exactly one `eth_sendTransaction [{from, to, data, value: "0x0"}]`, whose promise is returned unchanged; a late hash is never discarded.
- **`waitApprovalReceipt`:** explicitly inactive (`RECEIPT_PORT_INACTIVE`). The controller never calls it (the base had 0 references); approval confirmation stays with the gate's server `reconcile`.
- **Why Dynamic is refused:**
  - `dynamic-control.test.tsx` builds a Dynamic-shaped client from nested real viem 2.53.1 `custom()` transports. One -32603 then produces 4 `eth_sendTransaction` through `transport.request` of the outer client, and 16 through `request`.
  - A research probe of the real Dynamic `EthereumWallet` and wagmi connector code measured 16 through the client `useWalletClient` returns.
  - With the current `providers.tsx`, no single-attempt raw request exists.

Tests: `stocks-wallet-source/*.test.tsx` has 29 cases (27 from the stream + 2 from the review). They check:
- exact method sequences and params
- wrong chain, same-chain other checkpoint, missing checkpoint, malformed answers, account swaps, source events, digest change
- provider errors surfaced as `REQUEST_FAILED` once, with no raw text
- allowance values 0, 1 and 2^256−1, scope and owner refusals, malformed words, aborts (also during the checkpoint read), swaps
- one synchronous raw send, with the call logged before `requestTransaction` returns
- refusals, -32603 sent once, a late hash kept after `accountsChanged`
- stale attestation from an older read
- the inactive receipt port, the contracts accessor, the Dynamic negative control

Also: existing Savings/Funds and host wallet regressions 82/82 (`wallet-source/regression.log`: `phase5`, `wallet-bridge`, SSR and component tests), and `provider.dom` 11/11.

## 2–3. Host, evidence, page

`registry.test.tsx` (14):
- no I/O on creation
- capability codes (API base, session, wallet mismatch, missing source, Dynamic before and after sign-in)
- identity keys (session, address, chain, epoch, source object, API base)
- pinned rows and eligibility after a restart; live context
- evidence: one in-flight read; same evidence keeps the lease; new evidence replaces it; a stale scope is ignored; a failure drops the lease; another manifest is refused
- 401 invalidates the captured session, also after the host moved to a newer session
- no newer-session token; dispose aborts
- clock failure, then an explicit restart only
- source guards

`full-stack.test.tsx` (14) runs the real registry, controller, reads, gate and ports against the real Stocks, execution and submission plugins, the real deployment evidence, and the real receipt verifier over the real RPC port. A fake wallet and the server share one fake chain.

| Scenario (BUY and SELL unless noted) | Wallet sends | Server | Screen |
| --- | --- | --- | --- |
| check → approve (double) → reconcile → transfer (double) | 2 total, exact params | claims 2, outcomes 2, reconcile 1, order still AWAITING | SUBMITTED + hash; allowance exact |
| other checkpoint (91342), other chain, missing checkpoint | 0 | claims 0 | BLOCKED `WALLET_NETWORK_INSTANCE_MISMATCH` |
| A→B→A; same-address provider swap; swap during the allowance read | 0 | claims 0 | BLOCKED `WALLET_CHANGED` |
| account change inside a SIGNING subscriber | 0 | claim UNKNOWN (see limits) | UNKNOWN `WALLET_OUTCOME_UNKNOWN` |
| 4 s policy + 6 s check inside the final wallet read + 15 s evidence | **0** | claim REQUEST_MAY_START | UNKNOWN `EXECUTION_POLICY_EXPIRED`; negative control (a port that awaits its own check) → **1** send |
| evidence and policy expiry while the approval prompt is open | 1 | outcome SUBMITTED, reconcile 0 | APPROVAL_SUBMITTED + hash + `EXECUTION_AUTHORITY_CHANGED`; explicit check later → READY_TRANSFER, still 1 |
| logout/reload during the prompt (BUY) | 1 | late outcome via the old gate | old owner paints nothing; new owner → READY_TRANSFER only after a check |
| session expired by time during the prompt (SELL) | 1 | outcome refused by the gate (claim stays REQUEST_MAY_START) | same screen shows the hash; next session → UNKNOWN recovery-only, never resent |
| late 401 on outcomes | 1 | invalidates the captured session | APPROVAL_SUBMITTED |
| cancel during the prompt | 1 | outcome SUBMITTED | APPROVAL_SUBMITTED |
| 4001 / -32603 / invalid hash | 1 each, never retried | UNKNOWN | UNKNOWN recovery-only |
| reverted approval / pending finality | 1 | REVERTED / RECEIPT_PENDING → CONFIRMED after finality | BLOCKED `APPROVAL_REVERTED` / READY_TRANSFER after an explicit check |

`page.dom.test.tsx` (11 = gate + 10) runs the real `/stocks` routes in StrictMode with the real host, investor feature, provider, panel, controller, reads, gate and ports over the in-process server:
1. mount and sign-in: 0 wallet and 0 execution requests; capability copy only after sign-in
2. BUY accept → check (1 evidence read) → Approve armed ≥700 ms → 1 exact send → claim/outcome/reconcile → READY_TRANSFER, then no send for 2.5 s → Deposit → SUBMITTED
3. SELL through the Orders tab
4. server status refresh keeps the pinned hash
5. double click and repeated keyboard activation (1 send each)
6. clock jump during an open prompt
7. account switch during a held send (B never sees A)
8. sign-out during a held send (notice, no order data, late outcome to the original gate; a later session without a request clears the notice)
9. Dynamic source (unsupported copy before and after sign-in, legacy card copy, 0 proxy traps, 0 requests)
10. remount during a held send (UNKNOWN "do not repeat", then READY_TRANSFER after the old request is recorded; 1 send)

`testing/harness.test.tsx` (15) are the harness self-tests over real routes only:
- BUY/SELL claim → approve → outcomes → reconcile CONFIRMED → transfer → CONFIRMED
- a repeated claim returns null; an early transfer claim gets 409
- client-reported CONFIRMED gets 409; pending finality; revert
- another wallet cannot see the order
- body forwarding; memory SQL rollback, unsupported statements and serialisation
- browser reads and gate DTO compatibility; fixture sign-in accepted by the real JWT resolver

Other:
- Panel and investor tests: `model.test.tsx` covers the evidence-refresh availability, failure notes on recovery screens and host codes (the drift test now also scans the port and registry sources).
- `controller-adapter.test.tsx`: evidence read then check, wallet steps never read evidence, host unavailability code.
- `views.test.tsx`: the card with and without the slot; never "then deposit".

## 4. Common API base

- **Rule** (`api-base.ts`):
  - http(s) only, no credentials
  - the normalized `href` contains no `?` or `#`, even empty ones
  - trailing slashes are removed; path prefix and percent-encoding are kept
  - `resolveApiBase` additionally resolves a relative or empty value against a plain frontend origin, exactly as the host already did
- **Applied to:**
  - host `session.ts`
  - investor `client.ts` (`GIWA_STOCKS_INVALID_BASE_URL`)
  - market `client.ts` (`INVALID_API_BASE`)
  - admin `client.ts` (`configuration`, checked before the token check and any fetch)
  - `StocksPages.tsx`, which resolves one base for every client
- **Failure first** (`api-base/`): 57 tests; before 46 pass / **11 fail**, after **57/57**.
  - A cross-module corpus shows all seven modules agree: host, investor, market, admin, planner, submission gate, reads.
  - Every refused base makes 0 requests, and no error contains the raw base or token.
  - Accepted bases produce exact URLs, with Authorization only where it belongs.
- **Independent Codex probe** (`codex-url-probe/url-boundaries.test.mjs`, only the import roots changed; the original is unmodified):

| Probe | Base `b27b259` | Final |
| --- | --- | --- |
| hardened planner/submission reject empty delimiters | pass | pass |
| inherited host/investor/market/admin accept `?`/`#` and send to pathname `/` (defect-observing) | 4 pass (defect observed) | 4 fail: `INVALID_AUTH_CONTEXT`, `GIWA_STOCKS_INVALID_BASE_URL`, `INVALID_API_BASE`, admin sends no request (defect no longer observed) |

## Failure first at the base

`failure-first/base-facts.md`:
- `/stocks` said "입금·매도 예치 지갑 연결은 준비 중입니다", and the card said "Funding required — not available in this app yet".
- `stocks-wallet-source`, `stocks-execution-host` and `api-base.ts` did not exist.
- No product implementation of the wallet ports existed.

The new wallet-port, host, full-stack and page tests therefore cannot run at the base; the capability was absent. Measured before/after exists for the API base (above) and for each review fix and mutation (below).

## Builder-side review (not independent review)

A five-lens workflow (wallet port, host lifetime, panel, API base, tests/docs) ran with one skeptic verifier per lens. It produced 18 findings: 14 confirmed or plausible, 4 refuted, **none P0/P1**. After verification one P2 remained (TD-1), the rest P3.

| Finding | Verdict | Resolution |
| --- | --- | --- |
| WP-1 an older `readWallet` restores an attestation a newer failed read cleared | CONFIRMED P3 | Sequence numbers; a read in progress clears it; test |
| WP-2 an allowance read aborted during the checkpoint read still issues `eth_call` | CONFIRMED P3 | Abort checked before `eth_call`; test |
| WP-3 a synchronous port refusal is recorded as UNKNOWN | PLAUSIBLE P3 | Controller-owned; documented as a limit (fail-closed) |
| HL-1 the old lease stays usable after the server refuses new evidence | CONFIRMED P3 | Lease dropped on failure; test |
| HL-2 restart hides the panel of a moved-on order | CONFIRMED P3 | `hasPinned` eligibility; test |
| HL-3 the session-end notice is never cleared | CONFIRMED P3 | Cleared by a later session without a request; DOM test |
| HL-4 a Dynamic user is told to sign in first | CONFIRMED P3 | Unsupported before sign-in; registry and DOM tests |
| PANEL-1 the card says "approve … then deposit" after a deposit hash exists | CONFIRMED P3 | Neutral copy pointing at the panel ("never send one again"); test |
| PANEL-2 evidence-read failure invisible on recovery screens | CONFIRMED P3 | Failure note on every screen offering the check; test |
| TD-1 captured-session 401 untested after the host moved on | CONFIRMED P2 | Test |
| TD-2 no other-manifest evidence test | CONFIRMED P3 | Test |
| TD-3 chain missing from the identity-key test | CONFIRMED P3 | Test |
| TD-4 README claimed the notice survives a reload | CONFIRMED P3 | README corrected |
| TD-5 evidence doc and invalid-hash test missing | CONFIRMED P3 | This file; full-stack invalid-hash case |
| HL-5, PANEL-3, PANEL-4, API-BASE-01 | REFUTED | Not reachable at runtime, or intended (the host's existing relative-base rule) |

## Mutation checks (builder-side; each file restored and verified by SHA-256)

| Set | Result |
| --- | --- |
| `mutation/`: registry, panel model/adapter, card, API base (18) | 16 killed, 2 survived (R10 evidence read after the session moved on; P6 host unavailability code) → tests added → both killed |
| `mutation-review/`: WP-1 (×2), WP-2, HL-1, HL-2, HL-3, HL-4, TD-1, PANEL-1, PANEL-2 (10) | 10 killed |
| `wallet-source/mutation-checks.log`: await before the send, digest re-check, attestation digest, post-call abort/isCurrent, account match (5) | 5 killed |
| `page-dom/`: slot ignores capability, dispatched attempt not marked authority-lost, session notice disabled, arm delay 0 | 4 killed (arm delay after adding a ≥700 ms timing check) |

## Browser check (builder, in-app browser pane; `browser-check/observations.md`)

The offline page ran on `http://127.0.0.1:4327` (real page code, real server plugins in Node, fake wallet). Ports 5173/8788 were not touched. All page requests were loopback, and the server was stopped afterwards (port free).

Seen:
- Signed-out and READY capability copy; the accepted card with "Not checked yet" and an evidence explanation.
- Check → approval screen with only read calls on the wallet.
- A double-clicked Approve → exactly 1 send, 1 claim, 1 outcome, 1 reconcile. A double-clicked Deposit → 1 send, SUBMITTED + hash + "not the order result".
- An observer state change plus refresh → "Broker processing", with the hash kept and no send.
- 375 px: no horizontal overflow, hashes wrap, visible focus ring.
- Sign-out during an open approval or deposit → notice, no order data; release → late outcome recorded, no resend, no reconcile.
- Account B sees no A data. The Dynamic source shows the unsupported copy.
- The pane's synthetic Enter did not activate even a plain button, so keyboard repeat is evidenced by the DOM test.
- A fixture-only defect was found and fixed: the page lacked the `.arco-demo` theme scope of the app shell.
- Two product timing findings are listed below.

## Final checks (HEAD `7b418b1`, the tree of the final commit except this file; `final/`)

| Check | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | no errors |
| `npm run build` | 0 | built; Vite's existing chunk-size warning only |
| `npm run test:frontend` with DOM runtime + ABI artifacts | 0 | **661/661** (reference 558/558) |
| `npm run test:frontend` CI-like (both gates unset) | 0 | 626 tests: 622 pass, 4 skip (3 DOM gates, 1 artifact gate) |
| `npm run test:server` | 0 | 398 tests: **330 pass, 68 skip (DB)**, 0 fail |
| `npm run test:security` | 0 | pass |
| `npm run design:tokens` | 1 | the 7 known baseline findings (`Investor.tsx`, `components.tsx`), none new |
| `npm run design:stories` | 0 | no hard violations |
| `git diff --check b27b259 HEAD` | 0 | clean |
| `.mjs` DOM regressions (`routes.dom`, admin `scope-render`, investor `delayed-sell-regression`) | 0 | 23/23 |
| execution-host + wallet-source + stocks-wallet* modules ×3 (DOM + artifacts) | 0/0/0 | 306/306 each |
| Codex URL probe (final) | 1 | hardened pass; 4 defect-observing probes fail as described |

Locale golden: verified earlier on Node 24 (en-US/cs-CZ/sk-SK) and by Codex in Chrome 152 (ko); still passing in the frontend runs. Node 22 was not available locally; not verified, and nothing was installed.

## Findings for the commander and backend (not changed here)

1. **Quote deadline vs. finalized approval (blocks real-network use of the two-step flow).**
   - The server gives quotes 60 s (`clock_timestamp()+interval '60 seconds'`), and the order's `quoteExpiresAt` is that deadline.
   - An approval is confirmed only by `reconcile`, whose receipt verifier returns pending until the receipt block is finalized. The deposit/escrow step is offered only after that confirmation.
   - On a network whose finality takes longer than the time left, "approve → server-confirmed approval → deposit" cannot finish before the deadline. The panel then says "Quote deadline passed — do not deposit".
   - The fake chain finalizes immediately. The browser check still hit the deadline twice with manual steps.
   - Needs a backend/product decision: quote lifetime, approval-confirmation policy, or allowance before quoting.
2. **Short evidence window.**
   - Server-cached evidence lasts at most 15 s, and a check can receive evidence with only seconds left.
   - The 003A-1 controller returns an unrecorded "Approval required"/"Ready to deposit" screen to "Not checked yet" when the evidence ends. In the browser check this happened before a person could click. Nothing is sent; the user must check again.
   - The host cannot extend it (a renewed evidence ID is a new authority). Options are a minimum remaining lifetime on the server evidence, or a reviewed controller rule.
3. **Dynamic mode is not offered.** It has no single-attempt raw request. Enabling it needs a `providers.tsx` decision (for example `EthereumWalletConnectorsWithConfig({ httpTransportConfig: { retryCount: 0 } })`) and a review of embedded-wallet prepare/sign/`eth_sendRawTransaction` semantics.
4. **A synchronous port refusal is recorded as UNKNOWN** (review WP-3). An account change inside a SIGNING subscriber sends nothing, but the controller's dispatch `try` records the reserved claim as UNKNOWN (recovery-only). Distinguishing it needs a controller change.
5. **Expired session and late hash.** When the session expires by time during an open prompt, the original gate refuses to record the late hash; the journal keeps only the reserved claim, and the next session sees UNKNOWN (do not repeat). The transaction may still be on chain. A server-side recovery path would be needed to attach it.
6. **The session-end notice is page state.** It does not survive a reload or remount; recovery then comes only from the next check.
7. **The checkpoint attestation cannot detect a fork after the checkpoint block, or a lying wallet.** Only the server's finalized receipt verification binds a transaction to the reviewed chain.
8. **The planner throws a plain `TypeError`** for input that is not a URL at all (refused, not `INVALID_API_BASE`; planner not owned).
9. **Not verified:** a real wallet extension, the Dynamic SDK, a public network, a real database (Codex follow-up), Node 22, other browsers.

## Remaining (003C / follow-up)

- Codex independent review of this commit (P0/P1 block integration); local DB/EVM full-flow verification (Codex).
- Decisions on findings 1–3 above (quote/finality timing, evidence window, Dynamic).
- Controller refinement for synchronous port refusals (finding 4), and a server recovery path for late hashes after session expiry (finding 5).
- Real-wallet manual verification on a testnet only after those decisions; not claimed here.
