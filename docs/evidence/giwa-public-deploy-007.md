# GIWA-PUBLIC-DEPLOY-007 execution record

2026-09-24. User explicitly approved actual deployment of the reviewed GIWA Sepolia Stocks five-contract plan. Source fd1bdd0173315ddb6a9dfd9396d313ee63384192; plan digest bd3f8a539469dd4afc709bc076725c14e4f5f3da2330598aff25333f1df86906. See [task scope](../tasks/giwa-public-deploy-007.md).

## Completed actions

1. Checked clean tested product source and independently regenerated the plan from pinned artifacts. All three roles match the user's administrator; nonces226–230 and execution limits match the reviewed plan.
2. Created the durable public journal at `/Users/whdqkf88/Desktop/arco-giwa/GIWA_STOCKS_DEPLOYMENT_20260924/journal` with mode0700.
3. Ran the real read-only CLI against GIWA. Result: `PLAN_AND_NONCE_MATCH`, nextIndex0, no transaction hashes.
4. Started the real first `send-next` in an interactive PTY. The pre-send reads/gas checks and encrypted keystore envelope checks succeeded far enough to display `GIWA deployer keystore password:`. No password was provided, no wallet decrypted, and no signature was created.
5. Native Terminal control was denied by the computer-use tool. The Codex terminal open requests were queued; its read snapshot had no output, so no user-visible unlock prompt was verified. The waiting PTY was explicitly cancelled before signing. Its generic cancellation error is not evidence that the existing key file is invalid.
6. Confirmed durable journal is empty: no signed original was recorded or broadcast. Prepared a local `.command` handoff that invokes the reviewed CLI with the fixed public bundle. No credential is stored in the launcher.

## Required local input

The user must run `/Users/whdqkf88/Desktop/arco-giwa/GIWA_STOCKS_DEPLOYMENT_20260924/deploy-stocks.command` in their own local terminal and enter the keystore password at the hidden prompt. It is required once per CREATE; input is not echoed or logged. Do not send the password in chat. The launcher keeps one exclusive lock, checks current original state before each next CREATE, polls only read-only recovery, and never retries an uncertain send. A failure retains the launcher lock and original journal for inspection.

Final verification uses ABI digest `a0d31f9e9c54e63b38215aa64b271ff08d72d16b3a893dfa64652e4eabdaf974`, independently calculated from the 13-entry source ABI and matched to the built backend export. A verified public manifest is written to the durable operation directory, outside `deployments/91342`.

The launcher passed shell syntax inspection and independent read-only review. Review identified that durable inputs needed an immutable approval reference; it now compares both public input files byte-for-byte with the full fd1bdd0 Git commit objects at start, before every send, and before final verification. The tested product source is also compared against that commit. Current durable bundle equality, executable mode0700 and an empty journal were verified without accessing key contents.

## Current result

**Deployment incomplete; waiting for user-local keystore unlock. Zero public deployment transactions.** No product code, existing Savings/Funds registry, Supabase database or UI4392 runtime changed in this task. Existing deployment approval remains valid for the exact reviewed scope; no new approval is requested merely to unlock locally. If account state or the plan changes, stop for the review required by the approved scope.
