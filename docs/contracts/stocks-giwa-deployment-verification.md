# GIWA Stocks finalized deployment verification

Approved follow-up base `78e29d797f29a12df4f7efa3da6187a699491168`. Builder `/root/giwa_stocks_contracts`, commander `/root`, independent verifier `/root/rwa_reviewer`.
Allowed changes: NEW `packages/contracts/scripts/stocks/verify-deployment.ts`, NEW `packages/contracts/test/stocks/verify-deployment.test.ts`, this document, and NEW `docs/evidence/stocks-giwa-deployment-verification-20260917.md`. Existing planner, contracts, configuration, dependency files, deployment registry and application entrypoints remain unchanged.

The read-only verifier accepts the reviewed unsigned deployment plan, its independently retained original plan digest, exactly five original transaction hashes and the current backend ABI digest. It reconstructs the plan from pinned artifacts, checks each actual creation transaction and canonical finalized receipt, checks code and constructor getters at one finalized cutoff, rechecks canonical block hashes, and only then emits a compatible v2 deployment manifest.

It never signs, broadcasts, retries deployment or handles key material. The public CLI accepts only an explicitly supplied HTTPS RPC without embedded credentials, query string or fragment. No endpoint or public role is inferred. Tests use the injected local EVM RPC directly, never a public endpoint.

The manifest checkpoint is the **first creation block**, scanned inclusively by the existing observer. This preserves all observable token activity from initial cash-contract creation, including activity before the fifth creation. Code/getter verification uses the later common finalized cutoff where all five contracts exist. The verifier records both anchors in its returned evidence; it does not confuse the unsigned plan with a completed deployment.

Activation preparation additionally requires **zero total supply for both test cash and stock** at that cutoff. The exact reviewed test-cash code has no burn path: positive prior minting, funding, refund or redemption cannot be hidden by returning vault balances to zero. Stock also starts with zero supply. Any prior economic activity, including a deposit between the early vault creation and final escrow creation, is rejected and needs a separately reviewed recovery/bootstrap procedure. The tool never seeds opening balances or moves the checkpoint past that history. Faucet use begins only after deployment verification and runtime observer activation.

## Explicit evidence input

The input JSON has exactly four fields:

- `plan`: the complete previously reviewed unsigned plan.
- `expectedPlanDigest`: the original approved digest retained independently from that plan. Do not derive approval by trusting a newly supplied plan's own digest.
- `transactionHashes`: exactly five original transaction hashes in the plan's cash/vault/controller/stock/escrow order. Pending or missing creations cannot substitute for these receipts.
- `abiDigest`: the current backend's exact exported `ABI_DIGEST`, as 64 lowercase hexadecimal characters. The verifier validates its format; backend activation independently requires equality to the deployed backend's supported ABI digest.

No address or transaction is auto-discovered, no original transaction is replaced, and no hash is inferred from an unsigned plan. The trusted RPC must return the transaction's chain ID and full creation fields. Incomplete or inconsistent RPC evidence fails closed.

## Read-only command and result

From `packages/contracts`, after compiling the pinned artifacts:

```sh
corepack yarn ts-node scripts/stocks/verify-deployment.ts --input /absolute/creation-evidence.json --rpc https://explicit-giwa-rpc --output /absolute/manifest.json
```

The RPC URL is mandatory. HTTPS is required; username/password, query-string and fragment are forbidden. There is no dotenv/configuration discovery or default endpoint. The transport allows only chain/block/transaction/receipt/code reads and `eth_call`; signing, submission and account-unlock methods are rejected before a request is sent. Output uses exclusive creation and refuses overwrite.

`verifyStocksDeploymentEvidence(input, artifacts, rpc)` accepts an injected read-only RPC and returns `{ manifest, evidence }`. The CLI writes only `manifest`, which has the backend's exact v2 fields. Evidence includes the approved plan digest, five original finalized creation records and the common verification cutoff. The deployment ID and network-instance ID derive from the reviewed plan plus first creation block number/hash, so repeating verification at a later empty finalized block does not split the same deployment into a new ledger identity.

The verifier checks success status, transaction/receipt hash identity, sender, chain, original nonce, byte-for-byte init calldata, zero native value, null CREATE destination, predicted address, transaction order and exact inclusion in each canonical block. It checks all five runtime hashes and every immutable public getter at one finalized block, plus 6/9 token scales and pristine supplies, then rechecks all creation blocks and the finalized cutoff before returning.

The emitted file provides verified deployment evidence. It does not start runtime workers, unpause trading, fund a faucet, publish a registry entry or approve a signer. Those remain the commander's separately controlled activation steps using the existing runtime preflight.

## Bounded external responses and public files

Each HTTPS RPC call has a single 10-second deadline covering headers, body streaming
and JSON parsing. Actual decoded bytes are limited to 4MiB even when Content-Length
is missing or understated. Invalid UTF-8, oversized bodies, late results, redirects
and foreign response URLs are rejected. Failed or unused streams are cancelled;
the caller never waits for a broken cancellation callback. There is no automatic
retry. These are per-request limits, not a deadline for the complete multi-request
verification. A transport failure prevents manifest output.

Transport errors return `DEPLOYMENT_RPC_UNAVAILABLE`; malformed RPC envelopes return
`DEPLOYMENT_RPC_RESPONSE_INVALID`. Original response bodies, provider errors and
URLs are not included. URL parsing failures use `EXPLICIT_HTTPS_READ_RPC_REQUIRED`.
The transport remains read-only and preserves JSON-RPC request/response ID binding.

Input evidence and output manifests use the same
[public file boundaries](stocks-giwa-unsigned-deployment.md#public-file-boundaries)
as the unsigned planner: explicit absolute paths, 1MiB JSON limit, strict UTF-8,
regular input files, blocked credential paths and no output overwrite. No finalized
receipt, nonce, code-hash or constructor validation was relaxed by these limits.
