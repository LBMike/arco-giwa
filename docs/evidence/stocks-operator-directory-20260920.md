# Stocks operator-directory validation — 2026-09-20

The runtime previously checked only operator field types. Duplicate IDs, malformed audit identities and unknown permissions could survive configuration parsing. The session resolver also returned its stored permissions array directly, so a server-side caller mutating one result could change later requests' authority.

Added a shared validator at configuration parsing, direct runtime composition and session creation. Wallets normalize before uniqueness checks; IDs obey the existing control audit text limit; only unique `stocks:read`/`stocks:control` permissions are accepted. Failures return a fixed `INVALID_STOCKS_OPERATORS` error without external calls. Each resolved operator is now a fresh copy. Empty directories, empty permissions, read-only and control-only identities retain their existing behavior. Online preflight still separately requires a reader; the owner integration-bundle policy remains stricter.

Validation on the changed working tree:

- Before the fix, three of four new regression tests failed: boundary validation, cross-request mutation isolation and preflight rejection. The compatibility test passed.
- Focused runtime/preflight/bundle/control tests: 28 passed. Final server suite: 419 passed, 0 failed, 85 DB-only skips.
- Real PostgreSQL suite: 92 passed, 0 failed, 0 skipped. Process/database restart, BUY/SELL recovery, operator state/history/idempotency and backup/restore comparison passed (22 tables, 1,643 rows). Owned fixture processes stopped, archive removed and temporary fixture directory removed after evidence retention.
- Node 22 standard frontend suite: 764 passed, 0 failed, 7 skipped. This invocation does not enable the optional full DOM integration runtime.
- Typecheck, product build, server build and security checks passed. Design-token check reports the same seven documented findings; story check has no blocking findings.

Local logs and fixture cleanup evidence are retained in the untracked `review-results/20260920/operator-directory-evidence/` directory. Hosted checks are recorded separately on the PR; these local results do not claim hosted success.

This change does not deploy Stocks contracts or provision public services. Public hosting, database, role addresses, external signer and actual testnet deployment evidence remain required for public integration.
