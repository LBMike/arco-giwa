# GIWA Stocks read-only manifest verifier evidence

Task base `78e29d797f29a12df4f7efa3da6187a699491168`; worktree `/private/tmp/arco-giwa-stocks-deployment-20260917`; branch `codex/stocks-giwa-deployment-plan-20260917`.
Builder `/root/giwa_stocks_contracts`, commander `/root`, independent verifier `/root/rwa_reviewer`.
Only NEW verifier script, its NEW test, contract document and this evidence file are allowed. No existing planner, contract, dependency, configuration, registry or entrypoint was changed.

## Implementation

The verifier requires the independently retained approved plan digest, reconstructs the plan from pinned artifacts and verifies exactly five original canonical finalized creations. It confirms actual sender/chain/nonce/init calldata/value/CREATE destination/address/order and receipt success plus exact block inclusion. All runtime hashes, immutable getters, scales and zero bootstrap supplies are checked at one finalized cutoff; every creation block and cutoff are rechecked before emitting the backend-compatible v2 manifest.

The first creation block is preserved as the observer's inclusive checkpoint. A genuine test cash deposit made after vault creation but before the remaining three contracts existed is rejected. This avoids silently losing early money facts that cannot satisfy the all-five-contract verification policy. Pre-activation stock minting is likewise rejected. No opening balance or cursor is fabricated.

The CLI imports no Hardhat runtime/config, dotenv, signer or wallet. Its explicit HTTPS transport accepts only six read-only RPC methods and rejects credential URLs, query strings, fragments, redirects, malformed envelopes and write/sign methods. The manifest output refuses overwrite. No public-network verification was attempted without user-supplied deployment evidence.

## Verification executed

- `corepack yarn hardhat --config hardhat.stocks.config.ts test test/stocks/verify-deployment.test.ts`: **13/13 passed** using actual isolated local EVM creations and injected raw RPC.
- Tests cover full successful evidence, deterministic deployment identity across later empty cutoffs, original digest/plan tampering, malformed inputs, incomplete/duplicate hashes, unsigned/partial deployment, pending/nonfinal evidence, wrong chain/sender/nonce/value/calldata/destination, reverted/incorrect receipt, canonical block inclusion, code/getter/scale mismatches, history/cutoff change and finality regression, real pre-completion cash deposit, real pre-activation stock issuance, and HTTPS read-method enforcement.
- Scoped strict TypeScript check with the existing ES2020/CommonJS toolchain: passed.
- Full isolated Stocks suite: `corepack yarn hardhat --config hardhat.stocks.config.ts test` — **51/51 passed** (29 contract + 9 planner + 13 verifier cases).
- Prettier check of the two new TypeScript files — passed.
- `git diff --check` — passed; only the four allowed new files appear in status.

Independent approval remains separate from this builder evidence. ABI-digest test fixtures are explicitly local; the real CLI caller must pass the current backend's actual digest and runtime activation checks equality again.

## Boundaries

No PostgreSQL cluster, production signer, key/seed, existing deployment resource, public GIWA RPC or Mainnet was used. Actual EVM writes in tests occurred only on the isolated Hardhat chain through existing unlocked test accounts. The verifier itself made only read calls. No real public deployment or activation is claimed.
