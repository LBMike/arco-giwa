# Stocks wallet submission HTTP adapter

`createSubmissionGate` from `./client` implements the reviewed wallet module's `SubmissionGate`. It is deliberately not connected to the wallet controller or any screen yet.

```ts
const submissions = createSubmissionGate({
  session: hostSession, // verified host session captured for this order attempt
  side: "BUY",
  orderId: order.id,
  deploymentDigest: reviewedDeployment.manifestDigest,
  apiBase,
  walletAddress: verifiedActiveWallet.address, // optional caller identity consistency check
  onSessionRejected: capturedId => host.invalidate(capturedId),
})
```

Create a new gate for a new session/order/deployment/API scope. The API base must be http(s) without credentials and without any `?` or `#` in its normalized href, even an empty one; otherwise creation throws `SUBMISSION_INVALID_API_BASE` before any request. An old gate retains its original token and session ID for late outcomes. It never asks a getter for a replacement session and never falls back to another account. Local expiry/clock guards and server authentication both fail closed. Supplying `HostSession` does not make browser data an authority: the authenticated server owns actor/wallet/order/calldata checks. `walletAddress` only checks consistency with an identity already verified by the caller; it performs no wallet discovery or signing.

Call `inspect(expectedIntentKey)` or `claim(request)` before `record(outcome)`. The first expected intent permanently binds this instance. `record` accepts only a claim binding observed through this instance; a recreated instance must inspect authoritative server state first. Its small in-memory binding map is input-validation bookkeeping, never durable storage or permission. Only a new server claim response can return REQUEST_MAY_START, and an already observed stage cannot be replayed as new permission. A null claim remains null; any transport/parse/auth failure throws. No retries, persistence, chain receipt assertions or recovery unlocks occur here.

Reports may contain UNKNOWN or SUBMITTED (hash required). Server-preserved submitted hashes must survive later UNKNOWN reports. CONFIRMED/REVERTED are not client-writable. The adapter now implements optional `SubmissionGate.reconcile` as POST `/wallet-submissions/reconcile` with exactly claimId, intentKey, stage, transactionDigest and the already observed txHash. Only trusted server inspect/reconcile responses grant terminal authority. Terminal state and hash cannot downgrade or flip through late responses. An outcome response that preserves a server terminal state resolves, but a previously nonterminal local binding must still inspect/reconcile before advancement.

Missing server reconciliation, pending verification and errors fail closed. There is no RPC/wallet verification fallback. The controller can explicitly prepare again to recover a pending approval, then rechecks current wallet/order/policy/allowance and requires a separate transfer click. Reverted claims stay blocked; even a confirmed transfer does not mean order completion. The legacy wallet waitApprovalReceipt port is no longer called or trusted. Actual wallet UI activation remains outside this module.

Each request uses a 10-second default monotonic deadline (including body/JSON/schema work), 32KiB maximum streamed response, no cookies, no redirects and no caching. Timed-out work is aborted; transports that ignore abort are still bounded by the deadline race. Inject `fetch`, wall `now`, monotonic `monotonicNow`, or `timeoutMs` only for controlled integration/tests. Defaults use the existing browser APIs.

Tests use explicit fake HTTP fixtures, not a fake durable journal. Real API/persistence roundtrip acceptance is owned by the integration task.
