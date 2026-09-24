# GIWA-DEMO-API-002 evidence

Base706f9ef. Builder/root in /private/tmp/arco-giwa-demo-api-002, branch codex/giwa-demo-api-002.

Implemented: opt-in customer4392 fixed public API/RPC read gateway; no auth/header/cookie forwarding, private reads or writes; no fallback to snapshots/empty activity/fixture execution; read-only RPC method/batch/body/origin limits. Original UI and wallet connection unchanged. Real customer mode forces live market display and prints the existing investor-shell URL. Missing Stocks catalog remains404/unavailable.

Portfolio retains main layout and arithmetic while distinguishing loading/error/confirmed empty. Catalog/RPC failures do not display $0 or no holdings. Market failure preserves confirmed quantity and hides valuation. Activity requires both activity and redemptions reads to succeed. Refresh recovers and wallet-switch tests fence late results.

Verified:
- Fixed-destination native HTTP gateway:6 passed,0 failed. Upstreams are controlled test responses; no production auth sent.
- Full frontend with DOM gate:1040 passed,8 skipped,0 failed; existing SSR warnings.
- Server:517 passed,92 DB-only skipped,0 failed. No new DB/money path changed or claimed.
- Typecheck/build passed; existing bundle-size warnings.
- Security passed.
- Migration inspection: same4 untouched SQL alias findings (p/s/change/current_state) as previous baseline.
- Read-only independent review found start-link/default-market issues; both fixed. Preserve existing UI SSE via patch only.

Logs: /private/tmp/giwa-api-gateway.log, giwa-api-frontend.log, giwa-api-server.log, giwa-api-security.log, giwa-api-migration.log, giwa-api-typecheck.log, giwa-api-build.log.

Integration packet: /private/tmp/giwa-demo-api-002-ui4392.patch and /private/tmp/giwa-demo-api-002-ui4392-hashes.json. git apply --check against existing8609 passed. Changes exactly PortfolioPage.tsx, investor-shell/verification/main.tsx, stocks-execution-host/verification/serve.ts, new scripts/customer-demo/gateway.ts. Existing UI/live-market edits preserved. Applying to the foreign UI worktree and local preview restart are pending expanded approval; no such changes have occurred yet.

Authentication: automatic review rejected configurable sensitive egress. No rejected code was applied. Fixed public-read-only implementation accepted. Proposed future authorization is exclusively https://arco-giwa-api.onrender.com, public wallet/domain+nonce request, user-approved SIWE login message/signature to /api/v1/auth/verify, and15-minute bearer token to the same API's authenticated Stocks reads. No alternative destination, token persistence, signing automation, transaction or public deployment is included. This auth change is not implemented/activated yet.

Existing public API health200, Stocks catalog404, Portfolio route validates invalid address400 (read-only probes, no personal wallet address). Actual personal-wallet authenticated balances and public Stocks transactions have not been verified.

Final public-service read probe through the actual new gateway (temporary loopback test listener, not a new user demo): GIWA catalog200 with8 products; Stocks catalog404; read-only eth_chainId200 with91342. No personal wallet address, authentication payload or transaction was sent. Customer4392 remains unchanged pending explicit four-file/restart approval. Authentication destination/payload approval was separately requested after the review rejection.

Final Portfolio review found no functional blocker. Design token check remains at7 existing findings; story check has no hard findings. Source is complete for public-read integration, not a claim that authentication or public Stocks trading is complete.
