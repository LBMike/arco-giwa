# GIWA-DB-PREFLIGHT-005 — Supabase migration preflight

Approved scope: the user's continuing development instruction, following their explicit authorization to proceed without repeated approval and their correction to retain Supabase/Render. Root is the sole builder/integrator. Branch `codex/giwa-db-preflight-005`, worktree `/private/tmp/arco-giwa-db-preflight-005`, base `eb60df8a1f3bf94bda0fb6c2bce2e3cea9270445`.

## Files and outcome

Repair the existing static migration inspector's four false positives for SQL relation aliases and PL/pgSQL row variables. Run the same guard automatically before the existing migration command can start. Allowed files: `scripts/prisma/inspect-migrations.mjs`, `inspect-migrations.test.mjs`, `migrate-deploy.mjs`, new `migrate-deploy.test.mjs`, this task/evidence and a Supabase deployment note. No SQL, schema, API, UI, dependency, live registry, key or secret-file changes. This is not XRPL schema work and does not claim completion of the separate XRPL DB-001 task.

## Invariants and failures

The existing explicit `arco_evm` DDL/DML boundary, public/waitlist, dynamic SQL, malformed tokens and foreign-schema protections remain. Alias/record exemptions must have a declaration in the correct query/routine scope. An alias must never authorize a schema-qualified relation/function/type with that same spelling, escape its statement/routine, or hide a three-part foreign reference. Unsupported ambiguous field exemptions fail closed. This is a static guard, not a complete PostgreSQL parser: pre-existing acceptance of unqualified SELECT read sources is not broadened or claimed fixed here. Exact committed migration SQL bytes remain unchanged.

Migration deployment must stop before Prisma execution on inspection failure. It retains the explicit DIRECT_URL requirement, never applies SQL as part of tests, and never prints credentials. Existing 4392, Supabase and Render are preserved; no AWS provisioning or wallet action is included.

## Verification

`node --test scripts/prisma/inspect-migrations.test.mjs scripts/prisma/migrate-deploy.test.mjs`; accepted current history and scope/alias spoofing rejection cases; native CLI subprocess tests with a local stub for Prisma to prove ordering/no execution on invalid history. Relevant baselines: `npm run prisma:migration:inspect`, `npm run test:security`, `npm run typecheck`, `npm run build`, `npm run test:server`, and frontend with the existing DOM runtime. No shared money-path SQL or application transition changes.
