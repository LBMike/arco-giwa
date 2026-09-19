# 003E independent integration review — DONE_WITH_CONCERNS

2026-09-19. Functional, authorization, persistence and local browser integration
checks passed. One low-priority UI copy finding remains for Claude 003E-1. No
confirmed P0/P1/P2 issue was found in this scoped review. This is local test
acceptance, not production readiness or main integration.

## Finding first

**DIAG-UI-003E-P3-01** — `src/demo/giwa/stocks-admin/SubmissionDiagnostics.tsx:35`
(and the analogous disabled-route body at line37).

After a successful diagnostics read, refresh may return404. The store correctly
keeps the previous snapshot and explicitly labels it old. The error body also
says **“Nothing is shown”**, contradicting the visible earlier record. The real
Chrome run forwarded that refresh to an actual foreign-deployment order and
received404 from the production API, reproducing the contradictory message next
to the retained original hash. This is a copy issue; the UI does not present the
old record as a current snapshot or grant execution permission.

Fix only the error wording or make it conditional on retained data. Preserve the
server404 distinction, old-snapshot label, read-only controls and existing state
retention. Add successful-read→404-refresh tests for both `not_found` and
`disabled`, plus the no-previous-record paths. The follow-up task is
`docs/tasks/giwa-stocks-operator-diagnostics-copy-003e1-20260919.md`.

## Exact sources and ownership

- Prior accepted base: `a01e67071f5e66f3ebee3630b93023c109f32400`.
- Claude candidate: `21224d450a02c1f34aaf9cc4e9a51dbd0b82a574`; implementation
  `0b5e0507915725937a4815c191e393300a7d627f`.
- Claude clone `/private/tmp/arco-giwa-operator-diagnostics-ui-20260919` remained
  clean and unchanged; its push URL is disabled.
- Codex code: `329c2cc12faff0bf75a216d29c64d8bf411fe2f9`, tree
  `bba2ccdf20e84fa46e4b2214d3f19bd4b881227e`.
- Integration clone `/private/tmp/arco-giwa-operator-diagnostics-verified-20260919`,
  branch `codex/giwa-operator-diagnostics-verified-20260919`, push URL `DISABLED`.
- Claude owns production UI. Codex changed only the local test harness and its
  tests/docs. No production `src`, server, schema, contracts, registry,
  dependencies, authentication or quote-deadline changes after the Claude HEAD.
- Root implemented and ran browser integration. `diag_scope_review` independently
  reviewed store/scope and found the P3; `diag_contract_review` checked real DTO
  compatibility; `diag_real_fixtures` implemented the isolated fixture helper.
  Reviewers also read the new harness and their evidence-precision suggestions
  were addressed before the final successful run.

## Validation results

| Check | Result |
| --- | --- |
| Full frontend, DOM and compiled ABI enabled | 743 pass /0 fail /0 skip |
| Default server | 330 pass /0 fail /72 DB-gated skips |
| Actual PostgreSQL suites | 79 pass /0 fail /0 skip:72 server DB tests +7 browser-adapter roundtrip tests |
| DB + Node/process restart | BUY/SELL recovery and persisted proofs/claims PASS |
| Existing actual Chrome investor flow | 19 assertion groups PASS;7 original wallet sends/7 durable claims |
| New actual Chrome operator diagnostics | 24 examples and9 assertion groups PASS, with known P3 copy finding |
| Local harness boundary tests | 13/13 PASS |
| Independent scope/store + signed-route DOM | 29/29 PASS; memory SQL fixtures |
| Independent parser/card | 30/30 PASS |
| Independent repository/service/route/store probe | 12/12 PASS; memory SQL and test resolver, not actual PG |
| Typecheck, build, security, stories, diff check | PASS |
| Design tokens | Existing7 violations unchanged; no new violation |

Counts from repeated/narrow checks overlap the full suites and must not be added
into an inflated unique total. Node24.14.0 and Chrome153.0.8010.48 were used.
The builder's CI-like677pass/6skip is not a separate root rerun. Previous known-
hash31 and forced-lifecycle3 scenarios were not rerun this increment; the ordinary
Chrome19 flow and full frontend/DB regressions were rerun.

## What actual Chrome proved

The real `/admin/stocks` route mounts the existing host and production admin
feature. Its operator signs a real local SIWE message; the unchanged signed
operator resolver grants `stocks:read`. No injected JWT or mocked diagnostic
response is used for the successful examples.

Before diagnostics, the existing investor flow actually performs BUY/SELL,
reload, API restart, wallet-account change and a lost wallet response. The worker
and observer complete business orders and the independent chain/DB reconciliation
matches. At that boundary there are7 original UI sends and7 claims, holder stock
1.25, holder test cash1850, vault cash150 and escrow0.

The additional24 examples cover BUY/SELL × approval/transfer across null,
REQUEST_MAY_START, UNKNOWN without hash, SUBMITTED, CONFIRMED and REVERTED, plus
expired historical NOT_ENROLLED. Original completed orders provide four genuine
confirmed stage proofs. New fixture orders and journal records use production
services. Ten separately counted fixture sends produce real local EVM receipts,
including mined out-of-gas reverts. Historical and foreign-deployment orders are
explicit new isolated DB fixtures; business completion is never fabricated.

During the post-login diagnostics interval:

-115 server API requests (including CORS preflights) were reads only.
- Browser attempts to `/__local/wallet`:0, including attempts the operator bridge
  would reject before its own forwarded-call counter.
- Forwarded wallet calls:0; wallet sends:0; API mutations:0; request bodies:0.
- All19 Stocks tables plus signer-operation rows (20 compared collections),
  finalized chain head, balances and all local account nonces remained equal.
- Every rendered stage matched the real DTO, original hash and stored receipt.
  The server `observedAt` was displayed without browser replacement.
- A real foreign-deployment404 preserved an explicitly old record and exposed the
  P3 wording. A separately aborted network read also retained an old label and
  succeeded on explicit retry.
- Selecting a new order cancelled a held read and removed its previous hash.
  This check does not assert delivery of an already cancelled late response;
  delayed-response protection is separately covered by store/DOM tests.
- Native Enter and Space each produced exactly one refresh request.
-375/768/1440px checks found no horizontal overflow; full-page screenshots saved.
- A permanently stopped local runtime still served an expired order. The runtime
  reported STOPPED, newOrdersPaused=true, configuredPause=false. This is not a
  configured-pause transition test.
- Switching from operator to the holder hid diagnostics; a new signed ordinary
  session received403 from `/api/v1/admin/stocks/orders`, so the console did not
  request diagnostics. This is mounted-console denial evidence, not a claim of
  direct Chrome diagnostics-route403. The actual server route's direct denial is
  covered by independent signed-route DOM/plugin checks.
- No page errors were recorded.

## Harness setup corrections and cleanup

The initial launch stopped before acquiring resources because the Claude clone
had no contract dependency installation. The integration clone reused the prior
accepted local installation and cache; no download or dependency change occurred.
The first full run passed investor19 and prepared real fixtures, then the driver
waited for an investor-only login selector on the admin page. The product was
already signed in. The driver now waits for the real host's Sign out button.
The next complete run passed. Both acquired stacks were closed correctly.

The first boundary-test execution was sandbox-blocked from opening a loopback
listener. The authorized local rerun passed; this was an environment restriction,
not a product test failure. The local cleanup-report reader was corrected to
ignore non-object JSON lines, then confirmed the actual OS state.

Final verification confirmed10 owned process IDs absent and6 ports closed across
both browser attempts and the standalone PostgreSQL restart. PG evidence reports
stopped=true, restarts=1, TCP=false. Generated evidence scan found no signed JWT,
Bearer token or private-key banner. No process from another task was terminated;
Claude's reported4327 server was not owned or inspected by this run.

`scripts/check-independence.sh` is absent. It is not required by this repository's
`CLAUDE.md`; no replacement script or approval gate was invented. Independent
review was performed by the two agents above, with separate evidence and root
integration checks.

## Evidence and limits

Evidence root: `/private/tmp/arco-giwa-operator-diagnostics-verified-evidence-20260919`.

- `browser/result.json`, `browser.log`: final real run; top-levelPASS denotes all
  assertions, nested operator result is explicitly `PASS_WITH_KNOWN_P3`.
- `browser/diagnostics-404-retained-snapshot.png`: actual P3 reproduction.
- `browser/diagnostics-{375,768,1440}.png`: actual layouts.
- `postgres.log`, `/private/tmp/stocks-submissions-pg-kj6XnK/harness-evidence.json`:
  actual79 + restart results.
- `frontend.log`, `server.log`, `harness-unit.log`, `checks.json`, `cleanup.json`.
- `scope-review/review.md`, `scope-review/copy-probe.log`,
  `contract-review/report.md`: independent results and reproduction.
- `browser-attempt1-selector.log` and its directory: preserved failed test-driver
  attempt, not misreported as a successful end-to-end run.

No public RPC, real wallet, actual securities, live market pricing, production
signer or public deployment was used. Node22, full accessibility audit and a live
same-API deployment switch remain unverified. The same-tab known-hash memory
limit and hashless UNKNOWN no-resend policy remain unchanged. No main merge,
push or publication occurred.

**Next:** Claude003E-1 copy fix → narrow independent retest (including both404
branches) → closeP3. Backend follow-up recommendation remains actual local
DB/EVM/browser CI automation; it has not been implemented in this task.
