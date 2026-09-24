# GIWA-DEMO-TRADES-003 delivery evidence

Base562d0e3; commander/builder root; branch codex/giwa-demo-trades-003; /private/tmp/arco-giwa-demo-trades-003. User requested continued GIWA demo development. No backend API/schema/contract/dependency changes.

## Delivered

The existing customer gateway now supports an explicit `tradesEnabled` / `--customer-trades` option, default off and requiring customer authentication. It forwards only the existing investor quote/order/recover, execution proof/policy and wallet-submission inspect/claim/outcome/reconcile routes to the fixed https://arco-giwa-api.onrender.com API. Exact origin, Bearer shape, method/path, bounded JSON and allowed-field checks precede forwarding. Values, original order keys, digests and hashes are preserved; the backend still owns authorization, monetary/state validation and receipt verification. No retry, new operation ID, cookie, redirect, arbitrary upstream, administrator/faucet route, signing or broadcasting RPC was added.

Lost responses/timeouts retain an uncertain result in the existing investor client. They never claim the server rejected an order or automatically create another order. Client-submitted CONFIRMED/REVERTED outcomes are blocked. Existing read/auth mode remains unchanged.

Three runtime files were applied to the existing UI4392 workspace with matching preimage/postimage hashes: gateway.ts, new trading-routes.ts and the preview serve.ts startup flags. The patch preserves existing SSE/live-market/user UI edits. Target typecheck passed. Packet: /private/tmp/giwa-trades-003-ui4392.patch and /private/tmp/giwa-trades-003-ui4392-hashes.json. The current4392 process was not restarted and no `--customer-trades` flag was enabled. The new transport will be loaded on a future approved restart; it is not an active public trading service. Browser still shows the canonical Portfolio and wallet connection prompt.

## Real local trade evidence

Command: `TMPDIR=/private/tmp STOCKS_PG_BIN=/opt/homebrew/Cellar/postgresql@18/18.6/bin STOCKS_LOCAL_STACK_ONLY=1 STOCKS_LOCAL_CUSTOMER_GATEWAY=1 node --import tsx scripts/stocks-local/run.mjs`.

The fixed local scenario composes the production gateway over two actual loopback HTTP connections with the existing disposable PostgreSQL, backend, worker/observer and unforked local EVM. Only the test-injected fetcher translates the fixed API destination to the owned local server. No production configuration can choose that local target. SIWE uses the local unlocked test account; no key is read. Legacy nonce persistence in this harness remains in memory, while Stocks orders/submissions/ledger use real PostgreSQL.

Passed: login; deployment and owner-scoped policy reads; buy2 NVDA; sell0.5; durable claims and receipt reconciliation; duplicate claims return null; intentional loss of the already-committed buy response; API restart followed by recovery of the original order; another restart after settlement; unchanged order/claim/transaction counts and balances. No browser automation or personal wallet was used.

Final actual chain values (base units): holderStock1500000000, holderCash1820000000, vaultCash180000000, escrowStock0. One buy, one sell, four claims; reconciliation MATCHED_AT_CUTOFF; no worker errors. This is1.5 NVDA and1820 test cash after starting with2000 at the fixed mock price120. Owned EVM group1973 and PostgreSQL2006 were stopped and temporary directory /private/tmp/stocks-local-stack-qhoyUs was removed. These are local test results, not GIWA public transactions.

## Verification

- Native HTTP gateway14 passed, zero failures/skips, including default-off, required auth, strict fields/origin/path, uncertain outcomes and no automatic retry.
- Real PostgreSQL suites54 passed, zero failures/skips. Existing order concurrency, event replay, process crash, original-order recovery, conservation properties, wallet-submission/receipt/session recovery were exercised. Database restart, backup/restore and cleanup markers passed.
- Full frontend1040 passed/8 skipped/0 failed; server517 passed/92 DB-only skipped/0 failed. The dedicated PG run above is separate from these skips.
- Typecheck, build, security and target UI4392 typecheck passed. Existing chunk-size/SSR warnings remain. Local harness checks21 passed.
- Migration inspection retains the same4 untouched alias findings p/s/change/current_state; no new migration was added.
- Independent read-only review found no actionable security/protocol regression.

Logs in /private/tmp: giwa-trades-gateway.log, giwa-trades-roundtrip.log, giwa-trades-postgres.log, giwa-trades-frontend.log, giwa-trades-server.log, giwa-trades-typecheck.log, giwa-trades-build.log, giwa-trades-security.log, giwa-trades-migration.log, giwa-trades-harness.log, giwa-trades-ui4392-typecheck.log. First local run selected libpq's client-only initdb and failed before database creation; the successful run explicitly selected the already-installed PostgreSQL18.6 server binaries.

## Public rollout remains separate

Read-only live probe: API /health200; /api/v1/stocks/catalog404; /ready/stocks404. Auth OPTIONS preflight for origin http://127.0.0.1:4392 returned400 without Access-Control-Allow-Origin. This proves that preflight did not permit this origin; it does not identify the deployed revision or every underlying configuration value. The Stocks session resolver also requires domain127.0.0.1:4392 in its server-approved domain list derived from CORS_ALLOWED_ORIGINS.

Before public activation: select external signing custody/service and distinct public deployer/operator/faucet addresses; prepare and approve the unsigned deployment plan; verify the new Stocks contracts without modifying live Savings/Funds registry; deploy the existing reviewed backend/migrations and signer with paused trading, correct4392 origin and CURRENT observation; then explicitly enable the customer trading option for a user-driven test. Current signer modules remain unstarted factories/ports until a custody adapter and host are assigned. No public signatures, orders, deploy, push, merge or release occurred. The user's external-signer availability question is pending; keys/seeds are not requested.
