# GIWA Stocks backend — manifest v2, buy and sell

Scope: isolated, unactivated DEMO_TESTNET / TEST_VALUE_ONLY / MOCK_BROKER module. Chain 91342 only. NVDA first, fixed mock price 120.000000 test cash, quantity scale 9, cash scale 6. No real securities or redeemable production value. No existing process registers this plugin. This module does not deploy contracts, activate a signer or connect a live broker. It supports buy/mint and sell/escrow/atomic redemption through explicit trusted ports.

## Composition

A future separately approved composition task must supply a parameterized `pg` pool to `StocksRepository(pool, manifestDigest(manifest))`, a dedicated Stocks manifest, `ReceiptVerifier(manifest, createStocksRpcPort(transport, manifest))`, verified actor/operator resolvers, external signer, pause policy, and activation attestation. `StocksService` defaults paused and rejects activation without the exact manifest digest and contract-policy verification. `StocksWorker` takes `createDurableMockBroker(repository)` explicitly; it never chooses mocks through a production fallback. `stocksPlugin` is a Fastify plugin with no standalone listener. The JSON-RPC transport is externally supplied and must use the approved GIWA testnet endpoint. No private-key/signing material belongs in these modules.

The manifest pins network checkpoint, network instance, chain, future Stocks ABI digest, cash/stock/vault/controller addresses and non-upgradeable code hashes. Its restricted-transfer policy must be proven on the actual contracts before activation. This is a NEW Stocks deployment contract, not the existing Savings/Funds deployment registry. Manifest inputs are cloned and frozen. Port calls receive frozen request snapshots. Operation IDs and all durable rows are deployment-scoped; a new network instance/deployment cannot dispatch or display old intents/holdings.

The actor resolver supplies `{actorId,wallet,chainId:91342,scope:"STOCKS_TESTNET",verified:true}`. The operator resolver supplies a unique named `operatorId` and `stocks:read` permission. Neither is read from request body, role headers or a static shared credential by this plugin. Session/wallet signature verification is the later composition responsibility; no resolver means denied.

## API

All successful responses disclose the profile, mock broker and price source, chain, and `observedAt` response time. `observedAt` is not an assertion that chain data is current. Monetary values and quantities are base-unit decimal strings.

| Route | Request / result |
| --- | --- |
| GET `/api/v1/stocks/catalog` | NVDA capability, fixed mock price label, cash symbol/deployment, activation status |
| POST `/api/v1/stocks/quotes` | Only `{symbol,quantity}` with human decimal string; server freezes actor/wallet, scale, price-derived exact cash and 60-second deadline |
| POST `/api/v1/stocks/orders` | Only `{quoteId,idempotencyKey}`; immutable quote snapshot, actor-bound idempotency, quote single-use |
| GET `/api/v1/stocks/orders` | Actor/deployment-scoped latest 100 orders |
| GET `/api/v1/stocks/orders/:id` | Actor/deployment-scoped order or 404 |
| GET `/api/v1/stocks/portfolio` | Finalized restricted-transfer issuance projection and ALL nonterminal pending orders; no second spendable off-chain holding |
| GET `/api/v1/admin/stocks/overview` | Scoped order counts/cash totals by state; strings |
| GET `/api/v1/admin/stocks/orders` | Scoped latest 200 orders |
| GET `/api/v1/admin/stocks/orders/:id` | `{order,funding,operations,audit,holdings}` with transaction hashes, independent funding/refund/operation states and ordered audit timeline |
| GET `/api/v1/admin/stocks/reconciliations` | Independent chain comparison only with trusted fresh observer coverage; otherwise explicit UNAVAILABLE/INCOMPLETE; includes in-flight attention items |
| GET `/api/v1/admin/stocks/audit` | Scoped latest 200 immutable audit entries |

Admin APIs are read only. No public funding, mint, confirm, faucet, balance-edit, arbitrary calldata, force-complete or unknown-resubmit API exists. Future pause/resume/config/refund commands need identified maker/checker intent, bounded role, reason, stale-version checks and separate approval/audit; they are not admin v1 features. Read-only detail exposes no key material or raw provider failures.

## Order and settlement rules

Order acceptance must precede funding and occur before quote expiry. The fixed mock quote remains usable when the canonical deposit block timestamp is at/before its deadline even if L1 finality arrives later. Late inclusion is held as FUNDED_QUOTE_EXPIRED. This is not a live broker price guarantee.

Normal lifecycle: AWAITING_FUNDING → BROKER_PENDING → MINT_QUEUED → MINT_SUBMITTED / MINT_FINALITY_PENDING → COMPLETED. BROKER_UNKNOWN / MINT_UNKNOWN retain the original durable intent. A recovered started/unknown operation only looks up its original provider identity; missing lookup is not proof of non-submission and never triggers a fresh submit. Unsupported partial/rejected broker results enter REVIEW_REQUIRED. Pause blocks new irreversible dispatch but permits lookup and finality confirmation for existing submissions.

Only exact finalized cash movements matching the registered network, code, token, target, calldata, verified wallet, order key and amount auto-fund. The event key is the actual ERC20 cash Transfer `(network instance, tx hash, log index)`; the custom FundingReceived event adds attribution. Replays credit nothing; changed evidence under the same movement identity records a conflict and holds unfinished order/outbox activity. Wrong-wallet cash is independent suspense and cannot block the owner's pending order. Under/over/late/second payments and unknown order keys remain durable received-value facts. Direct positive cash Transfers to the vault become unallocated suspense. Zero-value Transfers are ignored; a direct cash mint from the zero address is unallocated, not a refundable wallet.

An internal `requestRefund` requires explicit trusted refund policy and a known finalized payment from the verified original order wallet. No unidentified/zero/wrong-wallet deposit is auto-refunded. Only the exact authorized refund call, custom operation event and matching finalized vault-to-wallet ERC20 transfer completes a refund. A never-bought held order becomes REFUNDED once its own-wallet funding is fully returned; a second-payment refund leaves a completed purchase completed.

The chain verifier reads transactions/receipts/canonical blocks/code through a trusted server-side RPC port and decodes raw logs itself. A successful receipt alone is insufficient. Settlement requires the actual `finalized` block tag, immutable checkpoint and canonical block hash; latest/safe/Flashblocks/confirmation-count heuristics cannot settle. Missing receipts or noncanonical/unfinalized blocks remain pending. Invalid evidence enters review. The expected event signatures are strict; unrelated signatures are ignored, and zero-address indexed topics are valid for ERC20 mint events.

## Storage and reconciliation

Each command atomically writes order state/version, an append-only audit, balanced journal pair and outbox where applicable. External calls are outside database transactions. Row/advisory locks, unique actor/key/quote/movement/operation identities, leases and immutable payloads guard duplicates and concurrent workers. A journal row contains one asset, one exact positive amount and two distinct debit/credit accounts, making each row a balanced pair. PostgreSQL unconstrained NUMERIC plus integral/bound constraints prevents silent fractional typmod rounding. Money is calculated with bigint and serialized as strings.

SQL triggers prohibit updates/deletes/truncation of immutable quote, journal, audit, holding and provider facts; protect immutable order/funding/outbox identities and terminal states. The additive Prisma models mirror SQL foreign keys. Integral checks, triggers and the partial transaction-hash index remain explicitly SQL-maintained features. Do not use schema-push to replace reviewed migration history.

Reconciliation uses a trusted observer coverage cursor with deployment digest, block/hash and observation time (within 60 seconds, no future timestamp beyond 5 seconds). It compares independently fetched finalized vault cash, stock supply and known wallet balances at that exact cutoff against settled journal/holding entries through that block. No coverage is UNAVAILABLE, stale/mismatched coverage is INCOMPLETE, and RPC failure is UNAVAILABLE. Differences are MISMATCH; equality is MATCHED_AT_CUTOFF, never an assertion of present-time solvency. Observer log-range ingestion/cursor persistence is a later activation task; no local fake coverage is selected by default.

## Activation and remaining work

Required before integration/activation: the separately appointed independent reviewer gate, real-Postgres evidence, approved runtime/session wiring, deployed audited Stocks contracts satisfying this ABI and restricted-transfer policy, chain fingerprint/code/finality probe, limited external signer with durable lookup and on-chain operation deduplication, complete observer coverage and operations runbook. No Stocks live address/secret exists in this change. Future live prices, 40-instrument trading, Alpaca, social-wallet creation and XRPL are separate tasks. The 40-instrument UI catalog is not represented as 40 orderable backend instruments by this slice.


## Wave 2 — SELL contract and runtime hooks

Manifest generation is now `schemaVersion: 2`, with mandatory `redemptionEscrow` and its pinned code hash alongside cash, stock, vault and controller. Old manifests fail closed. Activation must independently verify immutable constructor relationships: stock mintController/redemptionEscrow; vault cashToken/redemptionEscrow/operator; controller stockToken/operator; escrow stockToken/cashToken/fundingVault/operator. Contract builder owns deployed bytecode and these getter checks. The manifest ABI digest includes the frozen escrow/settle/return functions and events.

`StocksService` keeps prior constructor arguments and adds an optional seventh `EscrowReturnPolicy`. It exposes `sell: StocksSellService`. `StocksWorker(service, broker, signer)` remains unchanged. A broker request may have `side: SELL`; its durable operation prefix is `sell-broker:`. Legacy BUY request identity remains `broker:`. There are no new signer key assumptions: the external signer must serialize and durably bind nonces across all operation kinds before submitting, and lookup the original operation after ambiguity.

New authenticated APIs: POST `/api/v1/stocks/sell-quotes` accepts only `{symbol,quantity}`; POST `/api/v1/stocks/sell-orders` only `{quoteId,idempotencyKey}`; GET `/api/v1/stocks/sell-orders` and `/:id` are actor/deployment scoped. Mock sell price is 120.000000 cash, rounded down to integer cash base units; zero payout is rejected. Sell quotes and accepted order snapshots are immutable. Wallet-level advisory locking plus an ACTIVE quantity reservation prevent concurrent accepted orders from reserving the same confirmed available quantity.

New internal hooks:
- `service.bindDeployment()` validates activation and immutably binds network+vault+cash to this deployment digest. A second different digest for the same vault scope fails closed. This prevents versioned manifests splitting an actual cash pool into independent ledgers; migration of a live scope requires its own reviewed procedure.
- `service.sell.observeEscrow(txHash)` reads a canonical finalized receipt, verifies `StockEscrowed`, composite `keccak256(abi.encode(orderKey,payer,token))` identity, call, sender and exact ERC20 movement, then records custody and signed quantity movements. Exact escrow attempts cash reservation; abnormal custody stays held. Wrong-wallet custody cannot change the legitimate owner's order/reservation.
- `service.sell.reserveLiquidity(orderId)` and `advanceLiquidity()` use an external finalized snapshot before a DB transaction, then serialize by network+vault+cash. Available cash is `min(finalized chain cash,current confirmed journal cash) - suspense/refund liabilities - unfinished BUY cash - existing SELL reservations`. Insufficiency is LIQUIDITY_PENDING, with custody held and no broker order. Waiting orders do not prevent smaller eligible orders progressing.
- `service.sell.expireReservations()` releases only expired AWAITING_ESCROW reservations whose deadline is covered by a canonical finalized, processed observer cursor. A missing or version-zero cursor is insufficient. Timely escrow therefore has an observation opportunity before release. Later actual escrow is always recorded and held for exact return, even if the DB reservation already expired.
- `service.sell.requestReturn(custodyId)` is internal, requires explicit trusted policy for non-exact custody, and always returns to the immutable original escrow payer. The default policy denies. A broker's proven full rejection with zero executed quantity/cash can automatically queue exact return; partial/unknown outcomes retain stock custody and cash reservation.
- `repo.isTransactionProjected(txHash)` is true only when a scoped recognized MINT/REFUND/REDEEM/RETURN outbox is DONE and a matching finalized audit fact exists. Unknown operator issuance/settlement does not advance observer coverage.

`StocksObserverCursor` contains deploymentDigest primary key, integral blockNumber, blockHash, version and updatedAt. Version zero is an unscanned checkpoint; the separately owned observer scans it inclusively and increments version with CAS only after all recognized movements are projected. This module contains no observer timer or server wiring.

SELL lifecycle: AWAITING_ESCROW → ESCROW_HELD → SELL_BROKER_PENDING → REDEEM_QUEUED → SETTLEMENT_PENDING → COMPLETED. Insufficient cash is LIQUIDITY_PENDING; partial execution is SELL_PARTIAL_HELD; ambiguous broker/signing outcomes retain original intent under SELL_BROKER_UNKNOWN/SETTLEMENT_UNKNOWN. Full rejection returns via RETURN_QUEUED → finalized StockReturned → RETURNED. Cash is released only upon proven return, or consumed upon atomic redemption. `settleRedemption` confirmation requires the custom event plus BOTH exact stock escrow→zero burn and cash vault→original payer payout in the same finalized transaction. A failed/malformed transaction produces no holding/supply/cash projection.

Portfolio `holdings` now contains `walletQuantity`, `escrowedQuantity`, `reservedQuantity`, `availableQuantity`, and `quantity` (wallet plus escrow economic total, counted once). Original immutable mint facts remain; signed append-only movements project custody, return and burn. Active DB reservations are not extra assets. Pending orders and admin overview/list/detail identify BUY or SELL. Admin sell detail includes custody, operation statuses, audit and cash reservation evidence. Reconciliation compares wallet, escrow, total supply and vault cash at one finalized cutoff, and separately labels current in-flight liabilities. No equality claim is emitted without trusted coverage.

Additional SQL tables are Stocks-only, with exact numeric checks, immutable evidence/movements, monotonic reservation/custody terminal transitions and truncate guards. The old migration is unchanged; a new additive migration extends the outbox kind check and links SELL orders separately from BUY orders. No existing Saving/Funds state, deployed contract or entrypoint is altered by this backend task.

As directed by the latest user request, the separate development-verification agent is the mandatory review gate. Claude login is not a prerequisite for continued local development or candidate integration. Public GIWA signing/runtime activation remains a separately reviewed external step; this branch does not perform it.
