# User-operated GIWA local demo

Use the existing4392 investor UI, actual public GIWA Sepolia deployment007, and Supabase project `munsybkrsxrmajmbssli`. The customer is `0x3185f0eFB95228c9E476De5C9da1d1aA8ccf76D2`. API uses4493 and encrypted signer4394. Existing previews on4393/4395 are preserved; loopback4396 serializes the local tool lifetime and serves no HTTP/data API. Vercel/Render settings are unchanged.

The durable folder is `GIWA_LOCAL_DEMO_20260924` in the project directory. User input is through its local terminal commands only. Do not place a wallet private key/password or database connection value in chat.

1. `configure-server.command`: hidden Supabase DATABASE_URL input; exclusive private0600 configuration with local random credentials. No DB access or signing.
2. `prepare-local.command`: verify all fifteen migration hashes, apply only the remaining authorized Stocks suffix, require all database preflight checks to pass, and prepare the persistent local signer database. It does not unlock a wallet or send a transaction. Existing product records and migration history are retained.
3. `start-local-demo.command`: verify preparation, unlock the existing administrator keystore through hidden local input, and perform the first test-cash bootstrap. It funds only the fixed customer with10,000 ARCO_TEST_USDC before creating the initial signer account. Signed original hash is durable before the only broadcast; restarts look up the same original. Wait for finality before automatic settlement starts. This terminal must remain open during the demo.
4. After `LOCAL_CUSTOMER_API_READY`, the integrator switches the existing4392 preview to the explicit local mode using the reviewed source and preserved UI. This is deliberately still a separate controlled switch while the user's original server is running.

First-time readiness advances the original observer history without skipping blocks, requires current observation and matched reconciliation, and performs the existing audited version-zero operator resume. Restart never clears a later operator pause. Customer buy/sell still requires their own wallet signatures.

The persistent signer database is stored in `private/signer-postgres`. Its identity proof binds PostgreSQL system identifier, database OID, full schema/guard digest, migration hashes and bootstrap-directory inode. Missing/replaced storage or removed guards fail closed. Initialization never deletes or reseeds a journal. PostgreSQL listens only on an owned private Unix socket with durable writes enabled. Preparation and launch acquire the same singleton before starting PostgreSQL and retain it through shutdown; a session advisory lock additionally covers bootstrap and signer-host lifetime. No separate administrator transactions may run while this host owns the signer account.

The outside bootstrap marker is published after durable plan creation and before signing, allowing harmless pre-plan RPC errors to be retried. Missing marker/plan consistency requires review. Cancellation blocks subsequent signing, broadcasting and operator resume; already-started operations drain normally. All error messages use fixed stages/actions, never raw secret-bearing exceptions.

The preparation/start commands stop PostgreSQL only if that invocation started it; data remains. Ctrl+C drains API and signer work before releasing storage and the singleton. If preparation is interrupted after creating a database but before its proof is committed, the partial setup requires inspection rather than automatic reset.

This software verification is not evidence of actual customer trading. At handoff, the private server configuration, Supabase migration execution, public bootstrap, local wallet unlock and4392 switch must each be recorded separately. Never report the demo ready solely because these scripts compile.
