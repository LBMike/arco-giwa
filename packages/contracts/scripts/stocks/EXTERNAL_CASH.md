# Existing tUSDC Stocks deployment

This is a separate four-CREATE Stocks epoch. It reuses the unchanged platform
`TestAssetToken` proxy at `0x869d9c8d9bf0a961fc2fd3bba300fdbeee3c2633`. It does not
redeploy or change the existing tUSDC, Savings/Funds, old Stocks contracts,
registry, or order journals. Existing five-CREATE plans remain on their v2 path.

## Public input

`prepare-external-cash.ts` accepts exactly these fields. All values are public;
never include private keys, passwords, RPC credentials, or database URLs.

```json
{
  "chainId": 91342,
  "deployer": "<public deployer address>",
  "operator": "<public settlement operator address>",
  "startingNonce": "<confirmed decimal nonce>",
  "abiDigest": "<Stocks API ABI SHA-256 digest>",
  "cashToken": "0x869d9c8d9bf0a961fc2fd3bba300fdbeee3c2633",
  "cashCodeHash": "<proxy runtime keccak256>",
  "cashIdentity": {
    "kind": "ERC1967",
    "implementation": "<reviewed implementation address>",
    "implementationCodeHash": "<implementation runtime keccak256>",
    "proxyAdmin": "<reviewed proxy admin address>",
    "proxyAdminCodeHash": "<proxy admin runtime keccak256>"
  },
  "network": {
    "networkInstance": "<explicit reviewed network identity>",
    "checkpointNumber": "<finalized decimal block number>",
    "checkpointHash": "<canonical block hash>"
  }
}
```

The checkpoint must be no later than the first CREATE. A deliberate retained
network anchor is supported, but does not migrate or reset a signer journal.
Task 025's deployment preparation uses its own reviewed network identity and a
separate signer database. Signer handoff is a separate required operation.

From `packages/contracts`, with existing dependencies and reviewed compiler
artifacts under `artifacts/stocks`:

```sh
node node_modules/ts-node/dist/bin.js scripts/stocks/prepare-external-cash.ts \
  --input /absolute/public-input.json --output /absolute/unsigned-plan.json
```

The offline plan fixes every constructor argument, CREATE nonce/address,
bytecode/runtime hash, public cash identity and network anchor. The immutable
bindings are vault → existing tUSDC/operator/new escrow; controller → operator/new
stock; stock → new controller/new escrow; escrow → operator/new stock/new vault.

## Controlled local execution

The existing `local-deploy.ts` supports both exact plan kinds. Its explicit
approval file still binds `expectedPlanDigest`, `genesisHash` and the four fee
ceilings. Each new deployment requires an empty private journal directory.
The higher-level launcher must acquire the existing shared administrator lock
and complete the signer handoff preflight before any send; this CLI does not
stop or take ownership of a running signer itself.

```sh
node node_modules/ts-node/dist/bin.js scripts/stocks/local-deploy.ts check \
  --plan /absolute/unsigned-plan.json --approval /absolute/approved-limits.json \
  --journal /absolute/private-new-deployment-journal --rpc https://sepolia-rpc.giwa.io
```

Only after exact public deployment approval and nonce-lock coordination, use
`send-next` with the same options and `--keystore /absolute/existing-encrypted-key.json`
in the user's own TTY. It prompts for the password with hidden input. Never pass
that password through environment variables or command arguments. Run `recover`
with the same non-secret options to inspect the original recorded transaction;
an unresolved original is never signed or resent. Exactly four original CREATEs
are allowed for this plan kind. Existing v2 plans still require five.

`verify` accepts the same non-secret options plus `--abi-digest <approved digest>`
and `--output /absolute/manifest-v3.json`. For v3 the ABI argument must equal the
digest already committed in the plan.

## Independent read-only final verification

The verification input is exactly `{plan, expectedPlanDigest, transactionHashes}`,
where hashes are the four original transaction hashes in nonce order.

```sh
node node_modules/ts-node/dist/bin.js scripts/stocks/verify-external-cash.ts \
  --input /absolute/original-creation-evidence.json \
  --rpc https://sepolia-rpc.giwa.io --output /absolute/manifest-v3.json
```

The verifier requires canonical finalized CREATE transactions, exact sender,
nonce/calldata/address, all runtime hashes and immutable getters, token scales,
exact tUSDC symbol, proxy implementation/admin storage slots and code hashes. It
requires the new vault balance and new stock supply to be zero; existing tUSDC
total supply may be positive. It scans every new contract and relevant tUSDC
transfer/upgrade event from the first creation through the finalized cutoff so
an early round trip followed by zero balances is not accepted as pristine.
Log reads use at most 100 blocks each; a deployment window over 100,000 blocks
requires separate review instead of unbounded RPC work. Any read failure aborts.

This pins observed proxy identity; it does not make the existing token immutable
or remove the proxy administrator's upgrade capability. Runtime v3 verification
must continue enforcing the same policy after activation.

## Local verification

```sh
node node_modules/hardhat/internal/cli/cli.js \
  --config scripts/stocks/external-cash.local.config.ts \
  test test/stocks/*.test.ts test/external-cash/deployment.test.ts
```

The isolated config imports no dotenv, live network, user keystore or registry.
It compiles existing Solidity sources unchanged and uses only the local Hardhat
network. Tests include the real proxy token/faucet buy/sell round trip, wrong
cash approval rejection, implementation/admin changes (including upgrade then
restore), canonical evidence failures and durable original transaction recovery.
