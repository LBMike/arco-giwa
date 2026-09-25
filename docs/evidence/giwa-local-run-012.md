# GIWA-LOCAL-RUN-012 evidence

2026-09-24. Base `fe0fa35`, integrated bootstrap011 as `3addd1c` (original builder commit `51bcaaf`). No existing4392 source, other previews, contracts or hosted settings changed.

Implemented explicit guarded Supabase preparation, persistent local signer PostgreSQL, one-time customer bootstrap integration, hidden local keystore unlock, original-hash recovery, initial audited operator resume after current observation/reconciliation, and actual local API startup. Customer/admin and fee ceilings are fixed in the user launcher. Public runtime JSON was generated from the completed007 manifest.

Validation:
- Server suite584 passed,92 skipped,0 failed (676 total).
- Operations/configuration tests10 passed, including actual PostgreSQL seed persistence after stop/start, altered guard rejection, missing database/cluster rejection, process singleton, later-pause preservation and cancellation before operator mutation.
- Actual local HTTP gateway2 focused tests passed after moving API to4493; existing previews on4393 and4395 remain untouched.
- Bootstrap011 evidence covers13 focused unit/store tests and9 actual PostgreSQL/EVM tests, shared administrator, separate customer, duplicate attempts, lost acknowledgement across process restart, first seed, encrypted-custody mint and partial redemption.
- Frontend suite946 passed,15 skipped,0 failed (961 total), explicit jsdom runtime and concurrency2. Existing SSR warnings remain.
- Typecheck, production build, security and migration inspection passed. The build retains its existing large-chunk warning.
- Additional final readiness regression confirms observation expiry during the last control read prevents resume; the readiness suite is4 passing tests. A non-TTY CLI test passes without configuration or wallet access and proves supplied synthetic input is not echoed.

Durable installation: code commit `4c7264e` is archived into `GIWA_LOCAL_DEMO_20260924/source`, with compiled server files and local copies of the already-tested dependency trees. Dependencies retain actual `node_modules` directory names for Node resolution and use no absolute symlinks to `/private/tmp`. Three `.command` files verify a pinned244-file SHA256 manifest before running configuration, explicit preparation or hidden-TTY launch. `source-version.json` records the code commit and customer/ports, with activated=false. No private settings file is included in source or checksums.

From the actual durable source directory, all13 operations/configuration/readiness/non-TTY/hidden-PTY tests passed, including actual isolated PostgreSQL restart. All244 file hashes verified and copied ts-node/ethers dependencies resolved. The user's private server configuration remained absent throughout; these tests use synthetic input and isolated temporary storage only.

Independent review corrected false-ready handling of failed preflight checks, missing storage identity, socket path length, binary version detection, process lifetime race, cancellation boundaries and pre-plan attempt marking. A macOS PostgreSQL locale startup failure was reproduced with a synthetic empty test cluster and fixed by pinning LC_ALL=C. An initial unrestricted-socket test run in the sandbox failed EPERM; the authorized local test rerun passed. No real credentials or wallet were used in these tests.

Operational status: user reported configuration saved, but repeated metadata-only checks found `private/server.json` absent. A clarification about the final local terminal status is pending. No Supabase migration, public test-cash transaction, real keystore read/unlock, signer seed, actual API launch, customer trade or4392 replacement has run. The existing4392 process remains96850. Vercel and Render remain unchanged.
