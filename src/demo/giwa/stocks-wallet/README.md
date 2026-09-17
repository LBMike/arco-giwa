# GIWA Stocks wallet execution module

This is an **unmounted module**, not a connected trading feature. It imports no investor/admin builder modules, browser-incompatible server code, wallet SDK, DB code or existing Savings/Funds registry. No RPC URL, deployment address or signing implementation is chosen by default. No real wallet or public network was used to validate it.

## What it does

`planOrder(selection, context, now)` produces immutable, exact unsigned calls for an accepted GIWA Stocks order:

| Side | Token approved | Exact spender/call | Amount |
| --- | --- | --- | --- |
| BUY | Manifest ARCO_TEST_USDC | fundingVault / depositForOrder(orderKey, amount) | accepted cashAmount (6 decimals) |
| SELL | Manifest NVDA stock token | redemptionEscrow / escrowForOrder(orderKey, token, quantity) | accepted quantity (9 decimals) |

Both contracts consume ERC20 allowance. Existing sufficient allowance skips approval. A needed approval sets exactly the required amount, never uint256 max or an incremented/unbounded allowance. All quantities are integer strings/bigints; the fixed mock price formula uses BUY ceiling and SELL floor exactly as the existing backend. No real USDC/RLUSD, additional symbol, permit, faucet, minting or administrative contract operation is supported.

The planner requires chain 91342, NVDA, ARCO_TEST_USDC, manifest v2, exact current Stocks ABI digest, code hashes, checkpoint, reviewed deployment digest and immutable-policy evidence. The order must match the session wallet, deployment, derived network/order key, accepted immutable fields, version, pending state and deadline. Raw backend BUY/SELL rows are supported. BUY rows carry no side; SELL create and GET rows carry `side: "SELL"`. `Selection.side` is still required and must match.

`createStocksWalletController(ports)` exposes:

- `select({side, order})`: freeze the accepted server row, retiring old selection work.
- `refreshContext()`: synchronize a synchronous host scope change. Call during owning scope changes before rendering authenticated action props; `getSnapshot()` also performs the guard.
- `prepare()`: fresh authenticated order/catalog/policy reads, wallet/account/chain checks, durable-history inspection and allowance read. No wallet signature request.
- `approve()`: explicit exact approval only, matching canonical receipt check, fresh order/policy/allowance checks; it never automatically calls deposit/escrow. The attempt's captured `SubmissionGate` must provide trusted `reconcile`. This is checked immediately before the new APPROVAL claim, again after the final order re-read before SIGNING, and again after SIGNING subscribers ran, just before the wallet request. Missing before the claim → `BLOCKED / TRUSTED_RECONCILIATION_REQUIRED` with no claim. Removed after the claim → no wallet request; the reserved claim is kept unchanged (REQUEST_MAY_START, never deleted or re-opened), and the attempt is `UNKNOWN / TRUSTED_RECONCILIATION_REQUIRED`, which is recovery-only. Read-only `prepare`/inspect recovery of existing hashes does not require it.
- `submit()`: a separate explicit user action, requiring READY_TRANSFER and another full preflight. It durably claims the request, re-reads the accepted order immediately before signing and requests the exact planned transaction once.
- `cancel()` / `dispose()`: stop further host work. They cannot dismiss or cancel an external wallet transaction request already in progress. Its late hash/error remains associated with the original durable claim.
- `getSnapshot()` / `subscribe()`: stable status updates. No JWT is included in the snapshot or plan. There is no COMPLETED state, holding update, settlement simulation or success fallback.

Same-scope double clicks share one promise. Account, chain, wallet source/connection epoch, SIWE session, API, manifest digest and selection changes are **display scope** changes: they retire work and reset the snapshot (a late wallet answer is recorded through the original gate but never painted into the new scope). The host's epoch MUST advance on A→B→A, even if React batches the events.

Deployment evidence (ID, dates, expiry) and session validity are **execution authority**, checked separately (003A-1):
- If authority changes or expires, work that has not reached the wallet stops. A claim it reserved (also one whose claim request was still in flight) stays visible as UNKNOWN / `EXECUTION_AUTHORITY_CHANGED`.
- An attempt whose wallet request is already open stays on screen. Its answer is recorded and shown; an approval then stops with `EXECUTION_AUTHORITY_CHANGED` and no later step (verification, READY_TRANSFER, transfer) runs automatically. A transfer shows SUBMITTED (nothing follows a transfer). If the session itself expired, the attempt's captured submission gate refuses to record the late hash (it is shown with `RECOVERY_REQUIRED`); `stocks-host` normally clears an expired session, which resets the screen like logout.
- An approval answered after its execution policy ended also stops at the hash with `EXECUTION_POLICY_EXPIRED`; READY_TRANSFER only follows an explicit check with fresh reads.
- Recorded screens are kept; unrecorded ready screens return to IDLE, and a dispatched attempt that lost its authority never publishes a new ready screen, so a kept screen is never permission.

Every awaited preflight read is followed by a current-wallet read and scope/deadline verification. Reads have a 15-second deadline checked on both the wall clock and `ports.monotonicNow` (default `performance.now()`). Order/catalog observedAt must be less than 15 seconds old.

The execution policy is bounded twice:
- by its server `validUntil` on the wall clock
- by `monotonicStart + min(validUntil − observedAt, validUntil − wallStart)`, where both starts are sampled before the policy request is sent, so request delay, stalled or stepped-back wall clocks cannot re-grant its TTL

Both bounds are checked after the allowance read, before a new claim, before SIGNING and immediately before the wallet request (after SIGNING subscribers); refusals up to that point keep a reserved claim at REQUEST_MAY_START and record no outcome.

Clock readings fail closed: the controller's monotonic reading never decreases (a non-finite or lower reading makes it NaN for the rest of the controller's life), and within an attempt a non-finite wall reading or one lower than an earlier reading of the same attempt refuses the read or the request. Accurate host/server clocks and trusted transport are required.

Canonical JSON digests (`planner.canonical` / `digest`) sort keys with an explicit `en-US` collation, identical to the backend (`docs/contracts/stocks-canonical-locale-v1.md`). A browser in, for example, a Czech or Slovak default locale produces the historical en-US manifest, transaction and intent digests. This still depends on the runtime ICU collation data; it is not a version-independent canonical format.

`validateContext` refuses an API base with credentials, a non-http(s) scheme, or any `?` or `#` in its normalized href (even empty), before any read.

## Required host adapters

The backend endpoints behind these ports exist (`docs/contracts/stocks-execution-v1.md`, `stocks-wallet-submissions-v1.md`). Browser adapters:
- `../stocks-wallet-http`: deployment evidence lease, execution policy, order envelope, catalog.
- `../stocks-wallet-submissions`: `createSubmissionGate`, including `reconcile`.

The wallet ports (item 4) and host composition are not implemented yet.

The existing Stocks catalog only supplies deploymentId/cashSymbol/instrument capability. It does **not** supply a verified manifest, runtime-code evidence, immutable bindings or current pause authorization. Do not manufacture ReviewedDeployment from it.

1. `context()` must synchronously supply the current `stocks-host` HostSession, active wallet address/chain/connection epoch, API base and an independently reviewed deployment. The evidence ID/digest/lifetime must bind the exact manifest and actually verified runtime code/checkpoint/getters. A VERIFIED literal is a **trusted dependency boundary**, not cryptographic verification performed by this module. Missing/expired/mismatched evidence blocks all signing.
2. `readOrder()` performs the captured actor's authenticated fresh GET `/api/v1/stocks/orders/:id` or `/api/v1/stocks/sell-orders/:id` using the request's captured token/API/session, `no-store`, abort signal and response envelope. It must not use a mock, cached successful row or current-session token substituted after an await. `readCatalog()` returns the current top-level catalog. A 401 may invalidate only the captured session ID.
3. `readExecutionPolicy()` supplies a trusted fresh scoped execution decision. `CHECK_PAUSE_AT_ORDER` only describes the existing order capability; it is not evidence that execution is permitted now. GET `/api/v1/stocks/execution/{side}/{orderId}` implements it; `allowed:true` is not signing permission (only a new durable claim is). Missing policy blocks signatures.
4. `readWallet()`, `readAllowance()` and `waitApprovalReceipt()` must use the active injected/Dynamic source and reviewed chain. `readWallet` must also attest that THIS active wallet source matches the reviewed network instance/checkpoint/deployment digest by checking its chain data; copying the configured manifest fields into the result or checking chainId alone is not verification. A local chain and public GIWA can share 91342. The receipt port returns the actual transaction and canonical receipt, not only a success boolean. The module checks exact hash/from/to/data/value/chain. Wallet adapters must preserve explicit account/chain/to/data/zero-value and must not add transaction fallback/resubmission. The allowance and receipt ports must independently enforce the reviewed deployment/network; no default public endpoint is selected here.
5. `SubmissionGate` must provide **durable, authenticated, atomic, cross-tab and cross-device** admission/claim/history updates. It is not an in-memory Map, localStorage flag, wallet nonce read, absence of a finalized event or empty catalog field. The test fake is deliberately not exported as a production implementation.

The submission gate is implemented by the backend wallet-submissions API and `createSubmissionGate`. It must authenticate/bind the caller to the wallet/order/deployment and validate the physical intent and exact transaction digest itself. `inspect()` must return authoritative stage records. `claim()` must atomically create at most one REQUEST_MAY_START record per physical target/token/wallet/order-key/stage **before** returning permission to open the wallet. Returned old/pending claims must never be treated as new permission. `record()` updates that original claim; it must not trust a client flag to assert chain confirmation. It needs a recovery path to validate actual transactions independently and accept late results for the original claim even after UI/logout changes.

Admission must explicitly distinguish newly accepted orders governed by this gate from historical pending orders whose submission history is unknown. A missing row cannot mark an old order safe. Rollouts must reject such historical orders until reviewed recovery proves their history; do not backfill them all as unattempted. The intent key is physical target/token/wallet/order key so manifest aliases cannot bypass a claim.

## Why refresh/recovery is deliberately restrictive

`StocksFundingVault.depositForOrder` does not reject a second payment for the same order key. The backend records additional value as suspense, but that does not protect the user from a duplicate payment. `StocksRedemptionEscrow` rejects duplicate custody for the same composite escrow ID; the UI still must not open another wallet request for an unresolved attempt.

Once any wallet request may have started, rejection (including provider 4001), an invalid/missing hash, timeout or uncertain exception remains UNKNOWN. A returned hash remains SUBMITTED/APPROVAL_SUBMITTED. A reload, logout, a new controller, cancel button or a missing receipt is never permission to try again. The durable pre-request claim blocks retries even if the later hash write fails. Late hashes update the original intent and cannot paint another account's screen. Approval uncertainty/revert also requires recovery; this module supplies no generic reset/retry-signature control.

After a confirmed approval the user must explicitly submit, with another preflight. If the order expires while the wallet is open, the module cannot cancel the eventual chain transaction or guarantee timely block inclusion. It preserves the hash and waits for backend classification. An approval may leave a bounded allowance behind when an order expires; there is no automatic revocation transaction.

A transfer hash or even a mined receipt does not mean the order is complete or holdings increased. The existing server's finalized observer state is the only settlement source. This module never promotes a hash to COMPLETED. Final route integration should show server order state separately and preserve any pending/unknown transaction identity until reviewed recovery.

## Validation

From the checkout, using existing runtimes/artifacts (no dependency changes):

```sh
GIWA_STOCKS_ARTIFACTS=/path/to/existing/packages/contracts/artifacts/stocks \
node --import tsx --test src/demo/giwa/stocks-wallet/wallet.test.tsx
```

The dedicated suite compares the exact ABI digest to the real backend ABI source and round-trips calldata through the previously compiled Solidity FundingVault, RedemptionEscrow, TestCash and StocksToken artifacts. The artifact gate is explicitly skipped without GIWA_STOCKS_ARTIFACTS; set it for verification. Full frontend validation also enables the host DOM gate via GIWA_HOST_DOM_RUNTIME as documented in stocks-host/README.md.
