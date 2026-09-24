# STOCKS GIWA app activation integration tests

Recorded before implementation. Exact base: `67603b84dbd3da374d0fc88f2f280881dd174a32`.
Builder: `/root/giwa_stocks_builder`; Commander: `/root`; independent verifier: `/root/rwa_reviewer`.
Branch: `codex/stocks-giwa-activation-tests-20260917`.
Own worktree: `/private/tmp/arco-giwa-stocks-activation-tests-20260917`.

Commander-approved ownership is limited to `scripts/stocks-local/stack.mjs`, new `server/src/stocks-runtime/app-integration.test.ts`, and this evidence document. The root agent owns app/index/runtime composition. No dependency, lockfile, schema, deployed registry, production data or secret changes are allowed.

Acceptance: use the actual `buildApp` entrypoint, preserve disabled Stocks behavior and legacy health/auth routes, verify configured BUY/SELL/admin routes with signed wallet/domain/chain sessions, reject cross-wallet reads and forged role headers, and prove no arbitrary money or admin write endpoints are exposed. Keep all existing local EVM/PostgreSQL scenario checks while replacing the standalone plugin host with `buildApp` and a minimal explicit legacy-service fixture. Fast route tests are HTTP composition evidence; the existing actual-bytecode/database harness remains the money-path evidence.

Validation plan: server compile, fast `app-integration.test.ts`, legacy app tests and syntax/diff checks; then the root-assembled activation implementation runs the local EVM/PostgreSQL harness after explicit coordination of the sole available PG slot. Before root's optional `stocks` service registration is assembled, configured route tests must fail with 404 rather than be skipped or manually register the plugin.

Implemented:
- Three fast tests construct the actual `buildApp`. A clearly labeled Stocks service boundary fixture records authenticated calls; the real Stocks plugin and signed-session resolvers own HTTP/auth behavior. No plugin is manually registered in the test.
- Disabled Stocks keeps legacy health/readiness/catalog/portfolio/nonce/attestation/operator denial and error serialization intact. Configured tests cover BUY/SELL order paths, cross-wallet quote/read isolation, named admin access, CORS, chain/domain/wallet rejection, forged roles/shared operator credentials, and absent arbitrary settlement/admin mutations.
- The existing local stack now constructs `buildApp` with real Stocks repository/service/worker/observer and a minimal legacy-service fixture. Ordinary holder/operator sessions come from the actual nonce and SIWE verification endpoints, using only ephemeral unlocked local-node accounts for signing; nonce replay must fail. Test-only adversarial JWTs check wrong chain/domain. All existing eleven scenario checks and settlement/conservation assertions remain.

Observed on the exact base before the Commander's app registration is assembled:
- `npm run build:server`: passed.
- Existing `server/dist/app.test.js`: 42/42 passed.
- New app integration tests: disabled path passed; two configured-path tests failed specifically with absent Stocks routes (404), as intended. They are not skipped and there is no standalone plugin fallback.
- `node --check scripts/stocks-local/stack.mjs` and `git diff --check`: passed.

Pending: root assembles the separately owned optional Stocks registration/lifecycle and reruns all three tests plus the actual EVM/PostgreSQL stack. This builder did not claim the PG slot or run the changed full stack on an unconnected app. No deployment, public RPC, external signing service or customer funds are used by this test task. Local signing is the pre-existing explicitly gated ephemeral EVM harness only; no key material is read, stored or logged by these changes.

Commander-approved follow-up extends only the same local harness/evidence scope. The assembled initial app tests passed19/19 according to the Commander. New phases instantiate the actual trusted-port runtime factory and `startManagedStocksServer` with fresh real database pools. Autodispatch=false must keep both quote routes paused, leave explicit ticks inert and add no signer records/cursor progress. Autodispatch=true uses the native 2-second lifecycle timer; HTTP BUY0.125 and SELL0.125 receive only wallet deposit/escrow transactions and HTTP state polling, without manual worker/observer/tick calls. The roundtrip restores3stock/360cash and adds exactly2 signer operations. Each managed app must close its own pool while the original app/pool stay usable. The Commander approved placing these phases before the deliberate future-time late-inclusion scenario so normal quote validity is not distorted. Root-owned runtime/lifecycle exports are required for execution; no public endpoint guard is weakened or bypassed. These new phases are pending root-assembled execution, not claimed passing from static inspection.
