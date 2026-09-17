# Stocks execution read adapter (`stocks-wallet-http`)

A browser adapter for the four read-only Stocks endpoints that the wallet controller (`../stocks-wallet`) and its host need. It is **not mounted** in any route, provider or host yet (003B).

It holds no session, cache, journal or wallet. It never retries and performs no I/O when created. It never produces `VERIFIED` evidence or an `allowed` policy by itself: every value comes from a server response it has validated.

| Method | Endpoint | Result |
| --- | --- | --- |
| `readDeployment(request)` | GET `/api/v1/stocks/execution/deployment` | `DeploymentEvidenceLease`: `{ deployment, sessionId, apiBase, receivedAt, monotonicDeadline }` |
| `readExecutionPolicy(request)` | GET `/api/v1/stocks/execution/{BUY\|SELL}/{orderId}` | `ExecutionPolicy`, server `observedAt`/`validUntil` unchanged |
| `readOrder(request)` | GET `/api/v1/stocks/orders/:id` (BUY), `/api/v1/stocks/sell-orders/:id` (SELL) | the original envelope **including PROFILE**, frozen |
| `readCatalog(request)` | GET `/api/v1/stocks/catalog` (public, sent without Authorization) | the top-level catalog, frozen. It is not deployment evidence and grants no permission |
| `currentDeployment(lease)` | none | the lease's `ReviewedDeployment` while it is current, else `null` |

`readExecutionPolicy`, `readOrder` and `readCatalog` match the `WalletPorts` signatures and take the controller's `AuthenticatedRead`.

Contracts: `docs/contracts/stocks-execution-v1.md` (evidence, policy), `stocks-wallet-submissions-v1.md` (journal, not implemented here), `stocks-order-recovery-v1.md` (the envelope and side projection of order rows).

## Usage (host composition, 003B)

```ts
import { createStocksWalletController } from "../stocks-wallet"
import { createSubmissionGate } from "../stocks-wallet-submissions/client"
import { createExecutionClock, createStocksExecutionReads, type DeploymentEvidenceLease } from "../stocks-wallet-http"

// One wall clock for the controller, the adapter and the submission gate. It remembers every observed forward
// correction plus the monotonic time since, so a stalled or stepped-back wall clock never runs behind observed time.
// The controller also bounds each execution policy by ports.monotonicNow (default performance.now()) on its own.
const now = createExecutionClock()

// One adapter per API base. Creating it sends nothing.
const reads = createStocksExecutionReads({
  apiBase: ARCO_API_BASE,
  now,
  onSessionRejected: (capturedSessionId) => host.invalidate(capturedSessionId),
})

// Deployment evidence: an explicit host read with the session captured NOW.
let lease: DeploymentEvidenceLease | null = null
async function refreshEvidence(session: HostSession, signal: AbortSignal) {
  const next = await reads.readDeployment({
    apiBase: ARCO_API_BASE, token: session.accessToken, sessionId: session.id, signal,
    deploymentDigest: acceptedOrder.deploymentDigest,
  })
  // Ignore an answer for a scope the host has already left.
  if (hostSnapshot().session?.id === next.sessionId) lease = next
}

// Ports for ONE session/order/deployment scope; the controller is created from exactly this object.
const ports: WalletPorts = {
  now,
  context: () => ({
    session: hostSnapshot().session, walletAddress, chainId, walletEpoch, apiBase: ARCO_API_BASE,
    deployment: reads.currentDeployment(lease), // null as soon as the lease ends
  }),
  readOrder: reads.readOrder,
  readCatalog: reads.readCatalog,
  readExecutionPolicy: reads.readExecutionPolicy,
  submissions: createSubmissionGate({
    session, side, orderId, deploymentDigest, apiBase: ARCO_API_BASE, now,
    onSessionRejected: (id) => host.invalidate(id),
  }),
  invalidateSession: (id) => host.invalidate(id),
  readWallet, readAllowance, requestTransaction, waitApprovalReceipt, // active wallet source (003B)
}
const controller = createStocksWalletController(ports) // the owner disposes it
```

## Host responsibilities

- **Storing and refreshing evidence belongs to the host.**
  - Keep only the latest lease for the current scope.
  - Supply `reads.currentDeployment(lease)` from the synchronous `context()`.
  - Refresh explicitly, for example when the user starts a check.
- **Evidence renewal and lease end are execution authority, not display identity** (003A-1).
  - The lease ends at the server's `validUntil`. The server caches evidence, so a fresh read may have only seconds left.
  - When `currentDeployment` turns null or a read returns new evidence, the controller stops work that has not reached the wallet. It keeps a recorded attempt on screen (open prompt, hash, uncertain request) for the same session, wallet, order and manifest digest; a late hash is recorded and shown, and nothing continues automatically.
  - Unrecorded ready screens return to "Not checked yet"; new actions need current evidence.
  - A refresh while the server still returns the same cached evidence changes nothing and extends nothing.
- **Discard stale leases.** A lease that arrives after the host scope changed is discarded: compare `lease.sessionId` and `lease.apiBase` with the current scope. `currentDeployment` only accepts leases issued by the same adapter instance, so a copied or forged object returns `null`.
- **Session invalidation contract.**
  - A 401 on an authenticated read calls `onSessionRejected(capturedSessionId)` once, with the id copied from **this request** when the call started. It then fails with `SESSION_REJECTED` and `status: 401`.
  - The wallet controller also calls `ports.invalidateSession` with its captured id for that error.
  - Both must go to an id-comparing `host.invalidate(id)` (stocks-host does this), so a late 401 for account A never signs out account B.
  - The public catalog never triggers invalidation: its 401 calls no callback and carries `status: null`, so the controller does not invalidate either.
- **One API base per adapter.** A request whose `apiBase` differs from the adapter's is refused before any network call, so a token is never sent elsewhere. A base with credentials, a query, a fragment or even an empty `?` or `#` is refused. Use a new adapter for a new API base.
- **Use `createExecutionClock()`** for `ports.now`, the adapter and the submission gate. The adapter measures each request against monotonic time and the controller bounds each policy by `ports.monotonicNow`; the helper keeps the wall readings themselves consistent with observed corrections.
  - Once any reading is non-finite or monotonic time goes backwards, the helper returns `NaN` for good (fail closed); create a new clock and controller to recover.
  - A mistaken forward jump makes leases look expired until real time catches up; it never extends one.

## Request capture and transport

- The request is copied synchronously when the call starts: `apiBase`, `token`, `sessionId`, `signal`, `side`, `orderId`, `deploymentDigest`. Nothing is read from the host afterwards.
- Every call is one GET with:
  - no query and no body
  - `Authorization: Bearer <captured token>`, except for the catalog
  - `credentials: "omit"`, `cache: "no-store"`, `redirect: "error"`
  - an internal abort signal linked to the caller's
- A single deadline (default 10 s, maximum 15 s) covers fetch, the streamed body, JSON parsing and validation. It is enforced by a timer, which also bounds transports that ignore abort, and by monotonic elapsed time.
- A wall clock stepped back during a request fails it.
- Size and encoding limits:
  - responses are limited to 32 KiB, checking the declared `content-length` first
  - bodies are decoded as UTF-8 with fatal errors
  - a followed or 3xx redirect, or a different final URL, is refused
  - non-2xx bodies are not read

Failures are `StocksExecutionReadError`, a `StocksWalletError`:
- `code` is one that already has fixed wording in `stocks-wallet-ui/messages.ts`
- `reason` is a fixed diagnostic word
- `status` is the HTTP status, except `null` for a 401 on the public catalog

No URL, token, header, response body or server message is kept or logged.

| Situation | code |
| --- | --- |
| request invalid, other API base | `INVALID_CONTEXT` (no request sent) |
| caller aborted | `CONTEXT_CHANGED` |
| deadline, stalled body, clock stepped back | `READ_TIMEOUT` |
| network error, refused redirect | `REQUEST_FAILED` |
| malformed / oversized / non-JSON / wrong shape or PROFILE | `INVALID_RESPONSE` |
| 401 on an authenticated read | `SESSION_REJECTED` (+ `onSessionRejected`) |
| envelope from the future or 15 s old | `STALE_RESPONSE` |
| policy non-2xx, `allowed` not `true`, other order/side/digest, lease > 15 s | `EXECUTION_NOT_ALLOWED` |
| policy lease already ended | `EXECUTION_POLICY_EXPIRED` |
| evidence non-2xx, not `VERIFIED`, lease > 15 s | `DEPLOYMENT_NOT_REVIEWED` |
| evidence from the future or ended | `DEPLOYMENT_EVIDENCE_EXPIRED` |
| manifest or expected digest mismatch | `MANIFEST_DIGEST_MISMATCH` (and the planner's other deployment codes) |
| order or catalog non-2xx (a 404 is not proof the order moved on) | `REQUEST_FAILED`; a catalog 401 has `status: null` so the controller does not treat it as a session rejection |
| order row for another id or deployment | `INVALID_RESPONSE` |

## Validation

- **Envelope** (evidence, policy, order):
  - exactly `profile`, `valuePolicy`, `brokerMode`, `chainId`, `priceSource`, `observedAt`, `data`
  - PROFILE is `DEMO_TESTNET` / `TEST_VALUE_ONLY` / `MOCK_BROKER` / 91342 / `FIXED_MOCK_PRICE`
  - `observedAt` is canonical ISO (milliseconds, `Z`)
  - `observedAt ≤ wall` and `effective − observedAt < 15 s`, where `effective = max(wall, request start + monotonic elapsed)`
- **Evidence:**
  - exact keys; `status: "VERIFIED"`
  - integer epoch-ms `verifiedAt < validUntil`, lease ≤ 15 000 ms, `verifiedAt` no later than the envelope and the wall clock, `effective < validUntil`
  - exact 21 public manifest fields
  - `codeHashes` has exactly the five contract addresses (lower-case)
  - the planner's `validateDeployment`: ABI digest, profile, contracts, SHA-256 of the canonical manifest equals `manifestDigest`
  - optional expected digest
- **Lease** (`currentDeployment`): current while `wall ≥ receivedAt`, `verifiedAt ≤ wall < validUntil` and `monotonic < monotonicDeadline`. `monotonicDeadline` is measured from the effective clock at acceptance. Neither download time, caching nor rendering extends it.
- **Policy:**
  - exact keys; `allowed === true`
  - `deploymentDigest`, `orderId` and `side` equal the captured request
  - integer epoch-ms `observedAt < validUntil`, lease ≤ 15 000 ms, `observedAt` no later than the envelope and the wall clock, `effective < validUntil`
  - the returned object carries the server times unchanged
  - `allowed: true` is not signing permission: only a new durable claim won by this attempt lets the controller open the wallet
- **Order:**
  - the investor client's `parseOrder`: known states, lower-case wallet, `evm:` actor, decimal strings, BUY rows without side, SELL rows with `side: "SELL"`
  - the wallet planner's `parseOrder`
  - `data.id` and `data.deploymentDigest` equal the captured request
  - the whole envelope is returned because the controller checks PROFILE on it
- **Catalog:** exact top-level keys (PROFILE, `observedAt`, `instruments`, `cashSymbol`, `deploymentId`), exact instrument keys, the investor client's `parseCatalog`, and freshness.

Money and units stay decimal strings; no floating point is used.

## Known limits (outside this module)

- **Collation data.** `planner.ts` and the server now sort canonical keys with an explicit `en-US` collation, so the default locale no longer matters (tested in real en-US, cs-CZ and sk-SK processes). The result still depends on the runtime's ICU data; keep the frozen backend vectors and re-verify when runtimes change. Records written earlier under another collation are not accepted or rewritten automatically.
- **Clock accuracy.** Server and browser clocks must agree to within the envelope and lease bounds: a response observed "in the future" by the browser is refused.

### PROFILE loss

The investor client's `getOrder()` validates PROFILE and then returns only `{ observedAt, data }`. Passed to `WalletPorts.readOrder`, it makes the controller fail with `ORDER_PROFILE_MISMATCH`. `readOrder` here returns the validated original envelope instead. PROFILE is never re-added to an unvalidated value.

## Tests

- `reads.test.tsx` (fake fetch):
  - request shape
  - accepted DTOs
  - capture and late 401
  - invalid requests without network
  - scope, lease and envelope rules
  - monotonic delay and wall rollback
  - lease currency and forged leases
  - timeout, abort, stalled body, redirects, oversize, bad JSON and UTF-8
  - non-2xx mapping
  - exactly one request per read on every failure (no retry)
  - deployment lease bounds moved one clock at a time
  - `createExecutionClock`
  - no secrets and no console output
  - panel copy for every code
  - source guards
- `controller-integration.test.tsx`: the real controller, the real `createSubmissionGate` and this adapter over an in-memory HTTP fake, for BUY and SELL.
  - evidence → check → exact approval → reconciliation → separate transfer
  - PROFILE loss regression
  - late 401 after an account switch
  - a catalog 401 signs nobody out
  - evidence expiry and refresh without automatic re-signing; a refresh returning the server's cached evidence cancels nothing
  - independent review R1: a clock created slow and corrected forward, then 6 s elapsed with a +1 s wall reading: 0 wallet requests with `createExecutionClock` (BUY/SELL × approve/submit)
  - the controller's own monotonic policy bound with a raw wall clock: rollback after the final order read, slow policy response, synchronous SIGNING subscriber, NaN and regressing monotonic readings → 0 requests; a 15 s policy control → 1 request; a later allowed policy never reopens the consumed claim
  - evidence expiry or renewal while the wallet prompt is open (BUY/SELL × approval/transfer): the prompt stays on screen, the late hash is recorded and shown with `EXECUTION_AUTHORITY_CHANGED`, no automatic verification; an explicit check with fresh evidence recovers
  - pre-signing checks and reserved claims stopped by evidence changes; unrecorded ready screens are not kept as permission
  - identity boundaries (logout, session, A→B→A, epoch, API, chain, manifest, order, dispose, cancel) still isolate an open prompt
  - cross-deployment, paused and missing policy
- `server-roundtrip.test.tsx`: the **actual** server Fastify execution and Stocks plugins with the real `StocksService` and `StocksExecutionService` over an in-memory SQL fake, through `app.inject` (no socket, DB or RPC).
  - Real DTOs pass the adapter; the planner derives the same intent and calldata as the server.
  - The real controller completes a read-only check over these reads.
  - Real denials map to fixed codes.

```sh
TMPDIR=/private/tmp node --import tsx --test src/demo/giwa/stocks-wallet-http/*.test.tsx
```

No real wallet, signature, transfer, public network or database is used.
