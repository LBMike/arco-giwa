# GIWA Stocks test contracts v2

Task STOCKS-GIWA-002, base `3cd4f7bb789944e30998b208d456a6e04e6f2295`.
Builder `/root/giwa_stocks_contracts`, commander `/root`, reviewer `/root/rwa_reviewer`.

Only new Stocks contract, test, script subtrees and isolated Hardhat config are changed. Existing live Savings/Funds contracts, configs, registry, packages and locks remain unchanged. No public-network deployment is part of this task.

## Immutable relationships and getter ABI

All contracts require chain ID 91342. Contracts are non-upgradeable; none has an admin setter or arbitrary execute function. The local deployment helper precomputes consecutive CREATE addresses and deploys in this order: cash, vault, controller, stock, escrow. Escrow construction verifies the already-deployed stock/controller/vault bindings and common operator. Activation must independently pin all runtime code hashes and read these getters:

| Contract | Getter signatures |
| --- | --- |
| StocksTestCash | `faucetOperator() returns (address)`, `decimals() returns (uint8)` |
| StocksToken | `mintController() returns (address)`, `redemptionEscrow() returns (address)`, `decimals() returns (uint8)` |
| StocksFundingVault | `cashToken() returns (address)`, `redemptionEscrow() returns (address)`, `operator() returns (address)` |
| StocksMintController | `stockToken() returns (address)`, `operator() returns (address)` |
| StocksRedemptionEscrow | `stockToken() returns (address)`, `cashToken() returns (address)`, `fundingVault() returns (address)`, `operator() returns (address)` |

External buy/sell function and event ABI exactly matches the Wave 2 approved task. All operator `operationId` values are opaque bytes32: the backend's SHA-256 operation key is accepted unchanged. An operation ID binds the action and full payload within each operation-owning contract. Exact replay is a no-op without a new value-moving event; conflicting reuse reverts. Signer/backend recovery still resolves the original transaction rather than blindly submitting again. Vault uses one identity registry for refund and escrow payout, preventing cross-action reuse there.

`escrowId = keccak256(abi.encode(orderKey,payer,token))`. Escrow records have immutable payer/order/token/quantity and one terminal outcome. A second deposit for the same composite identity reverts; other payers using the same order key have distinct custody records. Only the escrow may move a holder's approved stock into custody, return it to its stored original payer, or burn recorded custody. Ordinary stock transfers and direct holder burns are unavailable.

`settleRedemption` burns custody and calls the vault's escrow-only `payoutRedemption(bytes32 operationId,bytes32 escrowId,address recipient,uint256 amount)` atomically. Cash balance deltas are checked exactly. A failed payout rolls back the burn, escrow state and operation records. Recipient comes only from the original escrow record.

The faucet is restricted to a separate constructor-fixed faucet operator and has explicit test labels. It is not exposed through investor/backend routes. The mock execution operator can mint or refund under backend policy; its authority is therefore a trusted test operator, not a cryptographic proof of real broker fills. These contracts do not claim real stock backing.

## Local toolchain and verification

From `packages/contracts`, install the existing lockfile with `corepack yarn install --immutable --immutable-cache`. Build and test with `corepack yarn hardhat --config hardhat.stocks.config.ts test`. This config uses Solidity 0.8.28, Cancun, chain 91342, isolated artifacts/cache and no dotenv, keystore or old deployment imports.

A local HTTP node can be started using `corepack yarn hardhat --config hardhat.stocks.config.ts node --hostname 127.0.0.1 --port 18545`. Its startup subtask suppresses Hardhat's account/private-key banner. RPC unlocked accounts are test-harness-only. No account key is read or written by the helper. `STOCKS_LOCAL_RPC_PORT` selects a loopback port for `--network stocksLocal`.

The deployment helper and manifest generator use actual deployed runtime hashes and getter verification. The manifest is schemaVersion 2 and includes `redemptionEscrow` plus all five code hashes, immutable addresses, chain checkpoint, distinct deployment/network IDs, and the backend-provided ABI digest. It labels local execution explicitly and must never be presented as a public GIWA deployment.

`scripts/stocks/deploy.ts` exports `deployStocks(hre, abiDigest)`, returning `{ manifest, contracts, signers, publicAccounts }`. In the local harness, unlocked RPC account 0 deploys, account 1 executes backend-authorized operations, account 2 is the separate faucet operator, and accounts 3/4 are test holders. The function verifies `hardhat_metadata`, rejects a forked node and incorrect chain, verifies each predicted CREATE nonce/address, and checks all getters before returning. Local test accounts are never a public-network signing configuration.

To generate a JSON bundle, set the non-secret values `STOCKS_ABI_DIGEST` to the current backend's exact exported `ABI_DIGEST`, `STOCKS_MANIFEST_OUTPUT` to a new absolute filename and optionally `STOCKS_LOCAL_RPC_PORT`, then run `corepack yarn hardhat --config hardhat.stocks.config.ts run --no-compile scripts/stocks/deploy-local.ts --network stocksLocal`. The file contains `{ execution: "LOCAL_EVM_TEST_HARNESS_ONLY", manifest, publicAccounts }`; use only its `manifest` field where the backend expects a manifest. The output refuses overwrite. A stopped/reset local node invalidates the manifest's checkpoint/network identity.

Wrong-chain coverage uses `corepack yarn hardhat --config scripts/stocks/wrong-chain.config.ts run --no-compile scripts/stocks/check-wrong-chain.ts`; it verifies all five constructors reject chain 31337. This test-only config has no HTTP deployment network.

Final test evidence and exact commit are recorded separately in `docs/evidence/stocks-giwa-contracts-20260916.md`. Independent review is required before local integration.
