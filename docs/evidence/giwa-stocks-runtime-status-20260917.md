# GIWA-STOCKS-RUNTIME-STATUS-001 — combined backend verification

Status: ACCEPTED. Code: `36579cac6a534ff04e315ac3206fddda52693350` on `codex/giwa-runtime-status-20260917`, checkout `/private/tmp/arco-giwa-runtime-status-20260917`. Base `af614a4` is the previous preflight milestone. Root verification and final independent review PASS, with no confirmed unresolved finding.

## Delivered behavior

Optional GET `/api/v1/admin/stocks/runtime` is wired through the actual app and server entrypoint. Existing signed named operators with `stocks:read` can read a coherent process-local snapshot: lifecycle state, observation state/timestamps/age, dispatch setting, configured pause, in-flight tick, and exact pause reasons. Legacy shared tokens, client-declared roles and unlisted wallets cannot access it. Query/body input is rejected before snapshot access. Success and errors are no-store, and output is an explicit whitelist with fixed sanitized errors.

The endpoint performs no database/RPC/signer calls or tick/pause mutations. Runtime absence leaves the route absent. Diagnostics always say executionAuthorization=false; CURRENT never substitutes for deployment/policy checks, reconciliation or durable submission claims.

Health uses one wall/monotonic clock pair per snapshot. Either clock can expire the observation; rollback, invalid readings and expiry latch stale until a new valid CURRENT observation. Clock samples cannot regress from the prior sample. Reads do not refresh observation timestamps. Stop is terminal, preserves observation history and prevents late results from reviving CURRENT. STOPPED with tickInFlight=true explicitly describes shutdown while draining work.

## Provenance and scope

- Contract commit `24a2267d7262d17aafdb8204ca237ee6ff5f51d2`.
- Root health/runtime, app/index, signed-session app tests and actual local stack checks: `5cb6857`.
- API builder source `88a982bd6489ab283ae9390a355d290985845ffc`, imported as `839a956`, owns plugin/tests/guide only. Builder focused 38/38 and build/type/security passed; report `/private/tmp/arco-giwa-runtime-status-api-evidence-20260917/README.md`.
- Root corrected its app test fixture's too-short deployment label in `36579ca`; production validation remains unchanged. The initial fixture produced the expected sanitized 503; the corrected valid fixture passes the final full suite.

No UI, Solidity, deployed registry, schema/migration, dependency or lockfile changes. Local contract compilation uses private copies of existing artifacts and existing dependencies. There was no public RPC, real user wallet, external signing service, production DB, push, merge into the original checkout or public deployment. The real local signer and mock broker remain test fixtures.

## Root verification at final code

| Check | Result |
| --- | --- |
| Full server suite | 276 passed, 60 gated DB cases skipped, 0 failed |
| Fresh PostgreSQL | 60/60 passed, no skips |
| PostgreSQL restart + new Node process | BUY/SELL order recovery and immutable terminal proof restoration passed |
| Actual isolated local EVM + PG + HTTP + SIWE | 18 scenarios passed |
| Existing frontend with DOM and compiled ABI gates | 402/402 passed, no skips |
| Typecheck, frontend/server builds, security, whitespace | Passed |
| Design tokens | Existing 7 findings unchanged |
| Story structure | Passed with inherited soft warnings |

New non-DB tests comprise health/snapshot5 + signed-session app3 + API38, included in the full server count. The full database suite is the previous legacy32 + journal8 + receipts4 + execution5 + order recovery6 + preflight5. No new schema or database mutation path is introduced.

The actual local EVM run verifies operator-only/no-store runtime diagnostics; disabled dispatch and no observer timestamp; configured pause with CURRENT observation; shutdown while a real RPC response is held, followed by STOPPED without timestamp renewal after release; active CURRENT diagnostics followed by timer-driven BUY/SELL settlement. Existing approval/funding/escrow, receipt reconciliation, nonce recovery, observer replay and common-cutoff conservation all remain passing. Final wallet/supply: 3,000,000,000 stock units, escrow0, vault cash360,000,000 units, reconciliation MATCHED_AT_CUTOFF.

Logs: `/private/tmp/giwa-runtime-status-{server,postgres,local-evm,frontend,typecheck,build,security,tokens,stories}.log`.

Final owned PostgreSQL evidence: `/private/tmp/stocks-submissions-pg-xyeFKk/harness-evidence.json`, started=true, stopped=true, restarts=1, TCP disabled. postmaster.pid absence confirmed. Local stack harness exited0 after its cleanup path, which verifies owned EVM process group and PostgreSQL termination and removes successful temporary data. All root test processes completed. No unrelated service was stopped.

The existing frontend large-chunk warning and seven token findings remain. This operator API is process-local, not a cross-replica or live canonical-chain/ledger health proof. The actual Claude UI completion and real wallet end-to-end integration remain unverified, as does public testnet activation.

## Next integration boundary

Claude can consume [runtime status v1](../contracts/stocks-runtime-status-v1.md) for operator display, alongside the existing execution, receipt and order-recovery contracts. The next product step is UI/wallet/API integration and full user-flow verification, followed by prepared public testnet deployment inputs and paused-start checks. No pause/unpause control was added here.

## Independent verification

Reviewer `ledger_review` tested exact code `36579cac6a534ff04e315ac3206fddda52693350` in `/private/tmp/arco-giwa-runtime-status-review-20260917`. Focused runtime/status/app/lifecycle checks65/65 plus separate adversarial probes11/11 = **76/76 passed**; server compilation, security and whitespace checks passed. No independent DB/EVM service was started; those results remain the separately reported root executions above.

Final independent report: `/private/tmp/arco-giwa-runtime-status-review-evidence-20260917/README.md`. Original probes, commands and logs are retained alongside it; reviewer checkout is tracked-clean.

Direct adversarial checks cover independent clock expiry, rollback after the original observation time, stale latching and recovery only on a valid new observation, NaN/infinite clocks, a single sampled clock pair, stopped history preservation, real signed-session algorithm/expiry/issued-at/domain/chain/permission rejection, stop while authorization is awaiting, and no-store error responses. The initial probe expected a bare '?' to reach Fastify injection unchanged; injection normalized it away. That harness-only assertion was corrected, with original probe/log evidence retained. No production source fix was required by the independent review.
