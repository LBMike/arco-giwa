# 003E-1 independent acceptance — DONE

2026-09-19. **DIAG-UI-003E-P3-01 is closed.** Both diagnostics404 cases now
explain that no new data arrived when the explicitly old record remains visible.
A first404 with no prior record still says nothing is shown. No new actionable
finding was identified in the exact candidate or the added browser assertions.

## Exact source

- Previous integration: `cafdaf5975fa2a2c4ff4b456aae60f1fc8778436`, including
  actual-stack verification `329c2cc12faff0bf75a216d29c64d8bf411fe2f9`.
- Claude candidate reviewed: `528eae3485a5ead705badad5d87c7f48381031db`.
  Four files: one production card copy change and three regression-test files.
- Original Claude clone `/private/tmp/arco-giwa-operator-diagnostics-copy-20260919`
  was clean at that commit and was never edited by Codex. The user's report says
  the builder's separate review workflow is still underway; this acceptance is
  Codex's own verification of the exact committed candidate, not a claim that the
  builder's later workflow or unreported changes have finished.
- Codex code `944447d87df2e9ed52deff26a324f03bb5915006`, tree
  `9bdbdd1b49cd0f26db8fc1e20d2c257132540c4b`.
- Integration clone `/private/tmp/arco-giwa-operator-diagnostics-copy-verified-20260919`,
  branch `codex/giwa-operator-diagnostics-copy-verified-20260919`, push disabled.
- Codex changes are only the local browser regression and its README. Production
  UI is the Claude candidate unchanged. Server/DB/contracts/registry/auth/session
  rules/quote deadlines/dependencies are unchanged.

## Review and targeted negative controls

Independent reviewer `diag_copy_review` read the full four-file change, rendered
both404 kinds in retained/empty/wrong-side/wrong-order states, and reviewed the
new actual-browser regression. No new finding. The visible filtered record,
not merely a non-null stale store value, decides the copy. This preserves the
order/side visibility guard and avoids saying a hidden record is displayed.

| Check | Result |
| --- | --- |
| Candidate views + store + signed-route DOM | 56/56 PASS,0 skip |
| Independent external branch matrix | 8/8 PASS |
| Old component with candidate views + DOM | Expected failure:35 total,31 pass,4 fail;3 failing leaf tests plus the failed parent |
| Same independent matrix with old component | Expected failure:6 pass,2 fail;both retained404 kinds |

The negative clone `/private/tmp/arco-giwa-003e1-negative-control-20260919` is an
isolated disposable copy. Only its card was restored from cafdaf5; the deliberately
modified tree is not an accepted candidate. No service was started there. These
regressions therefore demonstrate the original issue, rather than only matching
new implementation text. Narrow counts overlap the full frontend suite and are
not added to its unique total.

## Root verification

| Check | Result |
| --- | --- |
| Full frontend with DOM + ABI enabled | 748/748 PASS,0 skip |
| Default server | 330 PASS,72 DB-gated skips,0 fail |
| Typecheck/build/security/stories/diff | PASS |
| Design tokens | Existing7 violations unchanged |
| Actual local Chrome investor path | 19 groups PASS,7 UI sends matched to7 durable claims |
| Actual local Chrome diagnostics | 24 examples,12 groups PASS;knownFindings=[] |
| Read-only interval |124 API requests including preflights;0 wallet attempts/calls/sends/mutations/request bodies |
| Business data comparison | All19 Stocks tables + signer operations, chain head/balances/nonces unchanged |
| Screenshots | Actual card captures,375/768/1440px;retained and initially empty404 cases |
| Cleanup |4 owned PIDs absent,3 ports closed,DB/socket/EVM group stopped |
| Evidence credential scan |0 matches |

Node24.14.0 and Chrome153.0.8010.48. The frontend increased from743 to748 because
of five new tests. The ordinary investor flow still ends with holder stock1.25,
holder test cash1850,vault150,escrow0 and MATCHED_AT_CUTOFF before diagnostic
fixtures. Ten explicit local fixture transactions are separate from seven
original UI transactions and create real receipt evidence.

The new browser driver forwards reads to an actual foreign-deployment order or
an actually unregistered Fastify path. It uses no fabricated404 response bodies.
For each kind it asserts the retained original hash/earlier timestamp, no
contradictory absence message, and then the empty initial-error state after
selecting a different order. Both statuses are recorded as404 in the browser
HTTP evidence. The former conditional known-P3 observation is now a failing
regression assertion. The entire final diagnostics result is PASS.

Native Enter/Space still issue one read each. Interrupted-read retry, held-read
cancellation on selection, expired-order reads after runtime STOPPED, and signed
ordinary-user denial remain covered. The ordinary-user403 is the mounted admin
orders route, not a claimed direct Chrome diagnostics request. The stopped
runtime reports configuredPause=false; it is not a live configured-pause test.

The final actual-stack run passed on its first attempt in this increment. Card
screenshots were visually inspected: the retained record says no new diagnostics
were received and identifies its earlier snapshot; the initial missing-route
card contains only the empty/error content. Mobile values wrap without horizontal
overflow.

## Scope limits and preserved earlier evidence

This copy-only increment did **not** rerun the separate actual PostgreSQL79 suite
and DB/Node restart probe, harness boundary13, known-hash recovery31, or forced
lifecycle3. Those are prior results, not new passes. The new actual browser24/12
run did use real PostgreSQL and local EVM throughout; this is separate from the
72 DB-gated skips in the default server command.

No main merge, push, public deployment, live RPC, physical wallet, production
signer, actual securities or live pricing. Node22 and a full accessibility audit
remain unverified. The same-tab recovery memory limit and hashless UNKNOWN
no-resend rule remain unchanged.

Evidence root:
`/private/tmp/arco-giwa-operator-diagnostics-copy-verified-evidence-20260919`.

- `browser/result.json`, `browser.log`: actual run and request/check summaries.
- `browser/diagnostics-not_found-retained-snapshot.png`,
  `browser/diagnostics-disabled-retained-snapshot.png`: fixed visible records.
- `browser/diagnostics-{not_found,disabled}-initial-empty.png`: no prior record.
- `frontend.log`, `server.log`, `checks.json`, `cleanup.json`.
- `independent/review.md`, candidate/old-component logs and the independent matrix.

**Next backend work:** automate the existing local DB/EVM/browser regression in
CI, with explicit pass/fail/skip reporting and reliable cleanup. This increment
closes003E-1; CI changes have not been implemented or scheduled here.
