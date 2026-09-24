# Local encrypted-keystore signer

The GIWA demo can use the existing administrator's encrypted wallet with the same authenticated signer host, original-transaction verifier and PostgreSQL nonce journal. AWS is optional; the existing KMS launcher is unchanged for KMS configurations.

After installing the repository and contracts dependencies and building the server, an operator can run:

```sh
node scripts/stocks-signer/run-local.mjs --config /absolute/reviewed-public-config.json --keystore /absolute/encrypted-wallet.json --check
node scripts/stocks-signer/run-local.mjs --config /absolute/reviewed-public-config.json --keystore /absolute/encrypted-wallet.json --serve
```

These are operator commands, not a ready-to-run production bundle. Configuration must pass `parseSignerHostConfig`: the verified manifest and its canonical digest, reviewed initial nonce, GIWA Sepolia RPC, explicit fee caps, and custody `{ "type": "LOCAL_KEYSTORE", "exclusiveAccountControlConfirmed": true }`. The listener must be `127.0.0.1`. The keystore path is local-only and does not belong in the public configuration. The existing strict keystore loader checks ownership, permissions, symlinks, envelope and recovered address.

The user enters the keystore password in their local hidden terminal prompt. The CLI rejects non-interactive execution and key/password environment overrides. It never loads dotenv or prints exception details. Database access uses `STOCKS_SIGNER_DATABASE_URL`; authenticated requests use the existing random 256-bit `STOCKS_SIGNER_TOKEN`. Those server credentials must be provisioned separately and must not be copied to the frontend, chat or public configuration. No API receives a wallet password or private key.

The CLI does not create a schema, seed an account, choose a nonce, fund a wallet, create an ingress or change Render. Prepare and verify the dedicated signer database first. The existing host checks schema, manifest, account state, chain identity and custody readiness before listening. Both `--check` and `--serve` unlock the wallet; `--check` closes after readiness and does not submit a transaction. `--serve` retains the signing capability only while the process is running. SIGINT/SIGTERM cancels a pending password prompt and restores the terminal, or drains an already running host. Shutdown releases held references; JavaScript does not guarantee physical memory erasure.

Only exact, bounded EIP-1559 transactions enter the custody adapter. It independently validates the returned signed transaction against the requested chain, signer, target, nonce, calldata and zero native value. Submission and recovery remain in the journal transport. An uncertain original is recovered rather than signed or broadcast again.

## Activation prerequisites

1. Confirm the intended Supabase project and dedicated signer role/database, then verify migration history and seed from freshly reviewed chain evidence.
2. Provide a real secured HTTPS path from Render to the loopback signer. A Mac-based demo requires the Mac and signer to stay running; this implementation does not create or expose such a path.
3. Add the test-cash faucet to the same nonce journal before using one administrator for both faucet and settlement. The current remote API permits only mint/refund/redeem/return. A separate faucet transaction would consume a nonce outside the journal and make the host unready.
4. Start with Stocks paused, verify observer history and reconcile balances, then validate the user's wallet buy, portfolio refresh and partial sell on UI4392 before updating `app.arco.financial`.

No public trading activation is claimed by the local custody tests.
