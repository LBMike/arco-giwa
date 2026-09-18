# GIWA-STOCKS-KNOWN-HASH-UI-003D — builder plan (recorded before code)

This is a local builder candidate. There is no push, merge, deployment, public network, real wallet, signature or transfer. It adds no server API.

Task prompt: `docs/tasks/giwa-stocks-known-hash-ui-003d-20260918.md`. Backend contract: `docs/contracts/stocks-session-outcome-recovery-v1.md`.

| Item | Value |
| --- | --- |
| Base | `/private/tmp/arco-giwa-003d-recovery-20260918` @ `a805b26cf531ca1102894e8d7510fb4ca6b9f1c4`, branch `codex/giwa-003d-recovery-20260918`; clean (0 files), recorded in `/private/tmp/arco-giwa-known-hash-ui-evidence-20260918/base.txt`. Production `src` is identical to 003B-1 `47dbec1` |
| Work clone / branch | `/private/tmp/arco-giwa-known-hash-ui-20260918`, `codex/giwa-known-hash-ui-20260918` (push URL disabled) |
| Environment (untracked) | `node_modules` → `/private/tmp/arco-giwa-preflight-20260917/node_modules` (lockfile byte-identical); `packages/contracts/artifacts` copied; jsdom from `/private/tmp/arco-rwa-ui-independent-review-20260917`; Node v24.14.0 |
| Commander | user / conductor (003D prompt) |
| Builder | Claude Code (`claude-opus-5`), same builder session as 003B/003B-1 |
| Independent reviewer | Codex (backend contract, PostgreSQL/EVM/Chrome integration) |

## Facts that shape the design

1. The controller reports a wallet answer only through `persist → submissions.record({...claim, status, txHash})` on the owner's captured gate (`stocks-wallet/controller.ts:261-271`).
   - A late hash after the session expired is refused by `createSubmissionGate`'s `auth()` before any request (`SUBMISSION_AUTH_REQUIRED`).
   - A missing or invalid wallet hash is persisted as `UNKNOWN` without a hash, so it can never be a candidate.
2. The gate turns every non-2xx response into `SUBMISSION_HTTP_ERROR`. A 409 `SUBMISSION_HASH_CONFLICT` is therefore not distinguishable at the adapter. A conflict is detected by `inspect` before `record`. A race that loses to another hash fails as a server error, and an explicit re-check then shows the conflict. The gate is outside this task's scope and stays unchanged.
3. `inspect`, `outcomes` and `reconcile` stay available after quote expiry and trading pause (contract). New execution admission does not. The recovery path reads no execution policy, evidence or deadline, and never claims or sends.
4. The investor feature keeps the accepted order card across sign-in, sign-out and remount. The execution slot renders in that card and in a selected order in the Orders tab. A new registry has no pins, so a moved-on order (for example a funded BUY) currently gets no execution UI after a new sign-in. The recovery UI must render for a matching candidate even when the order is not payable.

## Design

**New module `src/demo/giwa/stocks-known-hash-recovery/`** (React-free except one presentational card):
- **`store.ts`: in-memory candidate store.** A module singleton serves the page; tests inject their own.
  - A candidate is frozen plain data only: `claimId, intentKey, stage, transactionDigest, side, orderId, deploymentDigest, wallet (lower-case), chainId (91342), apiBase, origin, txHash (lower-case 0x+64), capturedAt`, plus a state (`KEPT | RECORDED | VERIFIED(CONFIRMED|REVERTED) | BLOCKED(reason)`).
  - No token, session, signature, provider or permission.
  - Filtering: owner scope (wallet, chain, API base, origin), and for an order also side, order ID and deployment digest.
  - Bounded (16). Resolved entries are evicted first, then the oldest. Eviction never changes the server claim.
  - No expiry.
  - A per-claim busy lock.
  - `subscribe`/`version` for `useSyncExternalStore`.
- **`capture.ts`: `captureKnownHashes(gate, scope, store)`**, a `SubmissionGate` wrapper.
  - It passes every call to the original gate unchanged and returns the original promise.
  - It remembers the claims the original gate actually won (`REQUEST_MAY_START`, matching order and deployment).
  - On `record({status: "SUBMITTED", txHash})` whose binding equals such a claim, it adds a rejection handler to the original `record` promise. Only when that original record **fails** (expired auth, 401, timeout, lost response) is the candidate stored. The same promise is returned, so the controller sees the identical failure.
  - A record the original session completes leaves nothing to recover.
  - UNKNOWN, a hashless record, an unclaimed binding or another order is never a candidate. Capture errors never change the gate's result.
- **`recover.ts`: `recoverKnownHash(options)`**, explicit and single-run.
  1. Pin the current session.
  2. Create a new `createSubmissionGate` for the candidate's side, order, deployment and API base, with the session wallet as `walletAddress` and `onSessionRejected` = host invalidate (the gate passes only the pinned session ID).
  3. `inspect(intentKey)`. Stop unless the stage row exists and `claimId`/`intentKey`/`stage`/`transactionDigest` equal the candidate. A different stored hash is a CONFLICT (never overwritten).
  4. If there is no stored hash, `record({...binding, status: "SUBMITTED", txHash})`.
  5. `reconcile(binding + txHash)`. `CONFIRMED`/`REVERTED` come only from that response; `SUBMITTED` means the receipt is pending.

  The same ownership check (identity key unchanged, candidate present) runs after every await. When ownership changed, the run stops without painting or updating the store. It never calls `claim`, `requestTransaction`, `approve` or `submit`, and never retries.
- **`KnownHashRecoveryCard.tsx`:** presentational, using the existing `Notice`/button tokens.

**Execution host changes:**
- `registry.ts`: options `knownHashes` and `origin`. `createOwner` wraps the owner's gate with `captureKnownHashes` (scope: side, order, deployment, captured wallet, 91342, API base, origin).
- `StocksExecutionProvider.tsx`: props `knownHashes` (default the module store) and `origin` (default `window.location.origin`).
  - It exposes to the slot and the notice: the live view reader, invalidate, fetch and clock.
  - `StocksOrderExecution` renders the recovery cards for candidates that match the current session owner, view wallet, chain, API base, origin and the order's side, ID and deployment. This is filtered during render, so there is no first-render leak.
  - A matching candidate renders even for a non-payable, unpinned order; that case gets no execution panel.
  - The session-end notice gets a second variant when unrecovered candidates exist for the same signed-out wallet scope. That variant says the hash is kept only in this tab and is recorded only by the user's own action after signing in again. The no-hash variant stays the 003B-1 text (do not resend, operations).
- `StocksPages.tsx`: no change expected (the provider defaults cover it).

## Requirement mapping

| Prompt item | Where |
| --- | --- |
| 1–2 capture only on the original controller → gate path, record failure propagated unchanged | `capture.ts`; registry wiring |
| 3 no credentials in the store, scoped, bounded, no expiry release | `store.ts` |
| 4 no cross-owner exposure from first render; A→B→A; StrictMode; late answers | render-time filtering; pinned identity checks in `recover.ts` |
| 5–7 explicit button; new pinned gate; inspect binding check; record only the original hash; server state only; conflict; lost response; no auto retry | `recover.ts`, card |
| 8 no claim, wallet or policy; works after expiry or pause | `recover.ts`; tests with a shifted clock and `setPaused(true)` |
| 9 receipt ≠ order completion; no new deposit for an expired approval-only order | card copy; the existing panel deadline rule is unchanged |
| 10 notice variants | `StocksExecutionSessionNotice` |

## Tests

| Test file | Coverage |
| --- | --- |
| `store.test.tsx` | Validation, scope filtering, bounds, states, busy lock, no credentials stored |
| `capture.test.tsx` | Fake gate: identical promise and error, call counts, candidate only on failure, UNKNOWN/hashless/unclaimed/other-order refused |
| `recover.test.tsx` | In-process real server plugins + fake chain: BUY/SELL × APPROVAL/TRANSFER record/reconcile; already recorded; conflict; no claim; binding mismatch; 401 with the pinned ID only; server error; lost response then explicit re-check; pending then confirmed; reverted; expired order and paused trading; STOPPED on ownership change; 0 claims, 0 wallet calls; transfer admission still refused after a recovered approval on an expired order |
| `registry.test.tsx` | Owner gate wrapper wiring |
| `page.dom.test.tsx` | Real `/stocks` page. Existing scenarios 11–12 move to the no-hash case (the wallet fails after expiry). New scenarios cover BUY/SELL × APPROVAL/TRANSFER late hash → expiry → notice (hash variant) → same-owner sign-in → button → inspect/record/reconcile, with exact request and wallet counts, double click, A→B→A and a clock past the quote deadline or paused trading |

Full checks: typecheck, build, frontend with DOM + artifacts and CI-like, server, security, design tokens (7 known) and stories, `git diff --check`.

**Not in scope:** reload or cross-tab persistence, manual hash entry, wallet transaction search, token storage, automatic recovery or retry, Dynamic mode, server/DB/Solidity/registry/auth/deadline changes, real PostgreSQL/EVM/Chrome integration (Codex follow-up).
