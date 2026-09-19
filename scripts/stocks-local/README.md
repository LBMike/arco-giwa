# Disposable Stocks local verification

The backend-only, jsdom UI, and Chrome browser modes each own a fresh Unix-socket PostgreSQL database, apply existing migrations, create an unforked loopback Hardhat chain, and deploy only the local test contracts. They do not load `.env`, production registries, keystores, existing databases or public RPCs. The numeric chain ID is 91342, but the deployment/checkpoint identifies a new disposable local chain.

Existing backend-only mode remains:

```sh
npm run build:server
STOCKS_LOCAL_STACK_ONLY=1 STOCKS_PG_BIN=/absolute/postgresql/bin node scripts/stocks-local/run.mjs
```

The original 003C jsdom UI mode mounts the production `/stocks` React routes, host, controller, wallet ports and submission gate under StrictMode in **jsdom**. The page uses native HTTP, real SIWE signatures from local unlocked test accounts, the real API/runtime, PostgreSQL and EVM receipts. It does not open Chrome, use a wallet extension, or provide a persistent browser demo server.

```sh
npm run build:server
TMPDIR=/private/tmp \
STOCKS_LOCAL_STACK_ONLY=1 \
STOCKS_LOCAL_UI=1 \
STOCKS_PG_BIN=/absolute/postgresql/bin \
STOCKS_LOCAL_UI_DOM_RUNTIME=/absolute/existing/jsdom/package.json \
node --import tsx scripts/stocks-local/run.mjs
```

Use installed root npm and contract Yarn 4 dependencies plus the existing Solidity compiler. `STOCKS_LOCAL_UI_DOM_RUNTIME` explicitly selects an already installed jsdom runtime; no package is downloaded by this harness. Node24.14.0 was used for current evidence. A separate Node22 run has not been performed.

## Original 003C jsdom scenario

1. Real nonce/SIWE login, UI quote/order creation, exact approval, separate deposit, native observer/worker processing and issuance for BUY 2 NVDA.
2. Double activation sends once; stopping processing, restarting the API on the same port and remounting the page recovers the same journal hash without another wallet request. This is an HTTP application restart, not a PostgreSQL or Node-process restart.
3. SELL 0.5 NVDA through approval and escrow, followed by actual burn/test-cash payout. UI holdings and chain quantity become 1.5.
4. An open BUY approval followed by account A→B hides A's order/hash on B's first render. The valid original session records the late answer; A's new login/check reads that same claim without resending.
5. SELL 0.25 escrow succeeds on chain but its wallet response is deliberately lost. The UI records UNKNOWN without a hash. The real observer independently sees the escrow, completes the order and updates holdings to 1.25. The instrumentation's hash is never injected into the UI or a recovery endpoint.
6. A held approval outlives the real evidence interval, a shortened **browser** session and the original 60-second quote deadline. No clock is advanced or reset and no deadline is edited. Only the test authentication response's `expiresIn` is restricted to 30 seconds; the signed server JWT remains 900 seconds. This case proves browser-gate expiry, not server JWT expiry. Existing separate PostgreSQL/JWT tests cover the latter.
7. Every holder RPC send is matched to the exact committed claim transaction and a successful claim response with an earlier trace sequence. Actual node transactions supply chain ID, calldata, account and distinct nonces. Faucet/operator sends are separate from the eight UI wallet attempts.
8. Final holder stock/supply 1.25, escrow zero, holder test cash 1,850 and vault test cash 150 agree with server reconciliation at its common cutoff. Deliberately unpaid BUY orders remain unpaid; the test does not manufacture completed states.

The standard broker remains a durable mock at fixed NVDA price 120 ARCO_TEST_USDC. Market-data endpoints are not configured, and their explicit unavailable UI is expected. The jsdom run does not certify real shares, public-network timing, Dynamic, a physical wallet, browser CORS enforcement or layout/accessibility. Its expiry case and eight wallet attempts belong to this jsdom scenario; they are not results from the Chrome scenario below.

## 003C-2 Chrome browser mode

This mode opens an already installed Chrome executable through an already installed Playwright runtime. A disposable Vite development server serves the test entry at `scripts/stocks-local/browser/index.html`; that entry mounts the actual Stocks routes, host and controller under StrictMode. API requests use the browser's native HTTP/CORS behavior, with real local SIWE, the same buildApp/runtime, PostgreSQL, Hardhat, observer and worker. This is a test-only prototype development server, not a production frontend server or deployment setup.

Select the existing runtimes and a dedicated evidence directory explicitly; replace all absolute-path placeholders. The harness does not install Playwright, download a browser or attach to an existing user browser. Keep `STOCKS_LOCAL_UI`, `STOCKS_LOCAL_STACK_CASE_PROBE`, `STOCKS_LOCAL_STACK_SIGNAL_PROBE`, and `STOCKS_LOCAL_BROWSER_PROBE` unset for a normal browser run. Choose only one runner mode.

```sh
npm run build:server
TMPDIR=/private/tmp \
STOCKS_LOCAL_STACK_ONLY=1 \
STOCKS_LOCAL_BROWSER=1 \
STOCKS_PG_BIN=/absolute/postgresql/bin \
STOCKS_LOCAL_BROWSER_RUNTIME=/absolute/existing/playwright/package.json \
STOCKS_LOCAL_CHROME=/absolute/installed/chrome-executable \
STOCKS_LOCAL_BROWSER_EVIDENCE=/private/tmp/stocks-browser-evidence \
node scripts/stocks-local/run.mjs
```

The browser scenario is structured as 19 assertion groups and seven holder wallet attempts. It exercises BUY and SELL through the actual page, separate approval/transfer clicks, UI disabled-state checks, API restart plus real page reload, account A→B isolation with a late A result, and a lost wallet response whose transaction the real observer independently processes. It reads final database/chain reconciliation and captures desktop/mobile screenshots with a horizontal-overflow check. These describe the scenario coverage, not an assertion that a particular run or all lifecycle probes passed. Screenshots and overflow checks are not a complete visual/accessibility audit.

The accepted 2026-09-18 exact-code run and lifecycle results are recorded in [003C-2 evidence](../../docs/evidence/giwa-stocks-local-browser-003c2-20260918.md).

## 003D known-hash recovery case

Add `STOCKS_LOCAL_BROWSER_CASE=known-hash` to the Chrome command above, with a new dedicated evidence directory. Keep `STOCKS_LOCAL_BROWSER_PROBE` unset. This fixed case exercises BUY/SELL × APPROVAL/TRANSFER recovery through native Chrome HTTP and the existing production submission adapter against real PostgreSQL/EVM. Original transactions still start at production UI buttons. Recovery calls are explicitly initiated by a test probe; this does **not** implement a production recovery screen.

The local-only `Next login: 30s JWT` control arms exactly one successful holder login. Real SIWE is verified by the unchanged server first. Only then does the explicitly enabled test fixture replace that successful response's token with a newly signed 30-second JWT using the same ephemeral local secret, preserving owner/domain/chain, and reduce `expiresIn` to 30. The original signed token lifetime in production remains 900 seconds. Failed verification does not consume the arm; ordinary and subsequent logins remain unchanged. The control is refused in the default browser mode and never accepts a custom lifetime. This is genuine server JWT expiry in a bounded fixture, distinct from the original jsdom browser-lease-only restriction.

The case waits for actual JWT expiry and the unchanged original 60-second order deadline. No fake clock, chain time manipulation, order-deadline rewrite, injected receipt, fabricated business state or automatic wallet retry is used. It checks expired-token 401, same-owner renewed SIWE, wrong-owner 404, binding/hash conflicts, missing hash, explicit inspect/record/reconcile, immutable trusted proof, idempotence and restart/read without new permission. Processing is temporarily stopped to preserve the order for comparison; configured trading pause is covered separately in the PostgreSQL suite. A known hash in this test comes from the actual original wallet return and is supplied explicitly to the probe, never inferred from a missing response.

Expected final holdings are 2.25 NVDA, holder cash 1,730, vault cash 270, escrow zero, eight original holder sends and eight claims. Four recovered claims have actual trusted receipt proofs. The driver reports 28 assertion groups and saves `recovery-portfolio-desktop.png` / `recovery-portfolio-mobile.png`. Accept a run only with its PASS result, cleanup records and exit 0.

Run the new fixture unit check with `node --test scripts/stocks-local/short-session.test.mjs`. The lifecycle checker explicitly clears `STOCKS_LOCAL_BROWSER_CASE` in its children, so those three probes continue to validate the ordinary browser lifecycle independently. [003D evidence](../../docs/evidence/giwa-stocks-known-hash-003d-20260918.md) records exact results and [the Claude implementation task](../../docs/tasks/giwa-stocks-known-hash-ui-003d-20260918.md) defines the remaining UI work.

A second owned browser origin attempts API reads, bootstrap reads and wallet writes, including a wallet request with the correct bridge capability. This checks local browser CORS and bridge rejection; it does not certify deployed-domain CORS. The real-time evidence/session/quote-expiry scenario from jsdom is **not rerun in Chrome**. The original 60-second quote and 15-second execution-evidence limits remain unchanged. Dynamic, wallet extensions, physical wallets, public RPCs and public-network finality/timing remain unverified. The broker is still the fixed-price durable mock, not a real securities venue.

Browser evidence is written to the explicitly selected directory: `result.json`, `portfolio-desktop.png`, `portfolio-mobile.png`, and `failure.png` when failure capture is possible. The browser result alone is insufficient: require successful resource-cleanup records and the expected process exit as well.

## 003D product recovery buttons

Use `STOCKS_LOCAL_BROWSER_CASE=known-hash-ui` with the Chrome command and a fresh evidence directory to validate the implemented recovery UI. The earlier `known-hash` adapter probe remains available separately. Both use the same explicit short-session fixture and disposable PostgreSQL/EVM stack.

The new case waits for actual 30-second signed JWT expiry and the original 60-second quote deadline in all four BUY/SELL × APPROVAL/TRANSFER combinations. The original wallet response populates the product's in-memory candidate. The browser stays in the same tab through API restart, sign-in and A→B→A account isolation; no hash, session or store data is injected into the page. SELL TRANSFER additionally returns the old wallet answer after a renewed login.

The 003D-1 acceptance also interrupts the first BUY APPROVAL inspect. KEPT must retain the uncertainty message and permit only an explicit Check again, with no database write or wallet call. In all four combinations, a later RECORDED + failed receipt check must say that the stage's hash remains recorded, never that recording is uncertain. These assertions distinguish the corrected copy from the previous contradictory card. The case now has 31 assertion groups.

Recovery uses the actual **Record this hash** and **Check the receipt again** buttons, each double-activated. A one-time browser network fault aborts the first reconcile request before server dispatch, after the real outcome write succeeds. The card remains RECORDED, no background retry occurs, and only the explicit receipt button obtains the real EVM receipt/proof. This checks recovery from an interrupted request, not naturally delayed public-chain finality. Each case requires two inspect requests, one outcome write, two attempted reconcile requests (one dispatched), zero new claims and zero wallet calls of any kind during recovery. All requests must use the renewed session; credentials are compared in test memory and never written to evidence.

After recovery, API restart and page reload must lose the tab card but preserve the actual PostgreSQL claim and trusted proof. Repeating the original claim grants no new permission; an expired approval-only order cannot obtain a new transfer claim. The real observer/worker subsequently completes the transfer orders. Expected final balances remain 2.25 NVDA, holder cash 1,730, vault cash 270 and escrow zero, with eight original sends matched to eight claims.

Pending-card and portfolio screenshots cover desktop and 375px width. The default Chrome scenario also explicitly asserts that a hashless UNKNOWN and later observer completion do not manufacture a recovery card. Acceptance still requires PASS, successful cleanup markers and exit 0. No production server, contract, authentication lifetime or quote deadline is changed by this test.

## Browser bridge boundary (test only)

Unlike the in-process jsdom wallet, Chrome uses a narrow local HTTP bridge. All assets and bridge routes require the exact `127.0.0.1:port` Host. The bootstrap config requires same-origin browser fetch metadata and returns a random in-memory capability with no-store/nosniff headers. Vite's broad CORS is disabled, its product config is not loaded, and its env directory is an empty owned directory. Wallet/control/finish POSTs require the exact Origin, same-origin fetch metadata, the capability header and JSON content type; bodies are size-limited and checked for exact fields. The capability is never put in a URL or log. A state read requires the capability and same-origin checks and returns only test counters/account and a read-only summary, not sessions or signatures.

The wallet route permits only the existing local-wallet methods: account/chain/checkpoint reads, the reviewed allowance read, SIWE signing, and exact reviewed approval/deposit/escrow transactions. The local wallet still enforces the active A/B account, contracts, calldata and single-send/no-retry behavior. It cannot expose arbitrary RPC, operator signing, key export or a production signer. Controls are limited to A/B selection, holding/releasing/dropping one response, pausing/resuming processing and restarting the API; they cannot change order state, expiry or chain time. Finish only reports test completion. Bodies, authentication headers, signatures and tokens are not logged.

Closing first fences new dispatch and closes the wallet, releasing held HTTP work before bounded draining and development-server shutdown. The bridge is an additional test-only surface, not a supported product API.

## Safety and lifetime

The in-process test wallet accepts only two local holder accounts, exact transaction keys, the reviewed contracts/ABI and this SIWE origin. The jsdom UI calls this wallet in process without an HTTP wallet bridge; the backend-only scenario drives its test transactions directly. Those modes still use the separate local settlement-signer HTTP fixture. Chrome adds the guarded holder-wallet bridge described above. It uses one raw `eth_sendTransaction` with no async preflight, extra gas/nonce fields, fallback or retry. A held/lost response occurs after the local node has accepted the original transaction.

Only the executable owns signal handlers. UI callbacks/wallet, API, runtime and signer close before the owned database/EVM. `runtime.stop()` precedes draining an active tick so close cannot start later worker iterations. An intentional processing pause is reversible and is distinct from closing the stack.

On success the runner removes its temporary directory. On failure or signal it retains diagnostics and prints the owned directory; existing user services are never discovered or stopped. `LOCAL_UI_OWNED_SERVICES_STOPPED` reports owned process-group/socket/PID-file cleanup after completion. Default Hardhat private-key output is disabled.

Run the wallet/bridge unit checks and the original jsdom lifecycle checker:

```sh
node --test scripts/stocks-local/browser-server.test.mjs scripts/stocks-local/local-wallet.test.mjs
TMPDIR=/private/tmp STOCKS_LOCAL_STACK_ONLY=1 \
STOCKS_PG_BIN=/absolute/postgresql/bin \
STOCKS_LOCAL_UI_DOM_RUNTIME=/absolute/existing/jsdom/package.json \
node scripts/stocks-local/ui-lifecycle-check.mjs
```

The jsdom lifecycle checker starts its own child runners and verifies ready-phase SIGINT, active-phase SIGTERM and intentional failure: expected exit code, closed API/RPC ports, absent EVM process group, stopped PostgreSQL and removed socket. Its failure probe is an explicit test-only path; it never changes production behavior.

Each `STOCKS_LOCAL_UI_STEP` line is a completed assertion group. The final JSON contains the evidence and `result: PASS`; the subsequent cleanup record and exit0 must also be present to consider the normal run successful. A PASS report printed before failed cleanup is not an accepted run.

The Chrome lifecycle checker defines three separate disposable cases: ready-phase SIGINT, held-response SIGTERM, and intentional startup/scenario failure. It verifies the expected exit and closed Chrome/bridge/API/RPC, EVM process group and PostgreSQL resources. Lifecycle verification must be accepted from its own final logs; a successful interactive scenario does not imply these checks passed. Use a separate evidence directory so lifecycle runs do not overwrite the normal browser evidence:

```sh
TMPDIR=/private/tmp \
STOCKS_LOCAL_STACK_ONLY=1 \
STOCKS_PG_BIN=/absolute/postgresql/bin \
STOCKS_LOCAL_BROWSER_RUNTIME=/absolute/existing/playwright/package.json \
STOCKS_LOCAL_CHROME=/absolute/installed/chrome-executable \
STOCKS_LOCAL_BROWSER_EVIDENCE=/private/tmp/stocks-browser-lifecycle-evidence \
node scripts/stocks-local/browser-lifecycle-check.mjs
```

The checker selects its fixed probe/mode internally and writes per-case lifecycle logs/JSON. It does not stop unrelated Chrome, database or node processes. The Chrome runner additionally reports `LOCAL_BROWSER_RESOURCES_STOPPED`; the shared runner reports the owned database/EVM cleanup separately.

## Operator submission diagnostics (003E)

Use `STOCKS_LOCAL_BROWSER_CASE=operator-diagnostics` with the existing explicit
Chrome command and a new evidence directory. The ordinary investor browser flow
runs first, including its seven original wallet sends and claim-before-send proof.
Only then does the additional `/admin/stocks` scenario prepare local diagnostic
records and sign in through real SIWE as the configured `stocks:read` operator.

The test-only operator account appears in the local control bar only for this
case. The wallet bridge permits its account/chain reads and origin-bound SIWE
message, and rejects its transaction or contract-call requests. It grants no
product permission: the unchanged server operator resolver decides access.

The 24 diagnostic examples include BUY/SELL, both journal stages, empty stages,
all five submission statuses, trusted CONFIRMED/REVERTED receipts, and expired
NOT_ENROLLED orders. Original completed orders come from the preceding investor
buttons. New fixture orders and journal records use production services; ten
additional local transactions create actual receipt evidence, including mined
out-of-gas failures. Those ten setup transactions are not investor UI sends.
Historical unenrolled and foreign-deployment orders are explicit new isolated DB
fixtures, not fabricated business completions or rewritten existing orders.

The actual admin buttons display the real API/service/PostgreSQL snapshots. The
scenario checks native Enter/Space refresh, three viewport widths, a real foreign
order 404, interrupted reads, cancellation on order selection, and regular-user
admin denial. It compares every Stocks table, signer operations, chain head,
balances and nonces before and after the read interval. Both browser wallet
request attempts and forwarded wallet calls/sends must stay zero, and API reads
must carry no body and make no mutation request. The mandatory SIWE login happens
before that interval and is counted separately.

The final runtime stop test proves reads remain available while new execution is
blocked by STOPPED, including expired orders. It does not claim a live
`configuredPause: true` transition. The held-request test proves cancellation on
selection, while delayed-response overwrite protection is tested separately by
DOM/store regressions. Error404 retained-snapshot wording is recorded as an
explicit known P3 finding until the Claude copy follow-up is accepted. A passing
functional run with that finding reports `PASS_WITH_KNOWN_P3` for diagnostics.
This is local Chrome/PG/EVM evidence, not public-network or physical-wallet proof.
