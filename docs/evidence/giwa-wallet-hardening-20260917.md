# GIWA-STOCKS-WALLET-HARDENING-003A-1 — evidence

Local builder candidate for independent Codex review. It is not integration approval, does not connect a real wallet, and does not enable public trading.

No push, merge, deployment, wallet signature, transfer, public RPC, database or dependency install took place. Every wallet, server and network below is an explicit in-process fake or real server code running in-process. The only child processes are local Node processes for the locale tests, which receive only `PATH`, `TMPDIR`, `LANG`, `LC_ALL` and `TZ`.

Plan (written before code): `docs/tasks/giwa-wallet-hardening-20260917.md`.

## Bases, roles, environment

| Item | Value |
| --- | --- |
| Claude 003A | `/private/tmp/arco-giwa-wallet-api-integration-20260917` @ `4e02a0e20d4dae5c5069275f1952a948a7d4f752` (read only; HEAD unchanged, clean) |
| Backend | `/private/tmp/arco-giwa-submission-diagnostics-20260917` @ `c97c5c9775572ace1d5510356c2f710b562c364f` (read only; unchanged, clean) |
| Backend locale fix | `/private/tmp/arco-giwa-canonical-locale-20260917` @ `dc43e750eab3ef839d86a340212397c7c8d57b5b`, child of `c97c5c9` (read only; unchanged, clean) |
| Work clone / branch | `/private/tmp/arco-giwa-wallet-hardening-20260917`, `codex/giwa-wallet-hardening-20260917`, cloned at `dc43e75` |
| Integration merge (exact base) | `5057a201598b53bd9210d88f06b4806685fdc095`: `--no-ff` merge of exact `4e02a0e` onto `dc43e75`, no conflicts |
| Review checkpoint | `7aef44313936311efa8115430e9771b61ebd02b3` (reviewed by the builder-side workflow below) |
| Final commit | The commit containing this file. Its SHA is in the handoff, because a file cannot contain its own commit SHA |
| Not used | `/private/tmp/arco-giwa-wallet-003a-combined-review-20260917`: not copied or modified. No file there (outside `node_modules`/`.git`) is newer than this clone's creation |
| Commander | user / conductor (003A-1 prompt) |
| Builder | Claude Code, session `local_adcc4340-7e91-44cb-a754-5453f2af4e11`, conversation `beb6fdbb-2740-48ec-948b-f6ffddadbd9f`, `claude-opus-5` |
| Independent reviewer | Codex (pending). The builder-side sub-agent review and every check below are **not** independent review |

Environment (untracked, ignored):
- `node_modules` is a symlink to `/private/tmp/arco-giwa-preflight-20260917/node_modules`, whose `package-lock.json` is byte-identical.
- `packages/contracts/artifacts` is copied from `/private/tmp/arco-giwa-canonical-locale-20260917`.
- DOM runtime: `GIWA_HOST_DOM_RUNTIME=/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json`.
- ABI artifacts: `GIWA_STOCKS_ARTIFACTS=<clone>/packages/contracts/artifacts/stocks`.
- Node `v24.14.0`, ICU `78.2`. Real `en_US.UTF-8`, `cs_CZ.UTF-8` and `sk_SK.UTF-8` locales are installed.

External evidence directory: `/private/tmp/arco-giwa-wallet-hardening-evidence-20260917/`

| Directory | Contents |
| --- | --- |
| `failure-first/` | Baseline, before-fix runs on `5057a20`, the ported reviewer clock probe |
| `mutation/` | Mutation run at the checkpoint (17, superseded) |
| `checkpoint-7aef443/` | All checks and probes at the checkpoint |
| `review-fixes-before/` | Post-review regressions run on `7aef443` production code |
| `mutation-final/` | 27 mutations on the final code |
| `final/` | Logs + `.exit` files, `probes/` |

Builder review workflow output:
- `/private/tmp/claude-501/-Users-whdqkf88-Desktop-arco-xrpl--claude-worktrees-dd-embedded-wallet-onboarding-87777e/beb6fdbb-2740-48ec-948b-f6ffddadbd9f/scratchpad/wallet-api/review2-full.txt`
- `review2-summary.txt` in the same folder
- finder probes under `/private/tmp/arco-giwa-wallet-hardening-review-scratch-20260917/`

## Changed files (`git diff --stat 5057a20`, 22 files with this one)

- `src/demo/giwa/stocks-wallet-http/`
  - `clock.ts`: monotone floor, remembers forward corrections, latches NaN.
  - `reads.test.tsx`: clock unit tests.
  - `controller-integration.test.tsx`: real controller + gate + adapter regressions.
  - `test-support.ts`: `setMonotonic`.
  - `README.md`
- `src/demo/giwa/stocks-wallet/`
  - `controller.ts`: policy lease, monotonic/wall bounds, display identity vs authority.
  - `types.ts`: `WalletPorts.monotonicNow?`.
  - `planner.ts`: en-US collation, `?`/`#` refusal.
  - `wallet.test.tsx`, `canonical-locale.test.tsx`, `canonical-locale-probe.ts` (test-only child).
  - `README.md`
- `src/demo/giwa/stocks-wallet-submissions/`: `client.ts` (`?`/`#` refusal), `client.test.tsx`, `README.md`.
- `src/demo/giwa/stocks-wallet-ui/`
  - `messages.ts`: `EXECUTION_AUTHORITY_CHANGED` copy.
  - `model.ts`: UNKNOWN reason line.
  - `model.test.tsx`, `controller-adapter.test.tsx`, `README.md`.
- `docs/tasks/giwa-wallet-hardening-20260917.md`, and this file.

Not changed: server, DB/Prisma, contracts, deployment registry, runtime config, dependencies/lockfile, router, `stocks-host` (auth provider), `stocks-investor`, `stocks-market`, `stocks-admin`, real wallet sources.

`git diff --name-status 5057a20 -- server packages deployments package.json package-lock.json src/demo/giwa/stocks-host src/demo/giwa/stocks-investor src/demo/giwa/stocks-market src/demo/giwa/stocks-admin` is empty.

## Two kinds of PASS

- **Regression tests with normal expectations** (in the repo) assert the safe behavior. They fail on `5057a20` and pass on the final code.
- **The reviewer's probes** are ported into the evidence directory; only the import paths changed (`diff` shows path lines only). The originals were not modified.
  - The clock probe asserts the normal expectation (0 wallet requests), so it goes fail → pass.
  - The controller probe's lease tests assert the **defect** ("known expiry/renewal clears SIGNING"). Those 8 now **fail**, which means the defect is no longer observed. They are reported separately and are not counted as regression PASS.

## Failure first (on `5057a20`, normal expectations)

| Area | Log | Before |
| --- | --- | --- |
| Baseline full frontend | `failure-first/baseline-frontend.log` | 524/524 pass (matches Codex 524/524) |
| Reviewer clock probe, ported (4 cases) | `failure-first/review-clock-before.log` | 4/4 fail; 1 wallet request + 1 claim each; READY_TRANSFER / SUBMITTED |
| R1 clock + raw-clock policy expiry through the real controller | `failure-first/clock-policy-before.log` | 8/8 fail |
| Lease display loss (open prompt, pre-signing) | `failure-first/lease-display-before.log` | 9/10 fail; the identity-boundary test already passed, so isolation was kept |
| URL delimiters (planner, submission client) | `failure-first/url-before.log` | 2/2 fail |
| cs/sk digests | `failure-first/locale-before.log` | 4/5 fail (en-US passed) |
| All new tests at the checkpoint on old production | `failure-first/all-new-tests-on-old-production.log` | 209 tests, 28 fail |

## 1. Execution clock (`stocks-wallet-http/clock.ts`)

The clock keeps an anchor `(anchorWall, anchorMono)`. Each reading computes `floor = anchorWall + floor(mono − anchorMono)`:
- If `wall > floor`, it is a forward correction or ordinary progress: the anchor moves and `wall` is returned.
- Otherwise it returns `floor`.

A non-finite wall or monotonic reading, or a monotonic reading below the previous one, makes every later reading `NaN`. Every lifetime comparison with `NaN` fails, so no lifetime or permission is created. The README states exactly this guarantee and its limits:
- a mistaken forward jump makes leases look expired
- a clock that is wrong and never corrected cannot be fixed here

Independent clock probe (reviewer's `clock-correction.test.ts`, ported). Scenario: clock created at START−60 s, corrected to START, 15 s evidence, 4 s policy, then +6 s monotonic / +1 s wall at the final order read.

| | BUY approve | BUY submit | SELL approve | SELL submit |
| --- | --- | --- | --- | --- |
| Before (`5057a20`) | 1 request, READY_TRANSFER | 1 request, SUBMITTED | 1 request, READY_TRANSFER | 1 request, SUBMITTED |
| After (final) | 0 requests, 1 claim kept, UNKNOWN + `EXECUTION_POLICY_EXPIRED` | same | same | same |

- Logs: `failure-first/review-clock-before.log` → `final/probes/review-clock-correction.log` (4/4 pass).
- Evidence was still current in the after run (`leaseCurrent: true`), so the policy bound alone blocked it.

Repo tests:
- R1 cases through the real controller (BUY/SELL × approve/submit). Only the helper protects these runs; the controller gets no fake monotonic clock.
- `reads.test.tsx`:
  - repeated forward/backward corrections
  - an initially slow clock that is corrected
  - `Infinity`/`NaN` wall and monotonic readings
  - monotonic regression latching `NaN` forever

## 2. Controller policy bound (`stocks-wallet/controller.ts`)

- `WalletPorts.monotonicNow` is optional and defaults to `performance.now()`. Inside the controller, a non-finite or decreasing reading latches `NaN`.
- Wall readings are tracked per attempt; a lower later reading refuses.
- `bounded()` reads (15 s) use the same monotonic port.
- The lease is sampled immediately before the policy request: `monotonicUntil = startMono + min(validUntil − observedAt, validUntil − startWall)`.
  - The server's `observedAt`/`validUntil` are kept.
  - The TTL is never re-granted at receipt.
- The lease is checked:
  - after the allowance read
  - inside the claim callback, before a new claim
  - after the final order read, before SIGNING
  - after SIGNING subscribers, immediately before `requestTransaction` and outside its `try`, so a refusal records no outcome
- A3's three reconcile checks are unchanged. A consumed claim stays recovery-only.

Monotonic bound matrix. Runs BUY/SELL × approve/submit; the policy is 4 s unless noted; the controller gets fake monotonic time. After each blocked case the test rolls clocks forward, reads fresh evidence, allows the policy and repeats prepare + the action.

| Variant | Wallet requests | Claims | Screen / journal | Later allowed policy + fresh evidence |
| --- | --- | --- | --- | --- |
| expires-before-claim | 0 | 0 | BLOCKED `EXECUTION_POLICY_EXPIRED` | — |
| rollback-after-final-read (+6 s mono, +1 s wall) | 0 | 1 | UNKNOWN / REQUEST_MAY_START | 0 requests, UNKNOWN |
| slow-policy-response (3 s response while wall stalls) | 0 | 1 | UNKNOWN / REQUEST_MAY_START | 0, UNKNOWN |
| signing-subscriber (+6 s mono, +1 s wall) | 0 | 1 | UNKNOWN / REQUEST_MAY_START | 0, UNKNOWN |
| monotonic-nan | 0 | 1 | UNKNOWN / REQUEST_MAY_START | 0, UNKNOWN |
| monotonic-regression | 0 | 1 | UNKNOWN / REQUEST_MAY_START | 0, UNKNOWN |
| monotonic-regression-above-start | 0 | 1 | UNKNOWN / REQUEST_MAY_START | 0, UNKNOWN |
| wall-regression-above-start | 0 | 1 | UNKNOWN / REQUEST_MAY_START | 0, UNKNOWN |
| server-observed-before-request (1 s really left) | 0 | 1 | UNKNOWN / REQUEST_MAY_START | 0, UNKNOWN |
| long-policy-control (15 s policy) | 1 | 1 | control: reaches the wallet once | — |

Also covered:
- Policy lease ending during the prepare allowance read (BUY/SELL): BLOCKED `EXECUTION_POLICY_EXPIRED`, no ready screen.
- Only the policy ends while the approval prompt is open (BUY/SELL; evidence still current):
  - APPROVAL_SUBMITTED + hash + `EXECUTION_POLICY_EXPIRED`, no `/reconcile`.
  - An explicit prepare reaches READY_TRANSFER, with 1 wallet request in total.
- `wallet.test.tsx`:
  - bounded reads with 15 s of monotonic time, `NaN` or a regression → BLOCKED `READ_TIMEOUT`
  - policy expiry (1 ms / 15 000 ms) inside SIGNING subscribers → 0 requests, claim REQUEST_MAY_START, `EXECUTION_POLICY_EXPIRED`

Reviewer's raw-wall-clock case:
- The original controller probe's "known raw wall clock limitation" test still passes: it asserts 1 request with a raw clock. The scripted fixture only advances fake wall time, and the controller's default monotonic source is the real `performance.now()`, which never sees the 6 s.
- A variant that differs only in passing that fake time through the new port: `final/probes/review-raw-clock-monotonic-port.test.mjs`. Same fixture, 4 s policy, and SIGNING subscriber (+6 s monotonic, +1 s wall), with a raw wall clock and `f.ports.monotonicNow = () => elapsed`.

| | buy APPROVAL | buy TRANSFER | sell APPROVAL | sell TRANSFER |
| --- | --- | --- | --- | --- |
| Before (`5057a20` export) | 1 request, READY_TRANSFER / CONFIRMED | 1, SUBMITTED | 1, READY_TRANSFER / CONFIRMED | 1, SUBMITTED |
| After | 0, UNKNOWN `EXECUTION_POLICY_EXPIRED` / REQUEST_MAY_START | same | same | same |

Logs:
- `final/probes/review-raw-clock-monotonic-port-before-5057a20.{log,json}` (4/4 fail)
- `…-after.{log,json}` (4/4 pass)

## 3. Display identity vs execution authority

- **Display identity:** `digest([identity, deploymentDigest])`.
  - `identity` covers session id, session wallet, session chain, wallet address, chain, wallet source epoch, API base and the selected order.
  - `deploymentDigest` is the current `manifestDigest`, or the one last seen for the same identity while evidence is null.
- **Authority:** the full context digest, valid only while `validateContext` passes. It is checked separately and is never implied by the display.
- New actions still plan from a fresh context. Null or expired evidence cannot claim or sign.

Preserved states and blocked wallet requests (`controller-integration.test.tsx` unless noted):

| Scenario | Screen | Wallet requests | Gate / journal |
| --- | --- | --- | --- |
| Open prompt + evidence expiry or renewal. BUY/SELL × APPROVAL/TRANSFER × expiry/renewal (8) | SIGNING and stage kept during the prompt. Late hash: APPROVAL → APPROVAL_SUBMITTED + hash + `EXECUTION_AUTHORITY_CHANGED`; TRANSFER → SUBMITTED + hash (no code) | 1 (never resent) | Hash recorded through the original gate; no `/reconcile`. Explicit prepare with current evidence → READY_TRANSFER / SUBMITTED, still 1 request |
| Pre-signing: CHECKING, then expiry/renewal | IDLE (check stopped) | 0 | — |
| APPROVAL_REQUIRED, then expiry/renewal, then approve | IDLE; approve refused | 0 | 0 claims |
| Claim made, authority lost before SIGNING | UNKNOWN / APPROVAL | 0 | 1 claim, REQUEST_MAY_START |
| Claim request in flight + renewal (BUY/SELL) | IDLE, then UNKNOWN / APPROVAL `EXECUTION_AUTHORITY_CHANGED` | 0 | REQUEST_MAY_START |
| Wallet read after the approval hash + renewal (BUY/SELL) | APPROVAL_SUBMITTED + hash + `EXECUTION_AUTHORITY_CHANGED` | 1 | no `/reconcile` |
| Evidence expires between the last read and READY_TRANSFER (`wallet.test.tsx`) | never READY_TRANSFER | — | — |
| Identity boundaries with an open prompt: logout, session swap, A→B→A, same-address epoch change, API base, chain, manifest, other order, dispose, cancel (10) | Hash and plan never painted into the new scope (`txHash`/`plan` null); cancel keeps the same scope and shows APPROVAL_SUBMITTED + hash | 1 | Late hash recorded through the original gate |
| Remount during an open prompt, BUY/SELL × APPROVAL/TRANSFER | New controller shows the reserved claim as UNKNOWN without a hash; its approve/submit sends nothing; the old controller never paints the new one; explicit prepare → READY_TRANSFER / SUBMITTED | 1 | 1 claim; hash recorded through the original gate |
| UI adapter: review evidence removed while the prompt is open, BUY/SELL (`controller-adapter.test.tsx`) | SIGNING ("open in your wallet") kept with every button disabled. Late hash → APPROVAL_SUBMITTED + hash + `EXECUTION_AUTHORITY_CHANGED`, no wallet-opening button, no "nothing was sent" wording. With evidence back, an explicit check → READY_TRANSFER | 1 | 0 reconcile reads |
| UI model (`model.test.tsx`) | UNKNOWN + `EXECUTION_AUTHORITY_CHANGED` shows the reason and "Do not repeat"; APPROVAL_SUBMITTED with either stop code shows "Approval sent — check needed"; no wallet-opening button; no completion wording | — | — |

Not done anywhere:
- claim deletion, history reset or a new idempotency key
- the accepted order stays pinned and `serverOrder` stays separate
- a tx hash or receipt is never shown as completion
- the A1/A2 wording is unchanged

Reviewer controller probe on the final code (`final/probes/review-controller-probe.log`, 18 tests, exit 1):
- 6 "missing reconcile" tests pass: A3 is preserved.
- 4 "raw wall clock limitation" tests pass (see section 2).
- 8 "known expiry/renewal clears SIGNING" tests **fail**, every one at `cleared.status`: actual `SIGNING`, expected `BLOCKED`/`IDLE`. The defect they document is no longer observed. The checkpoint result was identical.

## 4. en-US collation

- `planner.ts` `canonical()` sorts with `a.localeCompare(b, "en-US")`, the same as backend `server/src/stocks/contracts.ts:91` at `dc43e75`. There is no code-unit sort.
- Vectors are imported directly from `server/src/stocks/canonical-locale-fixtures.ts`: 13, frozen from `c97c5c9`, en-US, Node 24.14.0 / ICU 78.2. They are not regenerated.
- Each real child process checks:
  - every vector's canonical form, digest, and digest after key reordering (39 checks)
  - BUY `planOrder` approval/transfer/intent array against the vectors
  - SELL `planOrder` against server `deriveOrder` (canonical form, digest, intentKey), compared separately
  - `readDeployment` accepting en-US evidence
  - the actual server plugin DTO → read adapter → planner roundtrip (`server-roundtrip.test.tsx`, TAP `# pass 5`/`# fail 0`) for cs-CZ and sk-SK

| Process locale (resolved by `Intl`) | Before (`5057a20`) | After |
| --- | --- | --- |
| en-US | 0 failures, adapter ACCEPTED | 0 failures, adapter ACCEPTED |
| cs-CZ | 21 failures: 6 vectors × 3 checks (manifest, approval/transfer transactions, authorizedCall, receiptProof, extended-manifest counterexample), both `planOrder` calls threw, adapter `REJECTED:MANIFEST_DIGEST_MISMATCH`; roundtrip failed | 0 failures, adapter ACCEPTED, roundtrip 5/5 |
| sk-SK | same 21 failures as cs-CZ | 0 failures, adapter ACCEPTED, roundtrip 5/5 |

- Negative control: with the default locale, cs/sk key order differs from the golden order (`defaultLocaleOrderMatchesGolden: false`); en-US matches.
- ABI digest, operation keys, intents, payloads and calldata are unchanged: the existing golden/ABI tests pass, including the artifact round-trip in the DOM + artifacts run.
- Old records are neither accepted nor re-created.
- Limit: this is parity with the backend's ICU en-US collation, verified on Node v24.14.0 / ICU 78.2. It is not a claim of a universal ICU or cross-engine standard.

## 5. API base delimiters

`planner.validateContext` and `createSubmissionGate` refuse any base whose normalized `href` contains `?` or `#`, as the read transport does. Nothing is stripped.

| Case | Before | After |
| --- | --- | --- |
| Bare `?` or `#` | Accepted | Refused |
| `?x=1`, `#x` | Refused (unchanged) | Refused |
| Credentials, disallowed scheme | Refused (unchanged) | Refused |

- Every refused case makes 0 fetch calls.
- Origin, path prefix and trailing-slash bases still work.
- Before: `failure-first/url-before.log` 2/2 fail.

Out of ownership, not changed (003B / separate assignment):
- `stocks-host/session.ts` (auth provider), `stocks-investor/client.ts` and `stocks-market/client.ts` still use `url.search`/`url.hash`, so they accept a bare `?`/`#`.
- `stocks-admin/client.ts` does not validate the base.

## Builder-side review of checkpoint `7aef443` (not independent review)

A four-lens adversarial workflow (authority/display, policy/clock, locale/URL, tests/docs) ran with one skeptic verifier per finding. It returned 16 findings: none refuted, none P0/P1.

| Finding | Severity / verdict | Resolution |
| --- | --- | --- |
| policy-clock-1 = tests-docs-1: monotonic regression above the policy start still reaches the wallet; README said it cannot | P2 CONFIRMED | Controller monotonic latch + per-attempt wall high-water; variants `monotonic-regression-above-start`, `wall-regression-above-start` |
| tests-docs-2 = policy-clock-3: approval answered after its policy expired becomes READY_TRANSFER with no click | P2 CONFIRMED / P3 PLAUSIBLE | Stops at the hash with `EXECUTION_POLICY_EXPIRED`; BUY/SELL tests |
| authority-display-01: READY_TRANSFER published after authority lost | P3 CONFIRMED | `state()` refuses unrecorded statuses when `authorityLost`; race test |
| authority-display-02: authority loss during the post-hash wallet read shows "confirming" | P3 CONFIRMED | Shows APPROVAL_SUBMITTED + `EXECUTION_AUTHORITY_CHANGED`; test |
| authority-display-03: claim in flight during authority change shows "Not checked yet" | P3 CONFIRMED | `attempted` remembered in the claim callback; fenced claim published as UNKNOWN; test |
| authority-display-04, tests-docs-5: docs said session expiry keeps the attempt on screen | P3 CONFIRMED | Docs: `stocks-host` clears the session, so the screen resets like logout (hash still recorded) |
| authority-display-05: submitted deposit/escrow says "did not continue" | P3 PLAUSIBLE | TRANSFER after authority change shows plain SUBMITTED |
| policy-clock-2: policy expiry inside a SIGNING subscriber persists UNKNOWN outcome without a request | P3 CONFIRMED | Refusals moved before the dispatch `try`; claim stays REQUEST_MAY_START |
| locale-url-1: other clients accept bare `?`/`#`; admin checks nothing | P3 CONFIRMED | Out of ownership; documented above and in the READMEs/task doc |
| tests-docs-3: cs/sk roundtrip depends on the spec reporter (Node 22 CI) | P3 CONFIRMED | Explicit `--test-reporter=tap` |
| tests-docs-4: `validUntil − startedWall` term and after-allowance check removable | P3 CONFIRMED | `server-observed-before-request` variant and allowance-read test; mutations C6/C7 killed |
| tests-docs-6: UI README row wrong for UNKNOWN | P3 CONFIRMED | UNKNOWN adds the reason line; README row; model test |
| tests-docs-7: remount boundary missing | P3 CONFIRMED | Remount test (BUY/SELL × APPROVAL/TRANSFER) |

Post-review regressions on `7aef443` production code: the current test files copied onto a `git archive 7aef443` export (`review-fixes-before/post-review-tests-on-7aef443-production.log`).
- 99 tests: 79 pass, 19 fail, 1 skip.
- 18 failures are behavioral:
  - 4 SIGNING-subscriber policy tests
  - 4 monotonic matrices
  - 4 TRANSFER lease-display tests
  - 2 policy-only approval tests
  - 2 in-flight authority tests
  - the READY_TRANSFER race
  - the UI model test
- 1 failure is an artifact of the partial export: the ABI test could not open `packages/contracts/contracts/stocks/StocksFundingVault.sol`.
- The remount and allowance-read tests already passed on `7aef443`. They add coverage and are proven by mutations.

## Mutation checks (final code; `mutation-final/summary.txt`)

Each mutation was applied to the file, the listed tests were run, and the file was restored and verified by SHA-256.

| Result | Mutations |
| --- | --- |
| **27 / 27 killed**, 0 survived | K1 no re-anchor · K2 freeze at last max · K3 no NaN latch · K4 monotonic regression ignored · C1 wall-only policy · C2 lease anchored at receipt · C3 no check after SIGNING subscribers · C4 no check before claim · C5 `bounded` ignores monotonic · C6 no `validUntil − startedWall` term · C7 no check after allowance · C8 controller monotonic regression not latched · C9 wall high-water ignored · C10 subscriber refusals inside `try` · C11 approval continues after policy expiry · D1 evidence in display key · D2 continue after authority lost · D3 keep unrecorded ready screens · D4 manifest not in display · D5 claim remembered late · D6 `state()` allows READY_TRANSFER after authority lost · D7 post-hash wallet read error swallowed · D8 fenced claim not shown · M1 UNKNOWN reason missing · L1 default-locale sort · U1 planner allows bare `?`/`#` · U2 submission client allows bare `?`/`#` |

## Final checks (working tree identical to the final commit except this file)

Logs: `final/`

| Check | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | no errors |
| `npm run build` | 0 | built; only Vite's existing chunk-size warning |
| `npm run test:frontend` with DOM runtime + ABI artifacts | 0 | 558 tests, 558 pass |
| `npm run test:frontend`, CI-like (both gates unset) | 0 | 533 tests: 530 pass, 3 skip (2 DOM gates, 1 artifact gate) |
| `npm run test:server` | 0 | 398 tests: 330 pass, 68 skip (DB) |
| `npm run test:security` | 0 | env exposure and evmVersion checks passed |
| `npm run design:tokens` | 1 | the 7 known baseline findings, all in `Investor.tsx`/`components.tsx`, none in changed files |
| `npm run design:stories` | 0 | no hard violations (3 soft) |
| `git diff --check` and `git diff --check 5057a20` | 0 / 0 | clean |
| Stocks-wallet modules ×3 (DOM + artifacts) | 0 / 0 / 0 | 218/218 each |
| Reviewer clock probe (ported) | 0 | 4/4 pass, 0 wallet requests |
| Reviewer controller probe (ported) | 1 | 10 pass; the 8 defect-observing tests fail as described in section 3 |
| Monotonic-port variant of the reviewer raw-clock case | 0 | 4/4 pass (was 4/4 fail on `5057a20`) |

Reference numbers:
- Codex at `c97c5c9`: frontend 524/524, server 327 pass / 68 DB skip.
- Locale backend `dc43e75`: server 330 / 68.
- Baseline on `5057a20`: frontend 524/524.
- Checkpoint `7aef443`: frontend 550/550, CI-like 522 + 3 skip, server 330 / 68, modules 210 ×3.

## Remaining for 003B and review

- **Codex independent review of this commit is pending.** P0/P1 findings block integration.
- Real wallet ports: EIP-1193 provider, account/chain events and wallet source epoch. Also the `/stocks` panel mount and routing.
- Host composition:
  - `createExecutionClock()` for `ports.now`, the read adapter and the submission gate
  - `monotonicNow` for the controller (default `performance.now()`)
  - one clock pair per controller lifetime, with a remount after a latched clock
- API base validation in `stocks-host/session.ts`, `stocks-investor/client.ts`, `stocks-market/client.ts` (bare `?`/`#`) and `stocks-admin/client.ts` (none). These are outside this ownership and involve the auth provider.
- Collation parity was verified on Node 24.14.0 / ICU 78.2 only. The golden vectors should also run in the target browsers and on the CI Node 22 ICU before connecting.
- Session expiry: `stocks-host` clears the session and the panel resets like logout. The hash is still recorded but not shown on the new screen, so a recovery view for that case is a 003B product decision.
- The new stop copy (`EXECUTION_AUTHORITY_CHANGED`, `EXECUTION_POLICY_EXPIRED`) is English only.
- A device clock that is wrong and never corrected cannot be fixed on the client. A mistaken forward jump makes leases look expired until real time catches up.
- Not ready for real wallet connection or public trading.
