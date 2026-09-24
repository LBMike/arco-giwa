# GIWA-DB-PREFLIGHT-005 evidence

2026-09-24. Base `eb60df8a1f3bf94bda0fb6c2bce2e3cea9270445`; isolated branch `codex/giwa-db-preflight-005`. Scope and ownership: [task contract](../tasks/giwa-db-preflight-005.md).

## Outcome

The committed migration history previously failed inspection on four valid relation-alias/row-variable references. Scoped field recognition now accepts that history without changing any migration SQL. Query boundaries, routine identity, quoted identifiers, typed literals, DDL options and foreign relation/function/type references are checked before granting a field exemption. An independent read-only review reproduced and then verified fixes for typed-string and CREATE/ALTER TYPE alias-spoofing cases.

The existing migration deployment command now runs inspection before checking credentials or spawning Prisma. Native CLI tests use a local stub executable and scratch files, with no database access, to verify failed inspection cannot reach Prisma and valid history still requires DIRECT_URL.

## Verification

| Check | Result |
| --- | --- |
| Inspector and deploy CLI tests | 37 pass, 0 skipped |
| `npm run prisma:migration:inspect` | Pass on exact committed SQL |
| `npm run typecheck` | Pass |
| `npm run build` | Pass; existing large-chunk warning |
| `npm run test:server` | 528 pass, 92 skipped |
| `GIWA_HOST_DOM_RUNTIME=/private/tmp/giwa-portfolio-dom/package.json npm run test:frontend` | 1040 pass, 8 skipped; existing React SSR warnings |
| `npm run test:security` | Pass |
| `git diff --check` | Pass |

Logs: `/private/tmp/giwa-db-005-{targeted,migration,typecheck,build,server,frontend,security}.log`. Database/money-path implementation and SQL did not change; real PostgreSQL scenarios from the preceding signer task were not rerun or counted as passing in this task. The inspector is not a complete PostgreSQL parser; its existing unqualified SELECT source limitation remains documented in the contract.

## Live environment observation, read only

The authenticated Supabase dashboard contains an `Arco` project (ref `munsybkrsxrmajmbssli`). Its `arco_evm` table list displayed 10 existing GIWA tables: AuthNonce, EvmAssetDeployment, EvmIndexedEvent, EvmIndexerCursor, EvmNetwork, EvmProductDeployment, FeaturedCard, IndexedRedemptionRequest, VaultConfig, WalletAttestation. No Stocks table appeared in that list. Only table/column metadata was inspected; customer rows and credentials were not opened. `public` contains the existing waitlist and Prisma migration-history table. They were not modified.

The visible tables match the existing GIWA models, but the live Render service's database project binding has not been verified. No database mutation, SQL execution, key access, transaction signing, public contract deployment, Render deploy, 4392 restart, push or hosted-CI verification occurred. UI4392 and the main Portfolio layout remain unchanged.
