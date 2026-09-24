# GIWA-STOCKS-WALLET-INTEGRATION-003A — evidence

Local builder candidate for independent Codex review. This is not an integration approval.

No push, merge, deployment, wallet signature, transfer, public RPC, database or dependency install took place. Every "request", "wallet" and "server" below is an explicit fake, or the real server code run in-process through `app.inject`.

## Bases, roles, environment

| Item | Value |
| --- | --- |
| Backend base | `/private/tmp/arco-giwa-runtime-status-20260917` @ `97b2a2ad08cbbd98b1e2404501d10d734ec9fcf5` (read only, unchanged) |
| UI candidate | `/private/tmp/arco-giwa-stocks-wallet-ui-20260917` @ `68bb1ec0fad92fca6e53c1d26131ee4abf97a975` (read only, unchanged) |
| Work clone / branch | `/private/tmp/arco-giwa-wallet-api-integration-20260917`, `codex/giwa-wallet-api-integration-20260917` (a new path; no earlier clone existed) |
| Integration merge | `1a71d7e`: `--no-ff` merge of exact `68bb1ec` onto `97b2a2a`, no conflicts |
| Review checkpoint | `1ae7654` (reviewed by the builder-side workflow below) |
| Not used | `/private/tmp/arco-giwa-wallet-ui-combined-review-20260917` |
| Builder | Claude Code, session `local_adcc4340-7e91-44cb-a754-5453f2af4e11`, conversation `beb6fdbb-2740-48ec-948b-f6ffddadbd9f`, `claude-opus-5` |
| Independent reviewer | Codex (pending). The builder-side sub-agent review below is **not** independent review |

Environment (untracked):
- `node_modules` is a symlink to `/private/tmp/arco-giwa-preflight-20260917/node_modules`, whose `package-lock.json` is byte-identical.
- `packages/contracts/artifacts` is copied from the backend base.
- DOM runtime `GIWA_HOST_DOM_RUNTIME=/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json` (present).
- ABI gate `GIWA_STOCKS_ARTIFACTS=<clone>/packages/contracts/artifacts/stocks`.

External evidence directory: `/private/tmp/arco-giwa-wallet-api-integration-evidence-20260917/`
- `failure-first/`
- `after-fix/`
- `mutation/` (A3 checks)
- `pre-review/`
- `builder-review/` (workflow script, full result JSON, summary)
- `review-fixes/` (copy failure-first, `mutation/`)
- `final/` (logs + exit files, `probes/`)

## Changed files (`git diff --stat 1a71d7e`)

- `src/demo/giwa/stocks-wallet/controller.ts`: trusted-reconcile precondition (A3).
- `src/demo/giwa/stocks-wallet/wallet.test.tsx`: A3 regressions; one matrix entry removed and one test rewritten (see below).
- `src/demo/giwa/stocks-wallet/README.md` and `types.ts` (**doc/comment only**): the approve precondition, the backend/adapters now existing, SELL rows carrying `side`. Flagged because the ownership list named only the controller and its tests.
- `src/demo/giwa/stocks-wallet-ui/model.ts`, `messages.ts`: A1/A2 wording and review follow-ups.
- `src/demo/giwa/stocks-wallet-ui/model.test.tsx`, `controller-adapter.test.tsx`, `panel.dom.test.tsx`: regressions and updated expectations.
- `src/demo/giwa/stocks-wallet-ui/README.md`, `adapter.ts` (comment): integration status and host contract.
- `src/demo/giwa/stocks-wallet-http/`: all new — `errors.ts`, `validate.ts`, `transport.ts`, `reads.ts`, `clock.ts`, `index.ts`, `README.md`, `test-support.ts`, `reads.test.tsx`, `controller-integration.test.tsx`, `server-roundtrip.test.tsx`.
- `docs/tasks/giwa-wallet-api-integration-20260917.md`, and this file.

Not changed:
- server, Prisma/DB, contracts, deployment registry, dependencies/lockfile
- stocks-host / login provider, router and routes, real wallet sources, runtime config
- `stocks-wallet-submissions`, `stocks-investor`, `planner.ts`

## A1/A2 — panel wording (reproduced before, fixed after)

**Failure first.** On the unmodified merge `1a71d7e`:
- The review's own probe, copied with its paths rewritten to this clone and its output redirected here, fails **4/4**: `failure-first/review-probe-before.log`, `review-probe-results-before.json`.
- The new regressions in `controller-adapter.test.tsx` fail **6/6**: `failure-first/a1-a2-before.log`. They use the real controller and scripted ports, for BUY/SELL:
  - cancel after a confirmed approval
  - pending approval then an explicit check
  - recorded deposit/escrow with no, non-final and final server results

**Root causes.**
- The unchanged controller publishes `APPROVAL_SUBMITTED / RECOVERY_REQUIRED`:
  - after `cancel()` for an approval already `CONFIRMED`
  - in the `run` catch after an explicit check whose verification is still pending. The catch overwrites `RECEIPT_PENDING`.
  - after a failed hash record
  - for a prior approval found during approve or submit
- The model rendered `SUBMITTED / RECOVERY_REQUIRED` as "no final result" regardless of the matching injected server status.

**Fix** (`model.ts`):
- "Not confirmed" wording only for no code or `RECEIPT_PENDING`.
- `RECOVERY_REQUIRED` gets neutral "Approval sent — check needed" with "the approval's status needs another check…". It promises no deposit/escrow after the deadline or for a moved-on order.
- For a recorded transfer the sentence follows the matching server status:
  - final (`COMPLETED`, BUY `REFUNDED`, SELL `RETURNED`)
  - not final yet
  - unrecognized
  - none shown
- A final result suppresses the late-inclusion and "unresolved" paragraphs. `UNKNOWN` on the transfer stage follows the same rule, including its title.
- A txHash is never a completion signal.

**After.**
- Review probe **4/4** pass (`final/probes/review-probe-final.log`).
- The regressions pass.
- Copy follow-ups from the builder review fail on `1ae7654` (`review-fixes/copy-before.log`, 2/2 fail) and pass now.

**Known effect.** After an explicit check that still finds the approval pending, the panel shows the neutral "check needed" text, not "confirming". The controller's catch replaces `RECEIPT_PENDING`; changing that is controller work outside 003A.

## A3 — controller precondition (reproduced before, fixed after)

**Failure first.** On `1a71d7e`, the 7 new `wallet.test.tsx` regressions fail (`failure-first/a3-before.log`):
- direct prepare→approve without reconcile, BUY/SELL: wallet 1, claim 1
- removal after prepare, during the allowance read, during the pre-claim wallet read, during the claim, or in a SIGNING subscriber
- a captured gate versus a replacement installed mid-attempt

The contract review's probe scenario on this clone gives wallet 0, claim 0, record 0, `BLOCKED / TRUSTED_RECONCILIATION_REQUIRED` for BUY and SELL (`after-fix/missing-reconcile-after.log`, rerun in `final/probes/`).

**Fix.** `reconcilable(a, "APPROVAL")` checks the attempt's **captured** gate at three points:
1. Inside the claim callback, just before `claim()`. Nothing is claimed.
2. After the final order re-read, before SIGNING.
3. After SIGNING subscribers ran, just before the wallet request.

After a claim, the reserved claim stays `REQUEST_MAY_START`: never deleted, released or re-opened, and no outcome is recorded. The attempt is `UNKNOWN / TRUSTED_RECONCILIATION_REQUIRED`, which is recovery-only.

Unchanged:
- read-only recovery of existing hashes
- late outcomes through the original gate
- terminal history
- no automatic deposit/escrow
- the panel availability guard

Test updates:
- The `missing` entry of the reconciliation matrix was removed; the new tests cover it.
- "Outstanding approval requires server reconciliation" was rewritten: approval first with pending verification, then removal, then recovery once reconcile is back.
- The panel adapter test that pinned the old direct-call gap now asserts 0 requests and 0 claims for BUY and SELL.

**Mutation.** On the final code each of the three checks removed alone is caught (claim callback: 6 failing tests; before SIGNING: 2; after SIGNING subscribers: 2) — `review-fixes/mutation/A3-final-summary.txt`. The earlier `mutation/summary.txt` covers the checkpoint placement. The builder review found two further gaps, and both are now fixed and mutation-checked:
- A planned "before wallet read" check could not be told apart from check 1 by any test, so it was dropped.
- A check originally inside the dispatch `try` recorded a spurious UNKNOWN outcome, so it was moved before the `try` (`review-fixes/mutation/R9`).

## B — `stocks-wallet-http` read adapter

`createStocksExecutionReads({ apiBase, fetch?, now?, monotonicNow?, timeoutMs?, onSessionRejected? })`:
- `readDeployment` → a lease `{ deployment, sessionId, apiBase, receivedAt, monotonicDeadline }`, with `currentDeployment(lease)`
- `readExecutionPolicy` → the server `ExecutionPolicy`, times unchanged
- `readOrder` → the **original envelope with PROFILE**
- `readCatalog` → the public top-level DTO, without Authorization

`createExecutionClock()` is a wall clock that never runs behind monotonic time, for `ports.now` and the adapter. Full rules are in `src/demo/giwa/stocks-wallet-http/README.md`.

**Actual DTO proof** — `server-roundtrip.test.tsx`, 5 tests. It runs the real Fastify `stocksExecutionPlugin` + `StocksExecutionService` and `stocksPlugin` + `StocksService` over an in-memory SQL fake, through `app.inject`.
- Evidence, BUY/SELL policy, BUY/SELL order envelopes (SELL rows carry `side: "SELL"`) and the catalog pass unchanged.
- The browser manifest digest equals the server digest.
- The planner derives the same intent and calldata as the server `deriveOrder`.
- The real controller completes a read-only check to `APPROVAL_REQUIRED` over these reads.
- Real denials map to fixed codes: 401 → `SESSION_REJECTED` + captured id; policy 404/503 → `EXECUTION_NOT_ALLOWED`; order 404 → `REQUEST_FAILED`; failed evidence → `DEPLOYMENT_NOT_REVIEWED`.

**Controller integration** — `controller-integration.test.tsx`, 13 tests: real controller + real `createSubmissionGate` + adapter over in-memory HTTP.
- BUY/SELL evidence → check → exact approval → reconciliation → separate transfer.
- PROFILE-loss regression: the investor `getOrder()` result gives `ORDER_PROFILE_MISMATCH` with 0 requests; the adapter envelope gives `APPROVAL_REQUIRED`.
- Late 401 after A→B: B stays signed in; only `session-a` is ever invalidated; nothing is painted.
- A catalog 401 signs nobody out.
- Evidence expiry during a check; refresh during an open prompt: no re-sign, the late hash stays on the original claim.
- Cached identical evidence cancels nothing.
- Cross-deployment, cross-order, paused and missing policy: no claim, no request.
- Wall clock stepped back after the final order read, BUY/SELL × approve/submit:
  - raw clock: **1** request, the unchanged controller's limit
  - `createExecutionClock`: **0** requests, `EXECUTION_POLICY_EXPIRED`

**Unit tests** — `reads.test.tsx`, 23 tests:
- request shape: GET, bearer only on authenticated reads, `credentials: "omit"`, `no-store`, `redirect: "error"`, no body, internal linked signal
- capture before await
- invalid requests with 0 fetches, including other or empty-`?` API bases
- scope, lease and envelope rules; future, expired and >15 s leases
- evidence exactness: five code hashes; unsupported ABI, finality or upgradeability with a correct digest
- order and catalog exactness
- monotonic delay and wall rollback; lease bounds moved one clock at a time
- forged or copied leases
- timeout (fetch ignoring abort), stalled body with reader cancel, caller abort
- network error, 3xx, followed redirect, other final URL, declared and streamed oversize, non-JSON, invalid UTF-8, 204
- non-2xx mapping with exactly one request per read (no retry)
- no token, URL or server text in errors, and no console output
- fixed panel copy for every code
- source guards

## Builder-side adversarial review (not independent)

Workflow `giwa-003a-builder-review` on checkpoint `1ae7654`: six lenses, each with a skeptic verifier (12 agents). Script and full result are in `builder-review/`.

Result: 21 findings, 19 confirmed, 2 plausible, 0 refuted, 0 P0/P1.

| Finding | Verdict | Resolution |
| --- | --- | --- |
| adapter-security catalog 401 keeps status 401 → controller signs out (P2); duplicate requirements-docs-01 (P3) | CONFIRMED | Fixed: a public 401 carries `status: null`; integration test (mutation R1 killed) |
| adapter-contract-1 controller policy check is wall-clock only; rollback lets the wallet open past a 4 s policy (P2, pre-existing controller) | CONFIRMED | Mitigated in scope: `createExecutionClock` + README host contract + BUY/SELL × approve/submit regression (R8 killed). Controller-internal monotonic bound **escalated** |
| model-copy-1 evidence lease end resets SIGNING/SUBMITTED/UNKNOWN screens within ≤15 s (P2) | CONFIRMED | Documented accurately (UI + HTTP READMEs). Controller scope change **escalated to 003B/conductor** |
| adapter-contract-2 locale-dependent canonical key order (cs/sk) breaks digest parity (P3 after verification; pre-existing, `planner.ts` + server) | CONFIRMED | Out of scope; documented under Known limits; **escalated** as a separate task |
| controller-a3-01 dispatch refusal recorded as `WALLET_OUTCOME_UNKNOWN` (P3) | CONFIRMED | Fixed: check moved before the dispatch `try`; test asserts code and `REQUEST_MAY_START` (R9 killed) |
| controller-a3-02 / requirements-docs-05 task doc check points, lease API, error table, test rewrite (P3) | CONFIRMED | Task doc corrected |
| model-copy-2 neutral text promises a deposit after the deadline or move-on (P3) | CONFIRMED | Fixed (R10 killed) |
| model-copy-3 settled UNKNOWN title still "check required" (P3) | PLAUSIBLE | Fixed (R12 killed) |
| model-copy-4 unrecognized state called non-final (P3) | PLAUSIBLE | Fixed (R11 killed) |
| model-copy-5 `CONTEXT_EXPIRED` promise false once the order progressed (P3) | CONFIRMED | Copy softened; README corrected |
| model-copy-6 "confirming" after the controller silently stops verifying (P3, pre-existing controller) | CONFIRMED | Docstring and README corrected; controller change not made |
| model-copy-7 "a escrow" (P3) | CONFIRMED | Fixed (three sites) |
| adapter-security empty `?`/`#` API base (P3) | CONFIRMED | Fixed in the adapter (R2b killed). The same gap in `stocks-wallet-submissions/client.ts` is not owned; **escalated** |
| requirements-docs-02 cached evidence refresh cancels nothing (P3) | CONFIRMED | READMEs corrected; integration test added |
| requirements-docs-03 order 404 or wrong row shown as "moved on" (P3) | CONFIRMED | Fixed: `REQUEST_FAILED` / `INVALID_RESPONSE` (R3, R4 killed) |
| requirements-docs-04 stale "SELL GET rows have no side" (P3) | CONFIRMED | README and one `types.ts` comment corrected |
| tests-evidence-1..5 gaps: not-ready A1 branch, lease guards, no-retry, other ABI, `.pathname` portability (P3) | CONFIRMED | Tests added or fixed: not-ready/expired/moved-on A1 cases (the old defect text would now fail); lease guards (R5, R6 killed); request counts (R7 killed); correctly digested unsupported ABI/finality/upgradeability; `fileURLToPath` |

Review-fix mutations (`review-fixes/mutation/summary.txt`): on the first pass 11 of 12 were killed. The survivor, R2, was a doubled empty-`?` check whose second copy still caught it. After removing the duplicate, the remaining single check is killed (R2b), so every review fix is covered by a failing test.

## Checks on the final tree

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 (the existing large-chunk warning only) |
| `npm run test:frontend` with DOM runtime + artifacts | **524 / 524 pass**, 0 skip. Baseline on the unmodified merge: 467 tests, 466 pass, 1 fail (see note) |
| `npm run test:frontend` CI-like (no DOM runtime, no artifacts) | 499 tests: 496 pass, 3 skip (two DOM gates + ABI artifact gate), 0 fail |
| `npm run test:server` | 336 tests: **276 pass, 60 skip** (PostgreSQL-only), 0 fail. Matches the Codex baseline |
| `npm run test:security` | exit 0 |
| `node .claude/hooks/check-design-tokens.mjs --all` | exit 1, **7 findings** = known debt (Investor.tsx:111, components.tsx ×6); none in changed or new files |
| `node .claude/hooks/check-story-exists.mjs --all` | exit 0, no hard violations |
| `git diff --check` | clean |
| Changed and new module suites (wallet + wallet-ui + wallet-http), 3 consecutive runs | 157/157 each |

New tests: +57 (467 → 524).
- `wallet.test.tsx`: 35 → 42
- `model.test.tsx`: 17 → 20
- `controller-adapter.test.tsx`: 16 → 22
- `panel.dom.test.tsx`: 17 (expectations updated)
- `stocks-wallet-http`: 41 (23 + 13 + 5)

Note on the baseline failure: `stocks-wallet-submissions/client.test.tsx` "transport times out stalled body and cancels its reader" uses a 10 ms timeout. It failed once under full-suite load on the unmodified merge (`failure-first/baseline-frontend-merge.log`), passed in 5 isolated runs, and passed in every later full run. It is pre-existing and not owned; it was left unchanged.

## Remaining constraints and escalations

1. **Evidence lease vs. controller scope (P2).** The controller scope includes evidence ID and dates, so the ≤15 s lease ends or renews during a normal wallet flow and resets the displayed attempt (prompt, hash, warnings). Durable state is preserved and nothing re-signs. Needed for usable 003B: a controller scope on manifest digest/session/wallet/order, with guards still requiring current evidence before any claim or request. Conductor approval needed.
2. **Controller policy expiry is wall-clock only (P2, pre-existing).** Mitigated by the host using `createExecutionClock()` (tested). A monotonic policy bound inside the controller is recommended.
3. **Locale-dependent canonical JSON key order** in `planner.ts` and `server/src/stocks/contracts.ts` (cs/sk and some other locales). Fails closed; needs a coordinated code-unit comparator change with parity tests.
4. The controller's run catch replaces `RECEIPT_PENDING` with `RECOVERY_REQUIRED` after an explicit check, and `wallet()` failure after an approval hash returns silently (no code). The panel wording is now neutral or accurate; controller changes were not made.
5. `stocks-wallet-submissions/client.ts` accepts an API base with an empty `?`/`#` (same gap as fixed in the new adapter). Not owned.
6. UNKNOWN after a pre-dispatch refusal still uses the hedged "may have reached your wallet" copy. It is safe but imprecise: the journal cannot distinguish a claim whose wallet request was never started.

## 003B connection list (not done here)

- Real wallet ports through the active injected/Dynamic source:
  - `readWallet`, with network-instance and checkpoint attestation through that source
  - `readAllowance`
  - `requestTransaction`: exact `to`/`data`/`value=0`, no fallback or resubmission
- Host composition:
  - one `createExecutionClock`
  - a `createStocksExecutionReads` per API base
  - evidence lease reads and scope checks
  - `createSubmissionGate` + ports + controller per session/order/deployment scope, disposed by the owner
  - a connection epoch that changes on A→B→A and same-address source replacement
  - `invalidateSession`/`onSessionRejected` → `host.invalidate(id)`
- `serverOrder` reads and refresh policy; `selection` pinned to the accepted order row, including order-creation recovery.
- Mount `StocksWalletExecutionPanel` in the existing `/stocks` accepted-order flow.
- Resolve escalations 1–2 before relying on the flow with real wallets.
- Independent Codex verification of this candidate, then app-to-browser transport checks on a combined candidate.

Network actions performed: none (fake fetch and in-process `app.inject` only).
