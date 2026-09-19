# GIWA-STOCKS-OPERATOR-CONTROL-UI-003F-1 — builder evidence

This is a local builder candidate for Codex's re-verification. It is not a real PostgreSQL, EVM or Chrome result, not acceptance, and not a production rollout.

Nothing was pushed, merged or deployed. No public RPC, database, real wallet, signature or transfer was used. No project dependency was installed or changed. There was one unintended registry fetch outside the project; see "Incident" below. The following are unchanged:
- the server, DB, Prisma, contracts and environment;
- the harnesses (`scripts/**`);
- the read-only console (`stocks-admin/**`).

Codex's server fix for lone UTF-16 surrogates (`46d1dbd`) is included and not touched.

Task: the 003F-1 prompt. It fixes CONTROL-UI-003F-P2-01, CONTROL-UI-003F-P2-02 and CONTROL-UI-003F-P3-01 from `docs/evidence/giwa-stocks-operator-control-ui-003f-review-20260919.md`. Builder plan (recorded before code, commit `425e511`): `docs/tasks/giwa-stocks-operator-control-ui-003f1-plan-20260920.md`.

## Bases, roles, environment

| Item | Value |
| --- | --- |
| Base | `/private/tmp/arco-giwa-operator-control-ui-verified-20260919` @ `a27f38bd251742c3bf666184fb200dae3f241bc3` (tree `a6a22e4697150c4305fae36cc1eb88625e1b0c76`), branch `codex/operator-control-ui-verified-20260919`, clean. It contains `46d1dbd`. See `base.txt` |
| Work clone / branch | `/private/tmp/arco-giwa-operator-control-ui-fix-20260920`, `codex/giwa-operator-control-ui-fix-20260920` (push URL disabled) |
| Commits | `425e511` plan · `6b1e22c` the three fixes and their regressions · `2b50e9a` builder review round 1 · `a617c09` round 2 · `16ab777` round 3 · `fa105e1` round 4 (code HEAD, tree `9e3cde24b30fe93e4f3629ad052f3ed4fc63bec6`) · the commit that adds this file (its SHA is in the handoff) |
| Commander | user / conductor (003F-1 prompt) |
| Builder | Claude Code, `claude-opus-5` (the same builder session as 003F) |
| Independent reviewer | Codex (pending): re-verification with the real local stack |

Environment (untracked):
- `node_modules` is a symlink to `/private/tmp/arco-giwa-preflight-20260917/node_modules`; the lockfile is unchanged.
- `packages/contracts/artifacts` is copied.
- jsdom comes from `/private/tmp/arco-rwa-ui-independent-review-20260917`.
- Two Node versions: v24.14.0 (the default) and v22.23.2 at `/private/tmp/arco-stocks-ci-node22-20260919/node_modules/node/bin/node`, the version Codex used.

Evidence directory: `/private/tmp/arco-giwa-operator-control-ui-fix-evidence-20260920/`:
- `base.txt`
- `red/`, `red-final/`, `red-review/`, `red-review2/`, `red-review3/`, `red-review4/`
- `review-round{1,2,3,4}.txt`
- `mutation/`
- `final/`

## Changed files (`a27f38b..fa105e1`)

| File | Change |
| --- | --- |
| `stocks-trading-control/store.ts` | History revalidation (`historyFit`, `revalidateHistory`, `recheckHistory`, the arrival check, strict older-page continuation). One predicate for an unresolved command (`unresolvedOnClose`), used by Close, a new command and an access denial. Removes round 3's `historyAfterControl` flag and the POST path's own history read |
| `stocks-trading-control/types.ts` | `HistoryState.deploymentDigest` (the deployment the entries are confirmed for); the `unknownSeq` doc |
| `stocks-trading-control/TradingControlPanel.tsx` | The recorded-or-not copy (unknown notice, unresolved note, shared slot, retry conflict, read-first); the History card shows only confirmed entries |
| `stocks-trading-control/GiwaStocksTradingControlFeature.tsx` | The comparison clock is sampled on every render; the 15 s interval only re-renders |
| `stocks-trading-control/review-003f1.test.tsx` (new) | 24 store + SSR regressions (27 new tests with the 3 DOM subtests) |
| `stocks-trading-control/{store,views,control.dom}.test.tsx` | Assertions that fixed the false copy corrected. Two store tests changed by design. 3 new DOM subtests |
| `docs/tasks/giwa-stocks-operator-control-ui-003f1-plan-20260920.md`, this file | Plan and evidence |

Nothing outside `src/demo/giwa/stocks-trading-control/**` and these two documents changed. `final/16-scope.log` is empty.

## The three findings

### CONTROL-UI-003F-P2-01 — a matching history entry never identifies a command

**Cause.** The public event has no idempotency key. The old copy said that a version N+1 entry with the same action and reason "means it was recorded". It said the same in the shared-slot text and in "a 409 means the earlier one". Another operator, another tab or key of the same operator, or any other command can record identical public fields.

**Now:**
- **Unknown notice and unresolved note.** "The change history shows no keys, so it cannot confirm this command: another operator, another tab or another command can record the same version N+1 {action} with the same reason. A matching entry does not identify this command." Then:
  - "If the entry at version N+1 is a different action or has a different reason than “…”, this command was not recorded, and it can no longer be." This is the permitted exclusion.
  - "Only a verified answer for this command's key shows that it was recorded."
  - The note adds: "This page no longer resends it, so that may stay unknown here."
- **Shared slot** (an earlier unresolved note with the same version, action and reason). "the history cannot tell the two apart." Where a retry is possible, the text adds that a retry can confirm only this command (its own event, accepted or replayed). A version conflict (409) names no deployment and leaves it unresolved.
- **A retry answered 409.**
  - The server looks the key up per deployment before the version, and the 409 envelope names no deployment. The copy is therefore conditional: "If this answer came from deployment X, the one this command was reviewed for, it also shows that the earlier attempt with this key was not recorded there".
  - It also says no read can tell which deployment answered.
  - The command stays unresolved. Closing it, starting a new command or an access denial keeps it as an unresolved note.
  - A first attempt's 409 changed nothing anywhere and leaves no note.
- **Positive evidence** remains only a verified POST answer for this command's key (accepted, or replayed). No operatorId comparison, no new API, and no key in the history.

**Reproduced both ways Codex named, against the real routes (gated DOM):**
- **Another operator.** B records the same resume and reason after A's request never reached the server. A retry is then answered 409 and B's key is the only event.
- **The same operator in another tab.** Another key records the same values. Discard leaves the note with the undetermined copy.

### CONTROL-UI-003F-P2-02 — the history is revalidated whenever the control state is established or changes

`HistoryState.deploymentDigest` records the deployment the entries are confirmed for. Whenever either the control state (GET or POST answer) or a history page arrives, the history is checked against the shown control state (digest D, version V):
- Every entry must be D's, and the list at least as new as V. An empty complete list fits only V = 0.
- **Another deployment's entries** are cleared together with their pages, cursor and read time, and the first page is read again. That read supersedes an older-page read, so a late answer of the old deployment never lands. A first-page read already in flight is checked when it arrives instead.
- **A same-deployment list older than V** is read again. So is a first page that failed or was rejected.
- **A first page that does not fit** is read again once for that control state, then reported as "did not match the contract".
- **An older page must continue the list.** Versions have no gaps, so it starts at `last.version − 1`; an empty one is allowed only after version 1. Anything else is rejected, so another deployment's empty page cannot end the list.
- **The view** shows entries (and "Newest page read at", "End of history", "No changes recorded") only when their confirmed digest equals the shown control state's. Otherwise: "The history is shown once the current state confirms which deployment it belongs to."
- **Unchanged:** scope isolation by API base, session id and deployment key.

Covered orders:
- history first, then control of B;
- control of B first, then an A page (read once, then an error);
- a multi-page A history, then B (the late A page is aborted and ignored);
- a delayed first page from before the change;
- a failed revalidation read, then a retry and same-deployment paging;
- a stale list (V higher) and an empty list with V > 0;
- an accepted POST (one history read);
- an accepted POST after a failed first page;
- a rejected page, then B's control;
- an empty list read before B, whose re-read fails;
- an empty or non-adjacent older page.

### CONTROL-UI-003F-P3-01 — a fresh comparison clock

The feature passes `now()` sampled on every render. The 15 s interval only triggers re-renders.

Codex's case: mount at T, event at T+1500 ms, render at T+1600 ms. The DOM test with a fixed injectable clock:
- shows "0s ago" (it was "in the future (clock skew)");
- then advances the clock by 90 s and fires the captured interval, which shows "1m 30s ago";
- then records an event 61 s ahead of the client, which still shows the future warning.

The timestamps are unchanged and the read-only console's `Time` / `formatElapsed` are untouched.

## Red before green

| Run | Result |
| --- | --- |
| `red/`: base code (`425e511`) + only the new tests | review-003f1 11 tests: 1 pass / 10 fail. The pass is the guard that an accepted POST still reads the history once. DOM 18: 14 / 4 (the 3 new subtests + the parent) |
| `red-final/`: the `6b1e22c` tests on the base production files | 77 tests: 54 / 23. Every new test fails except the guard, and so do the corrected old assertions |
| `red-review{,2,3,4}/`: each review round's tests on the previous commit's production files | 10 / 4 / 6 / 4 failing. The only passes are coverage-only additions, where the code was already correct |

## Builder-side adversarial review (not Codex independent review)

Four rounds of workflows. In each, finders write probes against the real store and view, and skeptic verifiers try to refute every finding. Full texts are in `review-round{1..4}.txt`.

| Round (commit) | Confirmed and fixed | Rejected |
| --- | --- | --- |
| 1 (`6b1e22c`) | **COPY-003F1-01 (P3):** a retry's 409 was presented as proof although it names no deployment. **STORE-P2-02-A/B (P3):** after a failed or rejected first page, a control change or an accepted POST did not re-read the history | 4. Three were coverage suggestions, all adopted as tests. One was a conservative note, not false |
| 2 (`2b50e9a`) | **R2-01 (P2):** a new command dropped an unresolved retry-409 command without a note. **R2-02 (P3):** an access denial did the same. **F3 (P3):** an A→B→A read settled it | R2-03: the single note slot is the existing design |
| 3 (`a617c09`) | **LC-01, LC-02 and a variant (P3):** the settle-by-read rule leaked through a read during the in-flight retry and through runtime or history legs of another deployment. Fixed by removing the rule: a retry's 409 always stays unresolved. **P2-02-EMPTY-OLDER-PAGE (P3):** an empty older page ended the list | The first-attempt coverage suggestion (adopted as a test) |
| 4 (`16ab777`) | **R4-COPY-01 (P3):** the shared-slot sentence still said a 409 "settles" a command | R4-COPY-02: wording only, but applied |

The last round found only one copy leftover, and the reviews ran dry on behaviour.

## Mutation checks

Runner: `mutation/run.py`. It works on a separate copy (`/private/tmp/arco-giwa-003f1-mutation-20260920`), never the work clone. Each run applies one mutation, runs the module tests with the DOM gate on, and restores the file byte-exact. A run over 180 s counts as killed (hang).

| Commit | Applied | Killed | Survived |
| --- | --- | --- | --- |
| `6b1e22c` | 36 | 32 | N10 and F02, both now killed by added tests. N15 equivalent. N17: the store duplicated the parser's per-page single-deployment check, now removed |
| `2b50e9a` | 45 | 43 | N15, N26 (equivalent) |
| `a617c09` | 50 | 45 | N33, now killed by a test. N15, N26, N27 and N34 were equivalent; their code is gone in `16ab777` |
| `16ab777` | 52 | 50 | N28, now killed by a test. N15 equivalent |
| **`fa105e1` (final)** | **52** | **51** | **N15 only.** When a first page arrives that does not fit, revalidation has already made the kept entries match the shown deployment |

## Final checks

Two runs, both at code HEAD `fa105e1` (tree `9e3cde2`), clean before and after (0 status lines):
- `final/run.sh`: Node 24;
- `final/run-n22.sh`: Node 22.

`run.sh` also had Node 22 steps. They exited 127 because `PATH` contains a space ("Application Support") and was passed to `env` unquoted. That is a script bug, not a test result. `run-n22.sh` repeats those steps with `PATH` quoted. The npm scripts resolve the intended `node`: `npm exec -c 'node -v'` gives v22.23.2 at the Node 22 path, and v24.14.0 by default.

| Check | Node 24 | Node 22 |
| --- | --- | --- |
| Focused: the module's 5 test files + the admin console's (DOM runtime on) | 183 / 0 / 0 | 183 / 0 / 0 |
| Trading-control DOM suite, repeated | 5× 18 / 0 / 0 | 3× 18 / 0 / 0 |
| `npm run test:frontend`, DOM runtime + ABI artifacts on | **849 / 0 / 0** (Codex's 003F run: 822; +27 here) | **849 / 0 / 0** |
| `npm run test:frontend` CI-like (gates unset) | 771 tests: 764 / 0 / **7 gate skips** | 771 tests: 764 / 0 / 7 |
| `npm run test:server` | 491 tests: 408 / 0 / **83 DB-gated skips** | 491 tests: 408 / 0 / 83 |
| Server trading-control + runtime-status tests alone | 121 tests: 110 / 0 / 11 real-PG skips | 121 tests: 110 / 0 / 11 |
| `npm run typecheck` | exit 0 | — |
| `npm run build` | exit 0 (existing chunk-size warning only) | — |
| `npm run test:security` | exit 0 | — |
| `npm run design:tokens` | exit 1: the same 7 known findings, byte-identical to 003F's list; none in this module | — |
| `npm run design:stories` | exit 0, no hard violations | — |
| `.mjs` DOM regressions (admin scope-render, market routes incl. `/admin/stocks`, investor delayed-sell) | 23 / 0 / 0 | — |
| Local harness boundary tests (`scripts/stocks-local/*.test.mjs`) | 13 / 0 / 0 | — |
| CI evidence unit tests (`scripts/stocks-ci/evidence.test.mjs`) | 16 / 0 / 0 | — |
| `git diff --check a27f38b HEAD` | clean | — |
| Scope (`git diff --name-only a27f38b HEAD` outside the module and the two docs) | empty | — |

**Not run:**
- real PostgreSQL (the DB-gated tests are skipped);
- EVM;
- Chrome with a real SIWE sign-in;
- Codex's `scripts/stocks-local` operator-control stack;
- the Playwright chart test.

## Incident: one unintended registry fetch (outside the project)

To confirm which `node` the npm scripts use, I ran `npm exec -- node -v` in the work clone. npm resolves `node` there as a *package name*. It fetched the public npm package `node@26.9.0` into the user's npx cache, `~/.npm/_npx/1838e33cf768caf6/` (2026-09-20 01:03 KST), and ran `node -v` from it.

Effects:
- No project file, lockfile, dependency or `node_modules` changed (0 status lines).
- No test used that binary.
- The right check was `npm exec -c 'node -v'`, which resolves `node` from `PATH` (above).
- The cache directory was not deleted; removing it is the owner's decision.

## Limits and what Codex must re-verify

**Documented limit, not changed.** Leaving `/admin/stocks` and coming back loses the in-memory unresolved key, the unresolved note and the same-key retry. A fresh read shows the DB state and history. The version check (CAS) still protects any new command, which needs the current version. No persistence, session-lifetime change or API was added.

**Other limits:**
- **One note slot.** There is one unresolved-note slot, and a newer unresolved command replaces an older note (pre-existing design).
- **A retry's 409 always leaves a note,** even when it did come from the reviewed deployment, because the page cannot tell. The copy says this.
- **History hidden until confirmed.** When the control state cannot be read at all, the history stays hidden ("shown once the current state confirms…").
- **Read-again budget.** A mismatching first page is read again once per control state and then reported. A manual Refresh reads again.
- **Not real integration.** These are in-memory or jsdom runs: real Fastify plugins and the real session resolver over an in-memory control port. They are not PostgreSQL, EVM or Chrome acceptance.

**For Codex (real local stack):**
- **P2-01, two scenarios:**
  - (a) Operator A's POST fails before the server (for example, stop the API briefly) while operator B records the same resume and reason.
  - (b) The same operator in a second tab.
  - In both, check the unknown notice and the discarded note. Then a retry: its 409 copy, and the note kept on Close or on a new command.
- **P2-02:** switch the deployment served behind the same API base (history first, then control, and the other way round, with Load older in between). A's entries must never appear under B, and B's first page must be read.
- **P3-01:** a fresh change on a synchronized clock reads "0s ago", and a server clock ahead of the client still warns.
- **Browser screenshots** of the new copy. No visual pass was done here.
