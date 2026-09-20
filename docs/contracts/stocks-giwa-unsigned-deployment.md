# GIWA Stocks unsigned deployment preparation

Approved bounded task base: `67603b84dbd3da374d0fc88f2f280881dd174a32`.
Builder `/root/giwa_stocks_contracts`; commander `/root`; independent verifier `/root/rwa_reviewer`.
Worktree `/private/tmp/arco-giwa-stocks-deployment-20260917`, branch `codex/stocks-giwa-deployment-plan-20260917`.

Allowed files are NEW `packages/contracts/scripts/stocks/prepare-deployment.ts`, NEW `packages/contracts/test/stocks/prepare-deployment.test.ts`, this contract and `docs/evidence/stocks-giwa-unsigned-deployment-20260917.md`. Existing Solidity, deploy-local helpers, configuration, package manifests, locks, deployed registry and application entrypoints are immutable for this task.

The planner accepts only explicitly supplied public deployer, operation signer and faucet operator addresses, GIWA chain 91342 and the deployer's starting nonce. Roles must be valid, nonzero, pairwise distinct, and different from the predicted contract addresses. No public role address, nonce or signing method is guessed.

It prepares unsigned CREATE requests for cash, vault, mint controller, stock and redemption escrow in that exact order, using the pinned Solidity 0.8.28 / Cancun / optimizer-200 artifacts. It includes exact calldata, chain, sender, nonce, zero value, constructor arguments, predicted addresses and expected immutable relationships. It computes the expected deployed runtime code hashes by applying solc's immutable references to the compiled runtime templates. It creates no runtime activation or completed-deployment manifest: those require actual finalized chain evidence.

There is no RPC call, key access, signing, broadcast, production default endpoint or existing-registry update in the planner. Fees and gas limits are deliberately left for an explicitly authorized external signer to estimate without modifying any approved transaction identity field.

Acceptance tests execute the prepared requests only against the isolated Hardhat chain 91342 using unlocked local accounts. Tests must verify all five exact runtime hashes and constructor getters, deterministic preparation, invalid inputs, wrong compiler/chain, altered plans, stale nonce and reordered-step rejection. Public testnet deployment remains dependent on the user's public roles and external signing method.

## Operator input and offline command

The JSON input must contain exactly five fields: `chainId` (number `91342`), `deployer`, `operator`, `faucetOperator` (the three user-supplied public addresses), and `startingNonce` (canonical unsigned decimal string). There is no default address or nonce. Supplying extra fields is rejected. `startingNonce` and all subsequent nonce arithmetic use arbitrary-precision integers, including values above JavaScript's safe integer range.

From `packages/contracts`, compile using the existing isolated configuration:

```sh
corepack yarn hardhat --config hardhat.stocks.config.ts compile
corepack yarn ts-node scripts/stocks/prepare-deployment.ts --input /absolute/public-roles.json --output /absolute/unsigned-plan.json
```

The second command is fully offline and imports neither Hardhat runtime/configuration nor dotenv. It reads only the five named compiled artifacts and their referenced local build-info files. The output refuses overwrite, contains only public deployment data and includes a deterministic SHA-256 `planDigest` covering the complete plan. No real public-network plan was generated during development because the user's role addresses and starting nonce have not been supplied.

Every step includes a `CREATE` label, `to: null`, zero native value, exact chain/sender/nonce/calldata, constructor arguments, predicted address, creation/init-code hashes, expected runtime code hash and immutable getter expectations. Standard external transaction estimation may add fees and gas limits, but must preserve every approved identity field. `stockPolicy` records test-cash scale 6 and test-stock scale 9.

## Executor boundaries and recovery

`prepareStocksDeployment(input, artifacts)` prepares the plan without a provider. `verifyPreparedDeployment(plan, artifacts)` regenerates it from the pinned artifacts and rejects changed calldata, hashes, ordering or metadata. The user-approved digest must come from the reviewed original plan; a newly recomputed digest does not approve a changed plan.

`assertPreparedStep(plan, index, observed)` is a pure pre-send guard. Its caller supplies freshly verified GIWA chain ID, deployer address and pending nonce, plus the exact completed prefix with deployed addresses and runtime code hashes. A missing or reordered prefix, wrong network/sender, changed nonce or incorrect prior runtime hash rejects the step. These arguments are observations, not proof on their own: the separately authorized external executor must obtain them from trusted chain reads and finalized transaction receipts.

There is deliberately no broadcaster or automatic retry here. If a transaction's outcome is unknown, resolve its original nonce/hash before sending any later step. If another transaction consumes a reserved nonce, stop. Do not silently shift nonces or rebuild the remaining transactions: the stock/controller/vault/escrow constructor relationships depend on the original five predicted addresses. A partial failure needs explicit review of the original receipts and exact surviving code.

After all five finalized creations match the plan, the runtime activation still needs an actual chain checkpoint, deployment/network identity, code hashes, ABI digest and the existing `verifyStocksDeployment` check. An unsigned plan is not a completed deployment manifest. Existing Savings/Funds deployments and their registry are outside this workflow.

## Public file boundaries

The preparation and verification CLIs share a bounded public JSON reader/writer.
Explicit input files must be regular, valid UTF-8 JSON, at most 1MiB. The reader
also bounds reads if the file grows after its size is checked, and rejects pipes
without waiting for a writer. Both supplied and resolved paths reject `.env*`
components and `.secrets`; environment and key discovery are never attempted.
Compiled artifact/build-info reads remain limited to the planner's existing
named artifact set and are not treated as caller-supplied deployment input.

Output is limited to 1MiB, created exclusively with mode0600 under a validated
existing parent. Existing files and symlinks are never overwritten. A write failure
may leave a partial new file; inspect it and choose a new output path. File errors
use fixed `INVALID_PUBLIC_DEPLOYMENT_JSON` or `PUBLIC_DEPLOYMENT_JSON_NOT_WRITTEN`
messages without the original input text or filesystem path.

The `Stocks / isolated-contracts` CI job runs the entire Stocks contract suite,
including offline planning, finalized creation verification and malformed transport
and file cases, through `hardhat.stocks.config.ts`. It uses only an isolated local
chain, with no public network or key configuration.
