# GIWA Stocks host authentication

User instruction: continue the next development and report current work. This follows the agreed common SIWE host prerequisite. Builder: this Codex task `/root`; independent reviewer is separate from the builder.

Base: `bc67cf2a8ae98d3e5f820627afe8f25046a0891a`. Isolated local clone `/private/tmp/arco-giwa-stocks-host-20260917`, branch `codex/giwa-stocks-host-20260917`. No other builder checkout is modified.

Plan recorded before code:

- Add `src/demo/giwa/stocks-host/**`: framework-independent in-memory SIWE session controller, request/response checks, current-wallet message signing bridge, structural adapters for investor/admin host props, small external-store React hook, deterministic tests.
- Add optional message signing/read methods to the existing private `ActiveWalletClient` type in `contracts.ts` so the active injected/Dynamic source is reused. Existing transaction behavior is unchanged; clients without message signing fail closed for login.
- Add this task and a matching evidence document. No routes, provider mounts, feature folders, server, deployment, database, dependency, lockfile, token or wallet SDK configuration changes.

Authentication uses the existing POST `/api/v1/auth/nonce` and `/api/v1/auth/verify`. The SIWE domain is the frontend host including port, not the API origin. Only an explicit `signIn()` action requests a message signature. It never sends a transaction. The JWT is returned by the server and retained only in memory; decoding here checks binding/expiry, not its cryptographic authenticity or operator authority.

Every change of wallet, chain, frontend origin, API base or wallet source epoch clears the session and cancels the old operation. A generation fence covers nonce, wallet signature, verify and late failure. A→B→A, logout, expiry and disposal cannot revive old requests. Session IDs are opaque, rotate on each successful login and gate late 401 invalidation. Server logout/revocation does not exist; logout is local discard.

Bounded HTTP requests use abort plus completion-time checks. Signing is user-controlled and limited by the nonce expiration; expiry cancels the host attempt, but cannot dismiss a wallet extension's own prompt. No automatic signing, login renewal, persistent storage or raw provider errors.

Investor/admin APIs are in active parallel development. Structural adapters match the currently documented shapes without importing their unfinished code. The future integrator owns final props compatibility and mounting the host once across investor/admin navigation. `/admin/stocks` must be outside legacy operator-token/allowlist guards. No current route is represented as connected by this task.

Validation: real SIWE message parse/sign/verify with an ephemeral test-only account; injected fetch, clock, timers and deferred signature/HTTP for race/expiry tests; wallet bridge method allowlist and account/chain change; existing frontend suite; typecheck/build/security/design hooks. No public RPC, real wallet, DB, deployment or secrets. Root dependencies are independently copied from a same-package/lock checkout; no install or configuration changes.
