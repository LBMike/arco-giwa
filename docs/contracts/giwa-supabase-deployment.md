# GIWA demo: existing Supabase deployment path

The current product stack remains Supabase PostgreSQL, Render API/indexer, Dynamic/MetaMask and UI4392. AWS is not a prerequisite. The optional KMS host is not connected to this deployment.

`render.yaml` places API and indexer in the same environment group. Both use Prisma and DATABASE_URL; Stocks uses STOCKS_DATABASE_URL when explicitly set, otherwise DATABASE_URL. Before applying migrations, establish the actual project's identity by comparing the Render connection's project ref with Supabase. Do not expose the password or full URL. Dashboard schema similarity is supporting evidence, not proof of the deployed API binding.

Run `npm run prisma:migration:inspect` first. `npm run prisma:migrate:deploy` also invokes the inspection guard, requires the dedicated DIRECT_URL, and passes that connection to Prisma. Use the existing migration workflow after checking the actual migration history and checksums; never manually copy all SQL into the dashboard or modify applied migrations. Existing public/waitlist data and deployed Savings/Funds registry must be preserved. See the [read-only Stocks database preflight](../../server/src/stocks-preflight/database.ts) for history/checksum/schema/runtime checks.

For connection mode, retain explicit runtime/migration separation. Supabase documents direct and session-pooler connections for persistent backends and transaction-pooler limitations in its [Postgres connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres). Do not infer the user's AWS account from a Supabase pooler hostname, or blindly replace existing URLs.

Database access does not provide Ethereum signing. The user confirmed the existing administrator key was kept locally for prior contract deployments and subsequently selected that same public administrator address for deployer/operator/faucet roles. The [local deployment executor](stocks-local-keystore-deployment.md) checks the encrypted keystore identity, network and nonce. Keep one nonce authority for later same-account operations; never store a private key in Supabase, the API, frontend, ordinary environment variables or logs. Do not run `evm:probe:giwa` as a read-only check: it deploys a contract.

As of 2026-09-24, the Supabase Arco dashboard shows the existing GIWA tables and no Stocks tables. Live Render-to-project binding, migration application, public Stocks deployment, non-AWS operator signing and the complete user-wallet buy/sell flow remain unverified. Local test success must not be reported as public demo completion.
