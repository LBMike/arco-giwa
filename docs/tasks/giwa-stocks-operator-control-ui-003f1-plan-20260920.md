# GIWA-STOCKS-OPERATOR-CONTROL-UI-003F-1 — builder plan (recorded before code)

This is a local builder candidate. Nothing is pushed, merged or deployed. No public RPC or real wallet is used, and no server, DB, contract, environment or harness change is made.

Task prompt: `docs/tasks/giwa-stocks-operator-control-ui-003f1-20260919.md`. Review: `docs/evidence/giwa-stocks-operator-control-ui-003f-review-20260919.md` and the independent reproductions in `/private/tmp/arco-giwa-operator-control-ui-verified-evidence-20260919/`.

| Item | Value |
| --- | --- |
| Base | `/private/tmp/arco-giwa-operator-control-ui-verified-20260919` @ `a27f38bd251742c3bf666184fb200dae3f241bc3` (tree `a6a22e4697150c4305fae36cc1eb88625e1b0c76`), branch `codex/operator-control-ui-verified-20260919`, clean. It contains `46d1dbd` (Codex's server Unicode fix, not touched here). See `/private/tmp/arco-giwa-operator-control-ui-fix-evidence-20260920/base.txt` |
| Work clone / branch | `/private/tmp/arco-giwa-operator-control-ui-fix-20260920`, `codex/giwa-operator-control-ui-fix-20260920` (push URL disabled) |
| Node | v24.14.0 (default) and v22.23.2 (`/private/tmp/arco-stocks-ci-node22-20260919/node_modules/node/bin/node`, the version Codex used) |

## CONTROL-UI-003F-P2-01 — matching history fields do not identify a command

The public event has no idempotency key. The same version, action and reason can be recorded by another operator, by another tab or key of the same operator, or by any other command.

**Positive evidence of "recorded"** is only a verified POST answer for this command's key: accepted, or replayed. A retry of the identical command is the page's only way to get one.

**Negative evidence the page may state:**
- A version conflict (409) on a retry proves this key was never recorded, because the service checks the key before the version. It says nothing about who recorded the matching entry.
- A different action or reason at version N+1 shows that this command was not recorded, and now cannot be.

**Copy changes.** The unknown notice, the unresolved note (after a discard or an access denial) and the shared-slot text say exactly this. Nothing says "means it was recorded", and nothing claims that a matching entry or a 409 identifies the earlier local command.

## CONTROL-UI-003F-P2-02 — revalidate the history when the control state is established or changes

`HistoryState` gains `deploymentDigest`: the deployment the loaded entries are confirmed for, or null when not confirmed.

**Confirming against the shown control state** (digest D, version V) happens whenever either side arrives:
- Non-empty entries must all be D. An empty, complete list is consistent only with V = 0.
- An entry list whose newest version is below V is stale.
- On a history answer: a mismatch with a known control state makes the page unconfirmed. It is read again once for that control state, and after that it is an error.
- On every control write (GET or POST answer): a history that is loaded but no longer matches (another deployment, or stale) is cleared — entries, pages and cursor — and its first page is read again, once per control write.
  - An in-flight history read from before is superseded, so a late answer from the old deployment can never mix in.
  - This replaces round 3's "history after control" flag and the POST path's own history read.

**Display.** The history card shows entries only when their confirmed digest equals the shown control state's. Otherwise it says the history is being checked or read again, and unconfirmed entries are never used for the unresolved-command check. Older pages must continue the confirmed list.

Existing scope isolation (API base, session, deployment key) is unchanged.

## CONTROL-UI-003F-P3-01 — compare with a fresh clock

`GiwaStocksTradingControlFeature` keeps the 15 s ticker only to re-render. The comparison time passed to the view is sampled from `now()` on every render. A fresh answer is therefore compared with the clock at the moment it is shown: mount T, event T+1500, render T+1600 gives "0s ago". A genuinely future timestamp still shows the existing warning. The read-only console is not touched.

## Tests (red before the fixes, then green)

- **Store:**
  - history-first then control of another deployment, control-first then history, multi-page history then a control change, a late old-deployment page after the revalidation read;
  - a failed revalidation read, then a retry;
  - same-digest paging still continuing;
  - stale history after a newer control version;
  - an empty history with V > 0.
- **SSR:** no "means it was recorded" anywhere; for another operator and for another key of the same operator, the unknown notice, the discarded note and the shared-slot text each stay undetermined; a different action or reason at N+1 may say "not recorded"; unconfirmed history is hidden.
- **DOM (real plugins, gated):**
  - another operator records the same values after A's request failed before reaching the server;
  - the same operator in another tab (another key) records them;
  - a fixed-clock fresh answer shows "0s ago", and a future event still warns.
- Existing assertions that fixed the wrong copy are corrected.

**Full checks:** module, DOM, typecheck, build, frontend (Node 24 and Node 22, DOM + ABI gates on and CI-like), server, security, tokens, stories, `.mjs` DOM, harness units and diff.

**Documented limit (not changed):** leaving `/admin/stocks` and coming back loses the in-memory unresolved key and the same-key retry. A fresh read shows the DB state and history, and CAS still protects any new command.

## Results (recorded at completion)

- **Implemented as planned** in `6b1e22c`, with the tests red first (`red/`, `red-final/`).
- **Four builder review rounds** changed the plan in three places:
  - **A retry's 409.** It proves "not recorded" only for the deployment that answered, and the 409 names none.
    - The copy is conditional.
    - The command always stays unresolved: Close, a new command and an access denial keep it as a note.
    - An intermediate rule ("a later read of the reviewed deployment settles it") leaked in rounds 2 and 3 and was removed.
  - **Failed or rejected first pages** are read again on a control change or an accepted POST.
  - **Older pages** must start at `last.version − 1`.
- **Final:**
  - code `fa105e1`: 27 new tests; mutations 52 applied, 51 killed, 1 equivalent;
  - Node 24 and Node 22: frontend 849/849 with the DOM + ABI gates; CI-like 764 pass + 7 skips; server 408 pass + 83 DB skips.
- **Unchanged limit:** leaving `/admin/stocks` loses the in-memory unresolved key.
- **Details:** `docs/evidence/giwa-stocks-operator-control-ui-003f1-builder-20260920.md`.
