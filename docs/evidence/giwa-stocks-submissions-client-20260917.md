# GIWA Stocks wallet submissions browser adapter — builder evidence

Base `00ddcf49f2b7f8814f9e0093d39efd449d118031`. Separate clone `/private/tmp/arco-giwa-stocks-submissions-client-20260917`, branch `codex/giwa-stocks-submissions-client-20260917`. Contract: stocks-wallet-submissions-v1. This is builder verification; independent acceptance and the actual plugin/database roundtrip remain separate root/reviewer work.

## Delivered

- `createSubmissionGate(options)` implements the existing reviewed SubmissionGate. All session fields, API base, order/side/deployment and rejection callback are captured once. Optional caller wallet consistency check; the adapter does not itself authenticate a wallet or mint authority. Server authentication and authoritative transaction validation remain required.
- Authenticated GET inspect, POST claims and POST outcomes use exact fixed DTOs. PROFILE five fields, canonical ISO observedAt, expected intent, stage, claim identity, canonical transaction digest and hash rules are checked. Wrong order/deployment/from/chain/value/transaction digest fails before HTTP. Server and browser agreed label IDs, lowercase64 digests and lowercase nonzero0x64 transaction hashes.
- Inspect failures remain errors; claim null remains null. Previously observed records cannot be replayed as fresh REQUEST_MAY_START permission. Only observed claim bindings can report UNKNOWN/SUBMITTED; recreation requires authoritative inspect. Memory is validation bookkeeping, not persistence or a fallback journal. Client terminal statuses are rejected. Submitted hash preservation/conflict is checked.
- Late outcomes use the original token;401 callback carries the original session ID even if the caller changes account or the callback reenters. Missing/expired local auth and monotonic session lifetime fail closed. No automatic retry/session refresh/storage, UI activation, provider/controller/router changes, receipts or fake persistence.
-10-second configurable monotonic timeout covers fetch, streamed body collection, UTF8/JSON/envelope parsing and final return. Explicit deadline race handles transports ignoring abort.32KiB response bound, reader cancellation, no-cookie/no-redirect/no-cache requests. Errors expose fixed codes without raw response bodies or transport secrets.

## Verification

- Module `client.test.tsx`:21/21. Includes valid BUY/SELL/body/auth paths; lost response with only caller-driven retry/null; original captured session and late401; auth/clock expiry; malformed profile/ISO/extra fields; wrong intent/stage/order/deployment/transaction; forbidden reports; recovered binding and hash preservation/conflict; stalled fetch/body cancellation; size/UTF8/JSON rejection; timers-delayed elapsed checks including after JSON parsing; repeated permission rejection.
- Full frontend:389 tests,388 pass,0 fail,1 skipped because GIWA_STOCKS_ARTIFACTS was unset. The exact skipped existing calldata/artifact test was then run explicitly against reused Stocks artifacts and passed1/1. Existing host DOM runtime was enabled. No claim of389 passing in the first run.
- Typecheck, production build, security and story checks pass. Existing large-bundle warning remains. Token hook reports exactly7 inherited violations, none in the new module.
- Server baseline after required ignored ABI artifacts were restored:167 tests,135 pass,32 existing skips,0 fail. First clone-only run failed because ignored compiled ABI files were absent; preserved logs distinguish this environment failure. Artifacts were copied from the source clone after confirming identical clean contracts tree `732c8e606088d731423bcf6a3e4419848a594e8b`; no compiler/install or contract changes. Server source is unchanged by this task.
- Dependency reuse: package.json and package-lock.json byte-equal to prior market UI clone, copied existing node_modules; no install/network access. No public RPC, real wallet, database, browser surface or listener used. Prior owned5724 listener was confirmed absent.

Commands:

```sh
node --import tsx --test src/demo/giwa/stocks-wallet-submissions/client.test.tsx
GIWA_HOST_DOM_RUNTIME=/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json npm run test:frontend
GIWA_STOCKS_ARTIFACTS=/private/tmp/arco-giwa-stocks-submissions-client-20260917/packages/contracts/artifacts/stocks node --import tsx --test --test-name-pattern='calldata round-trips' src/demo/giwa/stocks-wallet/wallet.test.tsx
npm run typecheck
npm run build
npm run test:server
npm run test:security
node .claude/hooks/check-design-tokens.mjs --all
node .claude/hooks/check-story-exists.mjs --all
git diff --cached --check
```

External logs/revision: `/private/tmp/arco-giwa-submissions-client-evidence-20260917/`. Scope is only `src/demo/giwa/stocks-wallet-submissions/**` and dedicated task/evidence docs. No push, merge or deployment. Uncertain investor order creation, durable server receipt reconciliation, actual wallet activation and live execution remain outside this adapter milestone.
