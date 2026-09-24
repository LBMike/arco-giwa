# GIWA Stocks 003C-2 — real Chrome and local wallet bridge

2026-09-18. **PASS for the implemented local browser integration.** The actual Stocks React routes now have a repeatable Chrome test against real disposable PostgreSQL, local contracts and the production observer/worker. This is local test infrastructure; production UI, server sources, Solidity, migrations, registries and dependencies are unchanged.

## Source

- Base: `9d98700812717f5ff9d1071e30eec0cecf0c3edf` (accepted 003C).
- Code: `2b2a86f53a99e01691627aec5caf6288c285e3a5`.
- Code tree: `8a81214fed07ed7c5e91243f3d10f341a989a39c`.
- Checkout: `/private/tmp/arco-giwa-003c2-browser-20260918`.
- Branch: `codex/giwa-003c2-browser-20260918`; push disabled, original/main unchanged.
- Eight code files, +943/-4, under `scripts/stocks-local/`; separate README/evidence updates.

Claude retains production UI ownership. Codex implemented the test-only browser entry, bounded HTTP wallet bridge, browser driver and owned-service lifecycle. The entry imports the actual routes, session host, controller, wallet ports and submission gate under React StrictMode. It signs real SIWE messages using only local unlocked holder accounts. Native browser fetch talks directly to the actual API across origins; there is no API proxy, response substitution or CORS bypass.

## Final browser execution

Evidence directory: `/private/tmp/arco-giwa-003c2-browser-evidence-20260918`.
`integration.log`, `result.json` and `summary.json` describe the final exact-code run: **19 assertion groups PASS, seven holder wallet sends matched to seven committed claims, cleanup complete, process exit 0**. Chrome `153.0.8010.48`, installed Playwright `1.62.1`, Node `24.14.0`. No browser or package download.

| Scenario | Result |
| --- | --- |
| Native browser SIWE login | API CORS succeeds for the configured origin; mount/login sends zero transactions |
| BUY 2 NVDA | UI quote/order, exact approval, separate deposit, actual mint, COMPLETED and visible holdings 2 |
| Double-click order/approval/transfer | One intended order or wallet send |
| API restart and real browser reload | Signed out after reload; same-owner login/check restores the original durable transfer hash without resending |
| SELL 0.5 | Approval/escrow, actual burn/test-cash payout, COMPLETED and holdings 1.5 |
| Accepted approval response held during A→B | B hides A's order/hash and sends nothing; original valid A session records its late hash; A reload/check reads without resending |
| SELL 0.25 response lost after chain acceptance | UI UNKNOWN, journal hash null; actual observer completes the order, holdings 1.25; reload does not resend or manufacture a hash |
| Foreign owned browser origin | API read, bootstrap read and wallet request fail browser CORS; even a correct capability cannot reach the wallet from that origin |
| Portfolio at 1440 and 375 pixels | Screenshots inspected; no horizontal overflow |

Each holder transaction matches the exact committed claim payload and an earlier successful claim HTTP response. Actual EVM transactions provide chain ID, account, calldata, value and distinct nonces 0–6. This is additional read-only evidence, never input injected into the product UI. The lost-response transfer remains a hashless UNKNOWN journal row even though its business order completes from the actual event.

Final chain and reconciliation:

- Holder stock and total supply: **1.25 NVDA** (`1250000000` base units).
- Holder cash: **1,850 ARCO_TEST_USDC**; vault cash: **150**.
- Escrow stock: **0**; reconciliation: **MATCHED_AT_CUTOFF**, no differences or worker errors.
- One BUY and two SELL business orders completed. The deliberately unfunded BUY 0.25 remains unpaid.

Screenshots: `portfolio-desktop.png` and `portfolio-mobile.png` in the evidence directory. The visible local controls are test tools, not a production feature. Market data is deliberately unconfigured and shown as unavailable; no prices or chart series are invented. Screenshot inspection is not a complete accessibility or visual acceptance audit.

## Bridge and lifecycle

The HTTP bridge wraps the existing strict local wallet. It permits only two local holder accounts, the reviewed methods/contracts/ABI, exact transaction fields and the current SIWE origin. Requests dispatch once without retry, gas/nonce injection or alternative RPC methods. Held/dropped responses happen after node acceptance.

All assets require the exact loopback Host. Bootstrap reads require same-origin browser metadata; protected requests also require the in-memory capability. Writes require exact Origin, same-origin fetch metadata, JSON, bounded bodies and exact fields. Vite CORS is disabled, the product Vite configuration is not loaded, and its environment directory is empty. No capability appears in URL/log/storage. Local processes capable of forging HTTP headers are outside browser-origin isolation; this is a disposable development tool, not a production authentication service.

The runner owns signal handling. Playwright's automatic signal exits are disabled, and Vite runs as middleware inside an owned HTTP server so it cannot exit the process on SIGTERM. Close immediately fences acquired HTTP/runtime resources, including during incomplete startup, and later collects any resources acquired before startup observes cancellation. All cleanup rejections are handled immediately and aggregated. Database/EVM teardown follows browser/API/runtime cleanup.

`lifecycle-final.log`: **3/3 PASS**, with independent OS/PID/TCP checks:

| Case | Expected exit | Chrome PID | PG PID | EVM group |
| --- | --- | --- | --- | --- |
| Ready SIGINT | 130 | 90424 | 90382 | 90363 |
| Held actual wallet response SIGTERM | 143 | 90506 | 90464 | 90445 |
| Injected failure | 1 | 90611 | 90569 | 90548 |

Every listed process/group, API/bridge/RPC port, PG PID file and socket was absent after exit. Only child-owned temporary directories were removed. Final normal run independently confirmed Chrome90775, PG90733, EVM group90713 and runner90698 gone; API53152/bridge53148/RPC53129 closed; `/private/tmp/stocks-local-stack-naAQor` removed. No demo service remains running.

## Other checks

| Check | Result |
| --- | --- |
| Bridge + wallet unit tests | **9/9 PASS**, includes unchanged process SIGTERM listeners |
| Existing backend-only real PG/EVM scenario | **18 groups PASS**, 12 durable signer operations, original recovery checks preserved |
| Full frontend with DOM and Solidity artifacts enabled | **663/663 PASS**, skip0 |
| Default server suite | **330 PASS / 72 DB-gated skips**, total402 |
| Typecheck / build / security / strict entry typecheck / whitespace | PASS |
| Design checks | Existing 7 token violations unchanged; no hard story violations |

The standalone 72-test PostgreSQL suite was not rerun; these skips are not counted as passes. Actual PostgreSQL was exercised by the browser scenario, lifecycle children and existing backend scenario. The original jsdom long-expiry scenario was not rerun in this turn. The new browser mode does not modify clocks, quote deadlines, execution evidence or server JWTs.

Independent reviewer checked exact code in a clean separate clone: **HTTP10/10, lifecycle acquisition/fence8/8, rejection-handling1/1**, six JS syntax checks and whitespace PASS. No unresolved confirmed finding. These 19 independent checks overlap unit coverage and are not added to its total. Their browser/PG/EVM conclusions reference root-operated evidence; the reviewer itself used isolated HTTP and offline probes. Report: `/private/tmp/arco-giwa-003c2-review-evidence-20260918/README.md`.

## Failed runs and corrections retained

- The initial browser transaction scenario passed, but visual inspection exposed a missing theme scope on the test-only wrapper. The wrapper now applies existing tokens; both final screenshots were inspected.
- Initial ready-SIGINT exited through Playwright before owned stack cleanup. Disabling Playwright's handlers fixed that case. Held-SIGTERM then identified Vite's automatic `process.exit(0)`; middleware mode removed it. The final three lifecycle cases above pass. Initial owned PG/EVM remnants were identified by exact process arguments, unique directory and log file handles before targeted shutdown; cleanup JSON remains under `lifecycle-artifacts/`.
- Independent probes found delayed Chrome close postponing the runtime fence, the same condition during acquisition, and late attachment of cleanup rejection handlers. Each has a preserved failing probe and a passing exact-code rerun.
- One intermediate initdb attempt exhausted shared-memory identifiers while failed-run resources were still present. Its own EVM was stopped and log retained as `initdb-capacity-failure.log`; after targeted cleanup, sequential final runs passed. No unrelated IPC or database was removed.
- The first fully enabled frontend run used the wrong artifact directory. Correcting the test environment to `packages/contracts/artifacts/stocks` gave the final 663/663 result without changing product code.

## Next boundary

Reproduce via [runner instructions](../../scripts/stocks-local/README.md). The next product step is same-owner known-hash recovery after a new login, using the already verified backend contract: Claude owns the UI; Codex owns backend integration and independent regression checks. Unknown hashes must not be guessed or resent. Physical wallet/Dynamic support, public-network finality, live market data and real brokerage remain separate work. This local fixed-price mock does not establish an Ondo-equivalent live trading environment.
