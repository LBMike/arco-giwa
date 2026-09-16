# Stocks host session integration

This module is ready for composition; it is not mounted in existing routes. It imports no investor/admin builder files and issues no requests at import or construction. The only existing source change is optional message/read methods on the existing active wallet client type.

## Host lifecycle

1. Create one `createStocksHostSession(context, { signMessage: signWithActiveGiwaWallet })` per browser host lifetime. `context` includes the connected wallet address, chain, frontend **origin**, configured API base and optional wallet-connection epoch. Use `window.location.origin` as `frontendOrigin`; SIWE uses its host including port. Do not use the backend host for SIWE.
2. Subscribe with `useStocksHostSession(controller)` or `controller.subscribe`. Owning integration must synchronize `setContext` with wallet/chain/API changes before supplying session props to the feature. Do not keep displaying a previous scope while waiting for an effect or fetch. React lifetime/StrictMode ownership belongs to the mounting host; never reuse a disposed controller.
3. On an explicit user login action call `controller.signIn()`. This requests nonce, asks the **currently selected** injected or Dynamic wallet to sign a SIWE message, then calls verify. It never connects a wallet automatically, changes chains, signs a transaction or broadcasts. A concurrent click shares the same attempt. The signature format matches the current EOA backend path (65 bytes); contract-wallet signature support is not claimed.
4. Supply `investorSession(snapshot)` and `adminSession(snapshot)` to the feature props. These are structural adapters to the current builder contracts, not imports of unfinished features. The admin adapter grants no permission: server `stocks:read` remains authoritative.
5. Capture the returned session ID when dispatching authenticated requests. A 401 can call `invalidate(capturedId)`, so an old failure cannot clear a newer login. Do not read the latest ID after the failing request finishes. Admin endpoints currently use 403 for both unrecognized sessions and missing operator rights; do not treat 403 as proof of a valid authenticated session.
6. `logout()` immediately drops local credentials and pending attempts. There is no server revocation endpoint; do not promise that this invalidates a previously issued JWT on the server. No localStorage/sessionStorage/cookie is added. Refresh loses the in-memory login.
7. Call `refresh()` when a hidden page becomes visible so wall-clock expiration is promptly reflected. Reads also fail closed after expiry or clock reversal. Session transitions found during a snapshot read notify asynchronously to avoid React-render reentrancy. Expiry never requests another signature.
8. At final owner unmount call `dispose()`. Aborting the host attempt cannot dismiss an already-open external wallet prompt; its eventual result is discarded. Nonce expiry bounds how long this module waits for that prompt.

Investor and admin branches currently mount separate existing app providers. The future route integrator must define a common lifetime or explicitly accept a new login on remount. `/admin/stocks` must not inherit the legacy `RequireGiwaAdmin` / operator-token layout. These route/provider decisions are deliberately not applied while the two feature builders are working.

## Data and failures

- JWT claims are decoded only to reject an obviously mismatched or expired server response. This is not browser signature verification and grants no server/operator authority.
- Session IDs contain a random controller prefix and generation, never the token or wallet. Every successful explicit login rotates the ID.
- Wallet/account/chain, frontend origin, API base and wallet epoch changes cancel and fence all asynchronous stages, including stale errors. A→B→A does not reuse the first A attempt.
- HTTP defaults to a 15-second total fetch/body deadline per endpoint, bounded further by nonce expiry for verify. It uses abort plus elapsed-time acceptance checks. Response redirects are refused, credentials omitted, caching disabled. Error state contains stable codes only, never provider messages, RPC URLs or tokens.
- All five session actions (`signIn`, `setContext`, `logout`, `invalidate`, `dispose`) are local API calls; creation alone performs no network or signature action.

## Validation scope

Tests use fake HTTP/clock/timers and an ephemeral generated test account to validate SIWE compatibility with the existing `SiweMessage` parser/verifier. Wallet tests exercise both the actual active Dynamic-client selection and the injected viem client with a stub EIP-1193 provider, allowing only `eth_accounts`, `eth_chainId`, `personal_sign`. They do not exercise an installed wallet extension, live Dynamic service, actual HTTP application/nonce database, public RPC, UI routes or public execution.

No dependency/lockfile, server/auth endpoint, funds contract, deployment, database, common theme or existing route is modified. The existing transaction APIs retain their runtime implementation.
