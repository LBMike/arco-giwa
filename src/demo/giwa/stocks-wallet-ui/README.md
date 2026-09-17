# GIWA Stocks wallet execution panel

An **unmounted** UI module for an accepted GIWA Stocks order: check → exact approval → separate deposit (BUY) or escrow (SELL) → order result from the server. It presents the existing wallet controller (`../stocks-wallet`) and adds no transport, wallet, journal, verification or default of its own. The `/stocks` route (`../stocks-market`) and the Stocks session host (`../stocks-host`) already exist; this panel is not mounted in them yet. Mounting it in the accepted-order flow together with a real wallet adapter is the next step (003B).

No real wallet, signature, transfer, public network or server was used to build or verify it.

## Exports (`./index.ts`)

| Export | Kind | Use |
| --- | --- | --- |
| `StocksWalletExecutionPanel` | component | Connected panel: `useStocksWalletPanel` + `StocksWalletPanel`, keyed by scope. The normal integration entry. |
| `StocksWalletPanel` | component | Presentational panel. Takes a `WalletSnapshot`, the accepted `Selection`, account, availability, clock, optional server order status and explicit actions as props. |
| `StatusRegion`, `useStatusAnnouncement` | component, hook | Persistent polite status region text (with "Check finished." after an explicit check). |
| `createActivationGate`, `startActivation`, `armKeyFor` | functions | React-free activation rules: one action at a time, enabled buttons only, wallet-opening steps only once armed for the exact step. |
| `useStocksWalletPanel` | hook | Thin adapter: reads the host context/clock, selects the order on the controller, subscribes to its snapshot, computes local availability and binds guarded actions. |
| `stocksWalletPanelActions` | function | Maps `prepare/approve/submit` onto the controller behind availability, server-status and displayed-scope checks. |
| `executionAvailability` | function | Synchronous, I/O-free precondition check (ports, session, reviewed deployment, order scope/state/key/price/deadline). |
| `derivePanelModel`, `bindSnapshot`, `IDLE_SNAPSHOT`, `serverOrderAwaitsTransfer` | functions | Pure view model, scope binding and the moved-on server status rule (for tests or alternative layouts). |
| `describeCode` | function | Reason and next step for every controller/planner code. |
| Types | | `StocksServerOrderStatus`, `StocksWalletAvailability`, `StocksWalletController`, `StocksWalletControllerApi`, `StocksWalletNetwork`, `StocksWalletPanelActions`, `StocksWalletPanelProps`, `StocksWalletExecutionPanelProps`, `UseStocksWalletPanelOptions`, `StocksWalletPanelBinding`, `PanelModel`, … |

### `StocksWalletExecutionPanel` props

| Prop | Required | Meaning |
| --- | --- | --- |
| `controller` | yes (nullable) | `createStocksWalletController(ports)`, created and **disposed** by the host. `null` renders "Wallet execution unavailable". |
| `ports` | yes (nullable) | The **same** `WalletPorts` object the controller was created with. The panel only calls its synchronous `context()` and `now()`. |
| `selection` | yes (nullable) | `{ side, order }` with the **accepted** create-order row (GET sell-order rows need `side` supplied). Do not replace it with refreshed rows: that changes the controller scope and resets the screen. |
| `serverOrder` | no | `{ orderId, side, state, observedAt }` from a separate authenticated server read (for example the investor client's `getOrder`). The only source of the order result. Ignored unless `orderId`/`side` match. A matching state other than `AWAITING_FUNDING`/`AWAITING_ESCROW` disables (and makes the adapter refuse) approve and deposit/escrow. |
| `onRefreshServerOrder` | no | Host re-read of `serverOrder`, shown as "Refresh order status". Not a wallet action. |
| `serverOrderRefreshing` | no | Busy state for that button. |
| `headingLevel` | no | `2` (default) or `3`. State and result headings follow one level below. |
| `armDelayMs` | no | How long a wallet-opening step is shown before its button accepts activation. Default 800 ms. |
| `tickMs` | no | Re-render interval for the deadline countdown. Default 1000 ms; 0 disables. |

The component root is `w-full`; the page owns width.

## Host integration (003B, `/stocks` accepted-order flow)

```tsx
import { createStocksWalletController } from "../stocks-wallet"
import { StocksWalletExecutionPanel } from "../stocks-wallet-ui"

// Owner component: one controller per reviewed ports object, disposed on unmount (StrictMode-safe
// ownership as in stocks-host: create in a layout effect, dispose in its cleanup).
<StocksWalletExecutionPanel
  controller={controller}
  ports={ports}
  selection={{ side: acceptedOrder.side, order: acceptedOrderRow }}
  serverOrder={serverOrder && { orderId: serverOrder.id, side: serverOrder.side, state: serverOrder.state, observedAt }}
  onRefreshServerOrder={refreshOrder}
/>
```

Host contract:

1. **`selection` stays pinned to the accepted original order row** (the create-order or recovery response). Later server progress for the same order goes to `serverOrder` only. Replacing `selection` with a refreshed row changes the controller scope, resets the screen and fails the controller's order-equality check.
2. **`controller` and `ports` are the same pair**: `controller = createStocksWalletController(ports)`, and the panel receives exactly that `ports` object. Ports for the read adapter come from `../stocks-wallet-http`, the durable journal from `createSubmissionGate` (`../stocks-wallet-submissions`), wallet ports from the active wallet source (003B). The gate binds session, side, order, deployment digest and API base, so a new session or order scope needs a new gate, ports object and controller.
3. **The owner disposes** the controller when it unmounts or replaces the pair. Cancelling or disposing cannot close an already-open wallet prompt; its late result is recorded through the original gate and never painted into a new scope.
4. **`ports.context()`** is synchronous. It is built from the current `stocks-host` session, the active wallet address and chain, a **connection epoch**, the API base and the current deployment evidence. The epoch must change on account A→B→A and on wallet-source replacement **even for the same address**.
5. **Deployment evidence** is read explicitly by the host (`readDeployment`), not by the panel. Supply `reads.currentDeployment(lease)` in `context()`.
   - Lease length: the lease ends at the server's `validUntil`, at most 15 s after `verifiedAt`. The server caches evidence, so a read can return evidence with only a few seconds left.
   - Display vs. authority (003A-1): the controller shows an attempt for the same session, wallet address, chain, wallet source epoch, API base, accepted order and **manifest digest**. The evidence lease (ID, dates, expiry) is execution authority only. The last manifest digest is kept while evidence is momentarily absent; a different manifest digest is another scope.
   - When the lease ends (`context().deployment` becomes null) or a read returns new evidence:
     - A SIGNING screen with the wallet prompt still open, a hash, an UNKNOWN warning or a reverted attempt **stay on screen**.
     - A late hash is recorded through the original gate and shown. An approval then stops with `EXECUTION_AUTHORITY_CHANGED` (no automatic verification or READY_TRANSFER); a transfer shows SUBMITTED, as nothing follows it anyway.
     - Work that has not reached the wallet (a check, a claim before SIGNING) stops. A claim it already reserved, including one whose request was still in flight, is shown as UNKNOWN and stays recovery-only.
     - An approval answered after its execution policy ended also stops at the hash (`EXECUTION_POLICY_EXPIRED`) until an explicit check.
     - Unrecorded ready screens (APPROVAL_REQUIRED, READY_TRANSFER, CHECKING, error-only BLOCKED) return to "Not checked yet", so a kept screen is never permission.
     - New actions always plan from a fresh `context()` and need current evidence.
   - Refresh within the lease: refreshing while the server still caches the same evidence changes nothing. It neither cancels work nor extends the window.
6. Re-render the panel whenever that context or the selected order changes. During render the adapter calls `controller.select(selection)` before `getSnapshot()`, so a changed account, epoch, session, API, chain, manifest digest or order resets the snapshot in the same render. The panel is also keyed by account/epoch/session/API/side/order.
7. Read and pass `serverOrder` yourself. Polling is allowed for the server order status; it never triggers a wallet action.
8. Wire both `ports.invalidateSession` and the read adapter's `onSessionRejected` to `host.invalidate(capturedSessionId)`. They only ever name the session captured for the failing request, so a late 401 cannot sign out a newer account. A 401 on the public catalog invalidates nothing.
9. Clocks: pass `createExecutionClock()` from `../stocks-wallet-http` as `ports.now`, the read adapter's `now` and the submission gate's `now`, and leave `ports.monotonicNow` at its default `performance.now()` (or inject one monotonic source everywhere in tests). The controller itself bounds each execution policy by monotonic time from before the policy request was sent. The clock helper additionally keeps wall readings from running behind observed time.

## Screens

| Controller status | Title | Action offered |
| --- | --- | --- |
| (availability not READY) | Wallet execution unavailable / Quote deadline passed | "Check order", disabled, with reason and next step |
| `IDLE` | Not checked yet | **Check order** (read-only, never opens the wallet) |
| `CHECKING` | Checking execution conditions | none (disabled "Checking…") |
| `APPROVAL_REQUIRED` | Approval required | **Approve _exact amount_** |
| `SIGNING` | Confirm in your wallet | none; all actions disabled |
| `APPROVAL_SUBMITTED` | Approval submitted — confirming for no code or `RECEIPT_PENDING`. No code means the wallet returned the hash and verification is starting; if the controller could not start it, for example after a network switch, an explicit check shows the reason. `RECEIPT_PENDING` means the server said verification is pending. Approval sent — check needed with neutral re-check text for `RECOVERY_REQUIRED`, which the controller also publishes for an already confirmed approval, for example after cancel, and after a check that is still pending; past the deadline or for a moved-on order the text promises no deposit/escrow. Otherwise Approval sent — check needed with the code's reason | **Check approval status** (explicit reconciliation check), hash shown |
| `READY_TRANSFER` | Ready to deposit / Ready to escrow (or Quote deadline passed — do not deposit / Order moved on — do not deposit / Deposit unavailable) | **Deposit _amount_** (BUY) / **Escrow _amount_** (SELL), its own click |
| `SUBMITTED` | Deposit/Escrow submitted — waiting for the order result, or — server status: _label_. After a check (`RECOVERY_REQUIRED`) the sentence follows the matching server status: a final result (`COMPLETED`, BUY `REFUNDED`, SELL `RETURNED`), a status that is not final yet, or none shown | **Check transaction status** (read-only), hash shown |
| `UNKNOWN` | Wallet result unknown — check required. For a transfer with a matching final server result: Wallet result unknown — the server reports a final order result, and "needs a server check" is replaced by the final-result sentence | **Check again** (read-only); never a resend |
| `APPROVAL_SUBMITTED` or `UNKNOWN` with `EXECUTION_AUTHORITY_CHANGED` | The status's own title plus the code's reason (the review evidence expired or was renewed during the step, so no further step ran automatically). APPROVAL_SUBMITTED shows the approval hash and says it is kept; UNKNOWN (a reserved claim stopped before the wallet was opened) has no hash and keeps its "do not repeat" copy. A transfer answered under a changed authority shows plain SUBMITTED, because nothing follows a transfer anyway | read-only check only |
| `APPROVAL_SUBMITTED` with `EXECUTION_POLICY_EXPIRED` | Approval sent — check needed: the approval was answered after its execution policy ended, so verification and the transfer step wait for an explicit check with fresh reads | read-only check only; hash shown |
| `BLOCKED` | Execution blocked / Approval reverted / Deposit (Escrow) reverted | reason + next step; read-only "Check again" for transient, network-instance and recovery codes; none for expiry, sign-in, wallet, configuration or reverted attempts |

The summary shows side, NVDA test units, exact order quantity, exact approval and deposit/escrow amounts (with base units and decimals; the smallest unit renders as `0.000001 ARCO_TEST_USDC` or `0.000000001 NVDA`, never 0), SELL payout if completed, network (GIWA Sepolia testnet · chain 91342, reviewed network instance), quote deadline with open/expired state, order ID, spender and token. A "Test assets only" notice is always shown. Three steps (approve → deposit/escrow → order result from the server) show progress; "Completed" appears only when the injected server status says so.

Order details are shown only when the signed-in account is the ordering wallet. A snapshot whose plan, order, side or wallet does not match the displayed order and account is rendered as "Not checked yet" without its hash, stage or amounts.

Financial numbers here are deliberately exact rather than the app's 2-decimal display rule: an approval or deposit amount rounded for display would be a different amount.

## Safety rules implemented

- Actions run only from activation of their own enabled button. Nothing calls `prepare`, `approve` or `submit` on render, mount, StrictMode replay, effects, timers, the countdown, polling or a state change.
- One action at a time: a synchronous activation gate blocks a second activation before React re-renders; the controller also shares same-scope promises.
- Wallet-opening buttons (approve, deposit/escrow) accept activation only after their step has been shown for `armDelayMs`, render as new elements per step, and never receive focus automatically. A repeated click or key press cannot carry from approval into the deposit.
- Every action re-checks `executionAvailability` at activation; approve/submit also require that the injected server status does not show the order moved on, and that the controller snapshot is still the displayed order, side, account and step. Since 003A the controller also refuses a new approval claim or wallet request itself when its captured gate has no trusted reconciliation; the adapter check keeps the button disabled with the reason.
- Disabled actions always say why (deadline, moved-on order, missing configuration/evidence): the step's call to action and its step-list entry are replaced, and after the quote deadline submitted/pending screens say they can no longer be checked from here.
- After an approval or deposit/escrow hash exists, no message claims that nothing was sent; failed checks say the hash is kept and nothing is sent again.
- Missing controller/ports, execution policy port, durable submission gate, trusted reconciliation, session, reviewed deployment, or an invalid/mismatched/expired order disables execution with the reason. No production default supplies VERIFIED evidence, an allowed policy or a journal.
- Transaction hashes and confirmed approvals are never shown as order completion or a holding change. "Not confirmed" wording needs evidence (`RECEIPT_PENDING`); "final result" wording needs a matching final server order status.
- `BLOCKED` with a recorded stage is treated as a server-verified REVERTED attempt of that stage (the controller's follow-up code may be `RECOVERY_REQUIRED`).
- The end or renewal of the deployment evidence lease does not hide a recorded attempt (open prompt, hash, uncertain or reverted request) for the same session, wallet, order and manifest. It stops work that has not reached the wallet and returns unrecorded ready screens to "Not checked yet". Logout, another session, account A→B→A, a new wallet source epoch, another API base, chain, manifest digest or order resets the screen. A late hash is still recorded through the original gate but never painted there.
- Session expiry: `stocks-host` replaces an expired session with `null`, so for the documented host it resets the screen like logout (the journal keeps the attempt; an explicit check after signing in shows it). A host that keeps passing the expired session object keeps the display, but the attempt's captured submission gate refuses to record a late hash for an expired session; that hash is shown with `RECOVERY_REQUIRED` and recorded only by a later check under a valid session. After a new controller (for example a reload), an explicit check shows the journal's record again while the order still waits for the deposit/escrow; once the server has moved the order on, the order result below is what counts.

Accessibility: labelled section, heading hierarchy, one persistent polite status region (outside the scope-keyed panel in `StocksWalletExecutionPanel`) whose text is the state title, every paragraph and the server result, prefixed "Check finished." after an explicit check (dropped for good once the text changes, so it is never repeated without a new check); step list with `aria-current="step"`; native buttons with `aria-busy` and `aria-describedby`; visible focus ring token; a focus stranded by a state change moves to the state heading (without scrolling) only while the user's pointer/focus was last inside the panel; "Refresh order status" stays focusable while busy (`aria-disabled`). Mobile: stacked summary rows, full-width buttons below `sm`, wrapping hashes/addresses, 44 px targets. Colors are `src/demo/theme.css` tokens only.

## Integration status

**Backend: complete.** These endpoints exist on the current backend and are optional runtime registrations; a missing service returns 404, never an allowed answer:
- deployment evidence GET `/api/v1/stocks/execution/deployment`
- execution policy GET `/api/v1/stocks/execution/{BUY|SELL}/{orderId}`
- order reads GET `/api/v1/stocks/orders/:id` and `/sell-orders/:id`
- catalog
- durable wallet submissions with trusted reconciliation (`/api/v1/stocks/wallet-submissions/*`)
- order creation recovery

Contracts: `docs/contracts/stocks-execution-v1.md`, `stocks-wallet-submissions-v1.md`, `stocks-order-recovery-v1.md`.

**Browser adapters: partly done.**
- Done: `../stocks-wallet-http` (003A) implements `readDeployment`, `readExecutionPolicy`, `readOrder` (original envelope with PROFILE) and `readCatalog`.
- Done: `createSubmissionGate` in `../stocks-wallet-submissions` implements the durable journal including `reconcile`.
- Not done: the real wallet ports through the active injected/Dynamic source.
  - `readWallet`, with network-instance and checkpoint attestation through that source; copying manifest fields or checking the numeric chain ID alone is not attestation.
  - `readAllowance`.
  - `requestTransaction`: exact `to/data/value=0`, no fallback or resubmission.

**Panel mounting: not done (003B).**
- Host composition: evidence lease refresh, gate/ports/controller ownership and disposal, epoch source.
- `serverOrder` reads and the refresh policy.
- Placing this panel in the `/stocks` accepted-order flow.

Nothing in this repository has been exercised with a real wallet, signature, transfer or public network.

## Verification page

Standalone, not referenced by `index.html`, `src/main.tsx`, the router or the production build:

```sh
npm run dev
# open http://localhost:5173/src/demo/giwa/stocks-wallet-ui/verification/index.html
#   ?view=live            real controller over scripted fixture ports, with controls and request counters
#   ?view=gallery&side=BUY  every state for BUY (side=SELL for SELL)
```

The live view counts wallet transaction requests and `prepare/approve/submit` calls so it is visible that they only follow clicks. Its controls switch account A/B, reconnect (new epoch), sign out, switch accepted orders, hold/reject/malform the fixture wallet answer, set the fixture server verification outcome (confirm/pending/revert), remove review evidence or ports, deny policy, move the wallet to another network, advance the clock past the deadline and move the fixture server order state. `fixtures/scripted-wallet.ts` is verification/test-only and not exported.

## Tests

```sh
# module suites (the DOM gate uses an existing jsdom install; without the variable it is skipped)
GIWA_HOST_DOM_RUNTIME=/path/to/existing/node_modules/jsdom/package.json \
  node --import tsx --test src/demo/giwa/stocks-wallet-ui/*.test.tsx
```

- `model.test.tsx` — every status, amounts, completion only from server status, scope binding, hidden details, expiry, UNKNOWN/REVERTED, availability codes, code catalog drift against controller/planner source.
- `panel.test.tsx` — static markup of all states, arming on first paint, accessibility structure, tokens.
- `controller-adapter.test.tsx` — real controller + fixture: zero requests/reads on render and host changes, no automatic deposit/escrow, one request per action, duplicates, stale actions, account/order switch with late hash, expiry, UNKNOWN (and reload), REVERTED approval/transfer, missing evidence/policy/reconciliation (panel and direct controller call). The independent review's wording cases (003A A1/A2) are included for BUY and SELL: a cancelled check of a confirmed approval, a still-pending approval, and a recorded deposit/escrow with no, non-final and final server results.
- `activation.test.tsx` — React-free activation gate and arm keys (runs in every environment).
- `panel.dom.test.tsx` — real React DOM + StrictMode clicks: the same behaviors through buttons, minutes of mocked timers with no automatic approval/deposit, per-commit capture for account/order switches during SIGNING and during an in-flight check, persistent status region, focus rescue limits, refresh focus.

`npm run test:frontend` in CI does not set `GIWA_HOST_DOM_RUNTIME`, so the DOM gate reports as skipped there (the same convention as the stocks-host DOM gate; adding jsdom as a devDependency needs approval). The activation, model, adapter and static-guard suites still run.
- `static-guards.test.tsx` — no storage, no fixture import or fake evidence in feature code, actions called only by the adapter and never from effects/timers, verification page outside the app entry.
