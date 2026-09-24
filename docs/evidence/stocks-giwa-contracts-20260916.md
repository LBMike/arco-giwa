# STOCKS-GIWA-002 contract implementation evidence

- Base: `3cd4f7bb789944e30998b208d456a6e04e6f2295`.
- Builder: `/root/giwa_stocks_contracts`; worktree `/private/tmp/arco-giwa-stocks-contracts-20260916`; branch `codex/stocks-giwa-contracts-20260916`.
- Commander: `/root`; separate verifier: `/root/rwa_reviewer`. This document is implementation evidence, not independent approval.
- Approved contract: commander's `docs/tasks/stocks-giwa-wave2-20260916.md`, STOCKS-GIWA-002. Ownership is exclusively new Stocks contracts/tests/scripts, isolated `hardhat.stocks.config.ts`, contract spec and this evidence file.

## Delivered

Five new non-upgradeable test contracts: 6-decimal `ARCO_TEST_USDC`, 9-decimal restricted `ARCO_TEST_NVDA`, funding vault, operator mint controller, and holder-bound redemption escrow. Constructor-fixed relationships are exposed through immutable getters. All five reject deployment outside chain 91342, and value-moving entrypoints enforce the same chain guard.

Frozen buy/sell ABI is preserved. Exact operation replay does not move value or emit a new settlement event; altered replay fails. Escrow identity includes original payer, preserving each payer's independent custody. Only the approved escrow can move, return or burn custody. Redeem burns and pays test cash in the same EVM transaction; a failed payout reverts burn, supply, terminal state and both operation registries. Vault enforces exact incoming and outgoing cash balance deltas.

The deployment helper verifies actual runtime code hashes, all constructor relationships, scales, CREATE nonce/address predictions and local-node identity. It returns a schemaVersion 2 manifest with the redemption escrow and all five runtime hashes. The separate local JSON bundle is explicitly `LOCAL_EVM_TEST_HARNESS_ONLY`. The helper never opens a keystore or obtains account keys.

## Executed verification

Commands below ran from `packages/contracts`:

1. `corepack yarn install --immutable --immutable-cache`: passed using existing pinned dependencies and cache; no package or lock changes. Existing peer warning about old hardhat-upgrades' etherscan dependency remains unrelated.
2. `corepack yarn hardhat --config hardhat.stocks.config.ts test`: **29 passed**, actual EVM bytecode, Solidity 0.8.28, Cancun, local chain 91342.
3. `corepack yarn hardhat --config scripts/stocks/wrong-chain.config.ts run --no-compile scripts/stocks/check-wrong-chain.ts`: **5/5 constructors rejected** chain 31337.
4. Explicit scoped TypeScript check with strict, ES2020, CommonJS, skipLibCheck and node/mocha types for the new config, deploy scripts and tests: passed.
5. Prettier check over only new contract/test/script/config files: passed.
6. Solhint over only new Solidity files: exit 0, **0 errors / 76 advisory warnings**, primarily custom-error preference, getter-compatible immutable naming, constructor visibility and import style. Update lookup failed under restricted network; lint itself completed.
7. `git diff --check`: passed; only task-owned new files are changed.

Tests include role rejection, invalid inputs, allowance enforcement, exact event ABI and Transfer pairs, repeated cash deposits, duplicate/mutated operation IDs, cross-action vault collision, two payer custody isolation, unauthorized transfers and burns, both return/settle terminal orderings, actual competing pending transactions mined into one block, insufficient-payout atomic rollback, and fractional integer cash/supply conservation across repeated lifecycle actions.

## Loopback deployment check

Started the isolated Hardhat HTTP node on `127.0.0.1:18546`. Initial sandbox socket access required an approved local-only escalation. The node's startup task suppresses Hardhat's default account/key banner and printed only `STOCKS_TEST_HARNESS_ONLY ready at http://127.0.0.1:18546`.

Deployed all five contracts through the `stocksLocal` network using unlocked test RPC accounts. The manifest generator wrote `/private/tmp/arco-stocks-contracts-local-manifest-20260916.json`, confirmed actual code and immutable relationships, and refused overwrite by design. This smoke check used an explicitly dummy 64-hex ABI digest; integrated backend execution must pass its actual exported digest. The task's node was then stopped. Its manifest is historical local test evidence, not an active deployment or a public-testnet registry entry.

## Limits and handoff

No public GIWA or Mainnet transaction occurred. Existing Savings/Funds contracts, deployment registry, configs, package manifests, lockfiles, application entrypoints and credentials are unchanged. Root owns backend/session/signer/observer integration and the real-PostgreSQL end-to-end tests. Independent verifier must review this exact commit before local integration. A public GIWA deployment still requires an authorized external signer and a separate deployment manifest produced from that chain.
