# DB-001 — GIWA migration history inspection repair

Status: BUILDER_VERIFIED; independent review and commander acceptance pending.

- Commander: `/root`.
- Builder: `/root/giwa_backend_inventory` (read-only inventory role ended before this separately assigned builder task).
- Reviewer: separate commander-assigned identity/worktree; builder cannot approve this change.
- Approved contract: `STOCKS-GIWA-001`, final DB-001 prerequisite section, Commander worktree `docs/tasks/stocks-giwa-backend-20260916.md`.
- Base SHA: `8160f354b55dfe9a525565e30ddc007f51448f3d`.
- Branch: `codex/giwa-migration-inspector-20260916`.
- Worktree: `/private/tmp/arco-giwa-migration-inspector-20260916`.
- Allowed/changed files: `scripts/prisma/inspect-migrations.mjs`, new `scripts/prisma/inspect-migrations.test.mjs`, this evidence file.

## Problem and resulting behavior

The old inspector demanded the literal `CREATE SCHEMA IF NOT EXISTS "arco_evm"` in each migration. It rejected six valid incremental migrations even though the first migration already creates the schema. The replacement sorts the complete migration history and requires the idempotent schema bootstrap before qualified object use, without requiring each incremental migration to repeat it. Historical migration SQL and Prisma schema are unchanged.

The inspector remains read-only and has no database or environment dependency. Its CLI remains `node scripts/prisma/inspect-migrations.mjs`, preserving the existing npm command. Exported history/directory functions permit isolated regression fixtures.

## Invariants and guard scope

- Only `arco_evm` schema creation is accepted; it must be idempotent.
- Common CREATE/ALTER/DROP object targets, index/trigger ON targets, REFERENCES/INHERITS and TRUNCATE targets must be explicitly qualified.
- INSERT INTO, UPDATE, DELETE FROM and MERGE INTO write targets must be explicitly qualified, including inside routine bodies. Trigger/FK/locking/ON CONFLICT uses of UPDATE do not introduce a target.
- Quoted and unquoted foreign qualifiers, public identifiers, and waitlist identifiers are rejected.
- Comments and ordinary strings do not falsely become schema references or bootstrap evidence.
- Dollar-quoted routine bodies are scanned; NEW/OLD trigger record fields are allowed within them.
- Single-quoted executable bodies, dynamic EXECUTE, search-path changes, SET SCHEMA, Unicode-escaped SQL identifiers/literals and unsupported DDL object forms fail closed.
- Missing/empty/incomplete history directories and unterminated tokens fail inspection.
- No SQL history, dependency, live registry, contract, server, deployment, user-owned original checkout, environment or secret files changed.

## Verification

Node version: `v24.14.0`.

1. `node --test scripts/prisma/inspect-migrations.test.mjs` — PASS: 24 tests, 0 failures, 0 skips.
2. `npm run prisma:migration:inspect` — PASS: `Prisma migration SQL inspection passed` against the complete existing migration history.
3. `git diff --check` — PASS.
4. `git diff --name-only 8160f354b55dfe9a525565e30ddc007f51448f3d -- prisma` — empty: no schema/history changes.

Regression coverage includes unordered input histories, schema use before bootstrap, bootstrap omission/non-idempotence, comments and nested comments, literal escaping, quoted keyword identifiers, foreign/public/waitlist targets, unqualified/multiple DDL targets, write DML targets and UPDATE keyword contexts, foreign REFERENCES, trigger bodies, dynamic SQL rejection, schema/search-path mutation, malformed tokens, and filesystem history completeness.

Frontend/server/build/money-path integration suites were not run: this standalone read-only script changes no runtime code or database model. Actual database execution and new Stocks-schema verification remain separate tasks.

## Parser limitations

This is a conservative static guard, not PostgreSQL syntax validation, a sandbox, or a proof of complete migration isolation. It does not evaluate expressions, resolve functions, infer search paths/CTEs/aliases, or model arbitrary procedural-language semantics. In particular it does not fully parse query read sources or every SQL grammar context. A function called by a migration may have behavior this inspection cannot discover.

Qualified aliases other than routine NEW/OLD can be conservatively rejected as foreign qualifiers. Dollar-quoted text is conservatively scanned as executable content. Additional valid SQL forms (including intentional function search-path configuration) may need a separately reviewed expansion with negative fixtures. Ordinary strings assume PostgreSQL's standard-conforming strings; E-strings receive explicit escape handling. The script rejects Unicode-escaped SQL syntax rather than decoding it.

New money-path migrations still require human review and disposable real-Postgres application/invariant tests. Passing this guard alone is not migration execution approval.

Mainnet/network/signing/deployment/database actions performed: none.

## Independent-review P1 remediation

Reviewer `/root/rwa_reviewer` found that the single-quoted executable-body guard missed `DO LANGUAGE ... 'body'`, `DO E'body'`, and `CREATE FUNCTION ... AS E'body'`. The ignored literal could therefore hide public/waitlist statements that the old raw inspection rejected. Commander reassigned this P1 fix to the same builder and file scope; schema release remains subject to independent re-review.

Five negative cases were added before changing the guard (the three reported forms plus PROCEDURE with LANGUAGE after its E-string and DO LANGUAGE with an E-string). Initial regression run: 21 tests, 16 pass, 5 fail. The bounded fix tracks pending DO bodies by dollar-quote nesting depth and recognizes an E-prefix before FUNCTION/PROCEDURE AS bodies. It rejects these executable strings while permitting ordinary E-string defaults and scanned dollar-quoted DO bodies.

Post-fix: 21/21 tests pass; actual history inspection and `git diff --check` pass. No SQL history, database calls or additional file scope were introduced. Parser limitations above still apply.

## Trigger TRUNCATE event follow-up

Commander assigned a narrow follow-up because the Stocks migration's immutable-table guards use `CREATE TRIGGER ... BEFORE TRUNCATE ON arco_evm...`. The inspector incorrectly treated that trigger event as an executable TRUNCATE statement with an unqualified target.

Two positive fixtures (`BEFORE TRUNCATE` and `BEFORE UPDATE OR DELETE OR TRUNCATE`) failed before the fix. The parser now records only TRUNCATE event-token positions inside a CREATE TRIGGER header before its ON relation. It still validates that ON target. Normal TRUNCATE statements, later statements after trigger declarations, and statements inside executable DO/function bodies retain the qualified-target check.

Post-fix: 24/24 tests pass; actual committed history inspection and `git diff --check` pass. An additional read-only call to `inspectMigrationsDirectory('/private/tmp/arco-giwa-stocks-backend-20260916/prisma/migrations')` returned no findings, including the builder's new Stocks migration. No file in that builder workspace was modified. No Postgres/server operation was performed. The previous executable-body regression cases still pass.
