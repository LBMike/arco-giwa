# Stocks integration CI — local acceptance

2026-09-19. **CI implementation and local validation complete. Hosted Linux
execution has not been performed. External artifact upload remains excluded.**

## Source and scope

- Base: `1951782b33720d7b71642c9df0957377bb380bca` (003E-1 accepted).
- Clone: `/private/tmp/arco-giwa-stocks-ci-20260919`.
- Branch: `codex/stocks-ci-20260919`.
- Code: `3d7bd45320d71a5a32af7e70fe7221c0b3283ceb`.
- Code tree: `2c1fa9c3cfd8a1f5ef3f8a5a993741e6c6c05970`.
- Original workspace and Claude clones untouched. No product UI, API, schema,
  contract, authentication lifetime, deadline or trading-policy change.
- No main merge, push, remote workflow dispatch, public RPC or physical wallet.
  Clone push URL is disabled.

The new workflow defines four independent checks: PostgreSQL plus all DOM/ABI
frontend tests; investor flow plus operator diagnostics; product known-hash
recovery; and browser lifecycle failures. Each uses disposable local services.
Tool dependencies have a separate committed npm lock file. Root product
dependencies and the existing CI workflow remain unchanged.

The entry point requires successful child exits, zero skipped/TODO/failed TAP
tests, restart evidence, matching ordered browser cleanup records and independent
PID/socket/port checks. A browser result marked PASS before failed cleanup cannot
make CI green. The full job has a 25-minute bound; individual commands request
shutdown after 12 minutes. SIGKILL/host loss/hung teardown is not a guaranteed
graceful shutdown.

## Executed validation

Local platform: macOS arm64, Node **22.23.2**, PostgreSQL **18.6**, Chrome
**153.0.8010.48**, Playwright **1.62.1**, jsdom **26.1.0**. CI selects Ubuntu 24.04,
PostgreSQL16 and the Chromium build matching Playwright; that exact hosted
combination still needs its first run. PostgreSQL16's `initdb -c` compatibility
was checked against its official documentation, not an actual PG16 execution.

| Check | Actual result |
| --- | --- |
| Full frontend with DOM and ABI gates enabled | 750 pass, 0 fail, 0 skip |
| Actual PG server suites + browser adapter | 79 pass (72 server + 7 adapter), 0 skip |
| PostgreSQL + new Node process restart | Durable claims, trusted proof and BUY/SELL order recovery pass |
| Final harness boundary/acceptance/cancellation unit tests | 35 pass, 0 skip |
| Actual investor Chrome baseline | 19 groups, 7 original wallet sends and 7 claims |
| Actual operator diagnostics | 24 fixtures, 12 groups, no findings/page errors |
| Diagnostic read interval | 0 wallet attempts/calls/sends, 0 mutation requests; DB/chain comparisons unchanged |
| Actual product known-hash recovery | 31 groups, all 4 side/stage combinations; no extra wallet calls during recovery |
| Actual browser lifecycle | Ready SIGINT, held SIGTERM, intentional failure: all 3 pass with cleanup |
| Actual PG cancellation | SIGINT and SIGTERM: expected 130/143, child/PG cleanup verified, no success claim |
| Existing default server suite | 330 pass, 72 DB-gated skip; the separate PG run above executes those DB checks |
| Typecheck, frontend build, server build, contract compile, security | Pass |
| Workflow validation | Official actionlint1.7.12 archive checksum verified; new workflow lint passes |
| Story structure | Pass with existing soft notices |
| Design tokens | Existing 7 findings, exit1; unchanged baseline |

The first postgres CI run included 33 harness tests. Two lifecycle-wrapper
cancellation tests were subsequently added and all35 were run together. The full
frontend/PG tests and diagnostic browser scenario were run before the code
commit; their logic was unchanged afterward. The runner later gained an explicit
working-tree provenance flag and the two tests in its unit list. The recovery
run records its dirty source state; the final three actual lifecycle cases ran
from clean code commit `3d7bd45`. This is not a claim that every full suite was
rerun from the final clean commit.

## Independent review and cancellation regression

Two independent agents reviewed portability, false-success conditions,
dependencies, process ownership and scope. One found that terminating the outer
browser lifecycle checker could bypass its nested runner's cleanup. The checker
now forwards shutdown to that owned runner, waits for close, preserves partial
evidence and never starts the next case or reports a cancelled case as PASS.

The new black-box wrapper tests use fake child processes, not fake claims of
real PG/Chrome operation. Both pass under Node22; the reviewer also ran the old
checker as a negative control and both failed as expected. Separate actual
browser lifecycle cases above validate real service shutdown. PostgreSQL
portability tests cover startup/test/cleanup failure, both cancellation signals
and repeated signals during cleanup. Actual PostgreSQL signal probes also pass.
No unresolved implementation finding was reported after these fixes.

## Evidence and remaining activation work

Local evidence root:
`/private/tmp/arco-giwa-stocks-ci-evidence-20260919`.
Each scenario has `summary.json`, child logs and its explicit browser or PG
reports. Screenshots and original browser results are preserved. Owned services
are stopped; successful browser and lifecycle temporary directories are removed.
The successful standalone PG and actual signal-probe clusters were removed only
after their exported shutdown evidence and absent PIDs/sockets were verified.

An automatic approval review rejected adding external GitHub artifact upload
because specific authorization for transferring logs/JSON/screenshots to GitHub
was missing. The accepted implementation therefore has **no upload step**.
Hosted-run screenshots/JSON will be ephemeral until upload is separately
authorized; normal workflow console output remains available. A proposed next
addition is explicit test logs, result/summary JSON and screenshots in
`LBMike/arco-giwa` Actions artifacts for7days. Raw PG data, browser profiles,
environment files and the whole temporary directory are excluded from that
proposal. No such upload or configuration was performed.

Next: integrate the reviewed branch under the existing repository workflow,
perform the first Ubuntu/PG16/pinned-Chromium Actions run, and inspect each of the
four statuses. Required-check branch settings and external artifact retention
are not claimed to be enabled. CI changes require no additional Claude UI work.
