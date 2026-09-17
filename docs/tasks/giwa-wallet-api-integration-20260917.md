# GIWA-STOCKS-WALLET-INTEGRATION-003A — wallet UI on the current backend, review fixes, authenticated read adapter

This plan was recorded before any code change. Local candidate only: no push, merge, deployment, wallet signature, transfer or public network.

## Bases and roles

| Item | Value |
| --- | --- |
| Backend base | `/private/tmp/arco-giwa-runtime-status-20260917` @ `97b2a2ad08cbbd98b1e2404501d10d734ec9fcf5` (read only) |
| UI candidate | `/private/tmp/arco-giwa-stocks-wallet-ui-20260917` @ `68bb1ec0fad92fca6e53c1d26131ee4abf97a975` (read only) |
| Work clone | `/private/tmp/arco-giwa-wallet-api-integration-20260917`, branch `codex/giwa-wallet-api-integration-20260917`, cloned from the backend base |
| Integration commit | `1a71d7e` = `--no-ff` merge of exact `68bb1ec` onto `97b2a2a`. No conflicts: the UI adds 21 new files, and `src` shared by both is identical |
| Not used | `/private/tmp/arco-giwa-wallet-ui-combined-review-20260917` (Codex verification copy) |
| Commander | user / conductor (GIWA-STOCKS-WALLET-INTEGRATION-003A prompt) |
| Builder | Claude Code, desktop session `local_adcc4340-7e91-44cb-a754-5453f2af4e11`, conversation `beb6fdbb-2740-48ec-948b-f6ffddadbd9f`, model `claude-opus-5` |
| Independent reviewer | Codex (separate session). Builder-side sub-agent review is not independent review |

Environment (untracked, not committed):
- `node_modules` is a symlink to `/private/tmp/arco-giwa-preflight-20260917/node_modules`. Its `package-lock.json` is byte-identical, which is the same link the backend base uses. No install.
- `packages/contracts/artifacts` is copied from the backend base, for the ABI artifact gate and server tests.

## Read first

- `CLAUDE.md`
- The contracts `docs/contracts/stocks-execution-v1.md`, `stocks-wallet-submissions-v1.md` and `stocks-order-recovery-v1.md`
- The READMEs of `stocks-wallet`, `stocks-wallet-ui`, `stocks-wallet-submissions` and `stocks-host`
- Server sources `server/src/stocks-execution/{plugin,service,deployment,contracts}.ts`, `server/src/stocks/{plugin,repository,service}.ts` and `prisma/schema.prisma` (order rows)
- Review evidence
  - `/private/tmp/arco-giwa-wallet-ui-model-review-evidence-20260917/` (A1/A2 probe, 4 failing cases)
  - `/private/tmp/arco-giwa-wallet-ui-contract-review-evidence-20260917/` (DTO mapping, missing-reconcile probe)

## Owned files

1. `src/demo/giwa/stocks-wallet-ui/` — `model.ts`, the tests covering the two wording defects (`model.test.tsx`, `controller-adapter.test.tsx`, `panel.dom.test.tsx` where it asserts the old wording), `README.md`, and comments that describe the old controller gap (`adapter.ts`).
2. `src/demo/giwa/stocks-wallet/controller.ts` — trusted-reconcile precondition only. Regression tests in `wallet.test.tsx`; the README note about the gap. Types are not expected to change.
3. New `src/demo/giwa/stocks-wallet-http/` — read-only HTTP adapter, validation, tests, README.
4. `docs/tasks/giwa-wallet-api-integration-20260917.md` (this file) and `docs/evidence/giwa-wallet-api-integration-20260917.md`.

Not changed:
- server, DB/Prisma, contracts, deployment registry, dependencies/lockfile
- `stocks-host` (login provider), routes and router, real wallet sources, runtime configuration
- `stocks-wallet-submissions` (reused as is), `stocks-investor` (validators reused by import only)
- `planner.ts` and `types.ts` (unless a minimal type proves necessary)

## A1 — ambiguous `APPROVAL_SUBMITTED / RECOVERY_REQUIRED`

The controller publishes this pair in four situations:
- cancel of any attempt that knows an approval, **including an already CONFIRMED one**
- a failed hash record
- a prior approval found during approve or submit
- the `run` catch after an explicit check whose server verification is still pending. The catch overwrites `RECEIPT_PENDING`.

So the pair does not prove the approval is unconfirmed.

Change in `model.ts`:
- `approvalAwaitingConfirmation` is true only for `error === null` (wallet just answered; verification in flight) and `RECEIPT_PENDING`.
- `RECOVERY_REQUIRED` gets the neutral title "Approval sent — check needed" and a neutral paragraph: the approval status needs another check before the deposit or escrow can be offered, and nothing is sent again.
- Step detail "Approval sent". Hash, disabled wallet actions and the read-only check button stay unchanged.

Known effect: after an explicit check with a pending server verification, the unchanged controller republishes `RECOVERY_REQUIRED`. The panel then shows the neutral text instead of "confirming". Preserving `RECEIPT_PENDING` there would be a controller change outside this scope.

## A2 — final server result versus pending wording

`SUBMITTED / RECOVERY_REQUIRED` means the controller found a recorded deposit or escrow. The order result is only the separately injected server order status.

Change in `model.ts`, based on the matching server status (same order id and side):
- A **final** status (`COMPLETED`, BUY `REFUNDED`, SELL `RETURNED`; the status table's `terminal: true`) replaces the pending sentence with a statement that the server reports a final result, shown below.
- A non-final matching status says the latest server status is not a final result yet.
- No matching status gives a neutral sentence that no final order result has been received on this screen.

With a final server result, the post-deadline "held for review / contact operations if unresolved" paragraphs are not added. `UNKNOWN` on the transfer stage follows the same rule for its "needs a server check" sentence. A txHash is never used as a completion signal.

## A3 — controller trusted-reconcile precondition

For stage `APPROVAL`, `send()` checks `typeof a.submissions.reconcile === "function"` on the gate captured at `start()`. The check runs at these points:
1. Before the wallet identity read.
2. Inside the claim callback, immediately before `claim()`. This covers removal while the wallet read is pending.
3. After the final order re-read, before `SIGNING` is published.
4. Inside the dispatch `try`, immediately before `requestTransaction`. This covers removal by a synchronous SIGNING subscriber or during the claim.

Failure before a claim gives `BLOCKED / TRUSTED_RECONCILIATION_REQUIRED` with no claim. Failure after a claim reuses the existing post-claim paths: the claim is never deleted or released, the attempt stays UNKNOWN/recovery and no wallet request occurs.

Unchanged:
- `prepare`/`inspect` read-only recovery, including existing hashes and pending approvals
- late outcomes recorded through the original gate
- monotonic terminal history
- no automatic deposit/escrow after approval
- the panel's availability guard

The two existing `wallet.test.tsx` cases that relied on the gap (`missing` in the reconciliation matrix, and "outstanding approval requires server reconciliation") are rewritten. They now create the outstanding approval first and remove reconcile afterwards, which keeps their recovery intent.

## B — `stocks-wallet-http` read adapter

`createStocksExecutionReads({ apiBase, fetch?, now?, monotonicNow?, timeoutMs?, onSessionRejected? })` binds one immutable API base. It performs no I/O at creation. Each call synchronously copies its request (`apiBase`, `token`, `sessionId`, `signal`, `side`, `orderId`, `deploymentDigest`) before any await, and never reads host state afterwards.

| Method | Request | Returns |
| --- | --- | --- |
| `readDeployment({apiBase, token, sessionId, signal, deploymentDigest?})` | GET `/api/v1/stocks/execution/deployment` | frozen `{ deployment: ReviewedDeployment, observedAt, monotonicDeadline }` lease. The host stores it and supplies `deployment` in `context()` only while `deploymentLeaseCurrent(lease)` holds |
| `readExecutionPolicy(AuthenticatedRead)` | GET `/api/v1/stocks/execution/{side}/{encodeURIComponent(orderId)}` | validated `ExecutionPolicy`, server times unchanged |
| `readOrder(AuthenticatedRead)` | GET `/api/v1/stocks/orders/:id` (BUY) or `/sell-orders/:id` (SELL) | the validated original envelope, PROFILE included, frozen |
| `readCatalog(AuthenticatedRead)` | GET `/api/v1/stocks/catalog`, public, sent without Authorization | validated top-level catalog, frozen |

Transport:
- `Authorization: Bearer` for authenticated routes, `credentials: "omit"`, `cache: "no-store"`, `redirect: "error"`
- no query string or body
- a request API base that differs from the bound base is refused before fetch
- the caller's signal is linked to an internal abort
- one finite deadline (default 10 s, maximum 15 s) on fetch, streamed body, parse and validation, checked by timer and by monotonic elapsed time
- wall-clock rollback during a request fails closed
- 32 KiB streamed body limit, with a declared `content-length` checked first
- UTF-8 fatal decoding and JSON parsing
- non-2xx is not parsed (body cancelled)

Errors are `StocksWalletError` subclasses whose codes already have panel copy. There is no raw text, URL, token or server message:

| Condition | Code |
| --- | --- |
| timeout / abort | `READ_TIMEOUT` |
| network | `REQUEST_FAILED` |
| malformed | `INVALID_RESPONSE` |
| 401 | `SESSION_REJECTED`, with `status: 401`, calling `onSessionRejected(capturedSessionId)` once |
| policy non-2xx | `EXECUTION_NOT_ALLOWED` |
| deployment non-2xx | `DEPLOYMENT_NOT_REVIEWED` |
| order / catalog non-2xx | `REQUEST_FAILED` |
| stale or future envelope | `STALE_RESPONSE` |
| expired policy | `EXECUTION_POLICY_EXPIRED` |
| expired evidence | `DEPLOYMENT_EVIDENCE_EXPIRED` |
| scope mismatch | `EXECUTION_NOT_ALLOWED`, `ORDER_SCOPE_MISMATCH` or `MANIFEST_DIGEST_MISMATCH` |

Validation:
- **Envelope:** exact keys PROFILE5 + `observedAt` + `data`; canonical ISO `observedAt` (ms, `Z`, round-trip); `observedAt ≤ wall` and `effectiveNow − observedAt < 15 s`, where `effectiveNow = max(wall, requestStartWall + monotonic elapsed)`.
- **Evidence:**
  - exact keys; `status === "VERIFIED"`; evidence id label
  - safe-integer `verifiedAt < validUntil`, lease ≤ 15 000 ms; `verifiedAt ≤ envelope observedAt`; `verifiedAt ≤ wall`; `effectiveNow < validUntil`
  - exact manifest keys; `codeHashes` has exactly the five contract addresses
  - planner `validateDeployment` (ABI digest, profile, digest of manifest); optional expected digest
  - the returned lease keeps the server dates; its monotonic deadline is computed conservatively from `effectiveNow`
- **Policy:**
  - exact keys; `allowed === true`
  - `deploymentDigest`, `orderId` and `side` equal the captured request
  - safe-integer `observedAt < validUntil`, lease ≤ 15 000 ms; `observedAt ≤ envelope observedAt`; `observedAt ≤ wall`; `effectiveNow < validUntil`
- **Order:**
  - `stocks-investor` `parseOrder(data, side)` (BUY rows without side, SELL rows with `side: "SELL"`, lowercase wallet, `evm:` actor, known states)
  - wallet planner `parseOrder`
  - `data.id === orderId` and `data.deploymentDigest === deploymentDigest`
- **Catalog:** `stocks-investor` `parseCatalog` plus exact top-level keys.

Caching, `VERIFIED`/`allowed` synthesis, retries and journal writes are absent. `allowed: true` is not signing permission: only a new durable claim winner may open the wallet.

## Invariants

- No wallet request without a fresh claim won by this attempt, with trusted reconcile present for approvals.
- No automatic deposit/escrow.
- A hash or confirmed transfer is never order completion.
- Late results never paint a new scope. A 401 only invalidates the captured session id. Tokens never appear in errors, snapshots or logs.
- Money and units stay decimal strings / bigint. No `Number` or float for amounts; timestamps are integer ms.
- No storage (localStorage/IndexedDB), no background polling that can open a wallet.

## Verification plan

Failure first: the new regressions are run on the unmodified merge and must fail before the fix.
- A1 and A2 × BUY/SELL with the real controller and scripted ports (the four review cases).
- A3 direct `prepare → approve` without reconcile (BUY/SELL): wallet 0, claim 0.
- A3 removal after prepare, during the wallet read, during the claim, and in a SIGNING subscriber: wallet 0, claim not deleted.
- Existing hash recovery is preserved.

Adapter tests use a fake fetch only:
- real DTO shapes, plus an in-process real Fastify server plugin roundtrip: the execution plugin and the real `StocksExecutionService` over an in-memory fake SQL pool, and the stocks order and catalog routes. No network, no DB.
- PROFILE loss regression (investor `getOrder` → controller fails `ORDER_PROFILE_MISMATCH`; adapter passes)
- cross-order/session/deployment
- timeout, abort, stalled body, redirect, oversize, bad JSON, 401/404/503, late 401 after a scope change
- lease expiry, future and long-lived leases, wall-clock rollback
- no token, URL or raw text in errors or logs
- real controller + adapter + submission gate through prepare/approve/submit over fake HTTP

Commands:
- `npm run typecheck`, `npm run build`, `npm run test:security`, `npm run test:server`
- `npm run test:frontend` with `GIWA_HOST_DOM_RUNTIME=/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json` and `GIWA_STOCKS_ARTIFACTS=<clone>/packages/contracts/artifacts/stocks`
- `node .claude/hooks/check-design-tokens.mjs --all` (7 known findings)
- `node .claude/hooks/check-story-exists.mjs --all`
- `git diff --check`

Baseline on the unmodified merge: frontend 467 tests, 466 pass, 1 fail. The failure is the pre-existing timing test `stocks-wallet-submissions/client.test.tsx` "transport times out stalled body and cancels its reader", which uses a 10 ms timeout under full-suite load; the file passes 27/27 in 5 isolated runs. It is not owned here and is left unchanged.
