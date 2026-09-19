# GIWA-STOCKS-OPERATOR-CONTROL-UI-003F — builder plan (recorded before code)

This is a local builder candidate. Nothing is pushed, merged or deployed. It uses no public RPC, real wallet, signature or transfer, and adds no server API.

Task prompt: `docs/tasks/giwa-stocks-operator-control-ui-003f-20260919.md`. Contracts: `docs/contracts/stocks-trading-control-api.md` and `docs/contracts/stocks-runtime-status-v1.md` (with `server/src/stocks-trading-control/{contracts,plugin}.ts` and `server/src/stocks-runtime-status/{contracts,plugin}.ts`).

| Item | Value |
| --- | --- |
| Base | `/private/tmp/arco-giwa-stocks-operator-control-20260919` @ `338985b3e8ea86b8e40a5a36be8f69b2feb69d42` (tree `f8f8f2a3a548134bdbdffc3d482cb1a69c33311f`), branch `codex/stocks-operator-control-20260919`, clean. Code commit `c75f615` is an ancestor. See `/private/tmp/arco-giwa-operator-control-ui-evidence-20260919/base.txt` |
| Work clone / branch | `/private/tmp/arco-giwa-operator-control-ui-20260919`, `codex/giwa-operator-control-ui-20260919` (push URL disabled) |
| Builder / reviewer | Claude Code (`claude-opus-5`) / Codex (real local API, DB and chain acceptance) |

## Facts that shape the design

1. **Routes.** `GET` and `POST /api/v1/admin/stocks/trading-control` and `GET …/history` exist only with `operatorControls: true`; otherwise they are absent (404 without a code).
   - `GET` needs `stocks:read`; `POST` independently needs `stocks:control`.
   - Every other identity gets `403 OPERATOR_FORBIDDEN`.
   - Errors carry PROFILE, `observedAt`, `data: null` and a fixed code: 400 input, 409 version or idempotency conflict, 503 unavailable.
2. **Response shapes.**
   - State: `{deploymentDigest, paused, version, updatedAt, operatorId, reason}`. Version 0 is always paused with null metadata.
   - Events: `{id, deploymentDigest, version, previousPaused, paused, operatorId, reason, createdAt}`.
   - `POST` returns `{state, change, replayed}`; `state.version` can be greater than `change.version`, for example when an old resume is replayed after a later pause.
   - History comes newest first. `nextBeforeVersion` is non-null only when a full page was returned.
   - Every success carries `executionAuthorization: false` and `inFlightMayContinue: true`.
3. **Runtime status.** `GET /api/v1/admin/stocks/runtime` is a process-local diagnostic with the cached `operatorControl` (≤ 5 s old) and ordered `pauseReasons`. It is never authority and never the DB state.
4. **Existing admin console.** It is read-only and enforces that with tests: no `POST` in `stocks-admin/**` and no command buttons.

## Design

**Placement.** A separate module, `src/demo/giwa/stocks-trading-control/`, mounted on the existing `/admin/stocks` page (`StocksAdminPage`) above the read-only console.
- It uses the same `host.admin` signed session, the same validated API base and the page `fetch` seam.
- The read-only console and its invariant tests stay unchanged.
- It reuses the console's envelope parser, `stocksAdminGet`, error kinds and UI primitives (tokens only).

**Pieces:**
- **`parse.ts`:** mirrors the server's whitelists.
  - Exact key sets, and the version-0 invariants.
  - Event checks, and POST consistency: deployment match, `state.version >= change.version`, `change.version === expectedVersion + 1`, paused/reason equal to the sent command, and full agreement when the versions match.
  - History order, the page bound and `nextBeforeVersion`.
  - Runtime fields, with pause reasons recomputed in order and `newOrdersPaused`.
  - Both flags checked exactly.
- **`client.ts`:**
  - Two GETs through `stocksAdminGet`, with the history query in canonical form.
  - One `POST` that sends exactly `{paused, expectedVersion, idempotencyKey, reason}` as JSON with the Bearer only. There is no role header, operator id or legacy token.
  - A client-side timeout (default 20 s) makes a hung POST an *unknown* outcome, never a failure.
- **`store.ts`:** keyed by `(apiBase, session.id, deploymentKey)`, like the console. A scope change re-keys the feature, so old data is gone from the first commit, late answers are dropped, and a pending command is aborted and never resent. A token-only rotation keeps data and the pending command.
  - **Reads:** state, runtime and the first history page, plus explicit Refresh and Load older.
  - **Starting a command** is allowed only after a successful current state read (phase ready, no error) and while nothing is sending or unresolved. The store freezes `{paused, expectedVersion: state.version, idempotencyKey: new, reason}` and sends it once. Double clicks are ignored while sending.
  - **Outcomes:**
    - 200 accepted or replayed: the response `state` becomes the current value, with the POST's `observedAt`, and `change` is shown as this request's audit event. History and runtime are then re-read (reads only).
    - 409 `CONTROL_VERSION_CONFLICT`: re-read state, history and runtime. Never resend; the operator reviews and starts a new command with a new key.
    - 409 idempotency conflict, 400, 403 or 404: rejected, nothing changed. A POST 403 does not deny reads.
    - 503, another 5xx, network failure, timeout or an unverifiable 200: *unknown*. The UI offers "Retry the same command" (identical body and key), a re-read, or discarding the command (safe because of the version check).
  - **GET errors:** 403 and 401 clear the panel (access denied). A 404 without a code means the feature is not enabled. 503, network and invalid answers keep the earlier value, labelled as earlier.
- **`TradingControlPanel.tsx`, four cards:**
  1. **Manual gate (database):** paused/resumed, version, last change, and the read time.
  2. **New-order admission (this API process, diagnostic):** blocked or no reason reported, reasons in words, the cached operator-control view and its lag note. It is never labelled "trading resumed", and the other remaining reasons are shown after a resume.
  3. **Pause or resume:**
     - The reason is validated like the server: trimmed, 1–500 UTF-16 units, no control characters or line breaks.
     - Review shows the current state (with its read time) and the exact change (`version N → N+1`, the reason) before Confirm.
     - Warnings: a pause does not cancel approved or sent transactions and in-flight work may complete; order lookup and known-hash recovery stay available; a resume clears only the manual gate.
     - Permission is decided by the server; controls are never hidden by a guessed role.
  4. **Change history:** newest first, Load older, an explicit end, and a note that the history is a database record with no automatic deletion.

**Mount change:** `stocks-market/StocksPages.tsx` `StocksAdminPage` adds `<GiwaStocksTradingControlFeature apiBase session={host.admin} fetch={environment.fetch} />`.

**Not changed:** the server, DB, Prisma, contracts, environment, `scripts/**` harnesses, the read-only console (`stocks-admin/**`), wallet paths and known-hash recovery.

## Tests

| Test | Coverage |
| --- | --- |
| `parse.test.tsx` | Every server invariant (state, event, change, history, runtime), flags, exact keys; bad PROFILE |
| `reason.test.tsx` | Reason rules, including the bounds and control characters |
| `store.test.tsx` | No command before the first read; frozen body with exactly 4 keys; double submit; accepted; replayed old event; 409 version (re-read, no resend); 409 idempotency; POST 403/400/404; 503, network, timeout and invalid 200 give unknown, then retry with the same key and body; discard; scope change while sending (abort, no resend, late answer ignored); token rotation retry with the new token; history pages to the end; GET 403/401/404/503 |
| `views.test.tsx` (SSR) | The copy of every state above; no over-claiming ("trading resumed", "cancelled"); earlier data labelled; tokens only |
| Gated DOM suite (React DOM + StrictMode) | The REAL `stocksTradingControlPlugin` and `stocksRuntimeStatusPlugin` with the REAL `stocksSessionResolvers` (control operator, read-only operator, unregistered wallet) via `app.inject`, over an in-memory port that mirrors the service's version and idempotency rules, plus a consistent runtime snapshot. Scenarios: initial paused v0; resume with other reasons remaining; read-only 403; unregistered 403; double click; CAS conflict from a concurrent change; lost response then same-key retry (replayed, one event); old event replay; refresh and account change first-commit hiding; late POST answers after an account change; history to the end; 404, 403 and 503. A request log records every POST body |

**Full checks:** typecheck, build, frontend (DOM + artifacts and CI-like), server, security, design tokens (the 7 known) and stories, `.mjs` DOM regressions, the local harness unit tests and `git diff --check`. A builder-side adversarial review runs as a workflow (contract fidelity, command safety, copy truthfulness, test adequacy).

The real PostgreSQL, EVM, Chrome and operator login acceptance is Codex's. These in-memory results do not replace it.
