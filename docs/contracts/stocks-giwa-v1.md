# GIWA Stocks backend v1

Scope: isolated, unactivated DEMO_TESTNET / TEST_VALUE_ONLY / MOCK_BROKER module. Chain 91342 only. NVDA first, fixed mock price 120.000000 test cash, quantity scale 9, cash scale 6. No real securities or redeemable production value. No existing process registers this plugin. This does not deploy contracts, activate a signer, connect a broker, or complete user sell/redemption.

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

Required before integration/activation: independent code review and Claude counter-review, real-Postgres evidence, approved runtime/session wiring, deployed audited Stocks contracts satisfying this ABI and restricted-transfer policy, chain fingerprint/code/finality probe, limited external signer with durable lookup and on-chain operation deduplication, complete observer coverage and operations runbook. No Stocks live address/secret exists in this change. Future stock sell/escrow/burn/payout, live prices, 40-instrument trading, Alpaca, social-wallet creation and XRPL are separate tasks. The 40-instrument UI catalog is not represented as 40 orderable backend instruments by this slice.
