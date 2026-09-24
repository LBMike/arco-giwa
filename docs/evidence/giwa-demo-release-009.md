# GIWA-DEMO-RELEASE-009 preparation evidence

2026-09-24. Base `c5cbcda`; root builder/integrator. The user subsequently prioritized direct local UI4392 testing before any Vercel deployment. No hosted deployment was performed.

## Preserved product and connection changes

Imported only the [52 allowlisted files](../tasks/giwa-demo-release-009-files.txt) from the existing UI4392 workspace. Each target was checked against the clean base first; source files, the running4392 process and its environment were untouched. This preserves the user's current market list, chart and live NVDA display, including the corresponding server and tests. Main Portfolio, Dynamic wallet, root product entry and transaction authority remain unchanged.

Integration preparation and read-only connection checks now accept exactly `http://127.0.0.1:4392` as a frontend origin alongside HTTPS production origins. HTTP aliases, other ports, paths, credentials, query/hash and HTTP server endpoints remain rejected. Generated browser settings include `VITE_CUSTOMER_PRESENTATION=true`.

Independent review found no concrete imported-code regression and confirmed source equality for the52 imported files. Its identified verification gap was covered by a real local HTTP test using the normal `buildApp`: SSE preserves explicit Vercel/4392 CORS and refuses the untrusted origin before opening a stream. The new test initially needed a complete catalog stub and an assertion matching the existing denied-origin error; both were corrected without changing CORS policy.

## Verification

- Typecheck, normal product build, environment exposure check, EVM compatibility check and migration inspection passed.
- Frontend: 946 passed, 15 skipped, 0 failed (961 total), using installed jsdom runtime26.1.0 for market DOM tests.
- Server: 569 passed, 92 skipped, 0 failed (661 total), including actual HTTP SSE/CORS and both frontend-origin helper tests.
- Separate production-route DOM and local market/proxy tests:28 passed,0 skipped,0 failed.
- Design stories: no hard violation. Design tokens: the same7 pre-existing findings in `Investor.tsx` and `components.tsx`; none introduced by this integration.
- Existing SSR, zero-size jsdom chart and build chunk-size warnings remain. Database/chain signing tests were not re-run for display-only changes; the008 real PostgreSQL/encrypted-custody evidence remains applicable.

## Verified hosted inventory (read-only)

Render login succeeded. API service `srv-d9a3856cjfls7396f9tg` is `arco-giwa-api`, Starter, Oregon, Blueprint `exs-d9a2tcu7r5hc73c3vttg`, repository `LBMike/arco-giwa`, branch `main`. Live commit `8160f354b55dfe9a525565e30ddc007f51448f3d`; URL `https://arco-giwa-api.onrender.com`. Build is `npm install --include=dev && npm run prisma:generate && npm run build:server`; start is `node server/dist/index.js`; no pre-deploy command. Linked environment group is `arco-giwa-server` (`evg-d9a37tvaqgkc739263e0`). Only existing six variable names were inspected; no secret was revealed/copied.

A narrow Render web-shell diagnostic parsed existing database URLs inside the service and printed only host, port and project identity. Both bind to Supabase project `munsybkrsxrmajmbssli`. DATABASE_URL uses `aws-1-ap-southeast-2.pooler.supabase.com:5432`; DIRECT_URL uses `db.munsybkrsxrmajmbssli.supabase.co:5432`. The AWS text is Supabase's pooler hostname, not a requirement for a user AWS account. Existing CORS is `https://app.arco.financial,https://arco-giwa.vercel.app`; UI4392 is not yet included.

Within explicit `BEGIN READ ONLY` transactions with5-second statement timeouts, inspected table names and migration metadata only. Existing `arco_evm` has10 GIWA tables; no new Stocks application tables were observed. All10 finished migration checksums match current source; none was rolled back. Five pending migrations are `20260916000000_stocks_testnet`, `20260917000000_stocks_redemption`, `20260918000000_stocks_wallet_submissions`, `20260919000000_stocks_wallet_receipts`, `20260920000000_stocks_trading_control`. No row-level customer data or credentials were read.

Vercel project **arco-giwa**, team `whdqkf88-8213s-projects`, owns `app.arco.financial` and `arco-giwa.vercel.app`, repository `LBMike/arco-giwa`. Production is still commit8160f35, deployment `FS58rvjCVXzaZP3js3SGSBir2YDU`. Existing Production/Preview variable names: `VITE_ARCO_API_BASE`, `VITE_DYNAMIC_ENVIRONMENT_ID`, `VITE_GIWA_ADMIN_ADDRESSES`. Values were not revealed. Marketing project `arco-1` is a different project and is not the app deployment target.

## Next local-demo task

The user's immediate acceptance path is now existing UI4392 → actual GIWA contracts/Supabase → wallet buy → Portfolio → partial sell. A local-only API/signer composition, schema activation and test-cash preparation are required. Do not run the disposable local-chain owner harness as a substitute or replace the user's4392 screen. The current task has not activated public Stocks, changed a cloud setting, restarted4392 or sent a transaction.
