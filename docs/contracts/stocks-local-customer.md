# Local customer demo on actual GIWA Sepolia

Immediate target: the existing UI at `http://127.0.0.1:4392/src/demo/giwa/investor-shell/verification/index.html`, with customer `0x3185f0eFB95228c9E476De5C9da1d1aA8ccf76D2`. Existing administrator remains the settlement/faucet/deployment role holder. Do not use the administrator as the customer; their wallet transactions would consume the signer's managed nonce.

The dedicated local API CLI accepts the completed007 deployment only. It binds127.0.0.1:4493, uses the confirmed Supabase project, and reaches the008 signer at127.0.0.1:4394. The public GIWA RPC remains fixed. Normal hosted configuration still requires HTTPS signer endpoints and has no environment switch that enables this local mode.

UI4392 opts into `--customer-reads --customer-auth --customer-trades --local-customer`. Its original screens and live-market option remain available. Only allowed SIWE/Stocks requests switch to4493; legacy Savings/Funds/Portfolio reads retain the existing Render upstream, and public GIWA reads retain the fixed RPC. Admin/fixture/faucet routes remain disconnected. The backend continues to verify user signatures and bearer sessions. No local flag authorizes a trade.

## Private server configuration

The user-local setup helper accepts the existing Supabase session-pooler URL through hidden input and creates a new0600 JSON file in an owned0700 directory. It generates three random local server credentials. It performs no database connection, migration, wallet unlock or transaction. It never reads dotenv automatically or overwrites an existing configuration.

```sh
node scripts/customer-demo/setup-server.mjs --output /absolute/private/server.json
```

The connection must identify project `munsybkrsxrmajmbssli`, databasepostgres, port5432, and the approved direct/session-pooler hostname and username. Only an optional single TLS `sslmode=require|verify-full` query is accepted; query fields that can override host, username, port or read local TLS files are rejected. The session pooler is reused as the migration connection. Never paste the connection URL, generated tokens, key or password into chat.

After the separate database/bootstrap task is verified, start the actual API with:

```sh
node scripts/customer-demo/local-api.mjs --server-config /absolute/private/server.json --runtime-config /absolute/public/runtime.json
```

The child receives only the five reviewed server fields and fixed local settings. Parent dotenv, browser variables, NODE_OPTIONS and unrelated credentials are not inherited. Prisma and Stocks use the same childprocess environment. Invalid configuration fails before database access; errors do not print values.

## Remaining activation order

1. Apply only the five reviewed Stocks migrations to the confirmed Supabase project; verify history/checksums and all application guards. Preserve existing GIWA tables.
2. Prepare a durable, dedicated signer journal. If it has no account yet, the first-time bootstrap may fund the fixed customer before seed. Confirm that original faucet transaction finalized, then freshly verify the account nonce and seed once. Never use a guessed starting nonce, delete a journal, or send an independent faucet after seed.
3. Unlock the encrypted administrator wallet locally, start the signer and actual API, and reach CURRENT observation while paused. The local runtime requires persistent operator controls and named administrator read/control permissions.
4. Use a separately reviewed privileged local operations command to resume only after readiness and reconciliation. Do not forge a wallet session or weaken the gateway to bypass operator auth.
5. Activate4392's explicit local mode, then validate customer SIWE, actual test-cash balance, buy confirmation, Portfolio update and partial sell. The model cannot perform the user's MetaMask transaction confirmations.

The connection implementation and configuration setup are not a claim that this activation sequence has run. Vercel remains unchanged until the user has tested locally.
