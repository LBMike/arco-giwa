# GIWA-BOOTSTRAP-FAUCET-011 — first-time funding before journal handoff

User authorizes completing an actual GIWA local demo before Vercel, reusing their administrator and customer `0x3185f0eFB95228c9E476De5C9da1d1aA8ccf76D2`. This is implementation and test authorization, not permission to unlock a key through tools. Root is commander/integrator. One delegated builder owns this task only; branch `codex/giwa-bootstrap-faucet-011`, worktree `/private/tmp/arco-giwa-bootstrap-faucet-011`, base `c9293a1`. Do not edit010 or the running4392 workspace.

## Bounded scope and files

Implement a reusable first-time test-cash bootstrap engine and durable local state adapter. Allowed: new `server/src/stocks-signer/bootstrap-faucet.ts`, `bootstrap-faucet.test.ts`, `bootstrap-file-store.ts`, `bootstrap-file-store.test.ts`; focused new `scripts/stocks-signer/bootstrap-evm.test.mjs`; existing `scripts/stocks-signer/test-postgres.mjs` only to invoke the new isolated bootstrap integration test; task/evidence/docs. Existing Solidity/deployment scripts, SQL migrations, public signer protocol, other signer modules and customer runtime are read-only. Test dependencies may symlink existing004/001 runtimes. Root separately builds the real-user launcher and database setup.

## Required behavior and invariants

- Dependency-injected engine; no real key/password, network endpoint discovery, automatic public RPC, new schema, public signing or service changes during implementation/tests.
- Exact manifest/digest, administrator=faucet role, fixed distinct recipient, positive bounded integer test-cash amount and EIP1559 fee caps. Reuse existing local custody and `verifySignedOriginal`; no native transfer or arbitrary call support.
- Only valid before a signer account exists. Acquire/hold an explicit database bootstrap lock covering absence check, any send and final handoff; seeded/existing journal is never deleted/reseeded/modified. Think through concurrent first-run CLI/processes and accidental host startup. The engine must not start a live HTTP host itself.
- Validate public GIWA network/checkpoint/contract identity and current finalized/pending nonce before initial send. Persist exact immutable plan/nonce and signed hash durably before a single broadcast. Once an attempt is marked, unknown/crash outcomes permit lookup of the same original only, never signing or broadcasting again. Failures never silently invent completion or a fresh nonce.
- After original finalized success with exact sender/nonce/to/data/value and expected token mint/recipient amount, require fresh matching chain nonce before first seed. Return auditable handoff evidence to the reviewed caller; account insertion if implemented must be create-only under the same lock and bind manifest network/checkpoint/initialNonce. No nonces guessed from231.
- Durable local state files are owned, restrictive, symlink-safe, exclusive/atomic and fsynced. No secret/raw key material in public records or errors. A torn/ambiguous attempt fails closed. It is acceptable to block recovery for a never-broadcast signed hash; do not introduce a retry that violates the once-only rule.
- After handoff, no bootstrap faucet permitted. Further top-ups require a separate shared-journal extension and are outside this task.

## Validation

Unit tests for exact calldata/amount/identity/nonce/fee scope, changed or existing plan, unknown outcome, crash before/after broadcast, and irreversible handoff boundaries. Real PostgreSQL plus local EVM test with deployer=operator=faucet and distinct customer: customer faucet finalized, account seed, normal encrypted-custody settlement compatibility, parallel bootstrap no double send, response loss/restart same hash, seeded account rejects faucet. Use only generated/test wallets and owned temporary databases; no real key, Supabase or GIWA write. Run relevant compiler/security/migration checks. Root integrates and runs global baseline after reviewing final code.
