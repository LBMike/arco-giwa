# GIWA-LOCAL-CUSTOMER-010 verification

2026-09-24. Base `c9293a1`. Fixed UI4392 → local API4393 → encrypted signer4394 composition is implemented. Supabase and public GIWA remain authoritative; this is not the disposable EVM harness.

Verified:
- Typecheck and production build passed.
- Server suite: 571 passed, 92 skipped, 0 failed (663 total), bounded concurrency2.
- Frontend suite with the explicit jsdom runtime: 946 passed, 15 skipped, 0 failed (961 total), bounded concurrency2. Existing SSR warnings remain.
- Native HTTP gateway tests: 16 passed, including fixed local Stocks/SIWE forwarding, unchanged legacy reads, forbidden routes and origin checks.
- Focused local configuration/setup tests: 7 passed, including a synthetic hidden-input PTY, terminal restoration and restrictive file persistence. Latest environment-only rerun: 4 passed.
- Security checks and migration SQL inspection passed.

An initial over-parallel verification run exceeded existing deadline tests while multiple full suites and builds competed for local resources. The bounded rerun above completed without failures. This is not evidence of public-chain customer trading.

Independent review found and corrected PostgreSQL query-parameter host/user override risk, FIFO blocking, and an operator-control configuration bypass. Normal hosted configuration still rejects an HTTP signer. Local execution requires the exact manifest, network, ports, Supabase project, explicit operator permissions and persistent trading controls.

The durable `GIWA_LOCAL_DEMO_20260924/configure-server.command` invokes the reviewed setup helper with pinned file hashes. It accepts server connection input only through the user's hidden local TTY and creates an exclusive0600 file inside an owned0700 directory. It neither connects to a database nor signs or sends a transaction. Actual inputs were not inspected by the model.

Outstanding operational steps: confirmed private configuration, guarded Supabase migration/preflight, persistent signer journal, first-time test-cash bootstrap before account seed, signer/API startup, CURRENT observation and audited operator resume, controlled UI4392 switch, and customer-signed buy/sell acceptance. No hosted deployment, existing4392 restart, public transaction or Supabase mutation occurred in this task.
