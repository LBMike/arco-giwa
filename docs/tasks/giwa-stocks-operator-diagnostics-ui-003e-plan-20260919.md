# GIWA-STOCKS-OPERATOR-DIAGNOSTICS-UI-003E — builder plan (recorded before code)

This is a local builder candidate: no push, merge, deployment, public network, real wallet, signature or transfer. It adds no server API.

Task prompt: `docs/tasks/giwa-stocks-operator-diagnostics-ui-003e-20260919.md`. Contract: `docs/contracts/stocks-submission-diagnostics-v1.md`, `server/src/stocks-submission-diagnostics/{contracts,public,plugin}.ts`.

| Item | Value |
| --- | --- |
| Base | `/private/tmp/arco-giwa-known-hash-ui-verified-20260919` @ `a01e67071f5e66f3ebee3630b93023c109f32400`, branch `codex/giwa-known-hash-ui-verified-20260919`, clean (0 files); see `/private/tmp/arco-giwa-operator-diagnostics-ui-evidence-20260919/base.txt` |
| Work clone / branch | `/private/tmp/arco-giwa-operator-diagnostics-ui-20260919`, `codex/giwa-operator-diagnostics-ui-20260919` (push URL disabled) |
| Environment (untracked) | `node_modules` symlink (lockfile byte-identical), copied contract artifacts, jsdom from `/private/tmp/arco-rwa-ui-independent-review-20260917`, Node v24.14.0 |
| Builder / reviewer | Claude Code (`claude-opus-5`) / Codex (backend contract, local operator auth, real PostgreSQL/EVM/Chrome) |

## Facts that shape the design

1. **The endpoint.** `GET /api/v1/admin/stocks/wallet-submissions/:side/:orderId` is authorized by the existing signed-session operator resolver with `stocks:read`. The other admin routes use the same permission (`stocks/plugin.ts`).
   - It answers 403 `OPERATOR_FORBIDDEN`, 400 for bad input, 404 `ORDER_NOT_FOUND` (current deployment only), 503 `SUBMISSION_DIAGNOSTICS_UNAVAILABLE`, or 200 with PROFILE + `observedAt` + `data`.
   - `data` is exactly `publicSnapshot`: order `{id, side, state, wallet, version, quoteExpiresAt, quoteExpired}`, `enrollment`, `intentKey`, `approval`/`transfer` (`claimId, intentKey, stage, transactionDigest, status, txHash, createdAt, updatedAt, receipt`) and the fixed flags `readOnly: true`, `executionAuthorization: false`, `resubmissionAllowed: false`.
2. **Side comes from the server.** The admin console selects orders by ID only, and the order detail response carries the server-verified `order.side`. The diagnostics request takes its side from that loaded detail, never from an assumption.
3. **Existing store rules.**
   - A scope `(apiBase, session.id, deploymentKey)` change clears everything.
   - A token-only change keeps data.
   - Only the latest request per resource writes.
   - 401, 403 and a disabled API clear all data before showing that state.
   - The feature is re-keyed per scope.

## Design (only `src/demo/giwa/stocks-admin/**`)

- **`types.ts`:** diagnostics DTO types and a `diagnostics` resource on the snapshot, keyed by `{orderId, side}`.
- **`parse.ts`: `parseSubmissionDiagnostics(data, {side, orderId})`**, which mirrors the server's `publicSnapshot` invariants.
  - **Key sets:** exact on every object, so unexpected fields such as raw proof JSON or calldata make the response invalid instead of being shown.
  - **Flags:** `readOnly: true`, `executionAuthorization: false`, `resubmissionAllowed: false` exactly.
  - **Scope:** requested side and order must equal the response's.
  - **Attempts:**
    - stage and intent must match;
    - status is one of `REQUEST_MAY_START`, `UNKNOWN`, `SUBMITTED`, `CONFIRMED`, `REVERTED`;
    - `REQUEST_MAY_START` has no hash; `SUBMITTED`, `CONFIRMED` and `REVERTED` have one;
    - there is a receipt exactly when the status is terminal, and the receipt status matches;
    - timestamps are ordered;
    - `NOT_ENROLLED` has no attempts, and the two claim IDs differ.
  - **`quoteExpired`:** consistent with `observedAt`.
- **`client.ts`:** `submissionDiagnosticsPath(side, orderId)`, a GET through the existing `stocksAdminGet` (Bearer only, no operator token or role header, PROFILE envelope check).
- **`store.ts`:**
  - **Initial read:** once, when the selected order's detail first loads successfully, with that detail's `order.side`.
  - **Refresh:** `refreshDiagnostics()` only, explicit.
  - **Selection change:** selecting another order clears diagnostics at once.
  - **Write rule:** only the latest diagnostics request for the same order and side, in the same generation, writes.
  - **Detail refresh** leaves diagnostics alone.
  - **Errors:**
    - 401 and 403 use the existing global denial (same permission as every admin route);
    - 404 `ORDER_NOT_FOUND`, 404 without a code (route absent), 503, network and invalid stay local to the diagnostics card;
    - a failed refresh keeps the previous value, labelled with its load time.
  - **Cross-checks with the loaded detail:** the response's `deploymentDigest` and wallet must match; otherwise the response is invalid.
- **UI: a "Wallet submissions (read only)" card** in the order detail.
  - It shows the order state and quote deadline as of the server snapshot, and enrollment.
  - Each stage has a row: approval (both sides), and deposit for BUY or escrow for SELL. A row shows the status, the original hash only when present ("No recorded hash" for UNKNOWN or REQUEST_MAY_START), claim recorded/updated times and, for CONFIRMED or REVERTED, the receipt status, block, block hash and verification record time.
  - The notes say that a verified receipt is not mint, burn or payout completion, and that nothing here can execute, record, reconcile, sign or resend.
  - It shows the server snapshot time (`observedAt`) and one explicit Refresh button.
  - It uses the existing `Card`, `Field`, `Mono`, `Time`, `Pill`, `Notice` and `ResourceMeta` components, which already wrap on mobile.

**Not changed:**
- the server, DB, Solidity, registry and auth policy;
- the quote deadline and the wallet transfer path;
- the known-hash user recovery UI;
- `stocks-market/StocksPages.tsx` (the admin page already passes `apiBase`, `session` and `fetch`; no deployment key is known to the host).

## Tests

| Test | Coverage |
| --- | --- |
| `client-parse` | Every status and receipt combination for BUY and SELL, null stages, `NOT_ENROLLED`; failures for wrong flags, side/order mismatch, extra fields, invariant breaks, wrong PROFILE |
| `store` | Side taken from the detail; exact GET paths and Bearer; no request before the detail; selection change hides old data; late responses and A→B; token rotation; 401/403 global; 404/503/network/invalid local; failed refresh labelled; duplicate refresh |
| New gated DOM test (real admin feature in React DOM + StrictMode) | The diagnostics route is served by the REAL `stocksSubmissionDiagnosticsPlugin` (real `publicSnapshot` and envelope, real 403/404/503 mapping) through `app.inject`, with a fake reader and a token→operator resolver; other admin routes use the existing fixtures. Checks the rendered BUY/SELL, APPROVAL/TRANSFER, null, UNKNOWN, CONFIRMED and REVERTED; operator vs 403; first-render hiding on scope and selection changes; late answers; token rotation; double click; and, from the actual request log, 0 non-GET requests and 0 wallet calls |

Full checks: typecheck, build, frontend (DOM + artifacts, and CI-like), server (the diagnostics plugin and service tests are part of `test:server`), security, design tokens (7 known) and stories, `git diff --check`.

The real PostgreSQL, EVM, Chrome and operator login integration is Codex's; it is not replaced by these in-memory results.
