# GIWA-STOCKS-EXECUTION-API-001

User ownership: Claude owns UI; Codex owns backend only. Base5865b97db0513aea2045e3d51fcc6b73b35baf24. Separate clone; no frontend, journal, ledger, contract or deployment edits.

## Contract

Authenticated GET `/api/v1/stocks/execution/deployment` and GET `/api/v1/stocks/execution/:side/:orderId`. No query/body inputs. Same PROFILE+ISO observedAt envelope, data is ReviewedDeployment or ExecutionPolicy from server/src/stocks-execution/contracts.ts (timestamps inside data are epoch ms). no-store on success/error, auth before input handling, fixed sanitized errors, existing explicit CORS. Optional registration: absent runtime means404. Policy denial is non-2xx error, never fabricated allowed/VERIFIED.

`StocksExecutionService(stocks, deployments)` in service.ts exports async deployment(actor), policy(actor,side,id). `stocksExecutionPlugin`, StocksExecutionPluginOptions mirror existing plugin. Root owns contracts.ts and deployment.ts proof implementation plus runtime/app/index composition. Backend agent owns service.ts/plugin.ts/tests and docs/contracts/stocks-execution-v1.md. Reviewer separate clone and adversarial tests.

DeploymentEvidencePort.get() supplies fresh trusted full verification evidence with max15s lease anchored at actual verification START, bounded8s verification, no stale fallback. Root reuses full existing deployment verification plus checkpoint rechecks through deadline-guarded ChainPort and read-only transport. No new signer calls. Manifest output strictly public whitelisted fields; digest must match actual service manifest. Lifecycle stop disables cache and new reads. Cached evidence retains original verifiedAt/validUntil; concurrent refresh coalesced; failed or timed-out work cannot publish later.

Service policy validates actor owner wallet + side/order + deployment + physical vault binding + new-order enrollment + immutable order derivation + payable state + DB-clock quote expiry + paused()/observer health. Read-only queries; do NOT call ready()/bindDeployment() because they can INSERT. Use bounded read-only transaction and post-lock deadline check. No claims, audit inserts, enrollment, signing, or transfer. Claim remains sole execution permission authority. Do not reject policy solely because pending approval/transfer journal exists: controller needs policy read before inspect/reconcile recovery; policy allowed is eligibility, not new signature permission.

Policy lease max15s anchored before work, capped by deployment evidence lease and DB remaining order lifetime, never restarted at response construction. Recheck pause after awaited work, current monotonic/wall clocks and evidence expiry before response; delayed query/locks or event-loop stall cannot mint fresh lease. Prefer permission check before costly proof for cross-owner requests. DB and RPC errors sanitized.

Validation: fake clock/deferred adversarial unit tests, actual optional buildApp auth/CORS tests, freshPG owner/binding/enrollment/readonly/lockwait-expiry/pause tests, full backend/build/security, independent review. LocalEVM existing harness optional extension by root validates runtime wiring. One PG slot, elevated initial startup, owned cleanup only.
