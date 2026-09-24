# Stocks CI cleanup proof hardening — 2026-09-20

## Scope and cause

Base `b8ae4d3d2418fea753135ed356a0ecd3b193e8c0`; isolated branch
`codex/ci-cleanup-proof-20260920` in `/private/tmp/arco-giwa-ci-cleanup-proof-20260920`.
Code `e2df4ab96a090b48e7e3e9a1f5d53a5461fef907`, tree
`7d6cd1a68b1844e1935c2cc017919ac8ca4dea61`.

The CI runner and browser/DOM lifecycle wrappers each treated every socket error
and timeout as proof of port closure. A permission/routing failure or inconclusive
probe could therefore mark cleanup as verified. This is a verification defect;
no product trading defect or observed leaked service is asserted.

The original three functions were extracted unchanged from the accepted base and
executed with deterministic socket events. All three accepted timeout and EACCES
as closed, accepted ECONNREFUSED, and rejected a successful connection.
`before.jsonl` records those twelve observations. The probe source and original
functions are retained alongside it.

## Change

One shared `assertPortClosed` requires explicit ECONNREFUSED on the owned IPv4
loopback endpoint. Connections, unknown errors, early close without a result and
one-second deadline expiry reject. The socket is destroyed and deadline cancelled
on settlement. URL/port validation precedes connection. CI and both lifecycle
wrappers now use this function. Test fixtures copy the new dependency and the CI
postgres scenario includes its regression tests.

Only eight harness/test/documentation files changed. Product UI, server, schema,
contracts, deployments, workflow selection and dependency locks are unchanged.
No production UI work was taken from Claude.

## Evidence

All paths below are relative to
`/private/tmp/arco-giwa-ci-cleanup-proof-evidence-20260920`.

- `harness.log`: 62/62 pass, no skip; includes fourteen new cleanup tests.
  Uses real owned loopback listener before/after shutdown, plus deterministic
  errors, silent timeout, unexpected close, invalid input and synchronous failure.
- `mutation.log`: returning to error/timeout-as-success makes all eight selected
  regression cases fail. This is an intentionally failing mutation in a separate
  scratch copy; the accepted source is unchanged.
- `control-ui/summary.json`: PASS on clean code e2df4ab. Operator ten groups and
  investor nineteen groups; control wallet sends0, investor sends7, final control
  version30, MATCHED_AT_CUTOFF, independent cleanup verified.
- `browser-lifecycle/summary.json`: PASS on clean code e2df4ab; ready SIGINT,
  held response SIGTERM and intentional failure, with strict port refusal checks.
- `dom-lifecycle-final.log`: all three DOM lifecycle cases pass: ready SIGINT,
  active SIGTERM and intentional failure, also using the shared strict probe.
- `cleanup.json`: final independent check found sixteen recorded PIDs and eight
  process groups absent, twelve loopback ports refused, four recorded stack
  directories absent. DOM wrappers also performed their own strict checks before
  emitting PASS. `dom-setup-failed-cleanup.json` covers the failed setup cluster.
- `typecheck.log`, `security.log`, `actionlint.log`: pass.
- `design-tokens.log`: the same seven documented baseline violations;
  `design-stories.log`: no hard violation.

- `frontend.log`: 849/849 pass, DOM and ABI enabled, no skip.
- `server.log`: 408 pass, zero fail, 83 database-gated skips (not counted as passes).
- `build-server.log`, `build.log`: pass; existing frontend chunk-size warning remains.
- Final whitespace check: pass.

Status: **LOCAL_DONE**. All checks required for this local change completed.

## Retained failed attempts

The first focused test under the filesystem/network sandbox passed thirteen cases
but the real listener received listen EPERM (`focused.log`). Re-running with
local-listener permission passed all62 harness checks; the denied probe was never
relabelled as proof of a closed port.

The first DOM lifecycle command used GIWA_HOST_DOM_RUNTIME instead of the harness's
STOCKS_LOCAL_UI_DOM_RUNTIME. Ready shutdown passed, but active shutdown exited1
before its intended SIGTERM condition. `dom-lifecycle.log` retains that failure.
Correcting only the invocation produced the three final PASS cases. Its owned
PostgreSQL was stopped; recorded DB PIDs and socket/PID-file absence were checked,
the diagnostic PostgreSQL log preserved, and its owned scratch directory removed.

## Platform and remote status

Actual runs used macOS, Node22.23.2, PostgreSQL18.6 and Chrome153.0.8010.48.
The actual PG/EVM/browser scenarios ran, but the separate ninety-test PostgreSQL
suite and the other CI scenarios were not repeated in this change.
No separate review agent was spawned; root implemented and verified this change.

Read-only GitHub checks confirm main is still
`8160f354b55dfe9a525565e30ddc007f51448f3d` and Stocks integration workflow is absent
there (workflow lookup404). GitHub authentication worked in the permitted network
context. The local Docker context points to a stopped Colima daemon; no VM was
started. Ubuntu24.04/PG16/pinned Chromium and hosted Actions remain unverified.

Next: prepare/publish the accumulated verified candidate on a separate GitHub
branch and open a draft PR to run all six Linux jobs. Manual dispatch cannot start
the new workflow while it is absent from the default branch. There has been no
push, main merge, public deployment, real wallet/public RPC access, or artifact
upload configuration in this task. Local evidence remains local; existing Actions
console logging already forwards child output and needed no change.
