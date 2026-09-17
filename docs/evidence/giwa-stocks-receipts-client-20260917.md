# Trusted receipt reconciliation — frontend builder evidence

Base `a94a2a8bff09a3607e07b6c5acde6c35e9d8bbea`; isolated clone `/private/tmp/arco-giwa-receipts-client-20260917`, branch `codex/giwa-receipts-client-20260917`. Shared task: docs/tasks/giwa-stocks-receipts-20260917.md. Independent acceptance and actual server/PG/EVM integration remain root/reviewer work.

## Behavior

`SubmissionGate.reconcile` is optional in the shared type and implemented in the HTTP adapter. POST body is exactly claimId, intentKey, stage, transactionDigest and the already observed txHash. It reuses captured session/API/order/deployment ownership, strict profile/DTO/body limits, abort/deadline handling and original-session401 invalidation. Missing/unsupported server verification fails closed.

Inspect/reconcile alone can supply trusted CONFIRMED/REVERTED. Their claim binding and hash are immutable; terminal state cannot flip or downgrade through delayed responses. A stale nonterminal response retains previously accepted terminal evidence. Outcomes still accept only UNKNOWN/SUBMITTED as input. Per root/backend agreement, a server-preserved terminal outcome response resolves successfully but does not grant new authority to a previously nonterminal client binding; explicit inspect/reconcile is required. A known terminal state remains intact.

The wallet controller no longer calls or trusts waitApprovalReceipt, nor writes terminal journal status. Initial approval may request trusted server reconciliation once. Pending/error/missing verification preserves the approval hash and cannot open transfer. Explicit prepare can reconcile an outstanding approval. Confirmation then triggers completely fresh wallet/order/catalog/policy/allowance reads. A separate submit click is still required for transfer. Reverted claims stay blocked across prepare/cancel/recreation; confirmed transfer remains a submission, not order completion.

Each controller attempt captures its original submission gate. Late wallet results persist through that gate even if the caller replaces ports or changes account. Scope matching prevents an old outcome from repainting a replaced account/API/epoch. Reconciliation is bounded and its late result cannot advance a cancelled, disposed or replaced attempt. Existing expiry/pause/order/deployment gates remain in force; no wallet UI is activated.

## Verification

- Focused adapter/controller suite:62/62,0 skips, with existing Solidity ABI artifacts explicitly provided. Includes exact reconcile transport, captured auth, terminal/pending/error cases, original-session401, conflicting hash/status, stale concurrent results, outcome-terminal non-authority, unsupported endpoint, timeout and lost response; controller pending→explicit prepare→fresh preflight→separate transfer, missing verifier even with sufficient allowance, legacy receipt port never called, reverted recovery block, owner/API/A-B-A/cancel/dispose fencing, original gate late outcome, timeout and terminal transfer semantics.
- Full frontend:402/402,0 skips, process exit0. Host DOM and existing wallet artifact checks enabled. No lingering test process or timer remained after completion.
- Typecheck, production build, security and story checks:exit0. Existing large-chunk warning remains. Design token hook:exactly7 inherited findings,0 new.
- Existing server suite:180 total,140 pass,40 expected environment-dependent skips,0 fail. No PostgreSQL endpoint configured or exercised. This is baseline compatibility evidence, not trusted receipt backend or durable-storage acceptance.
- Whitespace check passes. Scope: stocks-wallet-submissions/**, stocks-wallet/{types.ts,controller.ts,wallet.test.tsx}, dedicated task/evidence docs. No provider/routes/server/package/theme changes.

Existing dependencies were symlinked after package-lock equality. Ignored ABI artifacts were reused from identical contracts tree `732c8e606088d731423bcf6a3e4419848a594e8b`; no compiler/install/network required. No real RPC, wallet, database, deployment or browser listener was used. All new server reconciliation responses in unit tests are explicitly marked mock trusted-service fixtures; they are not blockchain verification evidence.

```sh
GIWA_STOCKS_ARTIFACTS=/private/tmp/arco-giwa-stocks-submissions-client-20260917/packages/contracts/artifacts/stocks node --import tsx --test src/demo/giwa/stocks-wallet/wallet.test.tsx src/demo/giwa/stocks-wallet-submissions/client.test.tsx
GIWA_HOST_DOM_RUNTIME=/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json GIWA_STOCKS_ARTIFACTS=/private/tmp/arco-giwa-stocks-submissions-client-20260917/packages/contracts/artifacts/stocks npm run test:frontend
npm run typecheck
npm run build
npm run test:server
npm run test:security
node .claude/hooks/check-design-tokens.mjs --all
node .claude/hooks/check-story-exists.mjs --all
git diff --cached --check
```

Logs/exact revision metadata: `/private/tmp/arco-giwa-receipts-client-evidence-20260917/`. Source candidate must receive separate independent review before integration acceptance. No push/merge/deploy.
