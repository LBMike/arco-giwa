# Unsigned GIWA Stocks deployment evidence

Base `67603b84dbd3da374d0fc88f2f280881dd174a32`; branch `codex/stocks-giwa-deployment-plan-20260917`; worktree `/private/tmp/arco-giwa-stocks-deployment-20260917`.
Builder `/root/giwa_stocks_contracts`, commander `/root`, independent verifier `/root/rwa_reviewer`.

Allowed files are the new planner, new planner test and two assigned documents. Existing contract source, helpers, configuration, lockfiles, dependencies and deployment registry remain unchanged. The task prepares reviewable unsigned testnet transactions; it does not broadcast publicly.

## Delivered and verified

The planner accepts explicit public deployer/operator/faucet roles and a decimal starting nonce, validates chain 91342 and distinct nonzero roles, predicts the five ordered CREATE addresses, encodes exact constructor transactions, binds runtime immutable values and produces deterministic expected code hashes and getter expectations. A pure executor guard rejects wrong chain, stale nonce and missing/incorrect prior-deployment evidence. A verifier regenerates the entire plan from pinned artifacts and rejects any mutation.

Using the existing pinned dependency cache, `corepack yarn install --immutable --immutable-cache` succeeded with the existing unrelated etherscan peer warning. No package or lockfile changed.

Targeted test command: `corepack yarn hardhat --config hardhat.stocks.config.ts test test/stocks/prepare-deployment.test.ts`: **9/9 passed** on actual isolated EVM bytecode. Coverage includes deterministic offline preparation; all five unsigned transactions executed with local unlocked accounts; exact runtime-hash equality; all immutable getter bindings and token scales; malformed roles/nonce/chain; role/predicted-address overlap; precision above 2^53; incorrect compiler/settings/build evidence; modified calldata/hash/step/metadata; real nonce consumption; out-of-order nonce rejection; and the standalone offline filesystem CLI with overwrite refusal.

An initial CLI test caught use of an ES2022 helper under the existing ES2020 toolchain. It was replaced with the compatible own-property check; the complete targeted suite then passed. No dependency or compiler-target change was introduced.

Final verification also passed:

- Full isolated Stocks suite: `corepack yarn hardhat --config hardhat.stocks.config.ts test` — **38/38 passed** (the 9 new planner cases plus 29 existing contract cases).
- Scoped TypeScript check with strict mode, ES2020, CommonJS and node/mocha types over the isolated config and the two new TypeScript files — passed.
- Prettier check of the new planner/test — passed.
- `git diff --check` — passed. Status contains exactly the four allowed new files; no existing tracked file changed.

Independent approval is separate from this builder evidence.

## Explicit limits

No production/public account addresses were invented. The only addresses exercised were existing isolated Hardhat RPC accounts and the plan's deterministic local contract addresses; temporary CLI fixtures were removed. No private key/seed, dotenv, keystore, external signer, public RPC or existing deployment resource was accessed. No public GIWA or Mainnet transaction was signed or submitted, and no activation manifest or registry entry was fabricated.

Actual GIWA deployment requires the user's explicit public role addresses, a fresh starting nonce, an available authorized external signer and finalized on-chain verification. Those external prerequisites do not block offline code preparation and local bytecode verification, but this evidence does not claim they are completed.
