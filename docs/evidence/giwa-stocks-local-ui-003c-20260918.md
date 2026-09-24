# GIWA Stocks 003C — actual UI + local PostgreSQL/EVM

2026-09-18. **PASS for the implemented automated local integration scope.** The production Stocks React route now has a repeatable test path through native HTTP, real local PostgreSQL, unforked Hardhat contracts, SIWE, the observer/worker and the durable mock broker. Normal completion is never assigned by a fixture.

This harness uses jsdom, not Chrome or a wallet extension. It is the automated local portion of 003C; browser-engine interaction/CORS/layout and physical-wallet compatibility remain separate work.

## Source and ownership

- Base `5a9ad523715d19ee30b9e361f191463a6d5f7219` combines independently accepted Claude UI47dbec1 and backend69bb9ec.
- Code `988c53573a4d568f5ea6031724d90677085ed5e1`, tree `183819cbca08209f08f404dba8097db21e8a8240`.
- Checkout `/private/tmp/arco-giwa-003c-local-ui-20260918`, branch `codex/giwa-003c-local-ui-20260918`.
- Nine changed files, +1049/-3, all under `scripts/stocks-local/`: orchestration, test wallet, real runtime composition, UI driver, dispatch evidence, cleanup checks, unit tests and run instructions.
- No production UI/server, Solidity, schema, deployment registry, dependencies or API contract changed. Claude retains production UI ownership. Original/main are unchanged; no push or public deployment.

## Implemented route

`/stocks` React StrictMode → real host/session/controller/gate/wallet ports → loopback buildApp and PostgreSQL journal → local raw wallet transaction → actual contract receipt → production observer/worker → durable mock fill → mint or burn/payout → portfolio and common-cutoff reconciliation.

The test-only in-process wallet is bound to two local holders, exact transaction fields and reviewed ABI/targets. It signs this local SIWE origin with the node's unlocked accounts, without reading private keys. It provides no HTTP signing endpoint, gas/nonce override, retry or fallback. Deployment ID/checkpoint/Hardhat instance distinguish the disposable chain from public chain91342.

The runtime runs on native 2-second ticks. API restart rebuilds the actual HTTP application on the same port while retaining the owned database, runtime, signer and authentication secret. That check is not a database or whole-Node-process restart.

## Actual integration results

Final log: `/private/tmp/arco-giwa-003c-local-ui-evidence-20260918/full-integration.log`. Extracted full report: `result.json`; compact report: `summary.json` in the same directory. **17 assertion groups, result PASS, subsequent owned-services cleanup record and process exit0.**

| Scenario | Verified result |
| --- | --- |
| BUY2 through UI quote/order/approval/deposit | Actual mint, order COMPLETED, UI/chain holding2 |
| Double activation of order/approval/transfer | One order or wallet attempt for each intended action |
| Pause processing → HTTP API restart → StrictMode remount/check | Original transfer hash restored; no extra wallet send |
| SELL0.5 through UI approval/escrow | Actual burn/payout, order COMPLETED, UI/chain holding1.5 |
| A→B during accepted but held approval response | B first commit hides A order/hash, B sends0; original valid gate records A's hash; A relogin/check reads same claim |
| SELL0.25 wallet response dropped after chain acceptance | UI UNKNOWN/no hash; real observer completes order; UI/chain holding1.25; API restart/read does not resend |
| Actual elapsed16,007ms | Already-issued approval remains SIGNING after evidence expiry |
| Actual elapsed31,143ms | Browser session expired; late hash refused before outcome HTTP; original hashless claim retained |
| Original quote deadline +217ms | Fresh full session sees expired order; Check/approval/transfer disabled; wallet send count unchanged |

The expiry fixture changes only the browser-facing auth response `expiresIn` to30. The real JWT remains signed with900 seconds. There is no clock advance/reset, quote rewrite or finality weakening. The actual server-expired-JWT behavior has separate prior PostgreSQL coverage; it is not proved by this browser-expiry case.

Eight UI wallet attempts match eight actual durable journal rows. Each exact transaction is associated with a successful claim HTTP response with lower trace sequence, a DB creation time before dispatch, and an actual EVM transaction with the same account/target/calldata/value/chain and a distinct nonce0–7. Faucet/operator signer transactions are excluded from this holder count.

At the end:

- holder stock and total supply: `1250000000` units = **1.25 NVDA**;
- escrow stock: **0**;
- holder cash: `1850000000` units = **1,850 ARCO_TEST_USDC**;
- vault cash: `150000000` units = **150 ARCO_TEST_USDC**;
- reconciliation: **MATCHED_AT_CUTOFF**, differences0, worker errors0, all outbox jobs DONE;
- completed business orders: one BUY and two SELL; deliberately unpaid BUY orders remain unpaid;
- journal: approvals CONFIRMED4, transfers SUBMITTED2, lost-response transfer UNKNOWN1, expired-browser approval REQUEST_MAY_START1.

Business-order completion is distinct from submission-journal confirmation. The lost-response transfer still has no journal hash; its actual escrow event independently completes the business order. Instrumentation knows the chain hash but never hands it to UI or calls a recovery API with it. This does not implement known-hash browser recovery.

## Other root executions

| Check | Result |
| --- | --- |
| Existing backend-only real PostgreSQL/EVM scenario | **18 assertion groups PASS**, original nonce/lost-ack recovery and native runtime roundtrip retained |
| New UI lifecycle child checks | **3/3 PASS**: ready SIGINT, active SIGTERM, injected failure |
| Wallet bridge unit checks | **4/4 PASS** |
| Full frontend, DOM+ABI enabled | **663/663 PASS**, skip0 |
| Full server default run | **330 PASS / 72 DB-gated skips**, total402, fail0 |
| typecheck / build / security / strict UI-script typecheck / whitespace | PASS |
| design tokens / stories | Existing token violations7(exit1); no hard story violations |

The standalone 72-test PostgreSQL suite was not rerun; prior72/72 is separate evidence. This turn did execute real PostgreSQL repeatedly for the new UI integration, cleanup children and existing backend local stack. Counts from overlapping suites/reviewers are not combined.

Build retains existing dependency/browser-external and large-chunk warnings. UI logs contain React act warnings from native external updates; assertions and exit codes passed. Market data is not configured and its explicit unavailable state is expected; no public market provider was queried. Node24.14.0 was used; Node22 was not tested.

## Independent review

`ledger_review` reviewed exact code988c535 in a separate clean checkout and ran **25/25 offline checks**, seven JavaScript syntax checks and diff checking. No unresolved finding remains. Its lifecycle negative control restores the old close order by removing the new `runtime.stop()` call; that control fails because a pending tick can begin another worker iteration. The actual fixed module passes the close-before-drain probe. The negative control was constructed after the fix, not captured from a prior production run.

The evidence-verifier review checks that missing claims, extra sends, claim-response order reversal/refusal, wrong order/payload/hash/chain, duplicate nonce/hash and reconciliation mismatch are refused. These are offline boundary checks, not additional PostgreSQL/EVM runs. Report: `/private/tmp/arco-giwa-003c-review-evidence-20260918/README.md`.

## Failures preserved and corrections

- `first-integration.log`: initial happy BUY/SELL run passed before the three adversarial extensions.
- `adversarial-integration.log`: account switch and lost escrow response passed. The final case incorrectly assumed a new BUY0.1 needed approval, but an earlier unpaid BUY left a real30-USDC allowance. The driver timed out waiting for an unnecessary approval. The new case now uses BUY0.5/60USDC, preserving actual allowance and requiring approval without manipulating state. The final full run above passed.
- Review found close waited for an active tick before invoking runtime.stop. The test stack now stops production dispatch before draining; reversible processing pause remains separate. Independent positive/negative probes cover this correction.

## Owned cleanup

Full successful run: parent82872, EVM process group82879, PostgreSQL82898. Cleanup confirms no EVM group, no PG PID file/socket and removes `/private/tmp/stocks-local-stack-t9HsBp` after success.

Lifecycle children separately verified closed API/RPC TCP ports and absent owned PG/EVM processes: ready SIGINT group81724/PG81748; active SIGTERM group81804/PG81830; injected failure group82011/PG82245. Expected exits130/143/1, no default signal termination. Only these child-owned directories were removed after checking cleanup.

The failed scenario retains diagnostics at `/private/tmp/stocks-local-stack-TkNbv7`; its cleanup record confirms owned services stopped. No service remains running for a demo. No public RPC, real wallet, real asset, deployment or push was used.

## Next

Use the [local runner instructions](../../scripts/stocks-local/README.md) to reproduce this automated scope. The next extension is a browser-engine test using a local test wallet bridge and the same real stack, including browser origin/CORS, reload and interaction behavior. A physical testnet wallet/public-chain run is later. Known-hash recovery into a new session remains a separate Claude UI task using the already verified backend contract; this harness does not add that feature.
