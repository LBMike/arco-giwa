// VERIFICATION SCREEN ONLY.
//
// "Live" mounts the connected panel over the REAL wallet controller with scripted in-memory fixture
// ports (account/order switches, held/rejected wallet requests, server verification outcomes,
// expiry, missing evidence or ports, server order progress) and shows request counters.
// "All states" renders the presentational panel for every state, BUY and SELL.
// No server, wallet, chain, signature or transfer is used, and nothing here is a production default.

import { StrictMode, useState, useSyncExternalStore, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { sha256, toHex, type Hex } from "viem"

import "../../../../index.css"
import "../../../theme.css"
import { createStocksWalletController } from "../../stocks-wallet/controller"
import { planOrder } from "../../stocks-wallet/planner"
import type { Side, Stage, WalletSnapshot } from "../../stocks-wallet/types"
import { executionAvailability } from "../availability"
import {
  countControllerActions,
  createScriptedWallet,
  FIXTURE_WALLETS,
  type FixtureAccount,
  type FixtureReconcileMode,
  type FixtureWalletMode,
} from "../fixtures/scripted-wallet"
import { IDLE_SNAPSHOT } from "../model"
import { StocksWalletExecutionPanel } from "../StocksWalletExecutionPanel"
import { StocksWalletPanel, type StocksWalletPanelProps } from "../StocksWalletPanel"
import type { StocksServerOrderStatus } from "../types"

const params = new URLSearchParams(window.location.search)
const view = params.get("view") === "gallery" ? "gallery" : "live"
const gallerySide: Side = params.get("side") === "SELL" ? "SELL" : "BUY"

const BUTTON =
  "inline-flex min-h-9 items-center rounded-[var(--radius-control)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-3 text-xs font-medium text-[var(--color-arco-ink)] aria-pressed:border-[var(--color-arco-ink)] aria-pressed:bg-[var(--color-arco-chip)] disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2" role="group" aria-label={label}>
      <p className="text-xs font-medium text-[var(--color-arco-text-soft)]">{label}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  )
}

function Toggle({ pressed, onClick, children, disabled }: { pressed?: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className={BUTTON} aria-pressed={pressed} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}

// ── live controller ─────────────────────────────────────────────────────────────────────────────

const live = createScriptedWallet({ realTime: true, start: Date.now() })
const controller = createStocksWalletController(live.ports)
const counted = countControllerActions(controller)

function LiveView() {
  useSyncExternalStore(live.subscribe, live.getVersion)
  useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const state = live.state()
  const orders = live.ordersFor(state.account)
  const [chosen, setChosen] = useState<Record<FixtureAccount, string>>({ A: live.ordersFor("A")[0]!, B: live.ordersFor("B")[0]! })
  const orderId = orders.includes(chosen[state.account]) ? chosen[state.account] : orders[0]!
  const [serverOrder, setServerOrder] = useState<StocksServerOrderStatus | null>(null)
  const [log, setLog] = useState<string[]>([])
  const note = (line: string) => setLog((current) => [line, ...current].slice(0, 6))
  const walletModes: FixtureWalletMode[] = ["hash", "hold", "reject", "invalid"]
  const reconcileModes: FixtureReconcileMode[] = ["confirm", "pending", "revert"]
  const side = live.selection(orderId).side
  const readCount = Object.entries(live.reads).reduce((sum, [name, count]) => (name === "context" ? sum : sum + count), 0)

  return (
    <div className="grid w-full gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
      <div className="flex min-w-0 flex-col gap-4">
        <dl className="grid w-full grid-cols-2 gap-2 rounded-[var(--radius-card)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-3 text-xs sm:grid-cols-4" data-testid="verification-counters">
          {[
            ["Wallet transaction requests", live.requests.length],
            ["approve() calls", counted.calls.approve],
            ["submit() calls", counted.calls.submit],
            ["prepare() calls", counted.calls.prepare],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <dt className="text-[var(--color-arco-text-soft)]">{label}</dt>
              <dd className="font-mono text-sm text-[var(--color-arco-ink)]">{value}</dd>
            </div>
          ))}
        </dl>
        <StocksWalletExecutionPanel
          controller={counted.api}
          ports={live.ports}
          selection={live.selection(orderId)}
          serverOrder={serverOrder}
          onRefreshServerOrder={() => setServerOrder(live.serverOrder(orderId))}
        />
        <p className="text-xs text-[var(--color-arco-text-soft)]">Fixture async port reads so far: {readCount}. Every one follows an explicit Check, Approve or Deposit/Escrow click.</p>
      </div>

      <aside className="flex w-full flex-col gap-4 rounded-[var(--radius-strategy)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface-muted)] p-4" aria-label="Fixture controls">
        <Group label="Signed-in fixture account">
          {(["A", "B"] as const).map((who) => (
            <Toggle key={who} pressed={state.account === who} onClick={() => live.controls.setAccount(who)}>
              Account {who} · {FIXTURE_WALLETS[who].slice(0, 6)}…
            </Toggle>
          ))}
          <Toggle onClick={() => live.controls.reconnect()}>Reconnect (new epoch)</Toggle>
          <Toggle pressed={!state.signedIn} onClick={() => live.controls.setSignedIn(!state.signedIn)}>
            {state.signedIn ? "Sign out" : "Sign in"}
          </Toggle>
        </Group>
        <Group label="Accepted order">
          {orders.map((id) => (
            <Toggle key={id} pressed={id === orderId} onClick={() => setChosen((current) => ({ ...current, [state.account]: id }))}>
              {live.selection(id).side} · {id.replace("fixture-order-", "")}
            </Toggle>
          ))}
        </Group>
        <Group label="Fixture wallet answer">
          {walletModes.map((mode) => (
            <Toggle key={mode} pressed={state.walletMode === mode} onClick={() => live.controls.setWalletMode(mode)}>
              {mode === "hash" ? "Return hash" : mode === "hold" ? "Hold prompt open" : mode === "reject" ? "Reject" : "Malformed result"}
            </Toggle>
          ))}
          <Toggle disabled={state.held === 0} onClick={() => live.controls.releaseHeld()}>
            Release held ({state.held})
          </Toggle>
          <Toggle disabled={state.held === 0} onClick={() => live.controls.rejectHeld()}>
            Reject held
          </Toggle>
        </Group>
        <Group label="Fixture server verification of the approval">
          {reconcileModes.map((mode) => (
            <Toggle key={mode} pressed={state.reconcileMode === mode} onClick={() => live.controls.setReconcileMode(mode)}>
              {mode === "confirm" ? "Confirm" : mode === "pending" ? "Still pending" : "Reverted"}
            </Toggle>
          ))}
        </Group>
        <Group label="Evidence and configuration">
          <Toggle pressed={!state.reviewed} onClick={() => live.controls.setReviewed(!state.reviewed)}>
            {state.reviewed ? "Remove deployment review" : "Restore deployment review"}
          </Toggle>
          <Toggle pressed={!state.policyAllowed} onClick={() => live.controls.setPolicyAllowed(!state.policyAllowed)}>
            {state.policyAllowed ? "Deny execution policy" : "Allow execution policy"}
          </Toggle>
          <Toggle pressed={!state.networkMatches} onClick={() => live.controls.setNetworkMatches(!state.networkMatches)}>
            {state.networkMatches ? "Wallet on other network" : "Wallet on reviewed network"}
          </Toggle>
          <Toggle pressed={typeof live.ports.readExecutionPolicy !== "function"} onClick={() => live.controls.setPortPresent("readExecutionPolicy", typeof live.ports.readExecutionPolicy !== "function")}>
            {typeof live.ports.readExecutionPolicy === "function" ? "Remove policy port" : "Restore policy port"}
          </Toggle>
          <Toggle pressed={typeof live.ports.submissions.reconcile !== "function"} onClick={() => live.controls.setPortPresent("reconcile", typeof live.ports.submissions.reconcile !== "function")}>
            {typeof live.ports.submissions.reconcile === "function" ? "Remove reconciliation" : "Restore reconciliation"}
          </Toggle>
        </Group>
        <Group label="Fixture clock and server order">
          <Toggle onClick={() => live.controls.advance(60_000)}>Clock +1 min</Toggle>
          <Toggle onClick={() => live.controls.advance(600_000)}>Clock +10 min (expire)</Toggle>
          <Toggle
            onClick={() => {
              live.controls.setServerState(orderId, side === "SELL" ? "SELL_BROKER_PENDING" : "BROKER_PENDING")
              note(`Server state of ${orderId} → broker processing (press Refresh order status)`)
            }}
          >
            Server: processing
          </Toggle>
          <Toggle
            onClick={() => {
              live.controls.setServerState(orderId, "COMPLETED")
              note(`Server state of ${orderId} → COMPLETED (press Refresh order status)`)
            }}
          >
            Server: completed
          </Toggle>
          <Toggle onClick={() => note(live.controls.revertTransfer(orderId) ? "Journal marks the recorded transfer REVERTED (press Check transaction status)" : "No recorded transfer hash for this order yet")}>
            Server: transfer reverted
          </Toggle>
        </Group>
        {log.length > 0 ? (
          <ol className="flex flex-col gap-1 text-xs text-[var(--color-arco-text-soft)]" aria-label="Fixture log">
            {log.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ol>
        ) : null}
      </aside>
    </div>
  )
}

// ── static gallery ──────────────────────────────────────────────────────────────────────────────

type GalleryCase = { id: string; title: string; props: StocksWalletPanelProps }

function galleryCases(side: Side, record: (line: string) => void): GalleryCase[] {
  const fixture = createScriptedWallet()
  const orderId = side === "SELL" ? "fixture-order-a-sell-1" : "fixture-order-a-buy-1"
  const selection = fixture.selection(orderId)
  const context = fixture.context()
  const now = fixture.now() + 60_000
  const plan = planOrder(selection, context, now)
  const availability = executionAvailability({ configured: true, ports: fixture.ports, context, selection, now })
  const approvalHash: Hex = sha256(toHex("gallery-approval"))
  const transferHash: Hex = sha256(toHex("gallery-transfer"))
  const snap = (status: WalletSnapshot["status"], stage: Stage | null = null, txHash: Hex | null = null, error: string | null = null): WalletSnapshot =>
    Object.freeze({ status, orderId: plan.order.id, intentKey: plan.intentKey, stage, txHash, error, plan })
  const actions = { prepare: () => record("prepare() clicked"), approve: () => record("approve() clicked"), submit: () => record("submit() clicked") }
  const base: StocksWalletPanelProps = {
    snapshot: IDLE_SNAPSHOT,
    selection,
    account: context.walletAddress,
    availability,
    now,
    network: { networkInstance: fixture.manifest.networkInstance, deploymentId: fixture.manifest.deploymentId },
    serverOrder: null,
    actions,
    armDelayMs: 0,
  }
  const server = (state: string): StocksServerOrderStatus => ({ orderId, side, state, observedAt: new Date(now).toISOString() })
  const expiredNow = fixture.now() + 601_000
  const small = createScriptedWallet()
  small.controls.setAccount("B")
  const smallSelection = small.selection("fixture-order-b-buy-1")
  const smallPlan = planOrder(smallSelection, small.context(), small.now())
  return [
    { id: "not-configured", title: "Unavailable — wallet execution not configured", props: { ...base, availability: { status: "UNAVAILABLE", code: "NOT_CONFIGURED" }, network: null, actions: null } },
    { id: "not-reviewed", title: "Unavailable — no deployment review evidence", props: { ...base, availability: { status: "UNAVAILABLE", code: "DEPLOYMENT_NOT_REVIEWED" }, network: null } },
    { id: "other-wallet", title: "Another wallet connected — order details hidden", props: { ...base, account: FIXTURE_WALLETS.B } },
    { id: "idle", title: "IDLE — not checked yet", props: base },
    { id: "checking", title: "CHECKING", props: { ...base, snapshot: snap("CHECKING") } },
    { id: "approval-required", title: "APPROVAL_REQUIRED", props: { ...base, snapshot: snap("APPROVAL_REQUIRED") } },
    { id: "signing-approval", title: "SIGNING — approval", props: { ...base, snapshot: snap("SIGNING", "APPROVAL") } },
    { id: "approval-submitted", title: "APPROVAL_SUBMITTED — server confirmation pending", props: { ...base, snapshot: snap("APPROVAL_SUBMITTED", "APPROVAL", approvalHash, "RECEIPT_PENDING") } },
    { id: "ready-transfer", title: `READY_TRANSFER — ${side === "SELL" ? "escrow" : "deposit"} is its own click`, props: { ...base, snapshot: snap("READY_TRANSFER") } },
    { id: "signing-transfer", title: "SIGNING — transfer", props: { ...base, snapshot: snap("SIGNING", "TRANSFER") } },
    { id: "submitted", title: "SUBMITTED — hash, server still awaiting", props: { ...base, snapshot: snap("SUBMITTED", "TRANSFER", transferHash), serverOrder: server(side === "SELL" ? "AWAITING_ESCROW" : "AWAITING_FUNDING") } },
    { id: "submitted-processing", title: "SUBMITTED — server processing", props: { ...base, snapshot: snap("SUBMITTED", "TRANSFER", transferHash), serverOrder: server(side === "SELL" ? "SELL_BROKER_PENDING" : "BROKER_PENDING") } },
    { id: "submitted-completed", title: "SUBMITTED — server reports COMPLETED", props: { ...base, snapshot: snap("SUBMITTED", "TRANSFER", transferHash), serverOrder: server("COMPLETED") } },
    { id: "unknown-approval", title: "UNKNOWN — approval outcome", props: { ...base, snapshot: snap("UNKNOWN", "APPROVAL", null, "WALLET_OUTCOME_UNKNOWN") } },
    { id: "unknown-transfer", title: "UNKNOWN — transfer outcome", props: { ...base, snapshot: snap("UNKNOWN", "TRANSFER", null, "WALLET_OUTCOME_UNKNOWN") } },
    { id: "approval-reverted", title: "BLOCKED — approval REVERTED", props: { ...base, snapshot: snap("BLOCKED", "APPROVAL", approvalHash, "APPROVAL_REVERTED") } },
    { id: "transfer-reverted", title: "BLOCKED — transfer REVERTED", props: { ...base, snapshot: snap("BLOCKED", "TRANSFER", transferHash, "TRANSFER_REVERTED") } },
    {
      id: "blocked-policy",
      title: "BLOCKED — execution not allowed",
      props: { ...base, snapshot: Object.freeze({ ...IDLE_SNAPSHOT, status: "BLOCKED", error: "EXECUTION_NOT_ALLOWED" }) },
    },
    {
      id: "expired",
      title: "Quote deadline passed",
      props: { ...base, now: expiredNow, availability: executionAvailability({ configured: true, ports: fixture.ports, context, selection, now: expiredNow }) },
    },
    { id: "expired-ready", title: "READY_TRANSFER after the deadline — disabled", props: { ...base, now: expiredNow, snapshot: snap("READY_TRANSFER") } },
    {
      id: "smallest",
      title: "Smallest order — 1 base unit is never shown as 0",
      props: {
        ...base,
        selection: smallSelection,
        account: small.context().walletAddress,
        now: small.now(),
        availability: executionAvailability({ configured: true, ports: small.ports, context: small.context(), selection: smallSelection, now: small.now() }),
        snapshot: Object.freeze({ status: "APPROVAL_REQUIRED", orderId: smallPlan.order.id, intentKey: smallPlan.intentKey, stage: null, txHash: null, error: null, plan: smallPlan }),
      },
    },
  ]
}

function GalleryView() {
  const [log, setLog] = useState<string[]>([])
  const [cases] = useState(() => galleryCases(gallerySide, (line) => setLog((current) => [`Gallery only (no controller): ${line}`, ...current].slice(0, 4))))
  return (
    <div className="flex w-full flex-col gap-6">
      <nav className="flex flex-wrap gap-2" aria-label="Gallery side">
        <a className={BUTTON} aria-current={gallerySide === "BUY" ? "page" : undefined} href="?view=gallery&side=BUY">
          BUY states
        </a>
        <a className={BUTTON} aria-current={gallerySide === "SELL" ? "page" : undefined} href="?view=gallery&side=SELL">
          SELL states
        </a>
      </nav>
      {log.length > 0 ? (
        <p role="status" className="text-xs text-[var(--color-arco-text-soft)]">
          {log[0]}
        </p>
      ) : null}
      <div className="grid w-full gap-6 xl:grid-cols-2">
        {cases.map((item) => (
          <section key={item.id} className="flex min-w-0 flex-col gap-2" aria-label={item.title} data-gallery-case={item.id}>
            <p className="font-mono text-xs text-[var(--color-arco-text-soft)]">{item.title}</p>
            <StocksWalletPanel {...item.props} headingLevel={3} />
          </section>
        ))}
      </div>
    </div>
  )
}

function VerificationPage() {
  return (
    <div className="arco-demo min-h-screen w-full bg-[var(--color-arco-page)]">
      <header className="w-full border-b border-[var(--color-arco-ink)] bg-[var(--color-arco-surface-muted)]">
        <div className="mx-auto flex w-full max-w-[var(--container-header)] flex-col gap-2 px-4 py-3 md:px-8">
          <h1 className="text-sm font-medium text-[var(--color-arco-ink)]">GIWA Stocks wallet panel — verification fixture</h1>
          <p className="text-xs text-[var(--color-arco-text-soft)]">
            Real wallet controller over scripted in-memory ports. No server, wallet, chain, signature or transfer. Fixture review evidence and journal are not production defaults.
          </p>
          <nav className="flex flex-wrap gap-2" aria-label="Verification view">
            <a className={BUTTON} aria-current={view === "live" ? "page" : undefined} href="?view=live">
              Live controller
            </a>
            <a className={BUTTON} aria-current={view === "gallery" ? "page" : undefined} href="?view=gallery">
              All states
            </a>
          </nav>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-[var(--container-header)] flex-col gap-6 px-4 py-6 md:px-8">{view === "live" ? <LiveView /> : <GalleryView />}</main>
    </div>
  )
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <VerificationPage />
  </StrictMode>,
)
