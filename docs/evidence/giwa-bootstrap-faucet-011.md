# GIWA-BOOTSTRAP-FAUCET-011 evidence

Base `c9293a1`, branch `codex/giwa-bootstrap-faucet-011`. Changes are limited to first-bootstrap engine/store/tests, the existing isolated PostgreSQL test runner invocation, and this task's documentation. No actual administrator keystore, Supabase data, public RPC transaction, deployment registry, existing contract source, or running4392 workspace was read or changed by this task.

## Behavior

- Exact manifest digest, five-contract code/binding/checkpoint verification, faucet role, distinct recipient, integer test amount, EIP1559 fee ceilings and finalized/pending nonce equality are required before first signing.
- Plan is claimed exclusively before signing. Verified signed hash is persisted before the only send. Restart is always lookup-only for that original. Interrupted plan without intent fails closed.
- Finalized successful receipt must contain exactly the expected cash mint. Fresh nonce equality is checked before create-only signer account insertion under a PostgreSQL table lock.
- Immutable handoff is persisted before seed commit, permitting exact recovery of a lost commit response while rejecting unrelated existing accounts. No seed deletion, reset, normal faucet endpoint or ongoing faucet operation was added.
- Independent review found the between-poll ownership boundary. Commander012 confirmed sole seed authority, permanent store/cluster binding, external durable attempt marker and a session advisory lock across runner lifetime. The engine additionally blocks an independent seed INSERT during each transaction. Privileged manual SQL between polls is outside that launcher ownership model and cannot be prohibited without a schema/privilege change.

## Executed verification

- `npm run build:server`: passed.
- Focused engine/store tests:13 passed,0 skipped. Covers exact call/nonce/fees, invalid role/network/scope, malformed/changed state, lost send response, absent original, interrupted durable claim/hash/handoff writes, unrelated existing account, symlink/hardlink/FIFO/torn/oversized records, exclusive concurrent file publication and immutable recovery.
- `TMPDIR=/private/tmp node scripts/stocks-signer/test-postgres.mjs`: actual owned temporary PostgreSQL with6 journal tests, migration guard, restart probe, original KMS host EVM test, original encrypted-keystore host EVM test, and new shared-admin bootstrap EVM test.9 total node tests passed,0 skipped, plus standalone migration/restart assertions.
- New actual PostgreSQL/EVM path uses deployer=operator=faucet and a different customer. Two concurrent bootstrap calls produce one signature and one broadcast; an independent seed INSERT is blocked during signing. After acceptance with the response discarded and receipt hidden, a separate process with no signing capability recovers the same hash, verifies finality, and seeds the account. The unchanged encrypted custody/journal subsequently performs customer funding, mint, partial redemption, and duplicate requests without duplicate sends. Empty-state bootstrap after account initialization rejects.
- `npm run test:security`: passed.
- `npm run prisma:migration:inspect`: passed.
- `git diff --check`: passed.

The initial sandboxed PostgreSQL attempt failed at operating-system shared-memory creation before any test ran. The same owned temporary harness was then permitted and completed; this was not an application failure. Full frontend/build/global server baseline remains the root integrator's responsibility after integration. No actual user trade or public faucet transaction is claimed by these results.
