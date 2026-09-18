# Known-hash recovery (`stocks-known-hash-recovery`)

In the same tab, this module keeps a transaction hash that an original Stocks wallet request returned when that request's own submission gate could not record it (for example because the session had expired). After signing in again, the same owner can explicitly record that hash on the original claim.

It adds no server API and changes no server, gate, controller, deadline or session rule. Backend contract: `docs/contracts/stocks-session-outcome-recovery-v1.md`.

**Not verified here:** reload or cross-tab recovery, a real wallet or extension, a public network, a real database. The tests use the in-process real server plugins over memory SQL and a fake EIP-1193 wallet on a fake chain. Codex runs the PostgreSQL/EVM/Chrome integration.

## Pieces

| File | Role |
| --- | --- |
| `store.ts` | In-memory candidate store. `tabKnownHashStore` is the page's instance (module memory of this tab) |
| `capture.ts` | `captureKnownHashes(gate, scope, store)`: wraps an owner's ORIGINAL submission gate |
| `recover.ts` | `recoverKnownHash(options)`: one explicit recovery run |
| `KnownHashRecoveryCard.tsx` | Presentational card on the order (existing `Notice` and button tokens) |

The execution host (`../stocks-execution-host`) wires them together:
- `registry.ts` wraps every owner's gate.
- `StocksExecutionProvider.tsx` renders the cards and the session-end notice variants.

## Capture (`capture.ts`)

- **Every call goes to the original gate unchanged**, and its own promise is returned. An expired session's refusal, a 401 or a timeout reaches the controller exactly as before; nothing adopts another session or records anything.
- **The wrapper remembers only claims that original gate actually won**: `REQUEST_MAY_START`, same order and deployment.
- **What is kept.** A hash is kept only when all of these hold:
  - the controller reports `record({...claim, status: "SUBMITTED", txHash})`;
  - the binding (`claimId`, `intentKey`, `stage`, `transactionDigest`) equals such a won claim;
  - that original `record` fails.

  A record the original session completes leaves nothing to recover.
- **Never kept:** `UNKNOWN` (no wallet answer, a wallet error or an invalid answer), a hashless record, an unclaimed or other binding, another order or deployment.
- **Scope.** A kept candidate carries the original binding plus side, order ID, deployment digest, lower-case wallet, chain 91342, API base, frontend origin and the hash.

## Store (`store.ts`)

- **Contents:** plain frozen data only. There is no token, session, signature, provider or permission, and a static test checks this.
- **Location:** module memory only. There is no `localStorage`, `sessionStorage`, IndexedDB, cookie or broadcast. A reload or a closed tab loses every candidate.
- **Scope:**
  - `entries(scope)` filters by owner: wallet, chain, API base and origin.
  - `forOrder(scope, side, orderId, deploymentDigest)` also filters by order.
- **Size:** bounded to 16 entries. Verified entries go first, then blocked, then recorded, then the oldest kept; a running action is never evicted. Eviction only forgets this tab's copy and never touches the server claim.
- **No expiry.** Nothing is released, reset or re-granted by time or by a missing candidate. The server claim stays reserved either way.
- **Hash per claim.** The first hash for a claim is kept; another hash is never stored or swapped in.
- **States** (a trusted result is final):
  - `KEPT`: the server may not have the hash.
  - `RECORDED`: the server has it, and its receipt is not verified yet.
  - `VERIFIED(CONFIRMED|REVERTED)`: the server's trusted receipt check finished.
  - `BLOCKED(CONFLICT|NO_CLAIM|BINDING_MISMATCH)`: nothing more is offered.
- **One action at a time per candidate** (`begin`/`end`).

## Recovery (`recover.ts`)

Runs once per click:
1. Stops unless the candidate is `KEPT` or `RECORDED`, the session wallet, chain and API base are the candidate's, and `alive()` holds.
2. Creates a **new** `createSubmissionGate`:
   - pinned to the current session, with the session wallet as `walletAddress`;
   - scoped to the candidate's side, order, deployment and API base;
   - its `onSessionRejected` receives the pinned session's ID only.
3. `inspect(original intentKey)`:
   - the stage's stored claim must exist (else `NO_CLAIM`);
   - its `claimId`, `intentKey`, `stage` and `transactionDigest` must equal the candidate (else `BINDING_MISMATCH`);
   - a different stored hash is a `CONFLICT` and is never overwritten;
   - a stored terminal status is reported as it is.
4. Only when the server has no hash: `record({...binding, status: "SUBMITTED", txHash: original})`.
5. `reconcile(binding + hash)`. `CONFIRMED`/`REVERTED` come only from that server answer; `SUBMITTED` means the receipt is pending (`RECORDED_PENDING`).

Throughout the run:
- `alive()` is checked after every await. For the page, that means the same identity key (session, wallet, chain, epoch, source, API base) and a mounted card. When it fails, the run stops without reporting or storing.
- It never claims, opens the wallet, retries, or reads an execution policy, evidence or order deadline. Expiry and pause therefore do not stop recovery, while new execution keeps its own rules.

Failures:
- **Server errors and lost answers** (`FAILED`) keep the candidate. The user can check again explicitly: the next run inspects first, so it never records the same hash twice.
- **Conflicts.** The gate reports every non-2xx response as `SUBMISSION_HTTP_ERROR`, so a 409 conflict raced in after inspect shows as `FAILED` first. The next explicit run then reports it as `CONFLICT`.

## UI

- **Card:** shown on the order in the signed-in owner's order slot, filtered during render by owner scope, order and deployment. It also renders for a moved-on order that has no execution panel in this session. It shows the stage and hash and offers one explicit action per state:
  - "Record this hash"
  - "Check again" after a failure
  - "Check the receipt again" while recorded but pending
  - nothing once verified or blocked

  The verified copy says a receipt is not the order result: an approval does not fund the order, and only the order status shows the result.
- **Card copy:** every state that offers an action says the transaction behind the hash was already sent and must not be sent again from any app or wallet. A failed check says only that the check itself did not open the wallet or send anything, never that "nothing was sent".
- **Session-end notice (signed out, same wallet):**
  - When a kept hash exists, it says the hash is kept only in this tab's memory, that a reload loses it, and that it is recorded only by the user's action after signing in again. Its title ("This tab kept a transaction hash the server may not have recorded") asserts no timing, because a hash is also kept after a network failure inside a valid session. It shows whatever network the wallet is on; it names nothing.
  - Otherwise it keeps the no-hash copy: check, never repeat, operations.

  Neither variant names an order, amount or hash.

## Tests

| File | Coverage |
| --- | --- |
| `store.test.tsx` | Validation, scoping, first hash kept, final verified state, no expiry, busy lock, bounds; static check: memory only, no credentials, recovery never claims, opens the wallet or reads policy |
| `capture.test.tsx` | Identical promise and error; candidate only after the original record failed; UNKNOWN, hashless, unclaimed or other bindings never kept |
| `recover.test.tsx` | Real registry, controller, gate and ports against the real server plugins: BUY/SELL × APPROVAL/TRANSFER recovery with exact requests (0 claims, 0 wallet calls, 1 outcome, 1 reconcile, 1 inspect); quote expiry + pause (and the server still refuses a new TRANSFER claim: 503 paused, 409 expired); original lost answer; completed original record; wallet error; conflict; no claim; binding mismatch; other owner; expired and rejected (401) sessions; server error; lost recovery answer; pending then confirmed; reverted; owner change during a slow answer; busy |
| `KnownHashRecoveryCard.test.tsx` | Copy and actions of every state (static markup): never "nothing was sent", the never-again line while an action is offered, no completion claim, one action or none, busy |
| `../stocks-execution-host/scope.test.tsx` | Owner scope: the session wallet must be the shown wallet on chain 91342 with an API base and origin |
| `../stocks-execution-host/known-hash.dom.test.tsx` | First-commit visibility across deployment, origin, API base, chain and wallet changes and A→B→A; moved-on unpinned order shows only the card; a card unmounted mid-recovery stores nothing; notice variants (including another network) |
| `../stocks-execution-host/page.dom.test.tsx` | Scenarios 11–19 on the real `/stocks` page (see that module's README) |
