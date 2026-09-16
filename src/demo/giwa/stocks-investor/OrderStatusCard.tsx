// One order as the server last reported it. The state only changes through a server read.

import { useRef } from "react"

import type { FeatureError } from "./controller"
import { cashLabel, errorMessage, formatCash, formatQuantity, formatUtc, shortAddress } from "./display"
import { CATEGORY_TONE, deadlinePassed, orderStatusMeaning } from "./status"
import type { StocksCashSymbol, StocksOrder } from "./types"
import { BUTTON_SECONDARY, Chip, FOCUS_RING, Field, Notice, useRescueFocus } from "./ui"

export type OrderStatusCardProps = {
  order: StocksOrder
  /** Server time of the response that carried this order; also decides whether its deadline has passed. */
  observedAt: string | null
  cashSymbol: StocksCashSymbol | null
  refreshing: boolean
  error: FeatureError | null
  onRefresh: () => void
  headingLevel?: 2 | 3
}

export function OrderStatusCard({ order, observedAt, cashSymbol, refreshing, error, onRefresh, headingLevel = 3 }: OrderStatusCardProps) {
  const meaning = orderStatusMeaning(order, observedAt)
  const expired = deadlinePassed(order, observedAt)
  const cash = cashSymbol ?? "test cash"
  const Heading = headingLevel === 2 ? "h2" : "h3"
  const headingRef = useRef<HTMLHeadingElement>(null)
  useRescueFocus(headingRef, order.id)
  return (
    <article className="flex w-full flex-col gap-4" aria-labelledby={`giwa-stocks-order-${order.id}`} data-testid="stocks-order-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Heading id={`giwa-stocks-order-${order.id}`} ref={headingRef} tabIndex={-1} className={`text-base font-medium text-[var(--color-arco-ink)] ${FOCUS_RING}`}>
          {order.side === "SELL" ? "Sell" : "Buy"} NVDA
        </Heading>
        <Chip tone={CATEGORY_TONE[meaning.category]}>{meaning.label}</Chip>
      </div>
      <p className="text-sm leading-6 text-[var(--color-arco-text-soft)]">{meaning.detail}</p>

      {expired ? (
        <Notice tone="warning" title={order.side === "SELL" ? "Do not escrow for this order" : "Do not fund this order"}>
          <p>
            The quote deadline {formatUtc(order.quoteExpiresAt)} has passed (server time {observedAt ? formatUtc(observedAt) : "unknown"}).{" "}
            {order.side === "SELL"
              ? "A late escrow is not sold: it is held for review."
              : "A late payment buys nothing: it is held for review, and a refund is not automatic."}
          </p>
        </Notice>
      ) : null}
      {!expired && order.side === "BUY" && order.state === "AWAITING_FUNDING" ? (
        <Notice tone="action" title="Funding required — not available in this app yet">
          <p>
            This order is matched only by a <span className="font-mono">depositForOrder</span> call to the funding vault of this Stocks deployment, from wallet{" "}
            <span className="font-mono">{shortAddress(order.wallet)}</span>, with the order key below and exactly{" "}
            <span className="font-medium tabular-nums">{formatCash(order.cashAmount)}</span> {cash} (<span className="font-mono">{order.cashAmount}</span> base units, 6 decimals), before{" "}
            <span className="tabular-nums">{formatUtc(order.quoteExpiresAt)}</span>.
          </p>
          <p className="mt-2">
            This screen does not sign or send anything. A plain token transfer is not matched to the order. The order moves on only after the server records a finalized deposit.
          </p>
        </Notice>
      ) : null}
      {!expired && order.side === "SELL" && order.state === "AWAITING_ESCROW" ? (
        <Notice tone="action" title="Escrow required — not available in this app yet">
          <p>
            This order is matched only by an <span className="font-mono">escrowForOrder</span> call to the redemption escrow of this Stocks deployment, from wallet{" "}
            <span className="font-mono">{shortAddress(order.wallet)}</span>, with the order key below and exactly{" "}
            <span className="font-medium tabular-nums">{formatQuantity(order.quantity)}</span> NVDA test units (<span className="font-mono">{order.quantity}</span> base units, 9 decimals), before{" "}
            <span className="tabular-nums">{formatUtc(order.quoteExpiresAt)}</span>.
          </p>
          <p className="mt-2">
            This screen does not sign or send anything. A plain token transfer is not matched to the order. The order moves on only after the server records a finalized escrow.
          </p>
        </Notice>
      ) : null}

      <dl className="w-full">
        <Field label="Quantity">{formatQuantity(order.quantity)} NVDA</Field>
        <Field label={order.side === "SELL" ? "Payout (test cash)" : "Cost (test cash)"}>
          {formatCash(order.cashAmount)} {cash}
        </Field>
        <Field label="Status">{meaning.label}</Field>
        <Field label="Order ID" mono>
          {order.id}
        </Field>
        <Field label="Order key" mono>
          {order.orderKey}
        </Field>
        <Field label="Wallet" mono>
          {order.wallet}
        </Field>
        <Field label="Quote deadline">{formatUtc(order.quoteExpiresAt)}</Field>
        <Field label="Created">{formatUtc(order.createdAt)}</Field>
        <Field label="Updated">{formatUtc(order.updatedAt)}</Field>
      </dl>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-[var(--color-arco-text-soft)]">
          {observedAt ? <>Status as of {formatUtc(observedAt)} · </> : null}
          {cashSymbol ? cashLabel(cashSymbol) : "Test value only"}
        </p>
        <button type="button" className={BUTTON_SECONDARY} onClick={onRefresh} disabled={refreshing} aria-busy={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh status"}
        </button>
      </div>
      {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
    </article>
  )
}
