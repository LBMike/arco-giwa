# Stocks public configuration reader — 2026-09-20

Runtime startup and the preflight CLI previously used different public-file readers from integration preparation. The preflight reader decoded malformed UTF-8 with replacement characters: a fixture containing byte `0xff` inside an operator ID produced `CONFIGURED_NOT_PROBED` instead of rejecting the file. Runtime startup also lacked the existing integration tool's 64 KiB read limit.

All three paths now share `readStocksPublicJson`. It validates the supplied, absolute and resolved path components; rejects `.env*`/`.secrets` case-insensitively; opens without following a final-component symlink; rejects non-regular files; bounds the actual read as well as the initial size check; and requires strict UTF-8 JSON. The open file handle is closed on success and failure. File errors contain a fixed code without the supplied path or file contents. Normal public symlinks and relative runtime/preflight paths remain supported. The integration command retains its absolute-path and no-overwrite policy.

Validation:

- The malformed-UTF-8 CLI regression failed before the fix (exit 2) and passes afterwards (BLOCKED, exit 1).
- Focused reader, preflight and integration-bundle suites: 25 passed, zero failures/skips. Coverage includes exact 64 KiB acceptance, oversize rejection, multibyte text, malformed encoding, invalid JSON, directories, missing files, symlink loops, and named pipes without a writer.
- Configured-runtime tests verify fixed input rejection before external dependency construction, and preserve disabled-mode behavior.
- Full local server suite: 425 passed, zero failures, 85 database-only skips. Typecheck, product/server builds and security checks passed. The design-token check retains the seven previously documented findings; story checks have no blocking findings.
- Standard Node22 frontend suite: 764 passed, zero failures, seven optional skips; the full DOM integration runtime is not enabled in this invocation.

This filesystem change does not modify database schema, contract code or UI. Real database validation from the preceding operator-directory increment remains separate evidence, not a new database run for this change. Frontend and hosted validation results are retained separately in `review-results/20260920/public-config-evidence/` and the draft PR.

The reader is an input boundary, not filesystem isolation against a concurrent privileged process changing parent directories. Public deployment and actual UI-to-testnet trading still require the external services and deployment evidence described in the activation guide.
