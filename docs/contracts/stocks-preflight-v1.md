# Stocks paused-start preflight v1

This operator CLI aggregates configuration and read-only startup checks without starting the API, worker, observer, signer operations or trading. It never deploys, migrates, binds a vault, updates a cursor or changes pause state. It is not a new HTTP endpoint and requires no UI change.

## Run

From this checkout, compile once, then run the default offline inspection:

```sh
npm run build:server
node scripts/stocks-preflight/run.mjs
```

Supply the same server environment used by the runtime, through the existing operator environment or secret manager:

- `STOCKS_MODE=DEMO_TESTNET`
- `STOCKS_CONFIG_PATH`: public JSON config path; no dotenv or secrets files
- `STOCKS_SIGNER_TOKEN`: present, never printed
- `STOCKS_DATABASE_URL`, falling back to `DATABASE_URL`: never printed
- `STOCKS_AUTODISPATCH=1`: enable observation when the server is separately started

Config must pass the existing runtime parser and public-manifest verification whitelist. Its signer URL must be an HTTPS origin with root path. It must set `paused: true`, and include a valid unique-wallet operator directory with at least one named `stocks:read` operator. These are paused-start requirements, not a check of an already-running unpaused service. No endpoint, deployment manifest, account or credential is invented.

With these inputs, offline mode checks only local configuration. It creates no DB, RPC or signing-service clients. To explicitly request read-only external checks:

```sh
node scripts/stocks-preflight/run.mjs --online
```

There is no dotenv loading, automatic configuration discovery, default RPC, automatic retry, activation or network call in offline mode. Missing or invalid settings block all online probes, and all configuration failures that can be evaluated are reported together. The CLI rejects extra arguments rather than accepting credentials on the command line. Public config files use the same reader as runtime startup and integration preparation: strict UTF-8, regular files only, and at most 64 KiB both at stat and during the actual read. Malformed bytes are never silently replaced in operator identities. Both supplied and resolved paths reject `.env*` and `.secrets` components case-insensitively. Public-file symlinks and existing relative config paths remain supported; named pipes are rejected without waiting for a writer. File failures map to the existing redacted configuration-failure report.

## JSON result and exit code

Every full report includes the existing `DEMO_TESTNET` PROFILE fields, ISO `observedAt`, mode, status, a list of `{id,status,code}` checks, and **`tradingAuthorized: false`**. Only fixed diagnostic codes are exposed; no input config, URL, signer token, database exception, operator wallet, balances or private paths are printed.

| Overall status | Exit | Meaning |
| --- | --- | --- |
| DISABLED | 2 | Stocks is not configured to start; no external checks |
| CONFIGURED_NOT_PROBED | 2 | Local inputs pass; DB, deployment and signer remain unchecked |
| BLOCKED | 1 | One or more required checks fail |
| STARTUP_CHECKS_PASSED | 0 | Online startup checks passed; trading remains unauthorized |

Malformed CLI arguments or tool failures produce a smaller fixed-code BLOCKED result, still with `tradingAuthorized: false`. `--help` exits successfully without inspecting configuration.

## Checks

Database checks run inside `REPEATABLE READ READ ONLY`, with 2-second statement/lock timeouts, 3-second idle-transaction timeout, and a 5-second total phase budget. Late acquisition is released without SQL. After a late query, only rollback/release can continue; no late success is accepted. The CLI uses its own one-connection pool with bounded connection and query waits and closes it afterwards.

- All 19 base Stocks tables must exist as ordinary tables in `arco_evm`, with SELECT privileges. With `operatorControls: true`, both trading-control tables are also required (21 total).
- Prisma history must contain exactly one successful, non-rolled-back entry for every repository migration with its SHA-256 file checksum. Missing, unfinished, duplicate, altered or unknown active migration entries block. Rolled-back historical attempts are ignored.
- The Prisma metadata schema comes from the connection URL's `schema` parameter, defaulting to `public`; only `public` and `arco_evm` are supported. Only the `_prisma_migrations` metadata relation is read there. All product data checks use `arco_evm`.
- An existing physical cash-vault binding must match the configured manifest digest. An unbound vault is reported as `VAULT_UNBOUND_BEFORE_FIRST_START`; the tool does not create a binding. The existing runtime remains responsible for binding at actual startup.

### Mutation guards

The `stockMutationGuards` check compares the user-trigger inventory with the reviewed repository contract: 38 triggers and 10 functions for the base tables, or 44 triggers and 13 functions with operator controls enabled. The contract includes immutable quotes/journals/evidence, order snapshots and versions, submission state/proof binding, deletion/truncation protection, and operator state/history binding.

Each trigger must be attached to the expected table and function, fire for the expected events, and retain its row/statement timing and deferral behavior. Disabled and replica-only triggers, added `WHEN` conditions, column filters, arguments, transition tables, missing triggers, and unexpected user triggers fail. Ordinary (`O`) and always-on (`A`) triggers are accepted only in an `origin` replication session.

Function schema/name, language, return/argument types, volatility, invoker security and absence of per-function settings must match. SHA-256 of the exact stored function body must match the final migration version, including whitespace. A same-name no-op replacement therefore fails even if migration history is unchanged. Intentional function changes require a new migration and an updated `server/src/stocks-preflight/guard-contract.ts`; its tests compare every current Stocks trigger declaration and final function body against the migrations.

Success returns `STOCK_MUTATION_GUARDS_MATCH`; mismatch returns only `STOCK_MUTATION_GUARDS_MISSING_DISABLED_OR_CHANGED`. No function bodies or catalog rows are printed. This remains a catalog-only check inside the same bounded read-only transaction: it does not invoke a trigger or attempt a product write. A mismatch blocks this preflight report; the CLI does not automatically pause or repair a running service.

Deployment checks reuse the accepted execution-evidence verifier: chain/checkpoint, finalized canonical blocks, five contract code hashes, constructor bindings and token scales, with its 8-second total deadline. They use only read-only RPC methods.

Signer checks call only authenticated `GET /v1/capabilities` and verify the existing testnet protocol, expected signer, durable serialized nonce policy, immutable idempotent operations, and disabled replacement policy. They never call PUT/submit or generate a transaction. The capability request has a 10-second deadline.

The three online probes run independently, so a failed DB check does not hide a signer or deployment failure. A failed subcheck blocks the overall result even when DB connectivity itself succeeds.

## What passing does not establish

This is a point-in-time paused-start diagnostic, not an execution-policy lease or a complete database-schema diff. The mutation-guard inventory is checked, but CHECK/UNIQUE/foreign-key constraints, indexes, column definitions and operational write privileges are not comprehensively compared. A later administrative change can invalidate the result. Signer capabilities do not prove its internal persistence or fund its account. Chain verification does not replace the original deployment evidence review.

There is no claim about current observer coverage, matching ledger balances, faucet funding, gas balance, wallet/UI completion, broker custody, market-data availability or public deployment. After a reviewed paused startup, require CURRENT observation and balance reconciliation before separately permitting test trades. Actual order execution continues to require the existing fresh deployment/policy checks and durable submission claims.

Claude UI work remains separate. This increment reads no user secrets files and changes no frontend, contract, registry, schema, dependency manifest or application entrypoint.
