# GIWA-DEMO-RELEASE-009 — preserve UI4392 and prepare hosted connection

Authorized by the user's instruction to continue connecting the GIWA demo, preserve UI4392, and prepare the final Vercel `app.arco.financial` update. Their previous instruction authorizes continued development without repeated implementation approval. Root is the sole builder and integrator of shared app/config files. Base `c5cbcda`; branch `codex/giwa-demo-release-009`; worktree `/private/tmp/arco-giwa-demo-release-009`. Read-only agents audit and review.

## Scope and allowed files

Import exactly the 52 existing UI4392 market/live-display files listed in `giwa-demo-release-009-files.txt`, comparing their source bytes with the clean target base before replacement. Source workspace `/Users/whdqkf88/.codex/worktrees/8609/arco-giwa` is read-only and continues to run unchanged. Preserve existing main Portfolio, Dynamic wallet, customer auth and transaction APIs. No blanket checkout or patch of the user workspace.

Root integration additionally owns `server/src/stocks-preflight/integration-bundle.ts`, `integration-bundle.test.ts`, `connection.ts`, `connection.test.ts`; `scripts/stocks-preflight/check-connection.mjs` help text; task/evidence and release-readiness documents. Add only the exact `http://127.0.0.1:4392` frontend-origin exception needed by the user's fixed demo. Server API/RPC/signer endpoints remain HTTPS-only. Include `VITE_CUSTOMER_PRESENTATION=true` in generated browser settings. No new dependency, schema, wallet provider, signing operation, contract or registry change.

Inspect Render and Vercel dashboards read-only to identify the correct service/project and applied database migrations. Never display secrets. No service restart, branch switch, DB write, account/plan purchase or deployment is included in this preparation task. A working signer endpoint and reviewed database activation are still prerequisites for customer trading.

## Invariants, failure cases and verification

- Existing 4392 UI, Portfolio, Savings and Funds remain unchanged while an isolated normal-product build is prepared.
- Quote display/reconnect paths cannot change order pricing or settlement authority. Test market-closed, timeout, malformed data, SSE reconnect and tab lifecycle.
- Only exact loopback4392 is accepted for frontend origin; reject other HTTP hosts/ports, credentials, query/hash, path, comma/wildcard and alias spellings. This exception never applies to API/RPC/signer URLs. Keep origin-bound SIWE and authentication unchanged.
- Run imported market/server tests, explicit DOM/runtime tests and preview proxy tests, then `npm run typecheck`, `npm run build`, `npm run test:frontend`, `npm run test:server`, `npm run test:security`, `npm run prisma:migration:inspect` plus required design hooks. Existing documented design findings must not increase.
- Record Render target/Supabase identity, current deploy and migration state, Vercel app-domain project, exact remaining activation work. Never describe a local build as a public deployment.
