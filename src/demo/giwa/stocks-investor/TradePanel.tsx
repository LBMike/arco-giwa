// Quote → order for NVDA. The quote is the server's; this panel never computes an amount, never
// replaces an expired quote on its own, and never turns an unconfirmed request into a new one.

import { useId, useRef } from "react"

import type { StocksInvestorActions } from "./actions"
import { tradeBlock, type OrderAttempt, type StocksInvestorState } from "./controller"
import { isDecimalKeystroke } from "./decimal"
import { attemptErrorMessage, errorMessage, formatCash, formatQuantity, formatUtc, signedOutMessage, tradeBlockMessage } from "./display"
import { OrderStatusCard } from "./OrderStatusCard"
import { orderStatusMeaning } from "./status"
import { STOCKS_QUANTITY_SCALE, type StocksCashSymbol } from "./types"
import { BUTTON_PRIMARY, BUTTON_SECONDARY, FOCUS_RING, Field, Heading, Notice, useRescueFocus } from "./ui"

const QUANTITY_REASON: Record<string, string> = {
  FORMAT: "Enter a plain decimal number, for example 0.5.",
  PRECISION: "Use at most 9 decimal places.",
  ZERO: "Enter a quantity greater than zero.",
  TOO_LARGE: "This quantity is above the accepted maximum.",
}

/** Native `disabled` drops keyboard focus: while a read is in flight the button stays focusable, aria-disabled, and has no click handler. */
const BUSY = "aria-disabled:cursor-not-allowed aria-disabled:opacity-40"

/** The session can retry or look up the unresolved attempt: verified and not rejected by the server. */
function canResolveAttempt(state: StocksInvestorState): boolean {
  return state.session.status === "verified" && !state.authRejected
}

function statusAnnouncement(state: StocksInvestorState): string {
  const attempt = state.attempt
  if (attempt !== null) {
    const unconfirmed = attempt.lookup === "NOT_FOUND" ? "Order result not confirmed. Not found in your latest orders." : "Order result not confirmed."
    switch (attempt.status) {
      case "SUBMITTING":
        return "Placing order."
      case "UNCONFIRMED":
        return unconfirmed
      case "AUTH_REQUIRED":
        // Signed in again: the 401'd send was not processed; an earlier send with an unknown outcome stays unconfirmed.
        if (!canResolveAttempt(state)) return "Sign in again to finish this order request."
        return attempt.outcomeUnknown ? unconfirmed : "Order request not processed. Retry it unchanged."
      case "REJECTED":
        return `Order not placed. ${attempt.error ? attemptErrorMessage(attempt.error, attempt.outcomeUnknown) : ""}`
      case "ACCEPTED":
        return `Order accepted. ${attempt.order ? `Status: ${orderStatusMeaning(attempt.order, attempt.orderObservedAt).label}.` : ""}`
    }
  }
  switch (state.quote.status) {
    case "loading":
      return "Getting quote."
    case "ready":
      return `Quote ready: ${formatCash(state.quote.quote.cashAmount)} test cash for ${formatQuantity(state.quote.quote.quantity)} NVDA.`
    case "expired":
      return "Quote expired. No order was placed."
    case "error":
      return errorMessage(state.quote.error)
    default:
      return ""
  }
}

function AttemptView({ attempt, state, cashSymbol, actions }: { attempt: OrderAttempt; state: StocksInvestorState; cashSymbol: StocksCashSymbol | null; actions: StocksInvestorActions }) {
  const cash = cashSymbol ?? "test cash"
  const headingRef = useRef<HTMLHeadingElement>(null)
  useRescueFocus(headingRef, `${attempt.body.idempotencyKey}:${attempt.status}`)
  const request = (
    <dl className="w-full">
      <Field label="Side">{attempt.side === "SELL" ? "Sell" : "Buy"}</Field>
      <Field label="Quantity">{formatQuantity(attempt.quote.quantity)} NVDA</Field>
      <Field label={attempt.side === "SELL" ? "Quoted payout" : "Quoted cost"}>
        {formatCash(attempt.quote.cashAmount)} {cash}
      </Field>
      <Field label="Quote ID" mono>
        {attempt.body.quoteId}
      </Field>
      <Field label="Request key" mono>
        {attempt.body.idempotencyKey}
      </Field>
    </dl>
  )
  const canResolve = canResolveAttempt(state)
  const checking = attempt.lookup === "CHECKING"
  // After signing in again a 401'd request asks for nothing but the explicit retry; an unknown earlier send stays unconfirmed.
  const title =
    attempt.status === "SUBMITTING"
      ? "Placing order…"
      : attempt.status === "UNCONFIRMED" || (attempt.status === "AUTH_REQUIRED" && canResolve && attempt.outcomeUnknown)
        ? "Order result not confirmed"
        : attempt.status === "AUTH_REQUIRED"
          ? canResolve
            ? "Order request not processed"
            : "Sign in again to finish this order request"
          : attempt.status === "REJECTED"
            ? "Order not placed"
            : "Order accepted"
  // "Sign in again" from the 401 itself is obsolete once the session is verified again.
  const staleSignIn = attempt.status === "AUTH_REQUIRED" && canResolve && !attempt.outcomeUnknown && attempt.error?.kind === "UNAUTHORIZED"
  return (
    <div className="flex flex-col gap-4" data-testid={attempt.status === "UNCONFIRMED" || attempt.status === "AUTH_REQUIRED" ? "stocks-unconfirmed-attempt" : `stocks-attempt-${attempt.status.toLowerCase()}`}>
      <Heading level={3} headingRef={headingRef}>
        {title}
      </Heading>
      {attempt.status === "SUBMITTING" ? <Notice tone="info">Waiting for the server. Do not close this page.</Notice> : null}
      {attempt.status === "UNCONFIRMED" || attempt.status === "AUTH_REQUIRED" ? (
        <>
          <Notice tone="warning">
            <p>
              {attempt.status === "AUTH_REQUIRED" && !attempt.outcomeUnknown
                ? "The server did not accept the sign-in session, so this request was not processed. After signing in again, retry it unchanged."
                : "This request may already have created the order. Retrying sends the same request with the same request key, so it cannot create a second order."}
            </p>
            {attempt.error && !staleSignIn ? <p className="mt-2">{attemptErrorMessage(attempt.error, attempt.outcomeUnknown)}</p> : null}
            {attempt.lookup === "NOT_FOUND" ? <p className="mt-2">This request was not found in your latest orders. That does not prove it was not created.</p> : null}
          </Notice>
          {request}
          <div className="flex flex-wrap gap-3">
            <button type="button" className={`${BUTTON_PRIMARY} ${BUSY}`} onClick={checking ? undefined : actions.retryOrder} disabled={!canResolve} aria-disabled={checking || undefined}>
              Retry same request
            </button>
            <button type="button" className={`${BUTTON_SECONDARY} ${BUSY}`} onClick={checking ? undefined : actions.checkOrder} disabled={!canResolve} aria-disabled={checking || undefined} aria-busy={checking}>
              {checking ? "Checking…" : "Check my orders"}
            </button>
          </div>
        </>
      ) : null}
      {attempt.status === "REJECTED" ? (
        <>
          <Notice tone="error">{attempt.error ? attemptErrorMessage(attempt.error, attempt.outcomeUnknown) : "The server refused the order."}</Notice>
          {request}
          <div>
            <button type="button" className={BUTTON_SECONDARY} onClick={actions.startNewOrder}>
              Start a new order
            </button>
          </div>
        </>
      ) : null}
      {attempt.status === "SUBMITTING" ? request : null}
      {attempt.status === "ACCEPTED" ? (
        <>
          {attempt.order ? (
            <OrderStatusCard
              order={attempt.order}
              observedAt={attempt.orderObservedAt}
              cashSymbol={cashSymbol}
              refreshing={attempt.refresh === "LOADING"}
              error={attempt.error}
              onRefresh={actions.refreshAttemptOrder}
            />
          ) : null}
          <div>
            <button type="button" className={BUTTON_SECONDARY} onClick={actions.startNewOrder}>
              Start a new order
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}

export function TradePanel({ state, actions }: { state: StocksInvestorState; actions: StocksInvestorActions }) {
  const inputId = useId()
  const hintId = `${inputId}-hint`
  const inputRef = useRef<HTMLInputElement>(null)
  const cashSymbol = state.catalog.status === "ready" ? state.catalog.catalog.cashSymbol : null
  const cash = cashSymbol ?? "test cash"
  const block = tradeBlock(state)
  const attempt = state.attempt
  const showForm = attempt === null || attempt.status === "REJECTED"
  // Back to the form after "Start a new order" or "Discard quote": focus the quantity field.
  useRescueFocus(inputRef, `${showForm}:${state.quote.status}`)
  const invalid = state.quantityInput !== "" && !state.quantityCheck.ok

  return (
    <section className="flex w-full flex-col gap-4" aria-labelledby={`${inputId}-title`}>
      <Heading id={`${inputId}-title`}>Trade NVDA</Heading>
      <p className="sr-only" aria-live="polite" data-testid="stocks-trade-status">
        {statusAnnouncement(state)}
      </p>

      {block === "SIGNED_OUT" && state.session.status === "signed-out" ? (
        <Notice tone="info" title="Sign-in required">
          {signedOutMessage(state.session.reason)}
        </Notice>
      ) : block !== null && block !== "ATTEMPT_UNRESOLVED" && block !== "ATTEMPT_OPEN" ? (
        <Notice tone={block === "AUTH_REJECTED" ? "warning" : "info"}>{tradeBlockMessage(block)}</Notice>
      ) : null}

      {attempt !== null ? <AttemptView attempt={attempt} state={state} cashSymbol={cashSymbol} actions={actions} /> : null}

      {showForm ? (
        <>
          <fieldset className="flex w-full flex-col gap-4" disabled={block !== null}>
            <legend className="sr-only">Order side and quantity</legend>
            <div role="radiogroup" aria-label="Order side" className="grid w-full grid-cols-2 gap-2 sm:max-w-xs">
              {(["BUY", "SELL"] as const).map((side) => (
                <button
                  key={side}
                  type="button"
                  role="radio"
                  aria-checked={state.side === side}
                  tabIndex={state.side === side ? 0 : -1}
                  onClick={() => actions.setSide(side)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
                      event.preventDefault()
                      const nextSide = side === "BUY" ? "SELL" : "BUY"
                      actions.setSide(nextSide)
                      const group = event.currentTarget.parentElement
                      group?.querySelector<HTMLButtonElement>(`[data-side="${nextSide}"]`)?.focus()
                    }
                  }}
                  data-side={side}
                  className={`min-h-11 rounded-[var(--radius-card)] border px-4 text-sm font-medium ${FOCUS_RING} ${
                    state.side === side
                      ? "border-[var(--color-arco-ink)] bg-[var(--color-arco-ink)] text-[var(--color-arco-on-dark)]"
                      : "border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] text-[var(--color-arco-ink)]"
                  }`}
                >
                  {side === "BUY" ? "Buy" : "Sell"}
                </button>
              ))}
            </div>
            <form
              className="flex w-full flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                actions.requestQuote()
              }}
            >
              <label htmlFor={inputId} className="text-sm font-medium text-[var(--color-arco-ink)]">
                Quantity (NVDA)
              </label>
              <div className="flex w-full flex-col gap-3 sm:flex-row">
                <input
                  ref={inputRef}
                  id={inputId}
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  value={state.quantityInput}
                  aria-describedby={hintId}
                  aria-invalid={invalid}
                  onChange={(event) => {
                    if (isDecimalKeystroke(event.target.value, STOCKS_QUANTITY_SCALE)) actions.setQuantity(event.target.value)
                  }}
                  placeholder="0.5"
                  className={`min-h-11 w-full min-w-0 rounded-[var(--radius-control)] border bg-[var(--color-arco-surface)] px-3 text-base tabular-nums text-[var(--color-arco-ink)] placeholder:text-[var(--color-arco-muted)] sm:max-w-xs ${
                    invalid ? "border-2 border-[var(--color-arco-down)]" : "border-[var(--color-arco-border)]"
                  } ${FOCUS_RING}`}
                />
                <button type="submit" className={BUTTON_PRIMARY} disabled={block !== null || !state.quantityCheck.ok || state.quote.status === "loading"} aria-busy={state.quote.status === "loading"}>
                  {state.quote.status === "loading" ? "Getting quote…" : "Get quote"}
                </button>
              </div>
              <p id={hintId} className={`text-xs ${invalid ? "font-medium text-[var(--color-arco-ink)]" : "text-[var(--color-arco-text-soft)]"}`}>
                {invalid ? QUANTITY_REASON[state.quantityCheck.ok ? "" : state.quantityCheck.reason] ?? "Enter a valid quantity." : "Up to 9 decimal places. The server calculates the exact test cash amount."}
              </p>
            </form>
          </fieldset>

          {state.quote.status === "error" ? <Notice tone="error">{errorMessage(state.quote.error)}</Notice> : null}

          {state.quote.status === "ready" || state.quote.status === "expired" ? (
            <div className="flex w-full flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-arco-border)] p-4" data-testid="stocks-quote">
              <Heading level={3}>Quote</Heading>
              <dl className="w-full">
                <Field label="Side">{state.quote.quote.side === "SELL" ? "Sell" : "Buy"}</Field>
                <Field label="Quantity">{formatQuantity(state.quote.quote.quantity)} NVDA</Field>
                <Field label={state.quote.quote.side === "SELL" ? "You receive (test cash)" : "You pay (test cash)"}>
                  {formatCash(state.quote.quote.cashAmount)} {cash}
                </Field>
                <Field label="Exact amount" mono>
                  {state.quote.quote.cashAmount} base units (6 decimals)
                </Field>
                <Field label="Server deadline">{formatUtc(state.quote.quote.expiresAt)}</Field>
              </dl>
              {state.quote.status === "ready" ? (
                <>
                  <p className="text-sm text-[var(--color-arco-text-soft)]">Valid for {Math.max(0, Math.ceil((state.quote.deadlineMs - state.nowMs) / 1000))} s on this device.</p>
                  <div className="flex flex-wrap gap-3">
                    <button type="button" className={BUTTON_PRIMARY} onClick={actions.placeOrder} disabled={block !== null}>
                      {state.quote.quote.side === "SELL" ? "Place sell order" : "Place buy order"}
                    </button>
                    <button type="button" className={BUTTON_SECONDARY} onClick={actions.discardQuote}>
                      Discard quote
                    </button>
                  </div>
                </>
              ) : (
                <Notice tone="warning" title="Quote expired">
                  <p>No order was placed. Request a new quote to continue; it may have a different amount.</p>
                  <button type="button" className={`${BUTTON_SECONDARY} mt-3`} onClick={actions.requestQuote} disabled={block !== null || !state.quantityCheck.ok}>
                    Get a new quote
                  </button>
                </Notice>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
