# GIWA-STOCKS-WALLET-001 — builder evidence

Base `bac9020a1078b39df52be4a4e6f711ec489e1685`.
Isolated checkout `/private/tmp/arco-giwa-stocks-wallet-20260917`, branch `codex/giwa-stocks-wallet-20260917`.
Implementation candidate is the commit containing this document. Builder results require independent review; this is not an integration/public-execution approval.

## Implemented boundary

Only the new `src/demo/giwa/stocks-wallet/**` module and task/evidence documents are added. No shared provider, router, host, investor/admin feature, server, contract, manifest/deployment file, database, dependency or lockfile is modified.

The pure planner binds an accepted raw BUY/SELL order to the live SIWE wallet, chain 91342, reviewed manifest v2/digest/ABI/code hashes, physical addresses, network-derived order key, exact fixed-price amounts and deadline. It produces frozen zero-value `approve`, `depositForOrder` or `escrowForOrder` calls. No bytecode/address data is invented from the catalog or Savings/Funds registry.

The controller performs explicit prepare → optional exact approval/receipt → separate explicit transfer. It re-reads authenticated order, catalog, current trusted policy and allowance and checks the active wallet throughout preflight, including the reviewed network instance/checkpoint/deployment digest rather than chainId alone. Order/catalog observedAt and policy are bounded to 15 seconds, with elapsed-time checks on reads. After atomic durable claim it re-reads the accepted order immediately before a wallet request. Cancellation or a synchronous scope replacement during the signing notification prevents a not-yet-started request.

A required durable claim precedes any wallet prompt. Unknown/rejected results never release it. Late hashes are recorded against the original intent even after cancellation/logout/scope replacement, but cannot populate a different account/order. Re-created controllers and concurrent independent controllers consult the same mandatory trusted gate. Transaction hash/approval receipt never implies order completion or a holding increase. Expiration after submission retains the original hash. No COMPLETED transition exists in this executor.

## Missing integration adapters are intentional blockers

The module is NOT connected to a public wallet, actual Stocks page or backend transport. Missing/invalid dependencies fail closed. The current API does not provide:

1. A public read contract exposing independently reviewed manifest/runtime/checkpoint/getter evidence.
2. A fresh execution-policy decision (catalog CHECK_PAUSE_AT_ORDER is insufficient).
3. Authenticated durable, atomic, cross-tab/device submission admission/claims/recovery, including safe handling of historical pending orders.

The BUY funding contract permits repeated deposits for an order key. Browser storage, no receipt, an insufficient-balance/order error, or an empty journal row for a historical order cannot prove non-submission. README specifies that historical/unknown orders remain disabled until trusted recovery; no production in-memory gate or automatic retry/reset is supplied. Root reported an investor-order duplicate-submission finding during this work; no investor module was read/imported/changed or connected, and no insufficient-available-stock error releases a wallet claim here.

## Verification

- Dedicated module tests: **24/24 pass**, 0 skipped, with existing Solidity artifacts explicitly supplied.
- Full frontend suite: **241/241 pass**, 0 skipped, with existing host DOM runtime and Solidity artifact gate explicitly enabled.
- `npm run typecheck`: pass.
- `npm run build`: pass, existing large-chunk warnings.
- `npm run test:security`: pass.
- Design-token hook: exactly the **7 pre-existing** Investor.tsx/components.tsx findings; no new finding.
- Story hook: pass, existing soft warnings only.
- `git diff --check`: pass.

Dedicated coverage includes BUY/SELL exact calldata, both allowance paths, no automatic deposit after approval, reverted/mismatched/pending approval receipts, exhausted confirmed allowance recovery, large/minimal units, missing reviewed deployment/current policy/durable gate, stale order and response/deadline, final post-claim order change, account/chain/source/network-instance drift, A→B→A/API/selection/deployment changes, late 401, late wallet result after cancel/scope replacement/dispose, duplicate clicks, provider 4001 and malformed/unknown results, two-controller atomic admission, failed outcome persistence, disappeared history, expiry after submission, and synchronous cancellation before opening the wallet.

The ABI digest is compared against the real server ABI declaration. Unsigned deposit/escrow/approve calldata is decoded and encoded with existing compiled artifacts for StocksFundingVault, StocksRedemptionEscrow, StocksTestCash and StocksToken. The actual Solidity allowance code is checked; no fake transaction shape alone defines compatibility. Artifacts were read from `/private/tmp/arco-giwa-stocks-command-20260916/packages/contracts/artifacts/stocks`; contracts were not deployed or changed.

Logs:
- `/private/tmp/giwa-stocks-wallet-tests-20260917.log`
- `/private/tmp/giwa-stocks-wallet-typecheck-20260917.log`
- `/private/tmp/giwa-stocks-wallet-build-20260917.log`
- `/private/tmp/giwa-stocks-wallet-frontend-20260917.log`
- `/private/tmp/giwa-stocks-wallet-security-20260917.log`
- `/private/tmp/giwa-stocks-wallet-tokens-20260917.log`
- `/private/tmp/giwa-stocks-wallet-stories-20260917.log`

Test command:

```sh
GIWA_HOST_DOM_RUNTIME=/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json \
GIWA_STOCKS_ARTIFACTS=/private/tmp/arco-giwa-stocks-command-20260916/packages/contracts/artifacts/stocks \
npm run test:frontend
```

All wallet/read/gate ports in this run are deterministic fakes. They perform no public RPC, real wallet signature, transaction, database call or service deployment. No credentials or secret environment file were read. No push/merge/public execution occurred. Local verification processes are terminated/completed before handoff.
