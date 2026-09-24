# GIWA-DEMO-API-002 evidence

Base706f9ef. Builder/root in /private/tmp/arco-giwa-demo-api-002, branch codex/giwa-demo-api-002. Public-read implementation commit5548416; the following completion adds the separately approved fixed-destination authentication forwarding and integrates the combined runtime changes.

## Delivered to existing4392

The user's explicit “계속 개발 진행해줘” after the two-part approval request authorized the four-file UI integration/restart and public wallet address, SIWE message/signature and short-lived token forwarding only to https://arco-giwa-api.onrender.com. Automatic approval review accepted this restricted completion. The originally rejected arbitrary configurable HTTPS authentication gateway was never applied.

Exactly four runtime files were applied to /Users/whdqkf88/.codex/worktrees/8609/arco-giwa after checking every preimage and postimage hash: PortfolioPage.tsx, investor-shell/verification/main.tsx, stocks-execution-host/verification/serve.ts and new scripts/customer-demo/gateway.ts. Existing UI/live-market/SSE edits were preserved. No other target file was changed or staged. Packet: /private/tmp/giwa-demo-api-002-ui4392.patch and /private/tmp/giwa-demo-api-002-ui4392-hashes.json.

Only the4392 listener was restarted after matching PID81063, exact command and cwd. New PID96850 runs /usr/local/bin/node --import tsx src/demo/giwa/stocks-execution-host/verification/serve.ts --port 4392 --live-market --customer-reads --customer-auth. Existing user URL is unchanged: http://127.0.0.1:4392/src/demo/giwa/investor-shell/verification/index.html#/portfolio. Both customer-reads and IEX market HTML markers verified.

## Behavior

Fixed API and GIWA RPC destinations; no redirects, cookies, ambient privileged headers, auth logging or token persistence. Auth is opt-in and explicit: only nonce/verify POST, wallet/domain matching the loopback customer origin, SIWE URI/domain/chain91342 scope, and Bearer forwarding only to authenticated Stocks GET endpoints. Existing backend remains responsible for cryptographic SIWE, nonce consumption and JWT checks. Public reads/RPC never receive credentials. Order writes, signing/broadcast RPC and fixture endpoints remain blocked. No fallback to snapshots or simulated execution in customer mode.

Portfolio retains main layout and arithmetic while distinguishing loading/error/confirmed empty. Catalog/RPC failures do not display $0 or no holdings. Market failure preserves confirmed quantity and hides valuation. Activity requires both activity and redemptions reads to succeed. Refresh recovers; late results from another wallet remain fenced. Customer mode forces the existing live market presentation.

## Verification

- Native HTTP gateway9 passed,0 failed. Includes real buildApp SIWE verifier, ephemeral local test accounts, JWT-authenticated read, nonce replay rejection and wrong-signer rejection. No personal wallet or production login used; this is not a PostgreSQL persistence test.
- Focused Portfolio DOM, verification fixture and Stocks session tests44 passed,0 skipped,0 failed.
- Typecheck/build passed after auth changes; target4392 worktree typecheck also passed. Existing bundle-size warnings remain.
- Earlier full baseline for the public-read/Portfolio revision: frontend1040 passed/8 skipped/0 failed; server517 passed/92 DB-only skipped/0 failed; security passed. No new DB/money path changed or claimed.
- Migration inspection retains4 untouched SQL alias findings (p/s/change/current_state). Design tokens retain7 existing findings; story check has no hard findings.
- Independent auth review found no actionable security bug; Portfolio review found no functional blocker.

Logs: /private/tmp/giwa-api-auth-gateway.log, giwa-api-auth-focused.log, giwa-api-auth-typecheck.log, giwa-api-auth-build.log, giwa-api-auth-ui4392-typecheck.log. Baseline logs: /private/tmp/giwa-api-frontend.log, giwa-api-server.log, giwa-api-security.log, giwa-api-migration.log.

## Actual running service and browser evidence

Read probes through the restarted4392: public GIWA catalog200 with8 products; eth_chainId200 with91342; Stocks catalog404; fixture state503; private Stocks read without token401; invalid-domain nonce rejected locally400. No personal address, signature, token or chain transaction was sent by these probes.

Browser reloaded the canonical URL successfully. Home shows4 Savings and4 Funds from the public8-product catalog. Disconnected Portfolio shows Connect your wallet. Stocks shows the existing40-symbol market list and NVDA detail/chart with last-observed market time, preserving the user's UI. The NVDA trade sheet remains unable to order because the public Stocks catalog is missing. Its current copy says trading is available once the catalog loads; this is a remaining UI wording limitation, not a successful trade. Personal-wallet login/balances and public Stocks buy/sell were not exercised by the agent. The user's earlier wallet-connection confirmation is preserved separately from these checks.

## Remaining boundary

Public Stocks API/runtime deployment, external signer/role configuration and actual user-signed GIWA testnet transactions remain outstanding. No contract/registry deployment, money transfer, push, merge or release occurred. Authentication routing has been activated locally; successful production SIWE and Stocks trading are not claimed. Do not substitute another preview port or a simulated wallet as the user's demo.
