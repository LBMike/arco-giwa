// The customer presentation's one-click trade result, shown in the Buy or Sell panel itself instead of an order screen:
// what is being paid and received, the one wallet step while the order waits for it (the host's compact slot), then the
// server's progress and the result. The order state only ever comes from the server; nothing here infers completion.

import { useContext, useRef } from "react"
import { Loader2 } from "lucide-react"

import type { StocksInvestorActions } from "./actions"
import type { OrderAttempt, StocksInvestorState } from "./controller"
import { formatCash, formatQuantity } from "./display"
import { OrderExecutionSlotContext } from "./execution-slot"
import { deadlinePassed, orderStatusMeaning } from "./status"
import type { StocksOrder } from "./types"
import { BUTTON_SECONDARY, Field, Heading, Notice, useRescueFocus } from "./ui"

/** Where the one-click trade stands, from the server's order row (and the deadline by the server's clock). */
export type InstantPhase = "WALLET" | "SETTLING" | "DONE" | "EXPIRED" | "STOPPED"

export function instantPhase(order: StocksOrder, observedAt: string | null): InstantPhase {
  if (deadlinePassed(order, observedAt)) return "EXPIRED"
  const meaning = orderStatusMeaning(order, observedAt)
  switch (meaning.category) {
    case "ACTION_REQUIRED":
      return "WALLET"
    case "PROCESSING":
    case "CHECKING_RESULT":
    case "LIQUIDITY_PENDING":
      return "SETTLING"
    case "COMPLETED":
      return "DONE"
    default:
      return "STOPPED"
  }
}

function Busy({ children }: { children: string }) {
  return (
    <p className="flex items-center gap-2 text-sm leading-6 text-[var(--color-arco-ink)]">
      <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
      {children}
    </p>
  )
}

export function InstantTradeView({ attempt, state, actions, cashSymbol }: { attempt: OrderAttempt; state: StocksInvestorState; actions: StocksInvestorActions; cashSymbol: string }) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const renderExecution = useContext(OrderExecutionSlotContext)
  const order = attempt.order
  const sell = attempt.side === "SELL"
  const quantity = `${formatQuantity(attempt.quote.quantity)} NVDA`
  const cash = `${formatCash(attempt.quote.cashAmount)} ${cashSymbol}`
  const phase: InstantPhase | "PLACING" = attempt.status === "ACCEPTED" && order !== null ? instantPhase(order, attempt.orderObservedAt) : "PLACING"
  useRescueFocus(headingRef, `${attempt.body.idempotencyKey}:${phase}`)
  const title =
    phase === "DONE" ? (sell ? `Sold ${quantity}` : `Bought ${quantity}`)
      : phase === "EXPIRED" || phase === "STOPPED" ? (sell ? "Sale not completed" : "Purchase not completed")
        : sell ? `Selling ${quantity}` : `Buying ${quantity}`
  const wallet =
    phase === "WALLET" && order !== null && renderExecution
      ? renderExecution({
          order,
          observedAt: attempt.orderObservedAt,
          refreshing: attempt.refresh === "LOADING",
          onRefresh: actions.refreshAttemptOrder,
          // Only the order this tab's one-click press placed starts its wallet request on its own.
          instant: { autoStart: order.id === state.instantOrderId },
        })
      : null
  const meaning = order !== null ? orderStatusMeaning(order, attempt.orderObservedAt) : null
  return (
    <div className="flex w-full flex-col gap-3" data-testid="stocks-instant-trade" data-phase={phase.toLowerCase()}>
      <Heading level={3} headingRef={headingRef}>
        {title}
      </Heading>
      <dl className="w-full">
        <Field label={sell ? "You sell" : "You pay"}>{sell ? quantity : cash}</Field>
        <Field label="You receive">{sell ? cash : quantity}</Field>
      </dl>
      {phase === "PLACING" ? <Busy>Placing your order…</Busy> : null}
      {phase === "WALLET" ? (wallet ?? <Notice tone="warning">Wallet steps are not available on this page right now. Reload the page and try again.</Notice>) : null}
      {phase === "SETTLING" ? (
        <Busy>{meaning?.category === "LIQUIDITY_PENDING" ? "Waiting for payout liquidity. Your NVDA stays held until it is paid out." : sell ? `GIWA confirmed your NVDA. Paying out ${cash}…` : `GIWA confirmed your payment. Delivering ${quantity}…`}</Busy>
      ) : null}
      {phase === "DONE" ? (
        <Notice tone="success" announce="polite">
          {sell ? `${cash} is in your wallet.` : `${quantity} is in your wallet.`}
        </Notice>
      ) : null}
      {phase === "EXPIRED" ? (
        <Notice tone="warning" title="The price expired">
          {sell ? "The escrow was not confirmed before this price expired, so nothing was sold." : "The payment was not confirmed before this price expired, so nothing was bought."} Do not send anything for this order. Start again for a new price.
        </Notice>
      ) : null}
      {phase === "STOPPED" && meaning !== null ? (
        <Notice tone="warning" title={meaning.label}>
          {meaning.detail}
        </Notice>
      ) : null}
      {phase === "DONE" || phase === "EXPIRED" || phase === "STOPPED" ? (
        <button type="button" className={BUTTON_SECONDARY} onClick={actions.startNewOrder}>
          {sell ? "Sell more" : "Buy more"}
        </button>
      ) : null}
    </div>
  )
}
