# GIWA-KEYSTORE-SIGNER-008 — existing keystore custody integration

Authorized by the user's request to continue connecting the completed deployment, their earlier instruction to proceed without repeated development approval, and their choice to reuse the existing administrator. Root is the sole builder and shared-code integrator. Base `302614a777eebf02a611ef7376a6f9c6123c850a`; branch `codex/giwa-keystore-signer-008`; worktree `/private/tmp/arco-giwa-keystore-signer-008`. Review agents are read-only.

## Scope and files

Add a local, hidden-TTY keystore custody path to the existing signer host. Reuse the reviewed encrypted-keystore unlock helper, exact signed-transaction validation, authenticated HTTP protocol and PostgreSQL nonce journal. No new provider/account/SDK, contract deployment, public signing, secret transmission, schema migration or running-service change is included here. Hosting is configured separately after the user confirms whether the demo Mac can remain on. Final frontend target is `https://app.arco.financial`; preserve the existing UI4392.

Allowed files: new `server/src/stocks-signer/custody-local.ts` and `.test.ts`; `host.ts`, `host-config.ts`, `host-config.test.ts`; new `scripts/stocks-signer/run-local.mjs` and `run-local.test.mjs`; existing `scripts/stocks-signer/run.mjs` for an explicit AWS-only guard; `scripts/stocks-signer/original-transport-evm.test.mjs` and `test-postgres.mjs` for a second encrypted-wallet integration mode; new `docs/contracts/stocks-local-keystore-signer.md`, this task and `docs/evidence/giwa-keystore-signer-008.md`. Existing contracts scripts/registry, UI files, package dependencies, Prisma and signer SQL are read-only.

## Invariants and failure cases

- Password only through the user's hidden local TTY. No key/password in argv, ordinary environment, logs, API, database, fixture or frontend. Tests create throwaway encrypted wallets at runtime; never read the real admin key.
- Local CLI binds only127.0.0.1 and refuses secret environment overrides, mismatched custody type, malformed public config, invalid/weak HTTP bearer token and non-interactive input before unlocking.
- Local custody signs one exact EIP-1559 request at the fixed chain/fee limits and independently verifies the recovered signer, nonce, calldata, destination and amount. No provider/send/retry in custody. Close removes the retained signer capability; late results after closure are rejected.
- PostgreSQL remains the only nonce authority. Repeated operations never sign/send again; unknown originals block follow-up sends. Existing readiness and shutdown draining stay authoritative.
- This task does not add faucet to the remote HTTP API or claim that the current signer supports shared faucet nonce allocation. That requires a separate signer-only integration contract and additive migration before public bootstrap.
- No placeholder endpoint activates the Render API. A real HTTPS backend-to-signer path and explicit DB binding are deployment prerequisites.

## Verification commands

`npm run build:server`; targeted custody/config/host tests and CLI non-TTY/no-secret smoke checks; `node scripts/stocks-signer/test-postgres.mjs` extended to run real TCP/PostgreSQL/local-EVM mint, partial redemption, concurrent duplicate claims, shutdown during signing and lost-ack recovery through both existing KMS-test and new encrypted-wallet modes. Wrong password/address/permissions remain covered by the unchanged keystore helper tests. Run `npm run typecheck`, `npm run build`, `npm run test:frontend`, `npm run test:server`, `npm run test:security`, `npm run prisma:migration:inspect`. No public signed transaction is needed to validate the implementation.
