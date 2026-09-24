# GIWA Stocks operator control — local verification

Status: LOCAL_DONE, 2026-09-19. Production UI, public-network rollout, main merge,
push and hosted GitHub Actions execution were not performed.

## Candidate

- Clone: `/private/tmp/arco-giwa-stocks-operator-control-20260919`
- Branch: `codex/stocks-operator-control-20260919`
- Base: `fd1115346ed6327de716b74fbda048c4d1259698`
- Code commit: `c75f61578b9112e44838b4263fba72d7edae74b9`
- Code tree: `7e1ab7989982809eff913c26dcfe8f4749e61e58`
- Local raw evidence: `/private/tmp/arco-giwa-stocks-operator-control-evidence-20260919`
- Final runtime integration ran against this clean code commit, recorded by
  `runtime-final/summary.json`. Earlier full server/frontend/PG checks ran on its
  working tree; the final harness acceptance checks were rerun after their changes.

## Delivered behavior

`operatorControls:true` optionally exposes named signed-session operator state,
history and change endpoints. Read requires `stocks:read`; change separately
requires `stocks:control`. Initial absent state is paused/version0 with no read
side effect. State and immutable audit event commit together. Row locking,
expectedVersion and deployment-scoped idempotency serialize conflicting commands.
An old resume retry returns its original event plus current paused state without
reapplying the change. The history uses bounded descending keyset pagination.

Runtime admission reads shared DB state on every check. Error, slow response,
revision rollback and conflicting revision evidence fail closed. The fixed pause,
dispatch-disabled, stopped and observer freshness gates still apply, including
changes that occur while awaiting DB. Pausing keeps original receipt, signer and
observer recovery available. Diagnostics retain a separate process-local five-second
snapshot and do no DB/RPC reads themselves. Absent feature flag retains legacy
route absence and runtime wire shape. Preflight checks the extra two tables only
when controls are enabled.

The CI matrix adds an `operator-control` scenario using real owned local HTTP,
SIWE, PostgreSQL and an unforked EVM, with explicit result and OS cleanup checks.
There is no artifact-upload step. No production UI, contracts or deployment
registry files changed.

## Verification

Environment: Node 22.23.2, macOS, PostgreSQL 18.6, local unforked chain 91342,
disposable unlocked test accounts and local durable signer. The broker and price
remain mock. This does not establish live broker/securities behavior.

| Check | Result |
| --- | --- |
| Server suite | 403 pass, 0 fail; 82 database tests skipped in the ordinary no-DB command |
| Actual PostgreSQL suites | 89/89 pass, 0 skip: 82 server + 7 adapter tests |
| Actual PostgreSQL + Node restart | Pause/version/history survive; old resume replay leaves latest pause and audit count unchanged |
| Frontend with DOM + ABI gates enabled | 750/750 pass, 0 skip |
| Final harness/acceptance checks | 39/39 pass, 0 skip |
| Real local backend runtime | 19 scenario groups pass, including 8 operator-control groups |
| Final economic totals | Wallet/supply 3 stock units, escrow 0, vault 360 test-cash units; reconciliation MATCHED_AT_CUTOFF |
| Durable signer operations | 14 total, exactly 2 additional for the control BUY/SELL roundtrip, no duplicate submit after lost acknowledgement |
| Compiler, production build, security | Pass |
| Prisma schema validation, workflow actionlint, diff whitespace | Pass |
| Design checks | Existing 7 raw-color findings unchanged; stories have no hard violations |

The runtime cases demonstrate initial paused/no-write behavior, actual SIWE
holder GET/POST denial, idempotent retry and stale version rejection, new
BUY/SELL quote/order/claim/execution-policy rejection, receipt recovery while
paused, real funding observed with broker PENDING, lost signer reply recovered
while paused, escrow observed without new SELL settlement, single settlement
after resume, cross-service shared DB visibility, control-store failure with
continuing observation, runtime recreation and every independent runtime gate.
Stopping during a held control read still denies the pending admission.

Independent review found and closed a concurrency bug in the first draft:
one admission could use another overlapping read's diagnostic resume result.
Eight new tests failed before correction. The final policy's 24 tests passed;
separate reviewer modeling also covered 48 ordering/state combinations (288
assertions). Highest revision survives diagnostic expiration and failures.

The first local stack run exposed a test timing error: the harness retried eight
times without waiting for the real one-second outbox retry deadline. The harness
now waits under a bounded deadline without changing product retry timing. The
final run passed. A non-escalated final harness invocation hit seven localhost
listen EPERM errors; all 39 passed with the required local-port permission.
These failed attempts remain in evidence and are not counted as passing runs.

All final owned PG/EVM processes exited and temporary stack directories were
removed. The actual PG harness independently verified both restart PIDs exited,
socket and PID files absent. Raw DB clusters from this task are removed after
that ownership verification; result/log evidence remains outside the clusters.

## Boundaries and next work

Manual pause is an admission gate. It does not cancel previously issued wallet
claims, a valid execution policy, an in-flight send, or direct contract calls.
Changing this into a hard emergency cutoff requires a separate design. Resume
does not override configured pause or unhealthy observation. Multi-node
diagnostics can differ until refreshed; authorization always reads DB.

Control changes remain in the database with no seven-day automatic deletion.
Any backup, audit retention or privileged administrative purge policy remains
separate. Seven-day CI artifact retention is unrelated and no upload is configured.

The next UI task is [003F operator control](../tasks/giwa-stocks-operator-control-ui-003f-20260919.md).
Claude UI work and Codex's subsequent real browser integration acceptance have
not started. Hosted Ubuntu/Node22/PostgreSQL16 Actions execution is also pending;
local macOS/PostgreSQL18 success does not substitute for it. Public deployment
still requires the existing verified deployment/signer/role activation process.
