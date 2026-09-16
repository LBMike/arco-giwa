# GIWA Stocks investor recovery fixes — builder evidence

Date: 2026-09-17. Builder results only; independent acceptance remains required.

- Base: `0d07eb2c2fa5ff002c83460fd13bf542af0ea4e6`.
- Separate clone: `/private/tmp/arco-giwa-stocks-investor-fix-20260917`.
- Branch: `codex/giwa-stocks-investor-fix-20260917`.
- Review being addressed: `/private/tmp/arco-giwa-stocks-investor-review-evidence-20260917/README.md`, R1 P1, R2 P2, R3 P2.
- Logs/reproduction outputs: `/private/tmp/arco-giwa-investor-fix-evidence-20260917/`.

## Behavior changed

**R1 — unknown submissions keep their exact key.** Once any send becomes unknown, a later refusal cannot establish that an earlier POST has permanently stopped. The resolver set is removed, including the mutable `INSUFFICIENT_AVAILABLE_STOCK` condition and combined expiry/deployment code. Unknown attempts remain UNCONFIRMED; authentication failures remain AUTH_REQUIRED. Only a successful matching same-key retry or a positive lookup resolves the attempt. A first request that receives a definitive refusal without any unknown predecessor still follows the existing REJECTED behavior.

The committed integration regression executes the actual `stocksPlugin`, `StocksSellService`, production HTTP client and validators with in-memory SQL/storage ports: first POST waits before the transaction, retry overtakes it and receives insufficient stock, stock later increases and the first POST completes. The UI keeps one key and one stored order, blocks the new-order flow, then resolves the same key successfully. SQL transaction segments in this scenario are sequential; this is not a real Postgres concurrency test. Further fixtures cover both an already-committed original and an original that never reached the service.

This is intentionally conservative: an unknown request that never committed can remain blocked after quote expiry because this API has no durable rejection or authoritative absence mechanism. Refresh/remount does not prove non-submission. A future backend recovery contract is needed to safely unlock such an intent; the frontend must not invent one. The original expiry-refusal unit test now expects this behavior.

**R2 — outer continuations must still own the work.** Generation checks now also reject suspended controllers. Attempt writes after await require captured generation, current owner, displayed attempt and the current registry object to match. Loading/checking records are retired by existing generation cleanup; late completions do not overwrite them. Submission ownership is registered before notifying subscribers, and a reentrant switch prevents dispatch under replacement credentials. Session rejection captures the original session/callback, checks again after notifying subscribers, and its caller checks after the external callback returns. Other authenticated read paths retain their sequence guards and add explicit generation/dispatch guards. Same-wallet token changes, A–B–A and registry restoration retain existing identity semantics.

The feature's existing React render-time switching fence is unchanged. The original reviewer DOM/StrictMode probe remains green for logout, account B, token change, API change and host-wallet mismatch.

**R3 — quote transit consumes validity.** The monotonic deadline is request start plus `max(0, min(expiresAt-createdAt, expiresAt-observedAt, 60000))`. At receipt an already elapsed deadline is immediately expired. This conservatively charges the full request/response time (possibly more than strictly necessary) and uses server timestamps to bound cached/old answers. It does not assume that the device wall clock matches server time. At the deadline no order POST is sent and there is no automatic re-quote.

No API, shared host, route, server, contract, dependency or visual-token files changed.

## Checks

| Check | Result |
| --- | --- |
| Original reviewer regressions against pinned base | 0/5 passed, 5 failed; original reviewer evidence preserved |
| Identical-meaning original probes after final fix | 5/5 passed, exit 0 |
| Module suite including actual SELL integration | 70/70 passed, exit 0 (54 original + 15 new controller cases + 1 new integration) |
| Full frontend suite | 244/244 passed, exit 0 (the `.mjs` integration runs separately) |
| Original reviewer ReactDOM/StrictMode fence probe | 5/5 passed, exit 0 |
| typecheck / production build | exit 0; existing bundle-size warning remains |
| security | exit 0 |
| design-token hook | exit 1, exactly seven unchanged baseline findings, no new findings |
| story hook / diff whitespace | exit 0 |

The original three finding probes and two async-owner probes were copied to scratch, changing only repository/output paths. Red results show two stored orders under distinct keys, 60 seconds remaining after 10-second delivery, and stale A attempts in B's state. Final green results show one order/key, 50 seconds remaining, expired/no POST at 61 seconds, and no old attempts in B.

New controller regressions cover A–B and A–B–A between inner/outer continuations; accepted-order refresh; callback/subscriber reentrant401; subscriber switching at SUBMITTING; mutable refusal with committed/uncommitted originals; transit of10/60/61 seconds; stale server observation/receipt-expired replies; and all three formerly resolving quote refusals. Existing module tests cover additional token/API/deployment/remount behaviors.

## Repeatable commands

```sh
node --import tsx --test 'src/demo/giwa/stocks-investor/*.test.tsx' src/demo/giwa/stocks-investor/delayed-sell-regression.test.mjs
npm run test:frontend
npm run typecheck
npm run build
npm run test:security
node .claude/hooks/check-design-tokens.mjs --all
node .claude/hooks/check-story-exists.mjs --all
git diff --check
```

Node v24.14.0, React18.3.1. Dependencies copied using `cp -cR` from the independent investor review clone after package.json and package-lock byte equality; no install or dependency mutation. SHA256 package.json `67de05623952dfc07897ac7deaa269a253ac3e19930a82cb819c594a3eaf6654`, package-lock `fa5dee4ef139eaf1e7fc77c0838595a773ec46236c05b7e4db82c9803fb2e062`. DOM scratch probe uses the pre-existing jsdom26.1.0 runtime at `/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json`; committed controller/service tests need no extra runtime.

## Limits

No real wallet, signature, public RPC, database, public network, deployment, push or merge. Feature remains unmounted in the real app. No responsive screenshots or live integration were repeated. Server source is unchanged; the actual SELL path is covered through controlled ports, not the whole backend suite. `onSessionRejected` still exposes the existing wallet-only callback contract; an integrating host must bind invalidation to the session captured by its callback, never invalidate a replacement session by wallet alone. API recovery semantics and frontend public props are unchanged.
