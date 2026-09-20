# Stocks preflight mutation-guard verification — 2026-09-20

## Change

Paused-start preflight previously checked migration hashes and readable tables, but could pass after a DB administrator disabled a protection trigger or replaced its function without changing migration history. The database probe now reads the trigger/function catalogs and compares them with a reviewed contract derived from the existing Stocks migrations.

The base configuration requires 38 triggers / 10 functions. Operator controls require 44 / 13. Exact inventory, enabled state, event/timing/deferral semantics, function identity/settings and final function-body hashes must match. Unexpected user triggers and non-origin replication sessions also fail. A matching schema remains read-only throughout; this is not a runtime auto-pause or schema-repair feature.

## Local verification

- Node24.14.0 / PostgreSQL18.6, using newly created harness databases.
- Focused guard/database units: 10 pass, 0 fail, 0 skip.
- Full server suite: 411 pass; 85 DB-only tests skipped in that no-DB invocation and covered separately by the actual PG harness.
- Actual full PG harness: **92 pass, 0 fail, 0 skip**. Restart, order/receipt/control recovery, dump/restore after original fixture DB removal, and owned-resource cleanup passed. The restored snapshot contained 22 tables / 1,643 rows.
- Eleven actual DB mutations each leave migration history valid but fail the new check: disabled trigger, replica-only trigger, missing trigger, `WHEN(false)`, missing UPDATE event, same-name no-op function, SECURITY DEFINER, function settings, disabled operator-history guard, changed deferred timing, and an unexpected trigger. Every mutation is repaired in `finally`; the pristine state passes again after each case.
- A separate real PG session with `session_replication_role=replica` fails. An ALWAYS-enabled trigger in an origin session passes.
- Unit tests compare every Stocks migration trigger and final replaced function body with the checked-in contract, and reject individual removal/disablement of all 44 guards.
- Typecheck, production build and security checks passed. Existing design-token findings remain seven; story checks have no hard failure.

The first default Node24 frontend sweep had two timing-sensitive failures in unchanged tests: the quote's 59,999ms boundary and a 20ms control-request timeout. Its log is retained; it is not counted as a pass. Node22 with the full DOM fixtures and hosted validation are recorded separately in the development PR and local final report.

## Scope

No production UI, contract, migration, registry, signer or deployment configuration changed. The user-operated local environment is not restarted or modified by these isolated tests. This check does not comprehensively compare CHECK/UNIQUE/foreign-key constraints, indexes, columns or write privileges, and cannot prevent later administrative changes. Public test-environment deployment remains dependent on the actual hosting, roles and signer configuration.
