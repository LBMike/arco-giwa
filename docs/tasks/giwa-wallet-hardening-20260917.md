# GIWA-STOCKS-WALLET-HARDENING-003A-1 — clock floor, controller policy bound, display vs. authority, en-US digests, URL delimiters

This plan was recorded before any code change. Local builder candidate only: no push, merge, deployment, wallet signature, transfer or public network. The real wallet ports and the `/stocks` panel mount stay in 003B.

## Bases and roles

| Item | Value |
| --- | --- |
| Claude 003A | `/private/tmp/arco-giwa-wallet-api-integration-20260917` @ `4e02a0e20d4dae5c5069275f1952a948a7d4f752` (read only) |
| Backend | `/private/tmp/arco-giwa-submission-diagnostics-20260917` @ `c97c5c9775572ace1d5510356c2f710b562c364f`, and the locale fix `/private/tmp/arco-giwa-canonical-locale-20260917` @ `dc43e750eab3ef839d86a340212397c7c8d57b5b` (child of `c97c5c9`, read only) |
| Work clone | `/private/tmp/arco-giwa-wallet-hardening-20260917`, branch `codex/giwa-wallet-hardening-20260917`, cloned at `dc43e75` |
| Integration merge | `5057a201598b53bd9210d88f06b4806685fdc095` = `--no-ff` merge of exact `4e02a0e` onto `dc43e75`, no conflicts. The backend change is server/docs only; 003A is `src/demo/giwa` + docs only |
| Not used | `/private/tmp/arco-giwa-wallet-003a-combined-review-20260917` (root verification copy) |
| Commander | user / conductor (003A-1 prompt) |
| Builder | Claude Code, session `local_adcc4340-7e91-44cb-a754-5453f2af4e11`, conversation `beb6fdbb-2740-48ec-948b-f6ffddadbd9f`, `claude-opus-5` |
| Independent reviewer | Codex (separate). Builder-side checks are not independent review |

Environment (untracked):
- `node_modules` is a symlink to `/private/tmp/arco-giwa-preflight-20260917/node_modules`, whose `package-lock.json` is byte-identical.
- `packages/contracts/artifacts` is copied from `/private/tmp/arco-giwa-canonical-locale-20260917`.

Read:
- `CLAUDE.md`
- the 003A task/evidence docs
- `docs/contracts/stocks-canonical-locale-v1.md` and `server/src/stocks/canonical-locale-{fixtures,probe}.ts` / `.test.ts`
- the independent reports:
  - `/Users/whdqkf88/.codex/worktrees/8609/arco-giwa/review-results/20260917/wallet-api-003a-review.md`
  - `/private/tmp/arco-giwa-wallet-http-review-evidence-20260917/` (clock probe)
  - `/private/tmp/arco-giwa-wallet-controller-003a-review-evidence-20260917/` (lease and raw-clock probes)
  - `/private/tmp/arco-giwa-canonical-locale-review-evidence-20260917/`

## Owned files

- `src/demo/giwa/stocks-wallet-http/`: `clock.ts`, its tests, README.
- `src/demo/giwa/stocks-wallet/`: `controller.ts`, `planner.ts`, `types.ts`, regression tests, README.
- `src/demo/giwa/stocks-wallet-submissions/`: API base validation in `client.ts`, a regression test, README.
- `src/demo/giwa/stocks-wallet-ui/`: new code copy in `messages.ts`, tests whose expectations follow the controller change, README.
- `docs/tasks/giwa-wallet-hardening-20260917.md`, `docs/evidence/giwa-wallet-hardening-20260917.md`.

Not changed:
- server, DB, contracts, registry, runtime config, dependencies
- router, auth provider (`stocks-host`), real wallet sources

`stocks-host/session.ts` and `stocks-investor/client.ts` use the same `url.search`/`url.hash` check. They are outside ownership (auth provider / investor feature); they will be reported, not changed.

## 1. Execution clock floor (`stocks-wallet-http/clock.ts`)

A monotone lower bound anchored at the latest observation.
- It keeps `(anchorWall, anchorMono)`. On each reading, `floor = anchorWall + floor(mono − anchorMono)`.
- If `wall > floor`, the reading is a forward correction or normal progress, so the anchor moves to `(wall, mono)`.
- The helper returns `max(wall, floor)`, so the value keeps advancing with monotonic time after a stall or rollback and never decreases.
- A non-finite wall or monotonic reading, or a monotonic value below the previous one, latches the helper: every later reading is `NaN` (fail closed). Recovery means creating a new clock.
- Documented cost: a mistaken forward jump makes leases look expired until real time catches up. It never creates lifetime.

## 2. Controller policy bound

- New optional `WalletPorts.monotonicNow` (default `performance.now()`). `bounded()` uses it for elapsed-time acceptance, together with the wall check.
- `preflight()` samples `(startWall, startMono)` immediately before the policy request. After validation it builds a lease:
  `monotonicUntil = startMono + min(validUntil − observedAt, validUntil − startWall)`.
  The server's `observedAt`/`validUntil` are unchanged, and the TTL is never re-granted at response time.
- `policyLive(lease)` requires:
  - finite wall and monotonic readings, not below the request start
  - `wall < validUntil` and `mono < monotonicUntil`
- It is checked:
  - after the allowance read
  - inside the claim callback (before a new claim)
  - after the final order read (before SIGNING)
  - inside the dispatch `try` right before `requestTransaction`, after SIGNING subscribers ran
- The A3 reconcile checks (claim callback, before SIGNING, after SIGNING subscribers) stay.
- A consumed claim stays recovery-only: no reopen, no retry.

## 3. Display identity vs. execution authority

Two keys replace the single `digest([context, selected])` scope.
- **Display identity:** `digest([identity, deploymentDigest])`.
  - `identity` covers session id, session wallet (lower-case), session chain, connected wallet (lower-case), chain, wallet epoch, API base and the selected order.
  - `deploymentDigest` is the current evidence's `manifestDigest`. While evidence is absent it is the digest last seen for the same identity. The retained value is cleared whenever the identity changes.
  - A different manifest digest or identity resets the display as before.
- **Execution authority:** the full context digest plus `validateContext(context, now)`. It is checked on every synchronization while an attempt is active or a planned snapshot is shown. When authority changes or becomes invalid under the same display identity:
  - an active attempt that has not dispatched a wallet request is aborted (fenced). The snapshot keeps any claimed or recorded attempt (UNKNOWN / hash, with `EXECUTION_AUTHORITY_CHANGED`) and otherwise becomes IDLE.
  - an attempt whose wallet request is already open is not fenced. SIGNING stays on screen, the late hash is recorded through the original gate and shown, and the attempt stops before any follow-up read (no reconcile → READY_TRANSFER), publishing the hash state with `EXECUTION_AUTHORITY_CHANGED`.
  - with no active attempt, recorded states (SIGNING, APPROVAL_SUBMITTED, SUBMITTED, UNKNOWN, BLOCKED with stage, or any hash) are kept. Authority-bearing unrecorded states (CHECKING, APPROVAL_REQUIRED, READY_TRANSFER, error-only BLOCKED) become IDLE, so a preserved display is never permission.
- New actions still plan from a fresh `ports.context()` and fail with null or expired evidence.
- `CONTEXT_EXPIRED` is no longer produced by the controller.
- Isolation boundaries kept: logout, session replacement, A→B→A, same-address epoch change, API, chain, manifest, other order, dispose and cancel.
- The accepted order stays pinned; `serverOrder` and the A1/A2 wording are unchanged.

## 4. en-US collation in the planner

- `planner.ts` `canonical()` sorts keys with `localeCompare(b, "en-US")`, matching backend `dc43e75`. No code-unit sort. ABI digest, operation keys, intents, payloads and calldata are unchanged.
- Test: fresh Node processes with real `LANG`/`LC_ALL` en-US, cs-CZ and sk-SK, asserting the resolved `Intl` locale. They apply the frozen backend vectors (`server/src/stocks/canonical-locale-fixtures.ts`, not regenerated) to the browser `canonical`/`digest`:
  - BUY `planOrder` approval/transfer/intent against the vectors
  - SELL `planOrder` against server `deriveOrder`
  - the read adapter accepting en-US evidence under cs/sk
  - a default-locale negative control showing cs/sk really reorder keys

## 5. API base delimiters

- `planner.validateContext` and `createSubmissionGate` also refuse any base whose normalized `href` contains `?` or `#`, as the read transport does. Nothing is stripped.
- Tests: bare `?`/`#`, query/fragment values, credentials and a disallowed scheme each make 0 network calls. Origin, path prefix and trailing slash still work.

## Verification plan

Failure first, on merge `5057a20`, using the normal expected assertions:
- the reviewer's 4 clock cases, ported into the repo
- raw-clock policy expiry through the real controller (BUY/SELL × approve/submit)
- lease expiry/renewal display loss (SIGNING open, hash, no automatic READY_TRANSFER)
- URL delimiters (planner, submission client)
- cs/sk digest parity

Then fix, add mutation checks and run the full suite:
- typecheck, build
- `test:frontend` with `GIWA_HOST_DOM_RUNTIME=/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json` and `GIWA_STOCKS_ARTIFACTS=<clone>/packages/contracts/artifacts/stocks`
- CI-like `test:frontend`, `test:server`, `test:security`
- token, story and whitespace checks

Reference (Codex): frontend 524/524, server 327 pass / 68 DB skip at `c97c5c9`; the locale backend reports 330 pass / 68 DB skip. Existing token findings: 7.
