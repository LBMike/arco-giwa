# Disposable Stocks local verification

Both modes own a fresh Unix-socket PostgreSQL database, apply existing migrations, create an unforked loopback Hardhat chain, and deploy only the local test contracts. They do not load `.env`, production registries, keystores, existing databases or public RPCs. The numeric chain ID is 91342, but the deployment/checkpoint identifies a new disposable local chain.

Existing backend-only mode remains:

```sh
npm run build:server
STOCKS_LOCAL_STACK_ONLY=1 STOCKS_PG_BIN=/absolute/postgresql/bin node scripts/stocks-local/run.mjs
```

The new UI mode mounts the production `/stocks` React routes, host, controller, wallet ports and submission gate under StrictMode in **jsdom**. The page uses native HTTP, real SIWE signatures from local unlocked test accounts, the real API/runtime, PostgreSQL and EVM receipts. It does not open Chrome, use a wallet extension, or provide a persistent browser demo server.

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

## What the UI scenario proves

1. Real nonce/SIWE login, UI quote/order creation, exact approval, separate deposit, native observer/worker processing and issuance for BUY 2 NVDA.
2. Double activation sends once; stopping processing, restarting the API on the same port and remounting the page recovers the same journal hash without another wallet request. This is an HTTP application restart, not a PostgreSQL or Node-process restart.
3. SELL 0.5 NVDA through approval and escrow, followed by actual burn/test-cash payout. UI holdings and chain quantity become 1.5.
4. An open BUY approval followed by account A→B hides A's order/hash on B's first render. The valid original session records the late answer; A's new login/check reads that same claim without resending.
5. SELL 0.25 escrow succeeds on chain but its wallet response is deliberately lost. The UI records UNKNOWN without a hash. The real observer independently sees the escrow, completes the order and updates holdings to 1.25. The instrumentation's hash is never injected into the UI or a recovery endpoint.
6. A held approval outlives the real evidence interval, a shortened **browser** session and the original 60-second quote deadline. No clock is advanced or reset and no deadline is edited. Only the test authentication response's `expiresIn` is restricted to 30 seconds; the signed server JWT remains 900 seconds. This case proves browser-gate expiry, not server JWT expiry. Existing separate PostgreSQL/JWT tests cover the latter.
7. Every holder RPC send is matched to the exact committed claim transaction and a successful claim response with an earlier trace sequence. Actual node transactions supply chain ID, calldata, account and distinct nonces. Faucet/operator sends are separate from the eight UI wallet attempts.
8. Final holder stock/supply 1.25, escrow zero, holder test cash 1,850 and vault test cash 150 agree with server reconciliation at its common cutoff. Deliberately unpaid BUY orders remain unpaid; the test does not manufacture completed states.

The standard broker remains a durable mock at fixed NVDA price 120 ARCO_TEST_USDC. Market-data endpoints are not configured, and their explicit unavailable UI is expected. This run does not certify real shares, public-network timing, Dynamic, a physical wallet, browser CORS enforcement or layout/accessibility.

## Safety and lifetime

The in-process test wallet accepts only two local holder accounts, exact transaction keys, the reviewed contracts/ABI and this SIWE origin. It exposes no HTTP signing endpoint. It uses one raw `eth_sendTransaction` with no async preflight, extra gas/nonce fields, fallback or retry. A held/lost response occurs after the local node has accepted the original transaction.

Only the executable owns signal handlers. UI callbacks/wallet, API, runtime and signer close before the owned database/EVM. `runtime.stop()` precedes draining an active tick so close cannot start later worker iterations. An intentional processing pause is reversible and is distinct from closing the stack.

On success the runner removes its temporary directory. On failure or signal it retains diagnostics and prints the owned directory; existing user services are never discovered or stopped. `LOCAL_UI_OWNED_SERVICES_STOPPED` reports owned process-group/socket/PID-file cleanup after completion. Default Hardhat private-key output is disabled.

Run the bounded checks:

```sh
node --test scripts/stocks-local/local-wallet.test.mjs
TMPDIR=/private/tmp STOCKS_LOCAL_STACK_ONLY=1 \
STOCKS_PG_BIN=/absolute/postgresql/bin \
STOCKS_LOCAL_UI_DOM_RUNTIME=/absolute/existing/jsdom/package.json \
node scripts/stocks-local/ui-lifecycle-check.mjs
```

The lifecycle checker starts its own child runners and verifies ready-phase SIGINT, active-phase SIGTERM and intentional failure: expected exit code, closed API/RPC ports, absent EVM process group, stopped PostgreSQL and removed socket. Its failure probe is an explicit test-only path; it never changes production behavior.

Each `STOCKS_LOCAL_UI_STEP` line is a completed assertion group. The final JSON contains the evidence and `result: PASS`; the subsequent cleanup record and exit0 must also be present to consider the normal run successful. A PASS report printed before failed cleanup is not an accepted run.
