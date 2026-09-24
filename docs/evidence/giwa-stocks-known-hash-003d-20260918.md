# GIWA Stocks 003D — known-hash backend/browser acceptance

2026-09-18. **PASS for the backend/HTTP-adapter recovery scope. Production recovery UI remains unimplemented and assigned to Claude via the prepared task.** No new endpoint, production policy, contract or schema was necessary: the existing API already supports the flow.

## Source and implementation

- Base `54b9514da69d782d4bc94ff5ec67494587075b01` (003C-2).
- Code `a31349be58f65fe3b31a3b9941a2e89a86571638`; tree `2a6e11978d0c9fef9383cba1aca281eb9aee51e0`.
- Clone `/private/tmp/arco-giwa-003d-recovery-20260918`, branch `codex/giwa-003d-recovery-20260918`, push disabled.
- Ten code files, +294/-9, entirely within test infrastructure under `scripts/stocks-local/`.
- Production `src`, `server/src`, Solidity, dependencies, migrations and deployed registry unchanged. Original checkout/main unchanged, no network deployment or push.

The fixed `STOCKS_LOCAL_BROWSER_CASE=known-hash` driver extends the accepted Chrome harness. An explicitly gated test fixture can shorten exactly one successfully SIWE-authenticated local holder session to a genuinely signed 30-second JWT. The real server resolver therefore rejects it after actual elapsed time. All ordinary logins and the production 900-second token policy remain unchanged. This is not the prior jsdom scenario that shortened only browser-facing `expiresIn` while keeping the JWT at 900 seconds.

Each original order/approval/transfer starts at an actual production Stocks UI button. The wallet's original accepted response is held until its signed JWT expires, then released. The old UI gate cannot adopt new credentials or send an outcome. After the original 60-second quote deadline passes, the browser logs in again via actual SIWE. An explicit test probe invokes the unchanged production `createSubmissionGate` in Chrome to inspect the original binding, record the known original hash, and reconcile the actual chain receipt. This probe is not a production recovery screen. It supplies an observed original wallet-return hash, not a guessed or injected receipt.

## Actual recovery results

Evidence directory: `/private/tmp/arco-giwa-003d-recovery-evidence-20260918`. `known-hash.log` and `result.json`: **28 assertion groups PASS, exit 0, owned cleanup confirmed**. Chrome153.0.8010.48 / Playwright1.62.1 / Node24.14.0, installed runtimes only.

| Case | Recovered original claim | Business behavior |
| --- | --- | --- |
| BUY APPROVAL | CONFIRMED from actual approval receipt after token/quote expiry | Expired order grants no new transfer |
| SELL APPROVAL | CONFIRMED from actual approval receipt after token/quote expiry | Expired order grants no new transfer |
| BUY TRANSFER | CONFIRMED from actual deposit receipt after token/quote expiry | Original timely funding independently leads to actual issuance/COMPLETED when processing resumes |
| SELL TRANSFER | CONFIRMED from actual escrow receipt after token/quote expiry | Original timely escrow independently leads to actual burn/payout/COMPLETED when processing resumes |

All four cases verify expired JWT401/no-store, no old-gate outcome request, adapter refusal before HTTP, another owner's404, missing-hash refusal, altered binding refusal, client-terminal refusal, identical-outcome idempotence without another audit, conflicting-hash409, one immutable trusted receipt proof, preserved business-order state during record/reconcile, and API/browser restart with the same proof. Replay of the same claim returns null. Recovery never opens another wallet request. New TRANSFER admission on expired APPROVAL-only orders remains denied. Clocks, quote dates and chain time are never advanced or rewritten.

Final holder stock and supply **2.25 NVDA**, holder cash **1,730 ARCO_TEST_USDC**, vault cash **270**, escrow **0**, reconciliation **MATCHED_AT_CUTOFF**, worker errors0. Eight original wallet sends match eight committed claims and eight distinct real nonces0–7; successful claim responses precede each exact send. Seven total receipt proofs include the four recovered claims. Seed transfer business completion remains separate from submission-journal confirmation.

The processing loop is paused during each recovery comparison, not a newly added trading-pause API. The separate PostgreSQL suite below covers configured pause and true expiry with the same server contracts. The final observer releases an unpaid expired SELL reservation after finalized coverage; unpaid BUY stays unpaid. No business state is assigned by a fixture.

Screenshots `recovery-portfolio-desktop.png` and `recovery-portfolio-mobile.png` were captured with 1440/375px no-overflow checks; the mobile image was visually inspected. Market data remains explicitly unavailable. No accessibility certification, production UI recovery completion or live-market connectivity is claimed.

## Regression and review

- Bridge/wallet/short-session fixture unit tests: **11/11 PASS**. Default mode denies the new control; exact JSON fields and origin checks still apply. Arbitrary lifetimes are refused.
- Full existing fresh PostgreSQL suite including session recovery: **72/72 PASS**, skip0; separate database/process restart recovery PASS. Its receipt chain remains TestChain; the four Chrome cases above use actual EVM receipts.
- Full frontend DOM+ABI suite: **663/663 PASS**, skip0.
- Default server suite: **330 PASS / 72 DB-gated skips**; the gated suite is separately executed above, not counted twice.
- Typecheck, build, security, strict browser-entry typecheck and whitespace PASS. Existing token violations7 and build chunk warnings remain; no hard story violations.
- Review was performed by the implementing root in this turn. No separate independent-agent review is claimed.

The normal browser regression passed **19/19 assertion groups**, exit0 (`browser-regression.log`). Lifecycle checks passed **3/3**, exit0 (`lifecycle.log`): ready SIGINT, actual held response SIGTERM, injected failure. These use separate owned stacks and evidence paths. The lifecycle checker clears an inherited known-hash selector; this run intentionally supplied it to the checker and verified that the fixed child cases still execute correctly. `summary.json` contains the final results and independent OS/TCP cleanup checks for both successful browser runs and the PostgreSQL suite.

Recovery run cleanup: parent92247, Chrome92346, PostgreSQL92299, EVM group92265; temporary directory `/private/tmp/stocks-local-stack-0co44c` removed after success. PostgreSQL suite `/private/tmp/stocks-submissions-pg-Pvc0cP/harness-evidence.json` records `stopped:true`, `tcp:false`, one restart, owned PIDs93973/94172. Logs contain no session tokens, signatures or private keys. No public RPC, physical wallet, real securities or public contract deployment was used.

Normal browser regression temporary directory `/private/tmp/stocks-local-stack-LAB4EJ` was also removed; its Chrome/API/PG/EVM processes and ports were checked absent after exit. Lifecycle children independently confirmed absent Chrome94255/94342/94454, PG94213/94299/94412 and EVM groups94193/94280/94374, closed API/bridge/RPC ports and missing PG PID files/sockets. No test service remains running.

## UI handoff

Use [the Claude implementation prompt](../tasks/giwa-stocks-known-hash-ui-003d-20260918.md). The first UI scope retains only an original, wallet-returned hash and immutable claim metadata in memory, filtered by wallet/chain/API/origin/deployment. It preserves the old gate's rejection and requires an explicit user action with a new same-owner session. It provides no guessed/manual hash, automatic retry, new claim, fresh transaction or token persistence. Reload persistence is deferred and must be honestly reported. Codex will integrate and validate the implemented recovery buttons against this backend contract.

Reproduction is documented in [the local runner README](../../scripts/stocks-local/README.md). The stable conclusion is backend readiness for this narrowly defined recovery UI, not end-user recovery feature completion or an Ondo-equivalent production trading service.
