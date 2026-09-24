# GIWA-LOCAL-CUSTOMER-010 — actual-chain local customer composition

User explicitly prioritized local testing before Vercel and supplied test wallet `0x3185f0eFB95228c9E476De5C9da1d1aA8ccf76D2`. Root owns implementation and shared integration. Base `c9293a1`; branch `codex/giwa-local-customer-010`; worktree `/private/tmp/arco-giwa-local-customer-010`. No other worktree is edited.

## Scope, files and boundaries

Connect the fixed UI4392 customer gateway to an explicitly selected loopback actual API on4393 and the008 encrypted signer on4394. Supabase product data and public GIWA Sepolia RPC remain authoritative. Do not use the disposable Hardhat owner harness or fixtures as customer outcomes.

Allowed files: `scripts/customer-demo/gateway.ts`, its existing tests and new local-gateway test; `src/demo/giwa/stocks-execution-host/verification/serve.ts`; `server/src/index.ts`; `server/src/stocks-runtime/runtime.ts` and its tests; new `server/src/stocks-runtime/local-customer.ts` and test; new `scripts/customer-demo/local-api.mjs`, `local-environment.mjs` and tests; this task/evidence/operator guide. Root alone owns shared index/runtime/gateway changes. No API route/schema/dependency/contract changes.

Local composition is selected only by the dedicated local CLI. Normal hosted configuration continues to reject HTTP signer URLs. Local CLI requires exact UI/API/signer ports4392/4393/4394, exact GIWA RPC, verified manifest digest, explicit operators, Supabase project `munsybkrsxrmajmbssli`, and loopback binding. Browser input cannot select upstreams. Existing request allowlists, bearer validation, SIWE domain and secret redaction remain unchanged. Legacy GIWA reads continue to use the existing Render API.

An explicit server-config file is consumed only inside the launcher with a strict server-key allowlist; never print its contents or credentials. No automatic dotenv search, private-key/password environment input, credential copying from dashboards, or frontend secret injection. Missing configuration fails before network access with a fixed diagnostic. The user's local TTY remains the only wallet-unlock mechanism.

Configuration-preparation extension before implementation: allow new `scripts/customer-demo/setup-server.mjs` and its test to accept the existing Supabase session-pooler URL through a hidden user-local TTY, generate local-only random API credentials, and create an exclusive0600 server JSON inside an owned0700 directory. This performs no DB connection/migration or signing. A durable `.command` wrapper may invoke only this reviewed configuration helper while the separate bootstrap task is developed. The model never reads the resulting private file.

This task does not apply Supabase migrations, unlock/sign, fund the tester, seed/reseed a journal, restart4392 or deploy. Those operations require the tested bootstrap/run task after this connection boundary is verified. The first-time bootstrap may fund the tester before initial journal seed; after seed no independent administrator transaction is allowed. All unknown originals must resolve before any following send.

## Failure cases and tests

Test normal hosted rejection, exact local endpoint acceptance, aliases/foreign host/credentials/extra paths rejected, wrong Supabase project, unexpected/secret configuration keys, non-regular config input, local API receiving only Stocks/SIWE while legacy reads and RPC retain fixed upstreams, no unauthenticated write widening, and runtime binding/cleanup. Run focused gateway/runtime tests and required typecheck/build/frontend/server/security/migration checks. Existing real-PG/encrypted signer evidence is retained; actual setup/replay validation belongs to the bootstrap task. No hosted setting or chain write is needed to verify this scope.
