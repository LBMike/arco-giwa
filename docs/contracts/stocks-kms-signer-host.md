# GIWA Stocks KMS signer host

This supplies the previously missing executable external signer. It does not activate the customer API, deploy contracts, create a cloud account/key, or enable trading on UI4392. Its protocol is the existing authenticated `ARCO_STOCKS_SIGNER_V1`; the public browser never calls KMS or receives its credentials.

## Runtime

Use Node 22 or newer, the committed lockfile and a dedicated signer PostgreSQL database. Build with `npm ci` then `npm run build:server`. The AWS SDK dependency is pinned to `@aws-sdk/client-kms@3.1139.0`; no secret file is loaded by this CLI. Supply `STOCKS_SIGNER_DATABASE_URL` and a random 256-bit `STOCKS_SIGNER_TOKEN` through the server's secret settings. Do not use the customer API's database URL as an implicit fallback. The SDK uses the normal AWS credential chain; a workload IAM role is preferred to long-lived access keys. Never supply an Ethereum private key or seed.

The public configuration is an explicit UTF-8 JSON file, at most 64 KiB. Unknown fields, `.env*`/`.secrets` paths, credential fields, a changed manifest digest, nondecimal quantities and unsupported networks are rejected. The following is a shape guide, **not an activatable deployment file**. Replace the manifest marker with the full verified schema-v2 deployment manifest and the other markers with actual public values. Values shown for gas/fees are examples that must be assessed for that deployment.

```json
{
  "schemaVersion": 1,
  "profile": "DEMO_TESTNET",
  "manifest": "FULL_VERIFIED_MANIFEST_OBJECT",
  "reviewedManifestDigest": "INDEPENDENTLY_REVIEWED_SHA256",
  "reviewedInitialNonce": "0",
  "rpcUrl": "https://sepolia-rpc.giwa.io",
  "listen": { "host": "127.0.0.1", "port": 8081 },
  "custody": {
    "type": "AWS_KMS",
    "region": "ap-northeast-2",
    "keyArn": "IMMUTABLE_FULL_KEY_ARN",
    "exclusiveAccountControlConfirmed": true
  },
  "transaction": {
    "gas": "1000000",
    "maxFeePerGas": "2000000000",
    "maxPriorityFeePerGas": "1000000000"
  },
  "limits": {
    "maxGas": "2000000",
    "maxFeePerGas": "3000000000",
    "maxTotalFeeWei": "6000000000000000"
  }
}
```

The key must be an AWS commercial-region `ECC_SECG_P256K1` / `SIGN_VERIFY` key with a full immutable UUID key ARN, not an alias. Its public key must derive to `manifest.signerAddress`. The host fixes the official regional KMS HTTPS endpoint and does not accept endpoint or retry-strategy overrides. Its runtime IAM role needs exactly scoped `kms:GetPublicKey` and `kms:Sign` access to this ARN. In the key policy and IAM policy, permit GetPublicKey separately from Sign; the Sign statement can restrict `kms:MessageType` to `DIGEST` and `kms:SigningAlgorithm` to `ECDSA_SHA_256`. Key administration/provisioning belongs to a different role.

Example runtime identity policy (replace the resource marker; this is not a key-administration policy):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "kms:GetPublicKey", "Resource": "IMMUTABLE_FULL_KEY_ARN" },
    { "Effect": "Allow", "Action": "kms:Sign", "Resource": "IMMUTABLE_FULL_KEY_ARN",
      "Condition": { "StringEquals": {
        "kms:MessageType": "DIGEST", "kms:SigningAlgorithm": "ECDSA_SHA_256"
      } } }
  ]
}
```

GetPublicKey checks key identity, curve, usage, supported algorithm and Ethereum address; it does not prove that Sign permission is granted or that no other principal can sign. A disabled key, denied Sign, throttle or timeout can still interrupt an operation after its nonce was reserved. Verify key state, IAM/key policy, exclusive operator account use, and real cloud signing in the deployment environment before customer activation. `exclusiveAccountControlConfirmed` records that operational check; setting it is not an IAM audit.

## Database and startup

Apply `server/src/stocks-signer/migrations/0001_journal.sql` and `0002_signed_intent.sql` separately to the dedicated database. The latter refuses historical operations without signed commitments. Provision the account row with the verified manifest's chain, signer, network instance and checkpoint, and `initialNonce=nextNonce=reviewedInitialNonce`. Use a transaction and parameterized values; never overwrite an existing row or reset a progressed nonce. See [journal requirements](stocks-signer-journal-postgres.md).

For a new account, verify chain/checkpoint and historical nonce, and independently confirm finalized and pending nonce both equal the selected starting nonce immediately before seeding. Pending RPC data alone cannot establish exclusive custody. Starting the host performs no migration, seed, discovery, funding or deployment. Existing accounts are checked against their immutable seed and current journal; a mismatch fails closed.

```sh
npm run stocks:signer -- --config /absolute/path/signer.public.json --check
npm run stocks:signer -- --config /absolute/path/signer.public.json --serve
```

`--check` opens no listener and never signs or reserves a nonce. `--serve` checks current chain, PostgreSQL guards/account and KMS public identity before listening. Default configuration should bind loopback. A private container service may explicitly bind `0.0.0.0`, behind a restricted HTTPS ingress; no bearer token should cross plaintext public networking. Do not route this endpoint to browser clients or the public customer gateway. Configure the existing backend's signer URL/token with that HTTPS endpoint only after checks pass.

Every HTTP route requires one valid bearer before readiness. Readiness is reevaluated, fails closed, and never signs. SIGINT/SIGTERM prevent new admission, drain accepted submit/lookup work even if its HTTP socket disconnects, then close the database and KMS client. Startup/listen failures also clean up. Give the process enough shutdown grace for its bounded provider/RPC calls and active database work; a forced process kill can still leave an unresolved original operation. The CLI outputs fixed status/error codes without provider details, tokens, URLs or signed bytes.

## Transaction and recovery policy

The adapter hashes the unsigned EIP-1559 serialization with Keccak-256 and passes those exact 32 bytes to KMS Sign as DIGEST / ECDSA_SHA_256. It validates DER integers, normalizes low-s and recovers parity against the expected account, then independently verifies the serialized transaction's chain, nonce, recipient, calldata, zero value and fee ceilings. SDK Sign has one attempt. The provider does not broadcast.

The existing journal reserves first, commits the validated signed hash before broadcast and permits a single send. Repeating an operation never signs or broadcasts again. GET can recover only the original finalized transaction with the committed hash and exact original fields. Lost acknowledgements recover through history; absence, a dropped transaction or a crash before broadcast stays unresolved and blocks later nonce allocation. This implementation does **not** retain raw signed bytes or automatically resend them. Do not reset/delete the journal, re-sign, replace the transaction or skip a nonce to clear an unknown outcome. Keep customer trading paused while resolving it; an operator recovery design is required for those cases.

## Deployment sequence and remaining external inputs

1. Obtain the dedicated operator KMS public identity and distinct public deployer/faucet-operator addresses. Keep signer and deployer nonce review separate.
2. Complete the existing five-contract Stocks deployment workflow, verify public receipts and derive the reviewed manifest. Preserve existing Savings/Funds deployments and `deployments/91342`.
3. Provision the dedicated signer DB/role, exact-key IAM and HTTPS host; run check and then a controlled cloud transaction. No cloud key, host or contract was provisioned by this code change.
4. Deploy the existing Stocks backend with verified settings and dispatch paused. Its SIWE domain/origin settings must include `127.0.0.1:4392`; the public backend previously rejected that preflight and lacked Stocks routes.
5. Connect signer readiness, prove observer/reconciliation and test funding, then enable controlled test trading. Restart the existing4392 preview with its prepared `--customer-trades` option only after public readiness passes. Complete personal-wallet buy, partial sell and Portfolio refresh on that same UI.

Local verification uses disposable PostgreSQL, a local unforked GIWA-ID EVM, the real HTTP host and KMS adapter with a test-only signing port. It does not substitute for AWS IAM/KMS, public GIWA transactions, production TLS, hosted CI or the user's MetaMask test.

References: [AWS Sign](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html), [GetPublicKey](https://docs.aws.amazon.com/kms/latest/APIReference/API_GetPublicKey.html), [KMS conditions](https://docs.aws.amazon.com/kms/latest/developerguide/conditions-kms.html), [SDK retry policy](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html), [viem recovery](https://viem.sh/docs/utilities/recoverAddress).
