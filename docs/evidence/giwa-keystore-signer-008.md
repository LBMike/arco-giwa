# GIWA-KEYSTORE-SIGNER-008 verification

2026-09-24. Base `302614a777eebf02a611ef7376a6f9c6123c850a`; root builder/integrator in `codex/giwa-keystore-signer-008`. Scope: [task contract](../tasks/giwa-keystore-signer-008.md). Operational guide: [local signer](../contracts/stocks-local-keystore-signer.md).

Implemented local encrypted-wallet custody, strict loopback-only public configuration, and a hidden-TTY CLI using the existing reviewed wallet loader. Existing AWS configurations remain supported through their separate launcher. No dependency, contract, registry, Prisma schema, signer SQL or running service changed.

## Executed verification

- Server build and targeted custody/config tests passed. Exact signed transaction matching, fee caps, wrong signer, changed native value, malformed input, input mutation and completion after closure are covered.
- CLI tests: 2 passed. Non-TTY startup fails before file access. Actual PTYs with throwaway encrypted wallets reach the hidden prompt; SIGTERM and SIGINT each restore terminal echo/canonical mode and terminate before database/RPC access. The first PTY assertion raced the unchanged helper's label-before-raw-mode ordering; the test now waits for that bounded transition before delivering a signal. No password is entered by this cancellation test.
- Real PostgreSQL runner passed: 6 journal tests, restart persistence and signed-intent migration guard, plus both real TCP/local-EVM integration modes. The new mode creates and unlocks a throwaway encrypted wallet, then covers mint, partial redemption, concurrent duplicate claims, shutdown during signing, lost broadcast acknowledgement and recovery of the original after host restart. Marker: `SIGNER_HOST_TCP_KEYSTORE_MINT_REDEEM_RECOVERY_PASSED`. KMS fixture mode also remains green.
- `npm run typecheck`, `npm run build`, `npm run test:security`, `npm run prisma:migration:inspect`: passed. Build retains the existing bundle-size warning.
- Frontend suite: 908 passed, 22 skipped, 0 failed (930 total); existing React SSR warnings remain.
- Server suite: 534 passed, 92 skipped, 0 failed (626 total). Database-dependent checks were separately executed by the real PostgreSQL runner above.
- Independent read-only review found a pending-password signal cancellation defect; fixed and verified by the PTY test. Follow-up review found no further concrete lifecycle/security defect in this scope.

No real administrator keystore was read or unlocked, no public transaction was signed or sent, and no Render/Supabase/Vercel write was performed. The five contracts completed in task007 remain the deployment truth. Shared faucet nonce support, database provisioning, secured Render-to-signer connectivity, observer activation and actual customer trading remain separate integration steps.
