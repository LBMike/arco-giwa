# GIWA-STOCKS-WALLET-HOST-INTEGRATION-003B — active wallet port, execution host, `/stocks` panel, common API base

This plan was recorded before any code change. It is a local builder candidate: no push, merge, deployment, wallet signature, transfer or public network. Offline fakes and in-process server code only. It is not public-network trading completion.

## Bases and roles

| Item | Value |
| --- | --- |
| Base | `/private/tmp/arco-giwa-wallet-hardening-20260917`, branch `codex/giwa-wallet-hardening-20260917`, exact `b27b2592cb031e356eff8bfa497c161eb08ec596` (003A-1, Codex-accepted; includes backend `dc43e75` and Claude 003A). Not merged with anything else |
| Work clone | `/private/tmp/arco-giwa-wallet-host-integration-20260917`, branch `codex/giwa-wallet-host-integration-20260917` (new path; push URL disabled) |
| Untouched | the base checkout, Codex review clones (`…-root-review-…`, `…-locale-review-…`, `…-combined-review-…`), the original 003A/backend checkouts |
| Commander | user / conductor (003B prompt) |
| Builder | Claude Code, session `local_adcc4340-7e91-44cb-a754-5453f2af4e11`, conversation `beb6fdbb-2740-48ec-948b-f6ffddadbd9f`, `claude-opus-5`. Sub-builders are sub-agents of the same builder session, each in its own clone; they are builder-side, not reviewers |
| Independent reviewer | Codex (separate). Builder-side checks are not independent review |

Environment (untracked):
- `node_modules` is a symlink to `/private/tmp/arco-giwa-preflight-20260917/node_modules` (byte-identical lockfile).
- `packages/contracts/artifacts` is copied from the base checkout.
- DOM runtime `GIWA_HOST_DOM_RUNTIME=/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json`.
- ABI artifacts `GIWA_STOCKS_ARTIFACTS=<clone>/packages/contracts/artifacts/stocks`.
- Node v24.14.0 only. CI uses Node 22 (`.github/workflows/ci.yml`), which is not installed locally.

Read before planning:
- `CLAUDE.md`
- `docs/contracts/stocks-execution-v1.md`, `stocks-wallet-submissions-v1.md`, `stocks-order-recovery-v1.md`
- task/evidence docs for 003A and 003A-1
- READMEs of `stocks-wallet`, `stocks-wallet-http`, `stocks-wallet-submissions`, `stocks-wallet-ui`, `stocks-host`
- Codex `review-results/20260917/wallet-hardening-003a1-review.md`
- `/private/tmp/arco-giwa-wallet-hardening-locale-review-evidence-20260917/README.md` (URL boundary probe)
- A read-only research pass over the server gate, viem 2.53.1 request internals, the Dynamic/wagmi client, checkpoint semantics and the DOM harnesses. Its findings are summarized below

## Findings that shape the design

1. **Checkpoint attestation.** The server's own RPC port verifies a network with `eth_chainId` plus `eth_getBlockByNumber(<checkpointNumber hex>, false)` and compares the block hash with `manifest.checkpointHash` (`server/src/stocks/rpc.ts:14-24`). `networkInstance` is a reviewed label that the checkpoint binds to chain history; it cannot be read from the chain. The browser port does the same through the wallet source.
2. **viem `sendTransaction` is not a single request.** It calls `eth_chainId` first, and after `-32000/-32602/-32601/-32004` it sends `wallet_sendTransaction`. `client.request` retries codes -1, -32603, -32005, 429 and code-less errors up to 3 times. For a `custom(provider)` transport, `client.transport.request` is `provider.request.bind(provider)` with no retry.
3. **The Dynamic/wagmi client has no single-attempt raw request.** `useWalletClient().data` is Dynamic's connector client: `custom(EthereumWallet client)` over `interceptTransport(custom(...))` over the connector transport. Each layer has default retries, and the app configures no `httpTransportConfig`. A research probe measured 16 `eth_sendTransaction` attempts through `transport.request` for one -32603. The embedded wallet additionally prepares, signs and sends `eth_sendRawTransaction` over HTTP with retries. With the current `providers.tsx`, no captured Dynamic object offers a raw single-attempt request. Per the prompt ("그 capability가 없으면 사용 불가"), **Dynamic mode is reported unavailable for execution**, with zero wallet requests and no fallback to `window.ethereum`. Enabling it needs a provider configuration decision (003B follow-up, outside this change).
4. **Injected mode** has a raw EIP-1193 provider (`window.ethereum`). The port captures that object and its `request` at owner creation. `walletClient()` creates a new viem wrapper on every call, so wrapper identity is never used as an epoch.
5. **No stateful in-memory server exists.** The real submission service is SQL (`FOR UPDATE`, advisory locks, `ON CONFLICT DO NOTHING`), and its real test uses PostgreSQL. The existing roundtrip test drops request bodies and covers reads only. The investor fixture server's rows fail the wallet planner (orderKey, deploymentDigest).
6. **Investor order objects are replaced** on every refresh (`refreshAttemptOrder`, `refreshSelectedOrder`). The wallet controller's display scope digests the whole selection, so the host must pin the first row.
7. **wallet-ui static guards** forbid wallet/transport/controller creation inside `stocks-wallet-ui` feature files, so the host composition lives in a new module.
8. **DOM tests** written as `.tsx` must install jsdom globals before importing `react-dom` (text input otherwise never fires).

## Owned files

New modules:
- `src/demo/giwa/stocks-wallet-source/`: active wallet source capture and the three wallet ports (pure, injectable) + product bridge + tests + README.
- `src/demo/giwa/stocks-execution-host/`: React-free execution owner and registry, the page-level React provider and order slot, test-only in-process server harness under `testing/`, full-stack and DOM tests, offline browser verification page under `verification/`, README.
- `src/demo/giwa/api-base.ts` (+ test): the common API base check.

Existing files (minimal, as allowed by the prompt):
- `src/demo/giwa/contracts.ts`: a read-only accessor of the active wallet source (type + function). Existing `walletClient()` and transaction behaviour unchanged.
- `src/demo/giwa/wallet.tsx`: expose the captured active source object (injected provider / Dynamic client) with the existing `sessionEpoch`.
- `stocks-host`: `StocksHostProvider` exposes the host wallet view (address, chain, epoch, source); `GiwaStocksHost` passes the source; `session.ts` uses the common API base check. Tests adjusted.
- `stocks-investor`: `client.ts` base check; an optional execution slot prop through `GiwaStocksFeature` → `StocksViews`/`TradePanel` → next to `OrderStatusCard`; `OrderStatusCard` funding/escrow copy follows the slot's capability. Tests adjusted.
- `stocks-market`: `client.ts` base check; `StocksPages.tsx` resolves one API base for every client and mounts the execution provider; Korean header copy follows capability.
- `stocks-admin/client.ts`: base check before any authenticated request.
- `stocks-wallet-ui`: `adapter.ts`/`StocksWalletExecutionPanel.tsx`/`model.ts`/`messages.ts` accept an explicit host evidence refresh for the read-only check; tests and README.
- `stocks-wallet/README.md`, `stocks-wallet-http/README.md`: the receipt port's actual (unused) status and the host composition.
- `docs/tasks/giwa-wallet-host-integration-20260917.md`, `docs/evidence/giwa-wallet-host-integration-20260917.md`.

Not changed: server, DB schema, Solidity, deployment registry, dependencies/lockfile, runtime/ops configuration (`providers.tsx`, `config.ts`, `vite.config.ts`), router definitions, the wallet controller/planner/submission client logic.

## 1. Active wallet ports (`stocks-wallet-source`)

- `captureWalletSource(snapshot)` takes the host's render-time wallet view: mode, source object, address, chain, `sessionEpoch`.
  - **Injected:** captures the provider object and `request` bound to it. It subscribes to `accountsChanged`/`chainChanged`/`disconnect`; subscribing issues no request. Any event marks the capture stale.
  - `isCurrent()` is synchronous: not disposed, no event seen, the module's active source still reports the same mode and provider object.
  - **Dynamic:** unavailable (`WALLET_SOURCE_UNSUPPORTED`), whether or not a client exists. `window.ethereum` is never read in Dynamic mode.
  - A missing provider or address is unavailable.
- `createWalletSourcePorts({ source, deployment })`, where `deployment()` is the current context's reviewed deployment:
  - **`readWallet()`:**
    1. `eth_chainId` must be the canonical quantity 91342.
    2. `eth_accounts[0]` is a valid non-zero address.
    3. `eth_getBlockByNumber([hex(checkpointNumber), false])`: the object's `number` must equal the request and its `hash` must be a lowercase 32-byte hash equal to `manifest.checkpointHash`.
    4. `eth_chainId` and `eth_accounts` again, plus a synchronous `isCurrent()` and manifest-digest re-check.
    - Returns the attested identity and records the attestation for this capture and digest.
    - Codes: `WALLET_NETWORK_INSTANCE_MISMATCH` (other chain, missing or other checkpoint), `WALLET_CHANGED` (account, source or epoch), `INVALID_RESPONSE`, `REQUEST_FAILED` (provider errors). Nothing from the provider is surfaced raw.
  - **`readAllowance(request)`:**
    - token/spender must be the reviewed pair (BUY cash→fundingVault, SELL stock→redemptionEscrow); owner must be the captured account.
    - The same chain, account and checkpoint checks run before `eth_call [{to, data: allowance(owner, spender)}, "latest"]`.
    - The result must be exactly 32-byte hex and is returned as a decimal string.
    - The checks, `isCurrent()` and the abort signal are re-checked after the call. No other endpoint, no fallback, no retry.
  - **`requestTransaction(tx)`:** a non-async function.
    - Synchronous checks: exact keys, chain 91342, `value "0"`, `from` = captured account = last attested account, `to` ∈ reviewed token/spender, hex data, `isCurrent()`, a prior attestation for this capture and digest.
    - Then, with no await in between, **one** `request({ method: "eth_sendTransaction", params: [{ from, to, data, value: "0x0" }] })`.
    - The provider's promise is returned unchanged. A late hash is not post-checked away; the controller records it through the original gate and decides whether to paint it.
    - No `wallet_sendTransaction`, `eth_sendRawTransaction`, gas, nonce, chain switch or retry.
  - **`waitApprovalReceipt`:** an explicit inactive port that rejects with `RECEIPT_PORT_INACTIVE` and touches nothing. The controller does not call it; approval confirmation stays with the server gate's `reconcile`.
- The last await before dispatch is the controller's final `wallet()` read, followed by its synchronous policy/authority checks. The port adds no await, so no dispatch-time callback or controller type change is needed.

## 2. Execution host (`stocks-execution-host`)

- **Owner scope:** one registry per identity (host session id, wallet address, chain, wallet epoch, captured source, API base), created in a layout effect and disposed in its cleanup (StrictMode safe: a disposed registry is never read). Per accepted order (`side:orderId`), one owner holds:
  - `createExecutionClock()` + one `monotonicNow`, shared by the reads, the gate and the controller
  - `createStocksExecutionReads`, `createSubmissionGate` bound to session/side/order/deployment/API base
  - the wallet ports, the `WalletPorts` object and `createStocksWalletController(ports)`
  - Owners are not recreated on render, tick, order refresh or evidence renewal.
- **`context()`** synchronously returns the live host view:
  - session: only the owner's session while it is still the host's current, unexpired session
  - wallet address/chain/epoch and the API base
  - `reads.currentDeployment(lease)`
- **Evidence:** read only by the explicit check.
  - The panel's check first calls the owner's `refreshEvidence()`: one in-flight read with the session captured at start. The lease is accepted only if the owner is live, the lease's session/API match and its manifest digest equals the order's.
  - The read never retries, polls or runs on a timer, so it cannot cancel a preflight in a loop. Open prompts and warnings are preserved by the controller (003A-1).
- **401:** `invalidateSession`, the reads' and the gate's `onSessionRejected` call `host.invalidate(capturedId)` only.
- **Session expiry or logout:** the identity changes, so the registry is disposed. A late hash still goes to the original gate, which may refuse it when the session expired. The new screen never shows the previous account's attempt. Copy says to sign in again and check the order instead of repeating the transfer.
- **Pinned selection:** the owner stores the first accepted/selected row for `side:orderId`. Later investor rows go to `serverOrder` only; selecting another order uses another owner.
- **Panel:** `StocksWalletExecutionPanel` receives the owner's controller and ports, the pinned selection, `serverOrder` from the latest investor row, the refresh action, and the owner's `refreshEvidence`. Amounts and addresses come from the validated plan (unchanged panel).
- **Capabilities:** a Dynamic source, missing source, missing API base or signed-out host shows why execution is unavailable. No success is pretended.

## 3. `/stocks` page

- `StocksPages.tsx` resolves the API base once with the common check and passes it to market, investor, admin and the execution provider.
- The execution slot is rendered only for the signed-in wallet's own orders: the accepted order card in the trade panel, and a selected order in the Orders tab. BUY and SELL, NVDA/ARCO_TEST_USDC only; market symbols never become NVDA.
- `OrderStatusCard` keeps its server status and deadline warnings. When a slot is present, "not available in this app yet" is replaced with the explicit wallet steps.
- The Korean header describes the actual capability.

## 4. Common API base (`api-base.ts`)

- Rules: http(s) only; no username/password; the normalized `href` contains no `?` or `#` (even empty); trailing slashes removed; path prefix and percent-encoding kept.
- A relative base is resolved against the frontend origin only where the host already allowed it (`stocks-host/session.ts`) and in `StocksPages.tsx` before one base is supplied to every client.
- Applied to `stocks-host/session.ts`, `stocks-investor/client.ts`, `stocks-market/client.ts`, `stocks-admin/client.ts` (the admin check runs before any request that carries a token).
- Fixed error codes, zero requests, raw URL/token never in the error.

## Verification plan

Failure first on `b27b259` with normal expectations:
- **API base:** each of the four clients with bare/valued `?`/`#`, credentials and schemes (Codex probe ported).
- **Wallet ports:** they do not exist yet (recorded as the absent capability).
- **Panel:** `/stocks` shows "지갑 연결 준비 중" and no execution slot.

Tests (fake EIP-1193 provider, Dynamic-shaped clients, fake HTTP, in-process server via `app.inject`):
- **Port unit tests:**
  - exact methods and params
  - one `eth_sendTransaction`; zero `wallet_sendTransaction`/`eth_sendRawTransaction`
  - no await before send; dispatch refused after events
  - checkpoint and chain mismatches, same-chain other network, malformed answers
  - allowance swap/abort/malformed
  - late hash returned
  - 4001/-32603/hang/invalid hash
  - Dynamic unavailable with no `window.ethereum` use
- **Full stack:**
  - real controller, reads, submission client, wallet ports
  - real server plugins (Stocks, execution, submissions with the real receipt verifier over the real RPC port) over a stateful in-memory SQL fake, with a fake chain shared with the fake provider
  - BUY/SELL: check → exact approval → server reconcile → separate deposit/escrow, with exact request counts
  - source swap, A→B→A, other checkpoint, same-chainId other network, allowance-time swap
  - evidence/policy/session expiry during the prompt; 4 s policy with 6 s internal check and 15 s evidence → 0 sends
  - late 401/hash, cancel, remount, refresh, UNKNOWN/REVERTED claims
- **DOM (real `/stocks` routes, StrictMode):**
  - accept a new order; select an order
  - server status refresh; evidence acquisition
  - every button explicit; double click and keyboard repeat
  - warnings preserved
  - host/investor/admin regressions
- **Regression suites:** Savings/Funds wallet paths (`phase5`, `wallet-bridge`, provider DOM, SSR/component tests).
- **Browser:** the offline verification page in the in-app browser (states, narrow width, keyboard). It is separate from the product runtime and never a fallback.
- **Checks:**
  - typecheck, build
  - `test:frontend` with DOM + artifacts, and CI-like
  - `test:server`, `test:security`
  - design tokens/stories, whitespace
- **Reference baseline:** frontend 558/558, server 330 pass / 68 DB skip, 7 token findings.
- Locale golden: already verified on Node 24 (en/cs/sk) and Chrome 152 (ko). Node 22 is not available locally; recorded as unverified.

## Changes after planning (recorded at completion)

- **Streams:** implementation ran as five builder-side streams in separate clones (wallet-source, api-base, harness, browser-fixture, page-dom) plus the host/panel/page work in this clone. Each was merged with `--no-ff`.
- **Owner selection:** the owner selects its pinned order on creation, so the controller never starts without a selection.
- **Builder browser check:**
  - The verification page gained the `.arco-demo` theme scope.
  - Two product timing findings were recorded for decision: the 60 s quote vs. finalized approval confirmation, and the short evidence window.
- **Builder-side review:** 18 findings, none P0/P1. Resolved:
  - latest-read attestation
  - abort before `eth_call`
  - failed evidence drops the lease
  - Dynamic unsupported before sign-in
  - restart eligibility
  - session notice clearing
  - neutral card copy
  - evidence-failure notes
  - missing tests (captured-session 401, other manifest, chain identity, invalid hash)
  - README session-end wording
- **Kept as a documented limit:** a synchronous port refusal is recorded as UNKNOWN (controller-owned).
- Details: `docs/evidence/giwa-wallet-host-integration-20260917.md`.

## 003B-1 — session-end notice and documentation corrections (plan, recorded before code)

Follow-up to Codex's independent review of `eda0bc0` (`review-results/20260918/wallet-host-003b-review.md`: core wiring accepted; one P3 copy finding and P3 documentation corrections).

| Item | Value |
| --- | --- |
| Base | `/private/tmp/arco-giwa-wallet-host-integration-20260917` @ `eda0bc02bfa61fc72f4bb9305dbcf0255c4c3faa` (feature base `b27b259`) |
| Work clone / branch | `/private/tmp/arco-giwa-wallet-host-copy-20260918`, `codex/giwa-wallet-host-copy-20260918` (new path; push URL disabled) |
| Untouched | the 003B checkout and the Codex review clones and evidence directories (their probes are read, not edited) |
| Commander | user / conductor (003B-1 prompt) |
| Builder | Claude Code, same session as 003B, `claude-opus-5` |
| Independent reviewer | Codex (separate) |

**Finding.** `StocksExecutionSessionNotice` says a late wallet answer "may not be recorded until that check". A check never records it:
- If the session expired by time during an open prompt, the original gate refuses the late hash before any HTTP request.
- A later session's check reads the server journal: the reserved claim is still `REQUEST_MAY_START` with no hash, so the panel shows UNKNOWN without a hash.
- The browser never carries the old hash into the new session, and no outcome is posted for it.

**Owned changes:**
1. `stocks-execution-host/StocksExecutionProvider.tsx`: notice copy only. It will say:
   - a late answer may stay unrecorded even if the transaction was sent;
   - a check only shows what the server already recorded and cannot add a request it never received;
   - when the result is unknown, nothing is sent again from any app or wallet, and operations must confirm it.

   It will offer no button or URL, name no order, amount or hash, and keep the same-wallet-only and clearing rules.
2. `stocks-execution-host/page.dom.test.tsx`: the notice constant, plus new BUY and SELL scenarios on the real `/stocks` route (host, provider, panel, controller, reads, gate, ports) against the in-process real server plugins. Each scenario:
   - uses a 30 s session and holds the approval prompt;
   - expires the session by time and checks the notice;
   - releases the hash: 0 outcomes, claim `REQUEST_MAY_START` without hash, hash not painted;
   - signs in again and checks: UNKNOWN with no hash, 0 outcomes, 1 claim, still 1 wallet send;
   - counts wallet sends after mount, sign-in, check, approval, second sign-in and second check;
   - asserts what the copy means (no promise of recovery by checking, do-not-resend and operations guidance), not only that one string is gone.

   Failure first: the new scenarios run against the current copy before it changes.
3. `docs/evidence/giwa-wallet-host-integration-20260917.md`, `stocks-execution-host/README.md`, this file:
   - **Late-hash recovery.** The backend already supports a new, valid, same-owner session doing `inspect → outcomes → reconcile` for a known hash on the original immutable claim, including after quote expiry or pause, without granting a new send or claim. What is missing is the browser carrying the originally known hash into an explicit recovery flow in the new session (not built here). A hash the application never knew cannot be restored by a check or a claim.
   - **Quote deadline vs. finality.** Only the verified condition is stated: when approval finality arrives after the remaining deadline, the next send is refused. Public-network finality was not measured.
   - **Two separate cases.** A synchronous source change inside a SIGNING subscriber (before the provider call: 0 sends) is kept distinct from a change after the provider request is open (1 send, late hash).

**Not changed:** server, DB, Solidity, deployments, dependencies, wallet send logic, controller, session authority, order deadlines. No recovery UI, automatic recording or retry; no Dynamic work.

**Checks:**
- focused DOM, registry and full-stack runs;
- typecheck, build;
- `test:frontend` with DOM + `GIWA_STOCKS_ARTIFACTS`, and CI-like;
- `test:server`, `test:security`, design tokens/stories, `git diff --check`.

Baseline at `eda0bc0`: frontend 661, server 330 pass / 68 DB skip, 7 token findings.
