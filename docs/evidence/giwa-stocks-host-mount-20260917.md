# GIWA Stocks host mounting — builder evidence

Base: `dee3dd846f8fdc8b4c9ea17f5354b098b359e419`.
Checkout: `/private/tmp/arco-giwa-stocks-host-mount-20260917`.
Branch: `codex/giwa-stocks-host-mount-20260917`.
The implementation commit is the commit containing this evidence. Builder verification is not independent approval; root must review before integration.

## Result

The existing app now owns one provider above RouterProvider. Both injected and Dynamic wallet branches mount the in-memory Stocks authentication host inside their existing wallet context. Existing route definitions and legacy administrator guards are retained. The provider does not issue HTTP, prompt for a signature, automatically connect, change chain, sign a transaction or broadcast merely by mounting.

`StocksHostProvider` compares wallet/chain/origin/API/connection epoch/signing readiness and dependency identity during render. A mismatched owner's session is hidden before layout-effect disposal. Every effect setup creates a fresh session controller, including StrictMode replay; every cleanup disposes it and removes visibility/pageshow listeners. An expired session is checked on reads as well as timer/visibility events. An old request must invalidate with its captured session ID. Controller/session implementation remains unchanged from the base.

Injected connection events advance the authentication epoch, including batched A→B→A. A late connection response cannot undo logout or an account replacement. A newer chain event during connection remains authoritative without discarding the valid connected account. Dynamic signing readiness requires the current account, primary wallet and signer-client account/chain to agree. Signer replacement at the same address changes the epoch. Local logout clears the wallet-facing authentication scope while asynchronous SDK logout completes.

`StocksSignIn` exports explicit sign-in, cancel, sign-out, generic error/retry and expiry states. It uses existing color tokens and native buttons with an accessible status region. It does not display JWTs, raw provider errors, RPC endpoints or implementation codes. It is prepared for later Stocks feature composition; it is NOT inserted into Savings/Funds pages or represented as a working Stocks route.

## Checks

- `npm run typecheck`: pass.
- `npm run build`: pass (existing large chunk warnings).
- `GIWA_HOST_DOM_RUNTIME=/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json npm run test:frontend`: 217/217 pass, 0 skipped.
- Dedicated DOM gate with the same runtime: 11/11 pass, 0 skipped.
- `npm run test:security`: pass.
- `node .claude/hooks/check-design-tokens.mjs --all`: exactly the 7 pre-existing findings in Investor.tsx and components.tsx; no new finding.
- `node .claude/hooks/check-story-exists.mjs --all`: pass, existing soft warnings only.
- `git diff --check`: pass.

Logs:
- `/private/tmp/giwa-stocks-host-mount-typecheck-20260917.log`
- `/private/tmp/giwa-stocks-host-mount-build-20260917.log`
- `/private/tmp/giwa-stocks-host-mount-frontend-20260917.log`
- `/private/tmp/giwa-stocks-host-mount-dom-20260917.log`
- `/private/tmp/giwa-stocks-host-mount-security-20260917.log`
- `/private/tmp/giwa-stocks-host-mount-tokens-20260917.log`
- `/private/tmp/giwa-stocks-host-mount-stories-20260917.log`

The default frontend command skips the optional DOM gate when GIWA_HOST_DOM_RUNTIME is absent; this verification explicitly supplied the already installed jsdom runtime. No dependency was installed or changed. The new gate executes real React DOM, StrictMode and both production wallet providers. Only the Dynamic/Wagmi vendor-hook inputs and contract balance transport are replaced by fake ports using the Node module hooks available in the local Node v24 runtime. It verifies no automatic authentication, explicit button login, cleanup, first-render scope fencing, late nonce/verify success and 401, source/API/origin/chain changes, route navigation, remount/refresh, expiry, retry, injected listener removal, batched A→B→A, late connection after logout and Dynamic source mismatch/replacement.

One existing source-structure test in phase5.test.tsx was updated from direct wallet children to require the host wrapper in BOTH wallet branches. Other existing assertions remain. The first run failed solely on that obsolete direct-child assertion (216/217); the updated full suite passes.

## Integration boundary

Import `useGiwaStocksHost` and `StocksSignIn` from stocks-host. The host value includes `snapshot`, `investor`, `admin`, `canSignIn`, `walletStatus`, `signIn`, `logout` and `invalidate(capturedSessionId)`. Authentication is server SIWE Bearer; wallet connection alone and the legacy administrator token grant no Stocks authority. `/admin/stocks` must be integrated later as a sibling outside legacy RequireGiwaAdmin/GiwaAdminLayout.

No investor/admin in-progress feature files, route/menu definitions, server, contract transaction implementation, database, deployment, dependency/lockfile, theme or secret configuration was changed. No real wallet, live Dynamic environment, public RPC, backend nonce database, public transaction, push or merge was exercised. Browser visual screenshots and complete Stocks product flows are not claimed. No process or service is intentionally left running after validation.
