# GIWA Stocks wallet execution panel

An **unmounted** UI module for an accepted GIWA Stocks order: check → exact approval → separate deposit (BUY) or escrow (SELL) → order result from the server. It presents the existing wallet controller (`../stocks-wallet`) and adds no transport, wallet, journal, verification or default of its own. It is not connected to `/stocks`, a route, a provider or a menu; that is a later integration step.

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

## Host integration (later `/stocks` step)

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

1. Build `ports.context()` from the current `stocks-host` session, active wallet address/chain/**connection epoch**, API base and an independently reviewed deployment. The epoch must advance on A→B→A and wallet-source replacement.
2. Re-render the panel whenever that context or the selected order changes. During render the adapter calls `controller.select(selection)` before `getSnapshot()`, so a changed account, epoch, session, API, deployment or order resets the snapshot in the same render. The panel is also keyed by account/epoch/session/API/side/order.
3. Read and pass `serverOrder` yourself (polling is allowed for the server order status; it never triggers a wallet action).
4. Dispose the controller when its owner unmounts. Cancelling cannot close an already-open wallet prompt; its late result stays with the original durable claim.

## Screens

| Controller status | Title | Action offered |
| --- | --- | --- |
| (availability not READY) | Wallet execution unavailable / Quote deadline passed | "Check order", disabled, with reason and next step |
| `IDLE` | Not checked yet | **Check order** (read-only, never opens the wallet) |
| `CHECKING` | Checking execution conditions | none (disabled "Checking…") |
| `APPROVAL_REQUIRED` | Approval required | **Approve _exact amount_** |
| `SIGNING` | Confirm in your wallet | none; all actions disabled |
| `APPROVAL_SUBMITTED` | Approval submitted — confirming (no code / `RECEIPT_PENDING` / `RECOVERY_REQUIRED`), otherwise Approval sent — check needed with the code's reason | **Check approval status** (explicit reconciliation check), hash shown |
| `READY_TRANSFER` | Ready to deposit / Ready to escrow (or Quote deadline passed — do not deposit / Order moved on — do not deposit / Deposit unavailable) | **Deposit _amount_** (BUY) / **Escrow _amount_** (SELL), its own click |
| `SUBMITTED` | Deposit/Escrow submitted — waiting for the order result, or — server status: _label_ | **Check transaction status** (read-only), hash shown |
| `UNKNOWN` | Wallet result unknown — check required | **Check again** (read-only); never a resend |
| `BLOCKED` | Execution blocked / Approval reverted / Deposit (Escrow) reverted | reason + next step; read-only "Check again" for transient, network-instance and recovery codes; none for expiry, sign-in, wallet, configuration or reverted attempts |

The summary shows side, NVDA test units, exact order quantity, exact approval and deposit/escrow amounts (with base units and decimals; the smallest unit renders as `0.000001 ARCO_TEST_USDC` or `0.000000001 NVDA`, never 0), SELL payout if completed, network (GIWA Sepolia testnet · chain 91342, reviewed network instance), quote deadline with open/expired state, order ID, spender and token. A "Test assets only" notice is always shown. Three steps (approve → deposit/escrow → order result from the server) show progress; "Completed" appears only when the injected server status says so.

Order details are shown only when the signed-in account is the ordering wallet. A snapshot whose plan, order, side or wallet does not match the displayed order and account is rendered as "Not checked yet" without its hash, stage or amounts.

Financial numbers here are deliberately exact rather than the app's 2-decimal display rule: an approval or deposit amount rounded for display would be a different amount.

## Safety rules implemented

- Actions run only from activation of their own enabled button. Nothing calls `prepare`, `approve` or `submit` on render, mount, StrictMode replay, effects, timers, the countdown, polling or a state change.
- One action at a time: a synchronous activation gate blocks a second activation before React re-renders; the controller also shares same-scope promises.
- Wallet-opening buttons (approve, deposit/escrow) accept activation only after their step has been shown for `armDelayMs`, render as new elements per step, and never receive focus automatically. A repeated click or key press cannot carry from approval into the deposit.
- Every action re-checks `executionAvailability` at activation; approve/submit also require that the injected server status does not show the order moved on, and that the controller snapshot is still the displayed order, side, account and step. This matters because the existing controller does not itself require trusted reconciliation before opening an approval request.
- Disabled actions always say why (deadline, moved-on order, missing configuration/evidence): the step's call to action and its step-list entry are replaced, and after the quote deadline submitted/pending screens say they can no longer be checked from here.
- After an approval or deposit/escrow hash exists, no message claims that nothing was sent; failed checks say the hash is kept and nothing is sent again.
- Missing controller/ports, execution policy port, durable submission gate, trusted reconciliation, session, reviewed deployment, or an invalid/mismatched/expired order disables execution with the reason. No production default supplies VERIFIED evidence, an allowed policy or a journal.
- Transaction hashes and confirmed approvals are never shown as order completion or a holding change.
- `BLOCKED` with a recorded stage is treated as a server-verified REVERTED attempt of that stage (the controller's follow-up code may be `RECOVERY_REQUIRED`).
- Session or deployment-review expiry makes the controller drop the displayed hash (`CONTEXT_EXPIRED`); the durable journal still holds it and "Check order" after signing in shows it again.

Accessibility: labelled section, heading hierarchy, one persistent polite status region (outside the scope-keyed panel in `StocksWalletExecutionPanel`) whose text is the state title, every paragraph and the server result, prefixed "Check finished." after an explicit check (dropped for good once the text changes, so it is never repeated without a new check); step list with `aria-current="step"`; native buttons with `aria-busy` and `aria-describedby`; visible focus ring token; a focus stranded by a state change moves to the state heading (without scrolling) only while the user's pointer/focus was last inside the panel; "Refresh order status" stays focusable while busy (`aria-disabled`). Mobile: stacked summary rows, full-width buttons below `sm`, wrapping hashes/addresses, 44 px targets. Colors are `src/demo/theme.css` tokens only.

## Not connected yet (integration dependencies)

The panel is ready for these, but none exists as a production adapter in this repository today:

1. **Reviewed deployment attestation** for `context().deployment` (manifest v2, evidence ID/digest/lifetime bound to verified runtime code). The catalog is not evidence; do not manufacture it.
2. **Current execution policy** `readExecutionPolicy` — no public server endpoint implements it.
3. **Wallet ports** through the active injected/Dynamic source: `readWallet` (with network-instance/checkpoint attestation), `readAllowance`, `requestTransaction` (exact `to/data/value=0`, no fallback or resubmission).
4. **Authenticated order/catalog reads** `readOrder`/`readCatalog` with the captured session token and response envelope.
5. **Durable submission gate with trusted reconciliation** — `createSubmissionGate` in `../stocks-wallet-submissions` exists and the server endpoints were accepted, but it is not wired into a host.
6. **Server order status** for `serverOrder` (the investor client can read it) and the host's refresh/polling policy.
7. **Controller ownership** in the `/stocks` host (create per reviewed ports, dispose on unmount) and the route/menu mount itself.

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
- `controller-adapter.test.tsx` — real controller + fixture: zero requests/reads on render and host changes, no automatic deposit/escrow, one request per action, duplicates, stale actions, account/order switch with late hash, expiry, UNKNOWN (and reload), REVERTED approval/transfer, missing evidence/policy/reconciliation.
- `activation.test.tsx` — React-free activation gate and arm keys (runs in every environment).
- `panel.dom.test.tsx` — real React DOM + StrictMode clicks: the same behaviors through buttons, minutes of mocked timers with no automatic approval/deposit, per-commit capture for account/order switches during SIGNING and during an in-flight check, persistent status region, focus rescue limits, refresh focus.

`npm run test:frontend` in CI does not set `GIWA_HOST_DOM_RUNTIME`, so the DOM gate reports as skipped there (the same convention as the stocks-host DOM gate; adding jsdom as a devDependency needs approval). The activation, model, adapter and static-guard suites still run.
- `static-guards.test.tsx` — no storage, no fixture import or fake evidence in feature code, actions called only by the adapter and never from effects/timers, verification page outside the app entry.
