# GIWA-LOCAL-DEPLOY-006 — reuse the local deployer

Authorization: the user's continuing autonomous GIWA development request and confirmation that the existing administrator key was stored locally for contract deployment. Commander/root is sole builder. Branch `codex/giwa-local-deploy-006`, worktree `/private/tmp/arco-giwa-local-deploy-006`, base `14c9783`.

## Scope and allowed files

Add a standalone Stocks-only local deployment CLI, core, durable public intent journal, keystore and RPC adapters under `packages/contracts/scripts/stocks/local-*`, tests under `packages/contracts/test/stocks/local-*`, and this task/runbook/evidence. No dependency, Solidity, existing configuration, API, schema, UI4392, Savings/Funds or live registry changes. This is GIWA work, not XRPL. No actual secret files will be read, unlocked or changed during implementation; no public signing or broadcast is part of verification.

The CLI reuses the existing public deployer constant, five-step unsigned planner, signed CREATE attestation, and final evidence verifier. `check` and `recover` only read public inputs, journal and RPC. `send-next` requires an explicit plan, independently retained digest, GIWA genesis hash, fee limits, journal directory and encrypted keystore; unlock only through the local hidden TTY prompt. No raw-key/password environment input or key upload. Only one CREATE is submitted per invocation.

### Explicit single-admin integration assignment

During implementation the user supplied `0xFDCf58E2954988E5bf0446aAF1284A1069136F29` and explicitly directed all administrator roles to use that wallet. This supersedes the earlier distinct-role task preference for this GIWA demo. Root is assigned integrator for a narrow change to `prepare-deployment.ts`, its test, and related deployment runbooks: retain the existing distinct-role option, additionally allow all three roles to equal the existing fixed GIWA deployer constant. Other partial role collisions remain rejected. Public input/plan schema, ABI and Solidity are unchanged. Validate the fixed single-admin plan on a local impersonated account only; never read the user's key. Deployment must finish before enabling operator/faucet transactions, and runtime/manual users must not concurrently consume the same account's nonce. Existing Savings/Funds contracts are never changed.

## Invariants and failure handling

Keep exact nonce, calldata, predicted addresses and finalized prefix; bigint/string quantities only. Verify pinned plan, chain/genesis, canonical finalized receipts, runtime code and balances/gas/current base fee. Recheck chain and nonce after signing. Before broadcast, persist one immutable per-step intent using exclusive create, file fsync and directory fsync. Competing executions may prepare signatures, but at most one can claim and broadcast that step. Record only public identity/hash, never raw bytes or keys. Partial/corrupt records fail closed; existing records cannot be overwritten.

Any persisted intent without finalized success blocks later steps and all automatic re-sign/re-send attempts. A response loss is resolved only through the original hash. This includes the intentional conservative gap if a process dies after persisting intent but before sending; no automatic unlock/replacement exists. Validate all five finalized creations with the existing verifier before producing a manifest.

## Verification

Focused unit/file/CLI tests plus actual five CREATE transactions on the isolated Hardhat chain using a temporary random encrypted wallet. Test invalid plan/key/chain/nonce/gas/fees, immutable journal and concurrency, crash before send, accepted-but-lost response recovery and final evidence. No Supabase/PG mutation or money-ledger logic changes; the execution boundary is verified against the real local EVM and filesystem, not only in-memory fakes. Run Stocks suite and relevant baseline typecheck/build/frontend/server/security/migration inspection. Secrets are generated ephemerally inside tests; never static fixtures or test output.
