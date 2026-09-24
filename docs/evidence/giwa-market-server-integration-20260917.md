# Display market API integration evidence

Builder: root. Base source/host composition `fe9a0c8e28054ed471becdad149e818d4f2b66bc`; separate chart-brief docs imported as `49fe09e` from `54d6c932de0db21dee152b898603d83f68f68385`. This report accompanies the following implementation commit; its SHA is provided in the handoff. Independent review is pending.

## Change

- Optional display service in actual `buildApp` plus real `startServer` factory wiring. Service created once before Prisma allocation, no provider I/O on construction.
- Server-only key/feed-delay config; default NVDA PILOT, missing key is UNCONFIGURED. No changes to reviewed market module, trading, dependencies, frontend or deployment state.
- Seven actual `buildApp.inject` regressions covering keyless route behavior, cache sharing, exact response values, strict inputs, redaction, trading/legacy auth and handler isolation.

## Direct checks

| Check | Exit | Result / log |
| --- | --- | --- |
| `npm run build:server` | 0 | `/private/tmp/giwa-market-integration-server-build.log` |
| `node --test server/dist/stocks-market-runtime/*.test.js server/dist/stocks-market-data/*.test.js server/dist/stocks-runtime/app-integration.test.js` | 0 | 43/43; `/private/tmp/giwa-market-integration-targeted.log` |
| First `npm run test:server` | 1 | Ignored contract ABI artifacts absent from new clone; `/private/tmp/giwa-market-integration-server-full.log` |
| `npm run test:server` with same-source artifacts | 0 | 135 passed,32 existing DB-dependent skipped,0 failed; `/private/tmp/giwa-market-integration-server-full-with-artifacts.log` |
| `npm run test:security` | 0 | `/private/tmp/giwa-market-integration-security.log` |
| `npm run typecheck` | 0 | `/private/tmp/giwa-market-integration-typecheck.log` |
| `npm run build` | 0 | `/private/tmp/giwa-market-integration-build.log`; existing chunk-size warning |

The injected provider uses synthetic credentials and observations. The keyless factory's counting fetch was never invoked across catalog,quotes,profile,five chart ranges and logo. Concurrent quote requests reused one upstream call; exact decimal strings survived the actual app serializer. Trading catalog remained NVDA-only with fixed mock price120 even with a two-symbol display catalog. Display reads did not create an authenticated actor or bypass the separate admin/trading guards.

Runtime provenance: `package-lock.json` compared equal to `/private/tmp/arco-giwa-stocks-market-data-20260917` before clone-copying its node_modules. Ignored `packages/contracts/artifacts` copied from that same market builder; tracked contract sources have no diff from `bc67cf2a`. No package install, DB, listener, wallet signing, actual provider/RPC call or public activation was performed. Existing baseline design-token findings and frontend integration are handled by the separately assigned UI candidate; this commit changes no frontend source.

Actual `startServer` was inspected/compiled but not launched because it owns the existing real DB/RPC lifecycle. Tests execute the same config factory and actual buildApp registration with fake legacy services. This is not end-to-end public service validation.
