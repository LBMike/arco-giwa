# GIWA-STOCKS-WALLET policy dispatch correction evidence

Base: `518bcb5880e582137a028379fdba9b83a60c1d98`. Isolated branch: `codex/giwa-stocks-wallet-policy-fix-20260917` in `/private/tmp/arco-giwa-stocks-wallet-policy-fix-20260917`. This is a local candidate awaiting coordinator independent review, not integration or deployment approval.

The previous `SIGNING` notification synchronously called subscribers after the last policy expiry check. A subscriber could advance time to policy expiry while the order/session remained valid; the wallet request then proceeded. The controller now repeats the expiry check alongside the existing generation/context guard immediately before calling `requestTransaction`, with no intervening notification or await. Earlier checks remain intact.

The pre-request durable claim is preserved as UNKNOWN using the existing recovery path. It is never deleted or released, even though this particular pre-dispatch failure made no wallet request. This intentionally conservative state must be reconciled by the trusted recovery adapter. Requests already started and late transaction hashes retain their existing behavior.

Reproduction and correction:
- Copied the review probe and fixture into `/private/tmp/arco-giwa-stocks-wallet-policy-fix-evidence-20260917`, updating only candidate imports and the output destination. Original review files and candidate were untouched.
- Before: 0/4 passed; approve/submit × 1 ms/15 s all made one expired wallet request.
- After: 4/4 passed; every case made zero wallet requests and retained UNKNOWN.
- Added the same four cases to the module suite, also asserting the durable claim survives and a fresh policy, cancel, prepare, and repeated action cannot trigger another wallet request.
- Artifact-backed wallet suite: 28/28 passed, no skips (existing 24 plus four regressions). Existing cancellation, scope change, late hash, unknown outcome and duplicate claim tests passed.

Checks: typecheck, build, security, story structure and whitespace passed. Build retains existing chunk-size warnings. Design-token hook reports exactly the seven known baseline findings in unchanged Investor.tsx/components.tsx. Full frontend suite: 245/245 passed, no skips, including host DOM and actual Solidity artifact gates.

Local logs and machine-readable probe results: `/private/tmp/arco-giwa-stocks-wallet-policy-fix-evidence-20260917/` (`before.log/json`, `after.log/json`, `module.log`, `typecheck.log`, `build.log`, `frontend.log`, `security.log`, `tokens.log`, `stories.log`; exit files for broad checks).

Re-run module gate:
```sh
GIWA_STOCKS_ARTIFACTS=/private/tmp/arco-giwa-stocks-command-20260916/packages/contracts/artifacts/stocks node --import tsx --test src/demo/giwa/stocks-wallet/wallet.test.tsx
```

Scope: controller, wallet tests and dedicated task/evidence only. No production adapter, host/UI wiring, server, ABI, contract, registry, dependency, live wallet, public RPC or DB changes. Missing deployment verification, current execution policy and durable authenticated submission/recovery adapters remain integration blockers. No push, merge or deployment.
