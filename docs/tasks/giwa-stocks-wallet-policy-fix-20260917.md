# GIWA-STOCKS-WALLET policy dispatch fix

Authorized by the user’s continued development instruction and coordinator assignment. Base `518bcb5880e582137a028379fdba9b83a60c1d98`; isolated branch `codex/giwa-stocks-wallet-policy-fix-20260917`.

Plan recorded before implementation:
- Reproduce the independent reviewer’s four failures from a copied probe without modifying reviewer evidence or the original candidate.
- Recheck execution policy expiry at the actual wallet request boundary, after synchronous SIGNING subscribers, retaining the existing context guard and earlier policy checks.
- Preserve the durable claim and UNKNOWN recovery state; never release claims or assume an already-started wallet request was cancelled.
- Add approval/transfer regressions for 1 ms and 15 second policy windows, retaining late-hash and duplicate-request checks.
- Run the real artifact-backed module suite, frontend, typecheck, build, security and design checks; record the existing seven token findings separately.

Scope: controller, wallet tests, this task and matching evidence only. No ABI, contracts, server, UI, dependency, live wallet, RPC, deployment or DB changes. No production integration claim.
