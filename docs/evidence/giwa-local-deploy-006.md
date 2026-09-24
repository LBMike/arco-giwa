# GIWA-LOCAL-DEPLOY-006 evidence

Date: 2026-09-24. Base `14c9783`; isolated branch `codex/giwa-local-deploy-006`. Root was sole builder and integrator; agents reviewed read-only. [Task contract](../tasks/giwa-local-deploy-006.md), [local runbook](../contracts/stocks-local-keystore-deployment.md).

## Delivered

- Standalone explicit local encrypted-keystore CLI with check/recover/send-next/verify. The live deployer is pinned to the user's supplied existing address. Actual key files were not accessed in development.
- Exact original CREATE attestation, fresh chain/genesis/nonce/finalized-prefix and gas/balance checks, durable exclusive intent before one broadcast, original-hash-only recovery. No automatic retry or nonce replacement.
- User-selected single administrator permitted for this exact address in the planner. Other overlaps remain rejected; existing distinct roles continue to work. No Solidity, schema, dependency, API/UI or live registry changes.
- Concrete public unsigned plan for observed nonce226~230, with all roles set to the supplied administrator, fixed genesis hash and conservative fee ceilings. It is not deployment evidence or an active runtime manifest.

## Verification

| Check | Result |
| --- | --- |
| Full isolated Stocks suite | 85 pass |
| Final changed deployment subset | 24 pass |
| New code/test TypeScript including isolated Hardhat configuration | Pass |
| `npm run typecheck`, `npm run build` | Pass; existing bundle-size warning |
| Frontend with existing DOM runtime | 1040 pass, 8 skipped; existing React SSR warnings |
| Server | 528 pass, 92 skipped |
| Security and migration inspection | Pass |
| Design-token / story checks | Existing 7 token findings unchanged; no hard story violations |

The executor test uses an ephemeral encrypted random wallet and five actual local EVM CREATE transactions, then runs the existing final verifier. The same supplied public administrator is separately impersonated only on isolated Hardhat to verify all three roles and constructor bindings without its real private key. Concurrent calls produce one broadcast. A persisted but unsent original blocks retries. An accepted transaction with a lost response is recovered by a fresh child process through a local read-only RPC bridge, without another send. Tests reject changed plan/signature/chain/nonce/gas/fees/runtime/canonical evidence and malformed/insecure key files. No private key, password or signed raw transaction is written to the journal or reported in assertions.

Independent review found a lowered gas estimate could under-check the original signed gas cost and current block gas limit after signing. Both were corrected and covered by regression tests. The first subprocess test attempt was denied a sandbox loopback listener; it was rerun successfully with permission to bind a test-only local server. Direct contract typechecking initially omitted the Hardhat plugin declaration; including the actual isolated configuration resolved it without product changes.

Logs: `/private/tmp/giwa-local-006-{stocks,final-focused,contract-types,typecheck,build,frontend,server,security,migration,public-check}.log`.

## Public observations and limits

Read-only GIWA RPC reported chain91342, genesis `0xca1b5fee64a196abfca007b3a4d4e3ec2b37be83a452d452bf4e45937004cab2`, latest/pending nonce226, balance176579096541850714wei. The new CLI checked the actual public plan/network/nonce and reported nextIndex0 with no transaction hashes. No actual keystore read/unlock, signature or broadcast was made. These observations can become stale; all identity/nonce checks repeat before actual sending. The check command does not claim a successful gas estimate or decrypted-key readiness.

The existing UI4392 was not replaced or restarted. Supabase migration application, public contract deployment, non-AWS operator service, shared faucet/settlement nonce control, Render deployment, hosted CI and real user-wallet buy/sell remain incomplete. Same-admin faucet cannot be sent outside the existing operator journal and then fixed by merely resuming it; this needs a separate runtime integration. No legacy Savings/Funds contracts or registry were changed. No PostgreSQL/money-ledger mutation was introduced or new live DB tests claimed.
