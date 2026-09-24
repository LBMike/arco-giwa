# GIWA Stocks approved runtime connection — integration evidence

Date: 2026-09-17. Original integration base: `67603b84dbd3da374d0fc88f2f280881dd174a32`.
Candidate branch: `codex/stocks-giwa-command-20260916`.
Candidate worktree: `/private/tmp/arco-giwa-stocks-command-20260916`.
Final implementation SHA: `fb036bb61a092a82c1ae48ab580bf7155f572c43`. The subsequent documentation commit does not change implementation.
Gate: local implementation independently verified; S1 resolved, no remaining confirmed P0/P1 within this review scope. Public deployment and external signer configuration remain outstanding.

Commander/runtime integrator: `/root`. Integration test builder: `/root/giwa_stocks_builder`. Deployment-tool builder: `/root/giwa_stocks_contracts`. Independent reviewer: `/root/rwa_reviewer`, using separate detached checkouts. Additional user-owned independent review task: `01a0aae1-20be-7a42-9672-dbcd305033dd` (`GIWA Stocks — 개발 검증`). Builder self-tests do not substitute for either independent review.

The user explicitly approved continued development and the previously proposed runtime connection. This candidate implements optional Stocks registration in the existing application and explicit automatic dispatch. No main-branch integration, push, public GIWA deployment, external signer setup or public transaction has occurred.

## Implemented source

- `633af2e`: actual app integration and real SIWE login in the full-stack harness (builder `08543fbaf2648e4e46639575128317306a9b24c2`).
- `129b458`: offline unsigned five-contract deployment planner (builder `78e29d797f29a12df4f7efa3da6187a699491168`).
- `2c4f00d10e0fc60ba0341ceb8cb8dfce7450888b`: approved app/index composition, strict explicit flags, runtime resource ownership, lifecycle timer, startup failure cleanup and repeated-signal handling.
- `b5eb0baa079c5dd59a292e33706f0bb16b525d17`: actual runtime native timer and autodispatch-disabled integration scenarios (builder `746b6a7820dbcf65ca91e4d5017a34dc196e6834`).
- `427f832`: read-only finalized deployment verifier (builder `976e30677bd199da54c33587ad38357e38d28ff3`).
- `fb036bb61a092a82c1ae48ab580bf7155f572c43`: physical local-signer account identity fix and regression (builder `e0f1b0c2e70a669c1652dc943465abce910b7bc6`).

Default mode starts no Stocks configuration/RPC/signer/database work. Enabled mode uses the existing wallet session and named read-only operators. Explicit automatic dispatch is required to accept new trades. Startup checks network, finalized contract evidence, signer protocol and immutable physical-vault binding. Shutdown stops acceptance and scheduling before draining in-flight work and releasing both databases. No startup path deploys contracts or applies migrations.

## Directly reproduced checks

| Check | Evidence |
| --- | --- |
| Server regression | 95 passed, 32 PostgreSQL cases deliberately skipped in this generic invocation; 0 failed. `npm run test:server`. Those skips are not counted as passes. The unchanged money module's 32/32 real-PostgreSQL evidence is recorded in the preceding independent review. |
| Runtime/lifecycle/app scope | 19 passed, included in the server count. Covers disabled defaults, invalid flags, authorization, native timer ownership, startup/close races, resource failures and repeated signals while cleanup is blocked. |
| Frontend regression | 175/175 passed via `npm run test:frontend`; no frontend code changed in this task. |
| Build and static checks | `npm run typecheck`, `npm run build:server`, `npm run build`, `npm run test:security`, `npm run prisma:migration:inspect` passed. Migration parser 26/26 passed. No new migration/package/lockfile was added by this activation task. |
| Actual automatic full stack | Commander and independent reviewer each passed all 13 scenarios at `b5eb0baa`: five actual local EVM contracts, fresh PostgreSQL, actual buildApp, SIWE nonce/sign/verify and nonce replay rejection. |
| Planner and finalized verifier | Independent reviewer reproduced 51/51 actual isolated EVM tests and strict TypeScript at builder `976e306…` (29 contracts, 9 planner, 13 verifier). No public endpoint or PostgreSQL used. |
| Deployment output compatibility | Commander passed actual five-CREATE output with the backend's real ABI digest through `freezeManifest`, `parseStocksRuntimeConfig` and `verifyStocksDeployment`. First creation checkpoint 1, finalized cutoff 5, wrong ABI rejected. |
| S1 final independent gate | Reviewer directly reproduced 5/5 address-case scenarios, 13/13 complete automatic scenarios and 2/2 SIGTERM/SIGINT cleanup at exact fix `e0f1b0c…`, then released the S1 HOLD. The same four-file fix was cherry-picked without conflicts as `fb036bb…`. |

The automatic full-stack phase completes HTTP BUY 0.125 and SELL 0.125 using the actual runtime's native two-second timer; the phase does not manually call worker/observer/tick. Autodispatch-disabled quotes return 503, explicit ticks remain inert, and its owned pool closes. Final economic totals after all scenarios: wallet and supply `3000000000` stock base units, escrow `0`, vault `360000000` test-cash base units, `MATCHED_AT_CUTOFF`, 12 durable signer operations. These are local test values, not public balances.

Logs available on this machine:

- `/private/tmp/stocks-activation-server-20260917.log`
- `/private/tmp/stocks-activation-frontend-20260917.log`
- `/private/tmp/stocks-activation-webbuild-20260917.log`
- `/private/tmp/stocks-activation-fullstack-20260917.log`
- `/private/tmp/stocks-review-native-auto-20260917.log`
- `/private/tmp/stocks-verifier-review-20260917.log`
- `/private/tmp/stocks-deployment-backend-compat-20260917.log` and its adjacent `.cjs` probe
- `/private/tmp/stocks-review-signer-case-20260917.log`
- `/private/tmp/stocks-review-signer-case-fullstack-20260917.log`
- `/private/tmp/stocks-review-signer-case-signals-20260917.log`

The compatibility probe imports the verifier from its exact builder checkout and compiled backend from the integration checkout. It uses only an unforked in-process Hardhat chain, actual backend ABI `a0d31f9e9c54e63b38215aa64b271ff08d72d16b3a893dfa64652e4eabdaf974`, and the five locally created contracts. Public role addresses and deployment hashes are not invented.

## Independent S1 finding and follow-up

Status: RESOLVED by independently verified `e0f1b0c…`, integrated as `fb036bb…`. The additional review task reproduced a P1 at the preceding `67603b84…` candidate that persisted through `b5eb0baa`: lowercase/checksum representations split the physical account's nonce lock and prevented original-transaction recovery. Passing the original 13 scenarios did not resolve this finding. The issue was in the disposable local signer harness; this is not evidence of an external production signer flaw or actual loss.

The commander assigned a separate builder worktree with exact base `b5eb0baa` to retain immutable original payload/digest while normalizing the physical account, handle legacy records safely, and add mixed-case/duplicate/concurrency/restart/no-resubmission evidence. Builder candidate `e0f1b0c2e70a669c1652dc943465abce910b7bc6` is clean at `/private/tmp/arco-giwa-stocks-signer-case-20260917`. Its four scoped files include a five-scenario real EVM/PostgreSQL regression. The builder reproduced the failure before fixing it, then passed 5/5 address-case, 13/13 full-stack and 2/2 signal cleanup scenarios.

Independent `/root/rwa_reviewer` checked the exact fix in its own clean detached checkout `/private/tmp/arco-giwa-stocks-runtime-review-20260916`, then directly reproduced all 5/13/2 checks and the server build. The original defect probe remains unchanged. Correct expectations are tested by first mining a checksum-address original transaction, losing its response, restarting and recovering the original hash with zero new submissions/nonce growth. A later unresolved lowercase PREPARED operation then blocks both address spellings and a changed deployment digest; no unsafe PREPARED row is deleted or reset to allow the second condition. Concurrent requests, legacy checksum rows, stale chain nonce responses, physical uniqueness and preserved collision evidence also pass. All owned EVM/PostgreSQL processes and sockets were confirmed stopped and the single PG slot returned.

The original finder task is coordinating a separate direct user request for Claude parallel-work prompts and remains the overall progress coordinator. It did not execute this last rerun; results are attributed to the independent reviewer that actually ran them. The distinct Claude S1 fix `5cd320a015d6841cc1d9e3adde14dabb138df90b` was not also applied.

## External prerequisites and product scope

Public execution still requires the actual signing method and public deployer/operator/faucet addresses, original finalized deployment evidence, reviewed database installation and the external signer's durable operation service. Secret keys and seeds are never requested or read. Follow `../contracts/stocks-giwa-runtime-activation.md`; no local signer is selected as a public fallback.

This slice supports NVDA, ARCO_TEST_USDC, fixed mock price 120 and a durable mock broker. Forty tradeable stocks, live prices, Alpaca, actual USDC/RLUSD, social-wallet creation, admin write controls and XRPL are not completed by this slice. Existing Saving/Funds deployments and unrelated user work remain untouched. Source whitespace validation excludes the historical `docs/proposals/stocks-activation.patch`, whose literal patch context requires leading spaces; the applied implementation supersedes that original proposal.
