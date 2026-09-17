// GIWA Stocks wallet execution panel: order summary, the three execution steps and the one explicit
// action the current wallet state allows. Presentation only (rules in model.ts, wiring in README.md).
//
// Safety in this component:
//   • Actions run only from activation of their own enabled button; nothing runs on render, in an
//     effect, on a timer or on a state change.
//   • One action at a time: a synchronous lock blocks a second click before React re-renders.
//   • A wallet-opening button (approve, deposit/escrow) accepts activation only after its step has
//     been on screen for `armDelayMs`, so a repeated click or key press cannot carry into the next step.
//   • Focus is never moved onto a wallet-opening button; a stranded focus goes to the state heading.

import { useEffect, useId, useLayoutEffect, useRef, useState, type SyntheticEvent } from "react"

import { formatUtc } from "../stocks-investor/display"
import { CATEGORY_TONE } from "../stocks-investor/status"
import { BUTTON_PRIMARY, BUTTON_SECONDARY, Chip, FOCUS_RING, Field, Notice, PANEL } from "../stocks-investor/ui"
import type { Plan } from "../stocks-wallet/types"
import { derivePanelModel, type PanelAction, type PanelAmount, type PanelButton, type PanelInput, type PanelOrder, type PanelServerStatus, type PanelStep, type StepStatus } from "./model"
import type { StocksWalletNetwork, StocksWalletPanelActions } from "./types"

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect

export const DEFAULT_ARM_DELAY_MS = 800

export type StocksWalletPanelProps = PanelInput & {
  /** Explicit user actions. Null renders every action disabled. */
  actions: StocksWalletPanelActions | null
  /** Reviewed deployment identity for the summary; pass only from a locally validated plan. */
  network?: StocksWalletNetwork | null
  /** Host re-read of the server order status. Not a wallet action. */
  onRefreshServerOrder?: (() => void) | null
  serverOrderRefreshing?: boolean
  headingLevel?: 2 | 3
  /** How long a wallet-opening step is shown before its button accepts activation. Default 800 ms. */
  armDelayMs?: number
}

const STEP_BOX: Record<StepStatus, string> = {
  todo: "border-[var(--color-arco-border)] bg-[var(--color-arco-surface)]",
  current: "border-[var(--color-arco-ink)] bg-[var(--color-arco-surface)]",
  done: "border-[var(--color-arco-up)] bg-[var(--color-arco-surface)]",
  problem: "border-[var(--color-arco-down)] bg-[var(--color-arco-surface-muted)]",
}

const STEP_MARK: Record<StepStatus, string> = {
  todo: "bg-[var(--color-arco-chip)] text-[var(--color-arco-text-soft)]",
  current: "bg-[var(--color-arco-ink)] text-[var(--color-arco-on-dark)]",
  done: "border border-[var(--color-arco-up)] bg-[var(--color-arco-surface)] text-[var(--color-arco-ink)]",
  problem: "border border-[var(--color-arco-down)] bg-[var(--color-arco-surface)] text-[var(--color-arco-ink)]",
}

const STEP_STATE: Record<StepStatus, string> = { todo: "not started", current: "in progress", done: "done", problem: "needs attention" }

function ExactAmount({ amount }: { amount: PanelAmount }) {
  return (
    <span className="flex flex-col sm:items-end">
      <span className="font-medium">{amount.text}</span>
      <span className="text-xs text-[var(--color-arco-text-soft)]">
        {amount.baseUnits} {amount.baseUnits === "1" ? "base unit" : "base units"} · {amount.scale} decimals
      </span>
    </span>
  )
}

function OrderSummary({ order, plan, network }: { order: PanelOrder; plan: Plan | null; network: StocksWalletNetwork | null }) {
  const sell = order.side === "SELL"
  return (
    <dl className="w-full" aria-label="Order summary" data-testid="stocks-wallet-summary">
      <Field label="Side">{sell ? "Sell" : "Buy"}</Field>
      <Field label="Stock">NVDA (test units)</Field>
      <Field label="Order quantity">
        <ExactAmount amount={order.quantity} />
      </Field>
      <Field label="Approval amount">
        <ExactAmount amount={order.approval} />
      </Field>
      <Field label={sell ? "Escrow amount" : "Deposit amount"}>
        <ExactAmount amount={order.transfer} />
      </Field>
      {order.payout ? (
        <Field label="Payout if completed (test cash)">
          <ExactAmount amount={order.payout} />
        </Field>
      ) : null}
      <Field label="Network">
        <span className="flex flex-col sm:items-end">
          <span>GIWA Sepolia testnet · chain 91342</span>
          {network ? <span className="font-mono text-xs text-[var(--color-arco-text-soft)] [overflow-wrap:anywhere]">{network.networkInstance}</span> : null}
        </span>
      </Field>
      <Field label="Quote deadline">
        <span className="flex flex-wrap items-center gap-2 sm:justify-end">
          <span>{order.deadline}</span>
          <Chip tone={order.expired ? "attention" : "neutral"}>{order.expired ? "Deadline passed" : `Open · ${order.remaining}`}</Chip>
        </span>
      </Field>
      <Field label="Order ID" mono>
        {order.orderId}
      </Field>
      {plan ? (
        <Field label={sell ? "Spender (redemption escrow)" : "Spender (funding vault)"} mono>
          {plan.spender}
        </Field>
      ) : null}
      {plan ? (
        <Field label={sell ? "Token (NVDA test units)" : "Token (ARCO_TEST_USDC)"} mono>
          {plan.token}
        </Field>
      ) : null}
    </dl>
  )
}

function Steps({ steps }: { steps: readonly PanelStep[] }) {
  return (
    <ol className="grid w-full gap-2 sm:grid-cols-3" aria-label="Execution steps" data-testid="stocks-wallet-steps">
      {steps.map((step, index) => (
        <li
          key={step.label}
          aria-current={step.status === "current" ? "step" : undefined}
          data-step-status={step.status}
          className={`flex min-w-0 items-start gap-3 rounded-[var(--radius-card)] border px-3 py-2 ${STEP_BOX[step.status]}`}
        >
          <span aria-hidden="true" className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-pill)] text-xs font-medium ${STEP_MARK[step.status]}`}>
            {index + 1}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-medium text-[var(--color-arco-ink)]">
              <span className="sr-only">Step {index + 1}: </span>
              {step.label}
            </span>
            <span className="text-xs leading-5 text-[var(--color-arco-text-soft)]">
              {step.detail}
              <span className="sr-only"> ({STEP_STATE[step.status]})</span>
            </span>
          </span>
        </li>
      ))}
    </ol>
  )
}

function TransactionHash({ label, hash }: { label: string; hash: string }) {
  return (
    <div className="flex w-full flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface-muted)] px-4 py-3">
      <span className="text-xs text-[var(--color-arco-text-soft)]">{label} hash</span>
      <span className="font-mono text-sm text-[var(--color-arco-ink)] [overflow-wrap:anywhere]" data-testid="stocks-wallet-tx-hash">
        {hash}
      </span>
    </div>
  )
}

function ServerResult({
  server,
  level,
  onRefresh,
  refreshing,
}: {
  server: PanelServerStatus | null
  level: "h3" | "h4"
  onRefresh: (() => void) | null
  refreshing: boolean
}) {
  const Tag = level
  return (
    <div className="flex w-full flex-col gap-3 border-t border-[var(--color-arco-border)] pt-4" data-testid="stocks-wallet-server-status">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tag className="text-base font-medium text-[var(--color-arco-ink)]">Order result from the server</Tag>
        <Chip tone={server === null ? "neutral" : server.category === "UNRECOGNIZED" ? "attention" : CATEGORY_TONE[server.category]}>{server === null ? "Not reported" : server.label}</Chip>
      </div>
      <p className="text-sm leading-6 text-[var(--color-arco-text-soft)]">
        {server === null ? "No server order status is shown yet. Holdings change only after the server reports this order completed." : server.detail}
      </p>
      {server?.observedAt ? <p className="text-xs text-[var(--color-arco-text-soft)]">Status as of {formatUtc(server.observedAt)}</p> : null}
      {onRefresh ? (
        <div>
          <button type="button" className={`${BUTTON_SECONDARY} w-full sm:w-auto`} onClick={onRefresh} disabled={refreshing} aria-busy={refreshing || undefined}>
            {refreshing ? "Refreshing…" : "Refresh order status"}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function StocksWalletPanel(props: StocksWalletPanelProps) {
  const { actions, network = null, onRefreshServerOrder = null, serverOrderRefreshing = false, headingLevel = 2, armDelayMs = DEFAULT_ARM_DELAY_MS } = props
  const model = derivePanelModel(props)
  const id = useId()
  const titleId = `${id}-title`
  const messageId = `${id}-message`
  const rootRef = useRef<HTMLElement>(null)
  const stateHeadingRef = useRef<HTMLHeadingElement>(null)
  const interacted = useRef(false)
  const mounted = useRef(false)
  const pendingRef = useRef<PanelAction | null>(null)
  const [pending, setPending] = useState<PanelAction | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Arming: the key names the exact step on screen. A different step, a pending action or a new
  // scope produces a different key (or none), so an earlier arming never carries over.
  const walletButton = model.buttons.find((button) => button.opensWallet && button.enabled)
  const armKey = walletButton && pending === null && actions !== null ? `${model.kind}|${walletButton.action}|${model.snapshot.intentKey ?? model.order?.orderId ?? ""}` : null
  const [armed, setArmed] = useState<string | null>(null)
  useEffect(() => {
    if (armKey === null) return
    const timer = setTimeout(() => setArmed(armKey), Math.max(0, armDelayMs))
    return () => {
      clearTimeout(timer)
      setArmed(null)
    }
  }, [armKey, armDelayMs])

  useIsomorphicLayoutEffect(() => {
    if (!interacted.current || typeof document === "undefined") return
    const active = document.activeElement as (Element & { disabled?: boolean }) | null
    const lost = active === null || active === document.body
    const stranded = active !== null && rootRef.current !== null && rootRef.current.contains(active) && active.tagName === "BUTTON" && active.disabled === true
    if (lost || stranded) stateHeadingRef.current?.focus()
  }, [model.kind, model.stage, pending, armed])

  const markInteracted = (_event: SyntheticEvent) => {
    interacted.current = true
  }

  const activate = (button: PanelButton) => {
    if (actions === null || !button.enabled || pendingRef.current !== null) return
    if (button.opensWallet && (armKey === null || armed !== armKey)) return
    pendingRef.current = button.action
    setPending(button.action)
    let result: unknown
    try {
      result = actions[button.action]()
    } catch {
      result = undefined
    }
    void Promise.resolve(result)
      .catch(() => undefined)
      .then(() => {
        pendingRef.current = null
        if (mounted.current) setPending(null)
      })
  }

  const Heading = headingLevel === 2 ? "h2" : "h3"
  const SubHeading = headingLevel === 2 ? "h3" : "h4"
  const title = model.side === "SELL" ? "Sell NVDA: approve and escrow" : model.side === "BUY" ? "Buy NVDA: approve and deposit" : "Stocks wallet steps"

  return (
    <section
      ref={rootRef}
      aria-labelledby={titleId}
      className={`${PANEL} flex flex-col gap-5`}
      data-testid="stocks-wallet-panel"
      data-status={model.kind}
      onPointerDownCapture={markInteracted}
      onKeyDownCapture={markInteracted}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Heading id={titleId} className="text-lg font-medium text-[var(--color-arco-ink)]">
            {title}
          </Heading>
          <p className="text-sm leading-6 text-[var(--color-arco-text-soft)]">Each wallet request is its own click. The order result comes from the server.</p>
        </div>
        <Chip tone="attention">Test assets</Chip>
      </div>

      <Notice tone="info" title="Test assets only">
        <p>ARCO_TEST_USDC is test cash and NVDA units are test units on the GIWA Sepolia testnet. They have no real-world value; prices are fixed mock prices.</p>
      </Notice>

      {model.order ? <OrderSummary order={model.order} plan={model.plan} network={network} /> : null}
      {model.order ? <Steps steps={model.steps} /> : null}

      <div className="flex w-full flex-col gap-3" data-testid="stocks-wallet-state">
        <SubHeading ref={stateHeadingRef} tabIndex={-1} className={`text-base font-medium text-[var(--color-arco-ink)] ${FOCUS_RING}`}>
          {model.title}
        </SubHeading>
        <Notice tone={model.tone}>
          <div id={messageId} className="flex flex-col gap-2">
            {model.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        </Notice>
        {model.txHash && model.txLabel ? <TransactionHash label={model.txLabel} hash={model.txHash} /> : null}
        {model.code ? (
          <p className="text-xs text-[var(--color-arco-text-soft)]">
            Code <span className="font-mono">{model.code}</span>
          </p>
        ) : null}
        {model.buttons.length > 0 ? (
          <div className="flex w-full flex-col gap-3 sm:flex-row sm:flex-wrap">
            {model.buttons.map((button) => {
              const busy = pending === button.action
              const waiting = button.opensWallet && button.enabled && (armKey === null || armed !== armKey)
              const disabled = actions === null || !button.enabled || pending !== null || waiting
              const primary = button.opensWallet || model.kind === "IDLE"
              return (
                <button
                  // A new element per step and action: a press started on one step never lands on the next.
                  key={`${model.kind}:${button.action}`}
                  type="button"
                  className={`${primary ? BUTTON_PRIMARY : BUTTON_SECONDARY} w-full text-center sm:w-auto`}
                  disabled={disabled}
                  aria-busy={busy || undefined}
                  aria-describedby={messageId}
                  data-action={button.action}
                  onClick={() => activate(button)}
                >
                  {busy && button.action === "prepare" ? "Checking…" : button.label}
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      {model.order ? <ServerResult server={model.server} level={SubHeading} onRefresh={onRefreshServerOrder} refreshing={serverOrderRefreshing} /> : null}

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="stocks-wallet-announcement">
        {model.announcement}
      </p>
    </section>
  )
}
