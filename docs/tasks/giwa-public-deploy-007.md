# GIWA-PUBLIC-DEPLOY-007 — authorized public testnet execution

User authorization: after reviewing the scope, the user explicitly instructed "실제 배포 진행해줘". Root is the sole executor/integrator. Branch `codex/giwa-public-deploy-007`, worktree `/private/tmp/arco-giwa-public-deploy-007`, tested source base `fd1bdd0`.

## Exact scope

Deploy the five new Stocks contracts only on GIWA Sepolia chain91342 using the existing administrator `0xFDCf58E2954988E5bf0446aAF1284A1069136F29` for deployer/operator/faucet. Preserve existing Savings/Funds, UI4392, API, Supabase and `deployments/91342/**`. Approved plan digest `bd3f8a539469dd4afc709bc076725c14e4f5f3da2330598aff25333f1df86906`, nonces226–230. Genesis `0xca1b5fee64a196abfca007b3a4d4e3ec2b37be83a452d452bf4e45937004cab2`.

Use the checked-in execution approval: gas≤5,000,000, priority≤1,000wei, maxFee≤1,000,000wei and gas×maxFee≤5,000,000,000,000wei per CREATE. A plan/identity/fee change requires renewed review; do not silently adjust nonces or replace an uncertain original.

## Keys and execution

The user's authorization covers using the existing local encrypted keystore through the tested CLI, not displaying/exporting the key. Never inspect the plaintext key, print encrypted file contents, load dotenv, read password stores, or ask for a key/password in chat. Any required unlock input is entered by the user in a local hidden TTY. The CLI validates file ownership/permissions, V3 encryption and decrypted administrator address. If the existing path is unavailable, request only its location, never its contents.

Run `check`, then one `send-next` at a time. Persist original-hash intents in the single durable journal `/Users/whdqkf88/Desktop/arco-giwa/GIWA_STOCKS_DEPLOYMENT_20260924/journal`. A pending/missing/uncertain original blocks subsequent sends; use read-only `recover`. Finish by verifying all five original hashes and canonical finalized evidence with the exact backend ABI digest. Save public manifest/evidence outside the live registry. No automatic operator/faucet activation is included.

The initial authorized send invocation reached the existing keystore's hidden password prompt but no user-visible controllable terminal was available: native Terminal control was denied by the computer-use tool and the Codex panel was only queued. Root cancelled before signing; the durable journal remained empty. Add an operations-only `.command` launcher so the user can enter the password directly in their own terminal. It invokes the unchanged reviewed CLI, serializes one launcher with a retained-on-error lock, polls only read-only original recovery, and verifies at the end. It never captures a password or signed bytes. Public bundle files and the launcher live in the durable operation directory; source remains pinned to fd1bdd0. Review and syntax-check the launcher before handing it off. This is a required local unlock handoff, not a request for renewed deployment approval.

The user then ran the launcher, reported an unlock failure, and confirmed entering the private key into the password prompt. The correct input is the separate password created by import-keystore.ts. The failed process was gone, journal empty and public chain/nonce still matched; archive its launcher lock in the operation directory rather than deleting transaction evidence. The user requested multiple password attempts. Add an operations-only password checker using the existing unlock and hidden-prompt modules: up to five user-entered attempts, fixed local keystore/admin, no provider/RPC/sign call/journal, fixed messages only. The agent must not guess, capture, or receive candidates. This does not change any deployed code or approval.

## Verification and stop conditions

Reuse fd1bdd0's 85 contract tests and 24 final deployment tests, passing build/typecheck/security/migration and frontend/server baselines. This task changes no product code before execution. Recheck clean source, approved public files, current chain/genesis/nonce and each pre-send gas/balance/prefix. Stop on unavailable key/hidden input, unresolved journal, account nonce drift, changed code/history or fee limits; do not bypass the guard. Record actual hashes, receipts and verification outcomes, and distinguish deployment from later Supabase/Render/operator integration.
