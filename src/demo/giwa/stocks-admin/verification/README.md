# `/admin/stocks` — mock data verification page

**Mock data — not the app, not a real stack.** No API, database, chain, wallet provider or wallet request is behind this page.

The page mounts the real `/admin/stocks` page in React `StrictMode`: `StocksHostProvider`, `StocksPageEnvironment`,
`stocksRoutes`, `StocksAdminPage`, `StocksSignIn` and the `GiwaStocksAdminFeature` modules. Every response is answered inside the
page. Use it to look at operator states, narrow widths and keyboard behaviour, and to give feedback on them. It proves nothing
about SIWE, server permissions, PostgreSQL records or receipts. The terminating Chrome harness in `scripts/stocks-local` covers
those with a real local stack.

## Open it

The page needs a Vite dev server over the repo root. Use the existing offline verification server, which also serves the investor
`/stocks` fixture page. It reads no `.env*`: its Vite env directory (`stocks-execution-host/verification/`) contains no env files.

```sh
TMPDIR=/private/tmp node --import tsx src/demo/giwa/stocks-execution-host/verification/serve.ts --port 4327
```

Then open `http://127.0.0.1:4327/src/demo/giwa/stocks-admin/verification/index.html`. Stop the server with Ctrl-C.
Any free port from 1024 to 65535 works; the server refuses 5173 (the app's dev port and CORS origin) and 8788, and fails
instead of drifting when the port is busy.

## What is real and what is mock

| Layer | Real or mock |
| --- | --- |
| Page composition, host session controller, sign-in box, admin store, parsers and all admin views | **Real** product modules |
| `/api/v1/auth/nonce`, `/api/v1/auth/verify` | **Mock**: an unsigned token carrying the claims the host checks. No key, no signature check |
| `/api/v1/admin/stocks/*` | **Mock**: `../fixtures.ts` (`fixtureRoute`), with the bar's overrides applied per request |
| Clock | Real browser clock. Fixture timestamps are fixed on 2026-09-17, so deadlines have passed |

## The fixture bar

- **Operator wallet:** Operator A, Operator B, Disconnect, Wrong network (chain 1). Each switch changes the host context, as a
  wallet account or network change does.
- **Next sign-in lifetime:** 900 s, or 30 s to watch the host session expire on its own.
- **Server access answer:** 200, 401, 403 or 404 (routes off) for every admin read. The real server answers 403 for every
  missing, invalid or unauthorized session and never 401 on admin routes. The 401 button shows the UI's 401 view only.
- **Data:** Fixture orders, Long state names (valid reviewed states with the longest labels, for layout checks) or Empty, plus the
  reconciliation status.
- **Next wallet-submission reads:** Normal, 500, Network error, Invalid body, 404 order, 404 route, or Hold. Release held
  completes the held reads.
- **Next order-detail reads:** Normal, 500, Network error or 404 order.
- **Request log:** the last 12 requests with method, path and status. Admin reads are GET only. The only POSTs are the two mock
  sign-in requests.

## Not part of the app build

Nothing in `index.html`, `src/main.tsx`, the router or `vite.config.ts` references this directory, and product code never
imports it. `npm run build` uses the root `index.html`, so this page is never bundled.
