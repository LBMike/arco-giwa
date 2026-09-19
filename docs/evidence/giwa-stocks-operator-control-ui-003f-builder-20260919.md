# GIWA-STOCKS-OPERATOR-CONTROL-UI-003F — builder evidence

This is a local builder candidate for Codex's integration acceptance. It is not a real PostgreSQL, EVM or Chrome result, not acceptance, and not a production rollout.

Nothing was pushed, merged or deployed. No public RPC, database, real wallet, signature, transfer or dependency install was used. The server, DB, Prisma, contracts, environment, harnesses (`scripts/**`), the read-only console (`stocks-admin/**`), wallet paths and known-hash recovery are unchanged.

Task prompt: `docs/tasks/giwa-stocks-operator-control-ui-003f-20260919.md`. Builder plan (recorded before code, commit `e14a86c`): `docs/tasks/giwa-stocks-operator-control-ui-003f-plan-20260919.md`.

## Bases, roles, environment

| Item | Value |
| --- | --- |
| Base | `/private/tmp/arco-giwa-stocks-operator-control-20260919` @ `338985b3e8ea86b8e40a5a36be8f69b2feb69d42` (tree `f8f8f2a3a548134bdbdffc3d482cb1a69c33311f`), branch `codex/stocks-operator-control-20260919`, clean (0 files). Code commit `c75f615` is an ancestor. See `base.txt` |
| Work clone / branch | `/private/tmp/arco-giwa-operator-control-ui-20260919`, `codex/giwa-operator-control-ui-20260919` (push URL disabled) |
| Commits | `e14a86c` plan · `783814d` implementation and tests · `074c4a2` review round 1 fixes · `ab375b4` test · `7d8857f` review round 2 fixes · `fd72c58` review round 3 fixes · the commit that adds this file (its SHA is in the handoff) |
| Commander | user / conductor (003F prompt) |
| Builder | Claude Code, `claude-opus-5` (same builder session as 003E/003E-1) |
| Independent reviewer | Codex (pending): the UI against the real local API, PostgreSQL and chain, for pause, recovery and resume |

Environment (untracked):
- `node_modules` is a symlink to `/private/tmp/arco-giwa-preflight-20260917/node_modules`; the lockfile is byte-identical.
- `packages/contracts/artifacts` is copied.
- jsdom comes from `/private/tmp/arco-rwa-ui-independent-review-20260917`.
- Node v24.14.0.

Evidence directory: `/private/tmp/arco-giwa-operator-control-ui-evidence-20260919/`:
- `base.txt`
- `review/`
- `mutation/`
- `final/`

## Changed files (`338985b..fd72c58`, 13 source/test files + the plan)

| File | Role |
| --- | --- |
| `stocks-trading-control/types.ts` | DTOs, snapshot (control, runtime, history, command, unresolved note, order mark) |
| `stocks-trading-control/parse.ts` | Server-whitelist mirrors: state (version-0 invariants), event, POST change for the sent command, history pages, runtime (pause-reason derivation, CURRENT timing); the reason check |
| `stocks-trading-control/client.ts` | Two GETs through the console's `stocksAdminGet`, the runtime GET, and one POST of exactly the four fields (Bearer only, `redirect: "error"`) |
| `stocks-trading-control/store.ts` | Scope, reads, order marks, the command lifecycle, retry readiness, unresolved notes |
| `stocks-trading-control/TradingControlPanel.tsx` | Four cards: manual gate (DB), new-order admission (runtime diagnostic), pause or resume, change history |
| `stocks-trading-control/GiwaStocksTradingControlFeature.tsx`, `index.ts` | Scope owner (re-keyed per API base, session id and deployment key) |
| `stocks-trading-control/fixtures.ts` | Test-only fixtures (the feature never imports them; a source test enforces it) |
| `stocks-trading-control/{parse,store,views,control.dom}.test.tsx` | Tests (below) |
| `stocks-market/StocksPages.tsx` | `StocksAdminPage` mounts the panel above the read-only console, with the same session, API base and transport |

The read-only console (`stocks-admin/**`) and its invariant tests are unchanged. The panel is a separate module, so the console's "no POST, no command buttons" tests still hold for the console itself.

## What the operator gets (`/admin/stocks`)

1. **Manual gate (database).**
   - Paused or resumed, with the version and the last change (time, operator, reason). Version 0 reads as "No change recorded yet".
   - The server response time and the load time.
   - A failed re-read keeps the earlier state, labelled as from an earlier read. A state read before a command in flight, an unknown command or an unresolved note is flagged.
2. **New-order admission (runtime diagnostic).** One API process's report: "New orders paused" or "No pause reason reported", with every pause reason in words.
   - The cached manual gate is shown with its 5-second lag and flagged when it differs from the database.
   - A resumed manual gate never reads as trading resumed: "The manual gate is resumed; that alone does not resume trading. New orders are still paused by: …". The list includes configured pause, dispatch off, runtime stopped, control-store unavailable and observer not current.
   - An unreadable runtime means "unknown", never "open".
3. **Pause or resume.** Offered only after a successful current read. The reason is validated like the server: trimmed, 1–500 UTF-16 units, no control characters or lone surrogates. The server decides permission, and nothing is hidden by a guessed role.
   - **Review:** it freezes what is shown — the current state and its read time, the exact change (`version N → N+1` only if still N) and the reason. Pause and resume each say what they do not do. If the state is read again during the review, Confirm is withdrawn.
   - **Confirm:** it freezes `{paused, expectedVersion, idempotencyKey, reason}` and sends it once. Double clicks are ignored.
   - **Outcomes:**
     - Recorded or replayed: the POST `state` becomes the current value, unless a newer state of the same deployment, or another deployment, is already shown. The `change` is shown as this request's audit event; an old resume replayed after a later pause shows the old event plus the current paused state.
     - 409 conflict: the state is re-read and never resent.
     - Refused (403, 404, 400 or idempotency conflict on the first attempt): nothing was changed.
     - Unknown (503, 5xx, network, timeout, invalid 200, or any refusal of a retry): never assumed failed or applied.
       - Retry of the identical command and key is offered only after a fresh successful read of the same deployment.
       - A discard keeps an unresolved note.
       - Both say how to check the history: a version N+1 change with this action and reason means it was recorded; any other change at N+1 means it was not.
4. **Change history.** Newest first, Load older to an explicit end. It states that the history is a database record with no automatic deletion.

**Scope.** An API base, session id or deployment key change re-keys the panel. The old data is gone from the first commit, a command in flight is aborted and never resent, and late answers are dropped. A token-only rotation keeps the data, and the next retry uses the new Bearer.

## Tests (72 new; all in `src/demo/giwa/stocks-trading-control/`)

| File | Count | Coverage |
| --- | --- | --- |
| `parse.test.tsx` | 12 | State, event, POST change (each consistency check fires on its own), history, runtime (reason order, CURRENT timing), reason rules (incl. lone surrogates), and the client: exact POST body/headers/`redirect`, error classification, the canonical history query. **Parity with the real server plugins** (Fastify inject): every state/change/history the real `stocksTradingControlPlugin` emits parses to the same values, and the real `stocksRuntimeStatusPlugin` output parses to the same reasons for all 48 gate combinations |
| `store.test.tsx` | 27 | No command before a read; a frozen body with exactly 4 keys; double submit; accepted with a runtime re-read; 409 version (re-read, never resent, new key and version); refusals that prove nothing changed; unknown outcomes (503, 502, network, invalid 200, timeout) with read-then-retry; old replay; scope change while sending (4 kinds); token rotation; read errors (403/401/404/503); history paging, cursor and consistency; discard; the round-1/2 cases (refused retry stays unknown; newer or other-deployment state kept; timeout at once and a late answer ignored; deployment-changed retry; access denial note; order marks; discard keeps a note; not-retryable refusals; version limit; stale review by read time; round 3: an older-started read with a higher version wins, another deployment is read again, the history after an other-deployment answer, the note's deployment) |
| `views.test.tsx` | 18 | SSR copy for every state: initial v0, resume with remaining reasons (incl. the control store), unknown runtime, cached-gate lag, review and warnings, stale or failed reads labelled as earlier, disabled (404) and access states, every outcome (sending, accepted, replayed later state, conflict, 4 refusals, 4 unknown kinds with and without a fresh read), history end and retry, the fixed button set, a source scan (POST only in `client.ts`; no stored credentials, role headers, wallet calls or fixtures), read-failure summary, event ids, stale-review copy by phase; round 3: the recorded-or-not check per deployment and with the feature disabled, the shared version slot, the other-deployment note by phase, the named focus fallback |
| `control.dom.test.tsx` (gated) | 15 (1 + 14 scenarios) | React DOM + StrictMode against the **real** `stocksTradingControlPlugin` and `stocksRuntimeStatusPlugin` behind the **real** `stocksSessionResolvers`: control operators A/B (`stocks:read`+`stocks:control`), a read-only operator, an unregistered wallet; an in-memory port mirroring `StocksTradingControlService`. Scenarios: initial v0 → reviewed resume with remaining reasons; read-only 403 and stranger 403; invalid reasons; frozen review across a refresh; refused retry after a lost answer; double click; CAS conflict; lost answer → read → same-key replay; discard with a note; old resume replay after a later pause; 503-after-commit and timeout; account change, logout and API change while sending (first commit, no resend); history 45 → end; 404 and 503 |

## Request log (real plugins, DOM suite)

The DOM suite records every request the rendered page sends:
- every POST path is `/api/v1/admin/stocks/trading-control`, and its body keys are exactly `paused, expectedVersion, idempotencyKey, reason`;
- every other request is a GET without a body to `trading-control`, `trading-control/history?limit=20[&beforeVersion=N]` or `runtime`;
- `window.ethereum` is read 0 times.

POST counts per scenario:

| Scenario | POSTs | Events recorded |
| --- | --- | --- |
| Resume from v0 | 1 | 1 |
| Double click on Confirm | 1 | 1 |
| Read-only operator | 1 (403) | 0 |
| Unregistered wallet | 0 | 0 |
| CAS conflict, then a new pause | 2 (409, 200) | 2 (1 by the other operator) |
| Lost answer, then retry | 2 (same body) | 1 |
| Old resume replayed after a later pause | 2 (same body) | 2 (1 by the other operator) |
| 503 after the commit, then retry | 2 | 1 |
| Timeout, then retry | 2 | 1 |
| Refused retry (403) | 2 (200 lost, 403) | 1 |
| Discard of an unknown command | 1 | 1 |
| Account change, logout or API change while sending | 1 each, never resent | recorded as the old session |
| History 45 events | 0 | — |

## Builder-side adversarial review (not Codex independent review)

Three workflow rounds were run in this builder session. Each finding went to an adversarial verifier. Records: `review/round{1,2,3}-summary.txt` and `review/round{1,2,3}-workflow-output.json`.

**Round 1 (on `783814d`).** 4 lenses (contract, command safety, copy/a11y, test adequacy), 39 agents, 47 findings. 33 were verified real (P1 3, P2 10, P3 20; overlapping between lenses). Fixed in `074c4a2` and `ab375b4`:
- **P1:**
  - a refused retry after an unknown result was shown as "Not applied / Nothing was changed";
  - a late POST answer overwrote a newer read.
- **P2:**
  - the review was not frozen (a refresh could turn it into the opposite command with the original reason);
  - retry ignored a deployment change;
  - "Newest page read at" was overwritten by older pages;
  - retained values were stated as current.
- **P3:**
  - redirect not refused;
  - lone surrogates;
  - copy that read as permission;
  - focus loss, live-region overuse, event ids;
  - untested checks, and the store tests' 60 s timers.

**Round 2 (on `074c4a2`/`ab375b4`).** 2 lenses, 18 agents, 18 findings, 15 verified real (P2 6, P3 9). Fixed in `7d8857f`:
- **P2:**
  - a late POST answer of another deployment replaced a read of the new one;
  - the retry deployment guard used stale reads;
  - the unresolved note's "version N+1 means recorded" was wrong once another change took N+1;
  - discarding an unknown command removed the caveat;
  - the "read before" caveat was too narrow.
- **P3:**
  - copy per retry refusal and read phase;
  - conflict-on-retry meaning;
  - the disabled summary;
  - review group role;
  - focus fallbacks.

**Round 3 (on `7d8857f`).** 2 lenses, 15 agents, 14 findings.
- **Verified real (9):** P2 2, P3 7.
- **Refuted:** 4 (a stale 403 after an accepted POST; one note replacing another; the retry copy while a read is loading; the idempotency-conflict wording). One finding was info and was not verified.

Fixed in `fd72c58`:
- **P2:**
  - a control read that started before a POST answer was dropped even when it showed a newer version, or another deployment;
  - the recorded-or-not rule was applied to another deployment's history.
- **P3:**
  - the history was read against the old deployment after an other-deployment answer;
  - the note did not say which deployment it belonged to;
  - phase copy for the other-deployment note;
  - the in-flight caveat's "before it";
  - a disabled feature still offered read-then-retry and the history check;
  - a shared version slot between a note and a new command;
  - the focus fallback had no name.

The round-3 fixes were checked by tests and mutations, not by a fourth review round.

**Not changed (info, or outside this UI):**
- the server accepting lone surrogates (a note for Codex);
- one abandoned note replacing an earlier one after a second denial;
- a GET started between a POST's send and its answer being dropped when the answer lands (round 3 made such a read win when it shows a newer version or another deployment);
- a deactivate/activate of the same store dropping an in-flight command and its note. Today this happens only in StrictMode's mount replay, before any command can exist.

## Mutation checks

`mutation/run.py`: one mutation at a time over the module tests (DOM on), with a byte-exact restore asserted after each run.

- **Round 1:** 44 mutations, 43 killed. S14 ("conflict auto-resends") made the suite hang, which counts as killed. S20 survived at first and was killed by a test added in `ab375b4`. S11 survived: `mutation/summary.txt`, `summary-part2.txt`, `rerun.txt`.
- **Round 2 (`round2.txt`):**
  - 13 new mutations: 12 killed; R08 survived.
  - 9 earlier ones re-run: 4 killed (S01, S07, S12, V01); S11 survived again. Four could not be applied: S08, S09 and S10 because the code they patch changed, and V08 whose pattern no longer matched. R02 and R04 now cover what S08 and S09 tested.
- **Round 3 (`round3.txt`):** 7 mutations of the round-3 changes, all 7 killed.
- **Survivors, S11 and R08:** both judged equivalent in reachable flows.
  - S11 (the command sequence check) is backed by the client's abort check and the store's aborted drop.
  - R08 (`start`'s unresolved-read refusal) is unreachable: after a denial the control is reset, and after a discard it is read again.
  - Both stay as defence in depth.

## Visual check (transient harness, not committed)

The real feature was run against an in-browser fake of the routes, built into a scratchpad bundle and served on `127.0.0.1:4329`. The harness files were at the repo root and removed after the build; `git status` stayed clean.
- **Widths:** 375 and 1440 px only (768 px was not checked for this panel). No element went past the viewport at either width.
- **Flows checked:**
  - resume with other reasons left;
  - a double click giving one POST;
  - 503 giving unknown, then "Read state and history" showing the recorded state;
  - long operator ids wrapping;
  - history 20 → 40 → 45 to the end;
  - a disabled feature (404).
- **Accessibility:** the reason's label and description are linked, and Tab moves from the reason to Review. Reason validation (empty, line break, 501 characters) gives `aria-invalid` and the message.
- **Timing:** this check ran on `783814d`. The review-round changes to focus and copy are covered by the SSR and DOM tests, not by a second visual pass.

## Final checks

`final/run.sh` at HEAD `fd72c58`; clean before and after (0 status lines). Logs are in `final/`.

| Check | Exit | Result (pass / fail / skip) |
| --- | --- | --- |
| Focused: the module's 4 test files + the admin console's 6 (DOM runtime on) | 0 | 156 / 0 / 0 (module 72 + console 84) |
| Trading-control DOM suite repeated 5× | 0 | 15 / 0 / 0 each run |
| `npm run typecheck` | 0 | no errors |
| `npm run build` | 0 | built; existing chunk-size warning only |
| `npm run test:frontend` with DOM runtime + ABI artifacts | 0 | **822 / 0 / 0** (base 750; +72 here) |
| `npm run test:frontend` CI-like (gates unset) | 0 | 747 tests: 740 / 0 / **7 skipped** (6 DOM gates including the new suite, 1 artifact gate) |
| `npm run test:server` | 0 | 485 tests: **403 / 0 / 82 DB-gated skips** |
| Server trading-control + runtime-status tests alone | 0 | 115 tests: 105 / 0 / **10 real-PG skips** |
| Local harness boundary tests (`scripts/stocks-local/*.test.mjs`) | 0 | 13 / 0 / 0 |
| CI evidence unit tests (`scripts/stocks-ci/evidence.test.mjs`) | 0 | 16 / 0 / 0 |
| `npm run test:security` | 0 | env exposure and evmVersion checks pass |
| `npm run design:tokens` | 1 | the same 7 known findings (identical list); none in the new module |
| `npm run design:stories` | 0 | no hard violations |
| `.mjs` DOM regressions (admin scope-render, market routes incl. `/admin/stocks`, investor delayed-sell) | 0 | 23 / 0 / 0 |
| `git diff --check 338985b HEAD` | 0 | clean |

**Not run:**
- real PostgreSQL (DB-gated tests skipped);
- EVM;
- Chrome with a real SIWE sign-in;
- Codex's `scripts/stocks-local` operator-control stack;
- `stocks-market/chart.browser.test.mjs` (Playwright).

## Limits and what Codex must connect

- **In-memory results only.** The control port was an in-memory mirror of `StocksTradingControlService`, and the runtime snapshot was derived from it. Real PostgreSQL, EVM, Chrome and SIWE sign-in were not used here.
- **Codex's acceptance:** connect the panel on `/admin/stocks` to the real local API, DB and chain, and verify:
  - pause, recovery and resume, with a control operator (`stocks:read` + `stocks:control`), a read-only operator and an unregistered wallet;
  - initial paused/v0;
  - resume with other reasons remaining (configured pause, observer);
  - a CAS conflict between two operators;
  - a lost answer and a same-key retry after "Read state and history";
  - an old resume replay after a later pause;
  - history paging;
  - 404 with controls off and 503 on a store failure;
  - an account change while sending;
  - Chrome's network log showing only these requests and 0 wallet prompts.
- **Server-side note for Codex (not changed here).** The server's `reason()` accepts lone UTF-16 surrogates, and node-pg stores them as U+FFFD. That makes a committed command answer 503 and every retry answer an idempotency conflict. The client now refuses such reasons; the server should reject them too.
- **Runtime diagnostic.** It stays a per-process ≤5 s cache. The panel says so and never uses it as permission or DB state.
- **Equivalent mutants.** S11 (sequence check on POST answers) and R08 (the unresolved-read check in `start`) are defence in depth: other guards make them unreachable in real flows.
- **Unknown results.** An unresolved note is not concluded automatically; the operator checks the history. A version N+1 change with a matching action and reason could in principle come from another command with the same reason.
- **Node version.** Node 22 was not verified.

The same suite also passed at `7d8857f` before the round-3 fixes (`final-7d8857f/`).
