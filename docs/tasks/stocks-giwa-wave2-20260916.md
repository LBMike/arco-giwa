# GIWA Stocks Wave 2 — contracts, sell and runtime

Base SHA: 3cd4f7bb789944e30998b208d456a6e04e6f2295.
Status: CONTRACT_READY, approved by Commander /root under the user's instruction to keep developing with a separate verification agent.

The user now appoints a separate development-verification agent and requests continued GIWA development. Independent reviewer /root/rwa_reviewer is the mandatory review gate for this wave and the existing candidate. Claude authentication no longer blocks development or local candidate integration. This does not waive review, authorize Mainnet, or permit changes to existing live Saving/Funds deployments. GIWA is completed first; XRPL remains deferred. White-theme investor/admin UI remains a separate Claude handoff.

## Roles and file ownership

- Commander/integrator /root: this document, final evidence, first-slice review-status correction, `docs/proposals/stocks-activation*` review-only artifacts, disconnected `server/src/stocks-runtime/**` composition/observer/transport/session modules and their tests, and `scripts/stocks-local/**` local EVM+Postgres harness. Shared `server/src/app.ts` / `server/src/index.ts` wiring is a separate proposed change, currently not applied (see activation gate below). No changes to existing money behavior.
- Contracts builder /root/giwa_stocks_contracts: new worktree `codex/stocks-giwa-contracts-20260916` at the base. Owns only NEW `packages/contracts/contracts/stocks/**`, `packages/contracts/test/stocks/**`, `packages/contracts/scripts/stocks/**`, `packages/contracts/hardhat.stocks.config.ts`, `docs/contracts/stocks-giwa-contracts-v2.md`, `docs/evidence/stocks-giwa-contracts-20260916.md`. Existing Solidity, configs, package manifests, locks and deployment registry are immutable.
- Backend builder /root/giwa_stocks_builder: new worktree `codex/stocks-giwa-sell-20260916` at the base. Owns `server/src/stocks/**`, `scripts/stocks/**`, additive Stocks-only Prisma changes and NEW `prisma/migrations/20260917000000_stocks_redemption/**`, `docs/contracts/stocks-giwa-v1.md`, `docs/evidence/stocks-giwa-sell-20260916.md`. No existing migration changes, app/index, dependencies, UI, secrets or other worktrees.

Narrow approved scope addition: the backend builder may repair `scripts/prisma/inspect-migrations.mjs` and `scripts/prisma/inspect-migrations.test.mjs` for the demonstrated false positive on a DROP CONSTRAINT clause inside a qualified ALTER TABLE. This is a separate atomic prerequisite commit with failing-first regressions; standalone DROP, unsafe targets and other statement/routine boundaries remain checked. Independent review is required.
- Independent verifier /root/rwa_reviewer: read-only own worktree, exact-commit review and independent tests, no self-approval by either builder. Confirmed P0/P1 findings block local integration.

## Contracts task STOCKS-GIWA-002

Implement NEW non-upgradeable GIWA-only test contracts, chain 91342, with isolated local Hardhat configuration also using 91342. Hardhat test RPC accounts may sign locally; never create, read, log or embed private keys. No dotenv import, live registry, deployer keystore or production network defaults in the new test config. Use the existing pinned toolchain/dependencies and Solidity 0.8.28 / Cancun, without new packages or lock edits.

Contract set: test cash ERC20 (6 decimals, explicit ARCO_TEST label); stock ERC20 (9 decimals, restricted transfers); funding vault; mint controller; redemption escrow. Reject zero addresses/amounts, wrong chain and unauthorized callers; use safe transfers and reentrancy protection. Code identity and deployed constructor relationships must be verifiable. Stock issuance is limited to the designated controller; holders cannot transfer to arbitrary wallets or burn directly. Escrow alone may move a holder's approved tokens into custody, return them to the original payer, and burn recorded escrow.

Preserve existing buy ABI:

```solidity
depositForOrder(bytes32 orderKey,uint256 amount)
mintForOperation(bytes32 operationId,address token,address recipient,uint256 quantity)
refundForOperation(bytes32 operationId,address recipient,uint256 amount)
event FundingReceived(bytes32 indexed orderKey,address indexed payer,address token,uint256 amount)
event StockMinted(bytes32 indexed operationId,address indexed token,address recipient,uint256 quantity)
event FundingRefunded(bytes32 indexed operationId,address indexed recipient,uint256 amount)
```

New sell ABI (freeze before parallel implementations):

```solidity
escrowForOrder(bytes32 orderKey,address token,uint256 quantity)
settleRedemption(bytes32 operationId,bytes32 escrowId,uint256 cashAmount)
returnEscrowForOperation(bytes32 operationId,bytes32 escrowId)
event StockEscrowed(bytes32 indexed escrowId,bytes32 indexed orderKey,address indexed payer,address token,uint256 quantity)
event StockRedeemed(bytes32 indexed operationId,bytes32 indexed escrowId,address indexed recipient,address token,uint256 quantity,address cashToken,uint256 cashAmount)
event StockReturned(bytes32 indexed operationId,bytes32 indexed escrowId,address indexed recipient,address token,uint256 quantity)
```

`escrowId = keccak256(abi.encode(orderKey,payer,token))` so another wallet cannot poison an owner's order key. One escrow per composite identity; immutable original payer/token/quantity. Replay of settlement/return must not move value again, and altered payload reuse must revert. Once returned or redeemed an escrow cannot be used by any other operation. On-chain operation identity binds action and all parameters. Recipient always comes from the original escrow record, never a new operator-supplied payout address.

`settleRedemption` atomically burns escrowed stock and transfers exact test cash from the funding vault to the original holder. A failed/insufficient cash transfer reverts the entire transaction, including the burn. The funding vault's dedicated redemption payout capability must be callable only by the authorized escrow. Backend observations require the StockRedeemed event AND both exact ERC20 movements in the same finalized transaction. No separate burn-success/payout-failed terminal state is allowed.

Contracts must be tested for unauthorized mint/burn/payout/refund, duplicate/mutated operation IDs, double settlement, return-versus-settle race, failed payout rollback, wrong chain/token, transfer restrictions, approvals, and event compatibility. Local deployment scripts may produce a manifest with actual code hashes and constructor identities. Actual public-testnet deployment needs an available authorized external signing method; do not invent credentials or touch the old registry.

## Backend task STOCKS-GIWA-003

Preserve all BUY behavior and existing routes. Add actor-owned sell quotes/orders with explicit sell endpoints to avoid ambiguous defaults:

- POST `/api/v1/stocks/sell-quotes` `{symbol,quantity}`.
- POST `/api/v1/stocks/sell-orders` `{quoteId,idempotencyKey}`.
- GET `/api/v1/stocks/sell-orders`, GET `/api/v1/stocks/sell-orders/:id`.
- Admin existing order detail/list/overview and portfolio distinguish BUY and SELL, with strict actor/deployment scope. No fabricated live price or broker state.

Mock sell price is the same fixed 120.000000 test cash per NVDA, using integer floor; reject a zero payout. Freeze actor/wallet/price/quantity/deployment/expiry. Sell acceptance reserves confirmed spendable quantity atomically so concurrent orders cannot oversell. Expired unfunded orders can release a DB reservation, but any late actual escrow remains recorded and held for an exact return rather than forgotten. Holdings are on-chain projection: distinguish wallet quantity, escrowed quantity, reserved quantity and available quantity, never add the same economic holding twice.

Lifecycle: order -> finalized exact escrow -> durable mock SELL fill -> durable atomic REDEEM intent -> original-hash/finality verification -> COMPLETED. Fully rejected broker orders may return original escrow only when non-execution is proven; partial or unknown outcomes remain held with no automatic whole-quantity return. Late, wrong-wallet, under/over/second/unidentified escrow needs durable custody evidence and no automatic sale. Return uses its original escrow identity and finalized exact movement. Restrict new dispatch under pause, but continue existing outcome lookup.

Before dispatching the SELL broker request, atomically reserve confirmed available test cash. Exclude every suspense/refund liability, unfinished BUY's cash and already reserved SELL payout; no negative available liquidity and no reuse of another order's claim. Serialize liquidity claims by network+vault+cash asset, not merely actor or symbol. Insufficient liquidity leaves escrow held in an explicit state without a broker sale. Release a reservation only on a proven non-execution/return path or consume it on finalized payout; UNKNOWN and partial execution retain it. Reconciliation must expose these liabilities.

Add `redemptionEscrow` to a new deployment manifest generation and validate pinned code/ABI/relationships. Older manifests must not be silently activated. Preserve absolute quantities as bigint/decimal strings, immutable evidence and intents, balanced append-only journal, atomic state/outbox writes, CAS/locks, deployment scopes, original provider identity recovery and no external calls in DB transactions. Record signed quantity movements to project wallet and escrow holdings and supply correctly; do not edit original mint facts.

Extend independent reconciliation for wallet, escrow, total supply and cash at a common finalized cutoff, including in-flight trades. Missing observer coverage remains unavailable/incomplete. Strictly verify all event emitters, original calldata/operation/wallet/token/quantity/cash amount plus exact Transfer movement pairs before settlement or return. Real PostgreSQL tests must cover sell concurrency/oversell, duplicates, replay, restart, crash, lost acknowledgements, partial/rejected outcomes, rollback, malformed chain evidence and conservation across buy/sell/refund/return.

## Runtime and verification sequence

Commander will connect the reviewed plugin to existing verified SIWE sessions through injected options, keep Stocks default-disabled without complete manifest/ports, implement a read-only finalized observer and an external-signer protocol adapter with no key material, and supply deterministic local end-to-end execution on actual EVM bytecode plus disposable PostgreSQL. Existing app and legacy tests must continue passing with no Stocks configuration.

The signer boundary must serialize nonces across BUY, SELL and refunds for the same account and durably bind original operation+payload+nonce before broadcast. Backend retries only look up the original operation; a missing lookup is not authorization for another submit. First version does not implement transaction replacement. A later fee-replacement capability requires a separate attempt history and review, not mutation of the original hash.

Every builder returns an exact atomic commit and evidence. Run relevant unit/contracts tests, real PG tests, typecheck/build/server/security/migration inspection. Independent verifier reviews and reproduces before integration. No main merge, push, existing contract redeploy or Mainnet activity. Do not claim public GIWA execution from a local EVM harness. If real signing remains unavailable, complete all executable local development and provide a concrete deployable package while keeping that external step explicit.

## Activation approval gate

Automatic approval review rejected the proposed app/index change because it would connect an external signer and automatically dispatch actual testnet transactions when configured, without explicit approval for that concrete behavior. The rejected patch was not applied and must not be reintroduced indirectly. Existing app/index stay unchanged. Disconnected composition has no automatic timer or implicit scheduler. Develop and independently verify the local contracts/backend/harness, then present the exact optional runtime-wiring proposal for user approval as the final step. Public-testnet deployment and signing setup remain explicit; no secrets should be sent in chat.
