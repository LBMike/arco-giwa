# GIWA-SIGNER-RUN-004 — runnable external signer

Status: implementation authorized by the user's 2026-09-24 instruction to finish development without repeated approval. Commander/root is the sole builder and integrator. Branch `codex/giwa-signer-run-004`; worktree `/private/tmp/arco-giwa-signer-run-004`; base `70b3c42`.

## Scope and allowed files

Compose the existing signer journal, original transport, readiness and authenticated HTTP service into a runnable process. Add one sign-only AWS KMS secp256k1 adapter, fixed reviewed gas/fee policy, strict public configuration, check/serve CLI, and operational instructions. The root integrator explicitly includes the isolated AWS SDK dependency integration in this contract.

Allowed: new `server/src/stocks-signer/{custody-kms,host,host-config}.ts` and tests; `scripts/stocks-signer/{run.mjs,original-transport-evm.test.mjs}`; `package.json`, `package-lock.json`; this task, its evidence, and `docs/contracts/stocks-kms-signer-host.md`; a status/link note in `docs/contracts/stocks-external-signer-core.md`. Existing API, schema, Solidity, live deployment registry, UI and other worktrees are outside this implementation contract.

## Invariants and failure cases

No private key/seed in application configuration, database, logs or fixtures. KMS uses an immutable key ARN and a verified public-key address. Only GIWA 91342 EIP-1559 original transactions within fee ceilings are signed. The provider never broadcasts and the SDK never retries a Sign call. DER signatures are validated, normalized to low-s, and recovered against the expected account before serialization. Existing durable nonce reservation and signed-hash-before-broadcast boundaries remain authoritative; unknown outcomes block replacement/re-signing.

Public JSON is strict and contains no database/token/cloud credentials. No dotenv, automatic migrations, account seeding, nonce discovery or custody fallback. Check is read-only. Startup requires current chain, DB and KMS readiness; errors are sanitized. Shutdown gates new work and drains requests before closing resources. Missing access is reported as an external dependency, never as a successful cloud deployment.

## Verification

Targeted KMS malformed/incorrect signatures, wrong keys/curves, fee boundaries, deadline and no-retry tests; real socket lifecycle/auth/readiness tests; existing real Postgres concurrency/crash/replay/property suite and EVM integration extended through the host and KMS boundary. Run `npm run typecheck`, `npm run build`, `npm run test:frontend`, `npm run test:server`, `npm run test:security`, `npm run prisma:migration:inspect`. Dedicated signer command: `TMPDIR=/private/tmp STOCKS_PG_BIN=/opt/homebrew/Cellar/postgresql@18/18.6/bin node scripts/stocks-signer/test-postgres.mjs`. Known legacy migration findings are recorded separately.
