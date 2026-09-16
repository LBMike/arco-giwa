# GIWA Stocks host mounting

Builder scope approved by the user's request to continue development and delegate the next work. Base `dee3dd846f8fdc8b4c9ea17f5354b098b359e419`; isolated clone `/private/tmp/arco-giwa-stocks-host-mount-20260917`. No additional approval is needed within this scope.

Plan before implementation:
- Add a Stocks host React provider/consumer hook and explicit sign-in/sign-out status component under `stocks-host/**`. A render-time scope comparison hides old credentials immediately; layout effects create/dispose independent controllers, including StrictMode replay. The component uses existing page/ink/border/focus tokens and never displays JWTs or provider errors.
- Add connection-epoch/readiness signals to injected and Dynamic wallet providers. Account, chain, disconnect/reconnect and signing-source changes invalidate the host. Preserve existing transaction APIs.
- Mount the host inside the existing wallet providers, and move the existing application provider once above the router so investor/admin navigation shares the wallet and in-memory login lifetime. No new route, tab, feature import or legacy-admin permission change.
- Add deterministic fake-wallet/HTTP/clock tests and DOM lifecycle harness tests using an already available jsdom runtime, without adding dependencies. Run frontend/typecheck/build/security/design checks and distinguish existing token debt.

Allowed shared files: providers.tsx, wallet.tsx, GiwaPreprodApp.tsx, main.tsx. Validation also updates phase5.test.tsx’s existing direct-child provider assertion to require the newly mounted host in both wallet modes; its other assertions are retained. No server, deployment, DB, secrets, public RPC, unfinished investor/admin directories, dependencies or common theme changes. The login control is exported for future feature composition and exercised in a harness; it is not prematurely placed in existing Savings/Funds pages.
