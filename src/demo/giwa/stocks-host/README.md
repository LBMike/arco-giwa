# Stocks host session integration

The session host is mounted once inside both GIWA wallet-provider branches, above the application router. Investor/admin navigation preserves the in-memory login; a full refresh or owner unmount discards it. Connecting a wallet does not sign in. The `/stocks` and `/admin/stocks` routes (`../stocks-market`) consume it.

`GiwaStocksHost` maps the active wallet's address, chain, signing readiness, connection epoch and active source object (`wallet.source`), plus `window.location.origin` and configured API base, into `StocksHostProvider`. `useGiwaStocksHost().wallet` exposes that view (address, chain, epoch, source) to the `/stocks` execution host (`../stocks-execution-host`), which captures the injected provider for its wallet ports; sign-in never uses it. `useGiwaStocksHost()` exposes the current snapshot, structural investor/admin session props, explicit signIn/logout actions and request-ID-scoped invalidation. `StocksSignIn` is an exported accessible control for the future Stocks surfaces; it is deliberately not placed on unrelated Savings/Funds pages.

The provider guards the scope during render, before layout-effect cleanup. An old scope's controller is never supplied to a new scope. Every layout-effect setup creates a new controller and cleanup disposes it, including React StrictMode replay. A wallet/source replacement also increments its connection epoch, preventing A→B→A from reviving a prior login. No unfinished feature files are imported and no request is issued on mount.

## Host lifecycle

1. Create one `createStocksHostSession(context, { signMessage: signWithActiveGiwaWallet })` per browser host lifetime. `context` includes the connected wallet address, chain, frontend **origin**, configured API base and optional wallet-connection epoch. Use `window.location.origin` as `frontendOrigin`; SIWE uses its host including port. Do not use the backend host for SIWE.
2. Subscribe with `useStocksHostSession(controller)` or `controller.subscribe`. Owning integration must synchronize `setContext` with wallet/chain/API changes before supplying session props to the feature. Do not keep displaying a previous scope while waiting for an effect or fetch. React lifetime/StrictMode ownership belongs to the mounting host; never reuse a disposed controller.
3. On an explicit user login action call `controller.signIn()`. This requests nonce, asks the **currently selected** injected or Dynamic wallet to sign a SIWE message, then calls verify. It never connects a wallet automatically, changes chains, signs a transaction or broadcasts. A concurrent click shares the same attempt. The signature format matches the current EOA backend path (65 bytes); contract-wallet signature support is not claimed.
4. Supply `investorSession(snapshot)` and `adminSession(snapshot)` to the feature props. These are structural adapters to the current builder contracts, not imports of unfinished features. The admin adapter grants no permission: server `stocks:read` remains authoritative.
5. Capture the returned session ID when dispatching authenticated requests. A 401 can call `invalidate(capturedId)`, so an old failure cannot clear a newer login. Do not read the latest ID after the failing request finishes. Admin endpoints currently use 403 for both unrecognized sessions and missing operator rights; do not treat 403 as proof of a valid authenticated session.
6. `logout()` immediately drops local credentials and pending attempts. There is no server revocation endpoint; do not promise that this invalidates a previously issued JWT on the server. No localStorage/sessionStorage/cookie is added. Refresh loses the in-memory login.
7. Call `refresh()` when a hidden page becomes visible so wall-clock expiration is promptly reflected. Reads also fail closed after expiry or clock reversal. Session transitions found during a snapshot read notify asynchronously to avoid React-render reentrancy. Expiry never requests another signature.
8. At final owner unmount call `dispose()`. Aborting the host attempt cannot dismiss an already-open external wallet prompt; its eventual result is discarded. Nonce expiry bounds how long this module waits for that prompt.

The existing application providers now live above `RouterProvider`, so existing investor/admin branches share one lifetime. `/admin/stocks` must still be added outside the legacy `RequireGiwaAdmin` / operator-token layout by the future feature integrator. Existing legacy administrator guards remain unchanged.

## Data and failures

- JWT claims are decoded only to reject an obviously mismatched or expired server response. This is not browser signature verification and grants no server/operator authority.
- Session IDs contain a random controller prefix and generation, never the token or wallet. Every successful explicit login rotates the ID.
- Wallet/account/chain, frontend origin, API base and wallet epoch changes cancel and fence all asynchronous stages, including stale errors. A→B→A does not reuse the first A attempt.
- HTTP defaults to a 15-second total fetch/body deadline per endpoint, bounded further by nonce expiry for verify. It uses abort plus elapsed-time acceptance checks. Response redirects are refused, credentials omitted, caching disabled. Error state contains stable codes only, never provider messages, RPC URLs or tokens.
- All five session actions (`signIn`, `setContext`, `logout`, `invalidate`, `dispose`) are local API calls; creation alone performs no network or signature action.

## Validation scope

Tests use fake HTTP/clock/timers and an ephemeral generated test account to validate SIWE compatibility with the existing `SiweMessage` parser/verifier. Wallet tests exercise both the actual active Dynamic-client selection and the injected viem client with a stub EIP-1193 provider, allowing only `eth_accounts`, `eth_chainId`, `personal_sign`. They do not exercise an installed wallet extension, live Dynamic service, actual HTTP application/nonce database, public RPC, UI routes or public execution.

No dependency/lockfile, server/auth endpoint, funds contract, deployment, database, common theme or route definition is modified. The existing transaction APIs retain their runtime implementation. Shared provider ownership moves from `GiwaPreprodApp` to `main.tsx`; the wallet context now includes signing readiness and connection epochs.

The DOM lifecycle gate uses an existing external jsdom installation without adding a dependency:

```sh
GIWA_HOST_DOM_RUNTIME=/path/to/existing/node_modules/jsdom/package.json npm run test:frontend
```

Without that explicit runtime the normal suite reports the DOM gate as skipped. It must be enabled for mounting changes. Tests run real React DOM and actual wallet-provider source with fake vendor-hook inputs and contract balance transport. They cover StrictMode, scope changes before effects, batched injected A→B→A, Dynamic/Wagmi mismatch, signer replacement, route navigation, refresh, expiry/401, late HTTP completions, pending logout and cleanup. This does not claim installed-wallet or live Dynamic SDK testing.
