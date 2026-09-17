# GIWA-STOCKS-WALLET-UI-002 — Stocks order execution panel evidence

Base `5865b97db0513aea2045e3d51fcc6b73b35baf24`. Isolated clone `/private/tmp/arco-giwa-stocks-wallet-ui-20260917`, branch `codex/giwa-stocks-wallet-ui-20260917`. The reference checkout `/private/tmp/arco-giwa-receipt-integration-20260917` was only read (status clean, HEAD unchanged). This is a local candidate for coordinator review, not integration or deployment approval. No push, merge, deployment, wallet signature, transfer or public network use.

## Scope

Added only `src/demo/giwa/stocks-wallet-ui/**`, `docs/tasks/giwa-stocks-wallet-ui-20260917.md` and this file. `git diff --stat 5865b97` lists nothing else. The existing wallet controller/planner/types, submission journal client, stocks-investor, stocks-host, routes, providers, server, contracts, deployments and dependencies are unchanged; stocks-investor presentation primitives, exact decimal formatting and order-state meanings are imported read-only.

Module files: `types.ts`, `availability.ts`, `messages.ts`, `model.ts`, `activation.ts`, `StocksWalletPanel.tsx`, `adapter.ts`, `StocksWalletExecutionPanel.tsx`, `index.ts`, `README.md`; verification only: `fixtures/scripted-wallet.ts`, `verification/index.html`, `verification/main.tsx`; tests: `model`, `panel`, `activation`, `controller-adapter`, `panel.dom`, `static-guards` (`*.test.tsx`).

## Behavior

- Presentational `StocksWalletPanel` (props: `WalletSnapshot`, accepted `Selection`, account, local availability, clock, optional injected server order status, explicit `prepare/approve/submit` actions) and a thin adapter `useStocksWalletPanel` / `StocksWalletExecutionPanel` over the existing controller.
- Summary: Buy/Sell, NVDA test units, exact quantity, exact approval and deposit/escrow amounts with base units (1 base unit renders `0.000001 ARCO_TEST_USDC` / `0.000000001 NVDA`), SELL payout if completed, GIWA Sepolia chain 91342 and reviewed network instance, quote deadline with open/expired state, order ID, spender, token, "Test assets only" notice.
- Every controller status has its screen (IDLE, CHECKING, APPROVAL_REQUIRED, SIGNING, APPROVAL_SUBMITTED, READY_TRANSFER, SUBMITTED, UNKNOWN, BLOCKED) plus an unavailable screen. Deposit/escrow is a separate click; hashes and confirmed approvals are never order completion; the order result step and "Completed" come only from the injected server status.
- Safety: no action from render/effects/timers/polling/state change; synchronous one-action activation gate; wallet-opening buttons arm per exact step (800 ms) and never receive focus; actions re-check availability, the injected server status and the displayed controller scope at activation; order details and even Buy/Sell are hidden from signed-out or other wallets; snapshots not matching the displayed order/account render as not checked.
- Missing controller/ports, execution policy port, durable journal, trusted reconciliation, session or reviewed deployment, an invalid/expired order, or a server status showing the order moved on disables execution with the reason. No production code contains VERIFIED/allowed defaults.
- Accessibility/mobile: one persistent polite status region (survives scope changes, announces check results and server results), labelled headings, `aria-current` steps, native buttons, focus rescue only while the user works in the panel, 44 px targets, stacked layout; 0 px horizontal overflow at 390 px.

## Controller observations (unchanged, relevant to integration)

1. Called directly, `approve()` opens the approval wallet request even when `SubmissionGate.reconcile` is missing, and only fails afterwards (an approval that can never be confirmed). The adapter's availability guard prevents this; the controller itself does not.
2. After an approval is server-confirmed, a failing deposit/escrow preflight republishes `APPROVAL_SUBMITTED` with the failure code; the panel shows "Approval sent — check needed" with the code's reason.
3. A reverted transfer found by a check ends as `BLOCKED` with the recorded stage but code `RECOVERY_REQUIRED`; the panel treats BLOCKED + stage as the recorded REVERTED attempt.
4. Session or deployment-review expiry replaces the displayed snapshot with `BLOCKED CONTEXT_EXPIRED` and drops the visible hash; the durable journal keeps it and a check after signing in shows it again.

## Independent review

Two adversarial multi-agent review rounds (safety, requirements, controller integration, accessibility/design, test adequacy; each finding verified by a separate skeptic):

- Round 1 on 4b1ae86: 24 confirmed, 0 rejected (no unintended or duplicate wallet request found; defects were copy/state mapping, moved-on server status, recovery buttons, a11y announcements/focus, and test gaps). Fixed in d3e2b79.
- Round 2 on d3e2b79: 18 confirmed, 0 rejected (one medium copy risk: "Nothing was sent." after a hash existed; the rest remaining test gaps, deadline wording, step-list details, notice/focus edge cases). Fixed in the final commit.
- Mutation run on the final code: 28 targeted regressions (auto-approve/deposit/escrow via effects, mount-time polling and wall-clock thresholds, SELL-only auto-escrow, removed scope key, gate/arming removals, snapshot binding, account/session derivation, moved-on and SELL state rules, copy regressions, focus and status-region changes): 28 killed, 0 survived, 0 hangs.

## Checks (final commit)

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build` | PASS (existing large-chunk warning) |
| `npm run test:frontend` (CI-like, Solidity artifacts) | 442 tests: 440 pass, 2 DOM-gate skips, 0 fail (baseline 393/392/1) |
| `npm run test:frontend` with `GIWA_HOST_DOM_RUNTIME` | 467/467 pass, 0 skip |
| Module suite with DOM gate, 3 consecutive runs | 65/65 each |
| Module suite without DOM gate | 48 pass, 1 skip, 0 fail |
| `npm run test:security` | PASS |
| Design tokens `--all` | 7 findings, identical to baseline (Investor.tsx:111, components.tsx ×6); none in the new module; exit 1 as before |
| Story structure `--all` | no hard violations (existing soft warnings) |
| `git diff --check 5865b97` | PASS |

Reproduce:

```sh
npm run typecheck && npm run build && npm run test:security
GIWA_STOCKS_ARTIFACTS=/private/tmp/arco-giwa-receipt-integration-20260917/packages/contracts/artifacts/stocks npm run test:frontend
GIWA_HOST_DOM_RUNTIME=/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json \
  node --import tsx --test src/demo/giwa/stocks-wallet-ui/*.test.tsx
node .claude/hooks/check-design-tokens.mjs --all
```

Verification page: `npm run dev`, then `http://localhost:5173/src/demo/giwa/stocks-wallet-ui/verification/index.html` (`?view=live`, `?view=gallery&side=BUY|SELL`). Screenshots were taken from a standalone Vite build of that same entry (scratch config, output outside the clone) with headless Chrome at 1440 px and 390 px.

External evidence: `/private/tmp/arco-giwa-stocks-wallet-ui-evidence-20260917/` — `baseline/` and `final/` logs with exit files, `screenshots/` (desktop live flow and full galleries; mobile live flow and per-state gallery captures), `stocks-wallet-panel-verification.html`, `review/` (round findings, mutation results and scripts).

## Not connected (integration dependencies)

Reviewed deployment attestation, current execution policy endpoint, wallet ports through the active injected/Dynamic source (network-instance attestation, allowance, exact transaction request), authenticated order/catalog reads, wiring `createSubmissionGate` with trusted reconciliation into a host, server order status reads for `serverOrder`, controller ownership in the `/stocks` host, and the route/menu mount. The jsdom DOM gate is skipped in CI unless `GIWA_HOST_DOM_RUNTIME` is provided (adding jsdom as a devDependency needs approval).
