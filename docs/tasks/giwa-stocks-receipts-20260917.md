# Trusted wallet-submission receipt reconciliation

Base: f7a85402c866c672fff32c4a3ad013e8edc90d6b. Isolated local implementation only; no live deployments, external transactions, historical enrollment backfill, or UI activation.

## Shared contract

POST `/api/v1/stocks/wallet-submissions/reconcile`, same authenticated owner, profile envelope and no-store policy as journal routes. Exact body `{claimId,intentKey,stage,transactionDigest,txHash}`; hash must already be durably recorded. Returns the existing AttemptRecord shape with two additional permitted statuses CONFIRMED and REVERTED, no exposed proof fields. Pending returns existing status. RPC unavailable/mismatch fails closed with fixed errors and no terminal mutation.

Only trusted server ChainPort can produce terminal evidence: network/checkpoint, canonical finalized block, exact immutable transaction (from/to/input/value), configured contract code identities, successful stage-specific event semantics, and final canonical recheck. Reverted transactions need the same transaction/network/finality binding but no success events. Bounded verification; timed-out operations cannot later write. Immutable proof persisted transactionally; terminal states and hashes never downgrade or change.

Browser outcomes remain UNKNOWN/SUBMITTED only. Late outcomes preserve trusted terminal state. Same-stage claims always return null; APPROVAL cannot follow TRANSFER; TRANSFER may follow only server-confirmed APPROVAL with persisted proof. Reverted approval stays blocked. Existing order, deployment, pause, deadline and enrollment gates still apply. Transfer confirmation is not order completion.

Frontend SubmissionGate gains optional `reconcile(request: {claimId,intentKey,stage,transactionDigest,txHash: Hex}): Promise<AttemptRecord>`. Production HTTP adapter implements it; missing reconcile fails closed for an outstanding approval. Explicit prepare can recover pending approval by server reconcile. No client receipt can mark terminal. Approval confirmation only permits a fresh preflight and a separate transfer click; never automatic transfer. Old waitApprovalReceipt port may remain for compatibility but is not authoritative.

Backend export contract: `createSubmissionReceiptVerifier(manifest, rpc)` from `server/src/stocks-submissions/receipts.ts`, returning a trusted port accepted as optional second constructor arg of StocksSubmissionsService. Backend owns exact internal proof/request types. Root composes verifier through createStocksRuntime as `submissionReceipts` and passes it from index.ts.

## Ownership

Backend agent: server/src/stocks-submissions/**, new migration + prisma model, scripts/stocks-submissions/**. Frontend agent: src/demo/giwa/stocks-wallet-submissions/** and stocks-wallet/{types.ts,controller.ts,wallet.test.tsx}. Root: runtime/index composition and scripts/stocks-submissions-integration/**, integration evidence. Reviewer: independent isolated read/test copy and findings.

## Validation

Targeted adversarial unit tests, fresh PostgreSQL migration/reconciliation/concurrency/persistence tests, real app-to-browser adapter integration, legacy DB tests, required frontend/server/build/security checks and independent frozen-candidate review. Record what uses a deterministic RPC fixture; do not call it a live wallet or EVM test.
