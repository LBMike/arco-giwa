# Stocks offline integration bundle — 2026-09-20

## Implemented

`stocks:integration:prepare` assembles an existing reviewed v2 deployment manifest and explicitly provided public settings into a new directory containing `runtime-config.json` and `integration.json`.

The runtime starts configured paused with operator controls enabled. The handoff describes CORS, SIWE domains, explicit browser API/public-RPC/admin-visibility settings, the runtime-file hash, and required server-only configuration names. Server RPC and signer endpoint values are not inferred as browser values. The input must pin the separately retained expected manifest digest and acknowledge the existing contract policy. This is an offline configuration check, not deployment evidence or trading authorization.

No frontend, Solidity, migration, registry, existing runtime configuration or user-run local service is changed. No new dependency is introduced.

## Local checks

- Server regression suite: **415 pass, 0 fail**, 85 database-only cases skipped in the no-DB invocation. This change does not alter a database query or schema.
- Four focused tests cover deterministic generation, compatibility with the actual runtime parser and offline preflight, manifest/ABI/digest/extra-field rejection, operator permissions/duplicates/Unicode, URL and CORS boundaries, output-size bounds, executable CLI behavior, inherited secret exclusion, redacted errors, file modes and overwrite/path rejection.
- Typecheck, production build and security checks pass. Existing design-token debt remains seven findings; the story check has no hard failure.
- Fixtures use explicit `.example.test` addresses and generated temporary files. They are not public deployments or operator configuration. All fixture directories are removed by the tests.

The standard CI runs the new server tests automatically. Final head-specific Linux results are recorded in the development PR and the local integration-bundle report.

## Remaining activation work

Real manifest evidence, hosting/DB, role addresses and external signer configuration are still needed. Generated JSON must be applied to the appropriate server/build environments; the tool does not deploy or modify those environments. Online preflight, paused observation, reconciliation and the existing controlled resume procedure remain mandatory. `paused: true` is not overridden by the operator UI's resume action.
