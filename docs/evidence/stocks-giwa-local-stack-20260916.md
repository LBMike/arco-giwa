# GIWA Stocks local full-stack harness

Builder `/root/giwa_stocks_contracts`, commander `/root`, independent verifier `/root/rwa_reviewer`.
The bounded follow-up task starts at contract candidate `12f8e2d6d9af4e7515b56d335f98c32c498daf4e`. Its only allowed changes are NEW `scripts/stocks-local/**` and this evidence document. The commander requested a genuine local EVM + PostgreSQL + backend HTTP harness; it does not authorize public-network activation.

## Scope and invariants

The committed harness imports `server/dist/stocks/**` and `server/dist/stocks-runtime/**` from its own assembled repository. It never imports another worktree, starts existing application entrypoints, reads dotenv/keystores, changes product migrations, or accesses public RPC endpoints. Its PostgreSQL signer journal exists only in a fresh disposable `stocks_local_harness` schema. The application keeps its exact existing migrations.

Explicit `STOCKS_LOCAL_STACK_ONLY=1` is required. The runner creates a loopback-only banner-safe Hardhat node, deploys the five new bytecode contracts through the approved local deployment helper, supplies the actual backend ABI digest, and initializes its own temporary PostgreSQL cluster with all repository migrations. It verifies Hardhat node identity and chain 91342. The HTTP backend and signing service bind random loopback ports.

The local signer uses unlocked test RPC accounts through `eth_sendTransaction`; no key is loaded, returned, persisted or logged by these scripts. It serializes the execution account across all operation kinds using a PostgreSQL session advisory lock. The immutable operation payload/digest and original nonce are committed before broadcast. RPC occurs outside DB transactions. Existing operations may only resolve their original submission; unresolved original nonces block later broadcasts. Lost acknowledgement is recovered by scanning the original sender + nonce and exact transaction payload, never by resubmitting. This adapter is test harness code, not an approved public-network signer.

## Scenarios implemented

1. Real HTTP signed-session investor ownership, rejected caller-supplied wallet fields, cross-wallet order isolation, and named read-only admin authorization.
2. Five deployed runtime code hashes and real PostgreSQL finalized-observer checkpoint coverage.
3. Real PostgreSQL observer concurrency lock: a second observer reports `BUSY`. Inject a crash after a funding fact is durable but before cursor advancement, then replay without double credit.
4. HTTP quote/order -> actual cash approval/deposit -> raw RPC funding verification -> durable mock fill -> actual mint -> finalized holding.
5. Partial-position SELL -> actual stock approval/escrow -> durable mock fill -> atomic on-chain burn/cash payout -> database wallet/escrow projection.
6. Lost broadcast acknowledgement before the signer saved a transaction hash. Restart the signer HTTP service, retain the PostgreSQL nonce record, and recover the original transaction without a second submission.
7. Concurrent independent mint operations receive distinct consecutive nonces. Duplicate same-operation requests reuse one hash; altered payload reuse fails without another transaction.
8. Underpayment becomes suspense and returns only through an authorized exact finalized refund.
9. Create fresh buy/sell orders, then advance only local EVM inclusion time past quote expiry. Record late funding and custody, refund cash and return stock to the original payer. No immutable database quote is edited to fabricate expiry.
10. Final common-cutoff reconciliation compares independently read cash, stock supply and wallet/escrow balances against the database. Expected final stock wallet/supply is `3000000000` raw units (3 test NVDA), custody zero and vault cash `360000000` raw units (360 test USDC).

## Running in the assembled candidate

Prerequisites: the reviewed contract commit, the v2 buy/sell backend, the commander's disconnected runtime modules, root npm dependencies and pinned contract dependencies. Run the normal backend build first. Then:

```sh
STOCKS_LOCAL_STACK_ONLY=1 STOCKS_PG_BIN=/opt/homebrew/Cellar/postgresql@18/18.6/bin node scripts/stocks-local/run.mjs
```

`STOCKS_PG_BIN` may point to another installed PostgreSQL **server** binary directory; the plain libpq client installation is insufficient. The harness uses a private Unix socket and a unique temporary directory. Coordinate one PostgreSQL cluster at a time on this host because available shared-memory slots are limited. Loopback node/server sockets may require the host's approved local-test sandbox escalation.

On normal completion or caught failure, the runner stops only its own local-node process group and its own PostgreSQL cluster. Successful temporary resources are removed. Failure diagnostics are retained with their absolute path and no claim of success; failure to confirm PostgreSQL shutdown retains the directory for explicit owned-resource recovery.

## Verification status at handoff

- `node --check` passed for all three new JavaScript modules.
- `git diff --check` passed.
- No full-stack execution is claimed in this prototype commit: the separate SELL backend and runtime branches must first be assembled by the commander. The commander/independent verifier will run the actual stack, and any resulting failures must be fixed and retested before this harness is considered passed.
- The already-delivered contract EVM tests remain separately documented; their success does not substitute for this full-stack result.

No public GIWA or Mainnet deployment, application activation, UI implementation, package update or registry change is included.
