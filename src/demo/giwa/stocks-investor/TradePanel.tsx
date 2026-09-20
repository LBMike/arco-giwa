import { DemoDetails, useDemoPresentation } from "../demo-presentation"
// Quote → order for NVDA, in the GIWA invest-panel look. The quote is the server's; this panel never computes an amount,
// never replaces an expired quote on its own, and never turns an unconfirmed request into a new one. It reads no wallet,
// balance or allowance: the only balance it shows is the server portfolio's available NVDA on the Sell side.

import { useId, useRef, type ReactNode, type RefObject } from "react"
import { Loader2 } from "lucide-react"

import { AmountBlock, AmountField, INVEST_CTA, INVEST_CTA_READY, INVEST_PANEL_CARD, INVEST_TAB, INVEST_TAB_ACTIVE, INVEST_TAB_TRACK, InfoRow } from "../invest-panel-ui"
import { StockLogo } from "../stocks-market/StockLogo"
import { useStocksAccess, type GiwaStocksAccess } from "./access"
import type { StocksInvestorActions } from "./actions"
import { isUnresolved, tradeBlock, type OrderAttempt, type StocksInvestorState, type TradeBlock } from "./controller"
import { formatBaseUnits, isDecimalKeystroke } from "./decimal"
import { attemptErrorMessage, cashLabel, errorMessage, formatCash, formatPrice, formatQuantity, formatSignedQuantity, formatUtc, signedOutMessage, tradeBlockMessage } from "./display"
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

const CTA = `${INVEST_CTA} min-h-11 ${FOCUS_RING}`
const CTA_READY = `${CTA} ${INVEST_CTA_READY} disabled:cursor-not-allowed`
/** In progress: readable text on the muted surface (the muted text token is for placeholders only). */
const CTA_BUSY = `${CTA} cursor-progress bg-[var(--color-arco-surface-muted)] text-[var(--color-arco-text-soft)]`
const CHIP_NOTE = "rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-arco-text-soft)]"
const FIELD_FOCUS = "focus-within:outline focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-[var(--color-arco-ink)]"
/** The selected Buy / Sell segment: GIWA's active pill plus an inset ink ring, a non-colour cue of at least 3:1 (Stocks only). */
const SIDE_ACTIVE = `${INVEST_TAB_ACTIVE} ring-1 ring-inset ring-[var(--color-arco-ink)]`

/** The session can retry or look up the unresolved attempt: verified and not rejected by the server. */
function canResolveAttempt(state: StocksInvestorState): boolean {
  return state.session.status === "verified" && !state.authRejected
}

/** The polite status line for the trade (the panel's own, and the mobile summary's while the sheet is closed). */
export function statusAnnouncement(state: StocksInvestorState): string {
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
    default: {
      // Typing more than the server's available NVDA on the Sell side: said once while typing, never blocking.
      const available = state.side === "SELL" ? availableToSell(state) : null
      if (available !== null && state.quantityCheck.ok && BigInt(state.quantityCheck.baseUnits) > BigInt(available)) {
        return `More than the ${formatSignedQuantity(available)} NVDA available to sell. The server checks availability when the order is placed.`
      }
      return ""
    }
  }
}

/** The title an attempt is shown under (also the mobile summary's status line). */
export function attemptTitle(attempt: OrderAttempt, state: StocksInvestorState): string {
  const canResolve = canResolveAttempt(state)
  // After signing in again a 401'd request asks for nothing but the explicit retry; an unknown earlier send stays unconfirmed.
  return attempt.status === "SUBMITTING"
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
}

function AttemptView({ attempt, state, cashSymbol, actions }: { attempt: OrderAttempt; state: StocksInvestorState; cashSymbol: StocksCashSymbol | null; actions: StocksInvestorActions }) {
  const demo = useDemoPresentation()
  const cash = demo ? "USDC" : cashSymbol ?? "test cash"
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
  const title = attemptTitle(attempt, state)
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

// ── the next step (one primary action) ────────────────────────────────────

export type TradeStepKind =
  /** An unresolved or accepted order is shown instead of the form. */
  | "attempt"
  | "connect"
  | "switch"
  | "wallet-unavailable"
  | "signing-in"
  | "sign-in"
  /** No client, catalog not ready, trading not activated, or (without host access) not signed in. */
  | "blocked"
  | "quantity"
  | "quoting"
  | "place"
  | "requote"
  | "quote"

export type TradeStep = Readonly<{ kind: TradeStepKind; label: string; hint: string | null }>

/**
 * Why an earlier Stocks session is gone, from the host's code (the real host publishes these with status "signed-out";
 * WALLET_CHANGED is the page's own, for a wallet other than the last verified one). Never names an address.
 */
export function sessionEndedMessage(access: GiwaStocksAccess | null): string | null {
  switch (access?.hostError) {
    case "SESSION_EXPIRED":
      return "Your Stocks session ended. Sign in again."
    case "SESSION_REJECTED":
      return "Your Stocks session is no longer valid. Sign in again."
    case "WALLET_CHANGED":
      return "The connected wallet changed. Sign in again with this wallet."
    default:
      return null
  }
}

/** A host sign-in failure, for the hint under the sign-in action. An ended session is said by the panel's notice instead. */
function hostErrorMessage(access: GiwaStocksAccess): string | null {
  if (access.host !== "error" || sessionEndedMessage(access) !== null) return null
  if (!access.canSignIn) return "Stocks sign-in is not available on this page. Reload the page; if this continues, contact operations."
  return "Stocks sign-in could not be completed. Try again."
}

/**
 * The single next step the panel offers, in order: wallet → network → sign-in → catalog → quantity → quote → order.
 * Without host access (standalone feature) the wallet and sign-in steps belong to the host: the form stays disabled with
 * the reason shown, as before.
 */
export function tradeStep(state: StocksInvestorState, access: GiwaStocksAccess | null): TradeStep {
  const block: TradeBlock = tradeBlock(state)
  if (isUnresolved(state.attempt) || state.attempt?.status === "ACCEPTED") return { kind: "attempt", label: state.attempt ? attemptTitle(state.attempt, state) : "", hint: null }
  const signedIn = state.session.status === "verified" && !state.authRejected
  if (access !== null && !signedIn) {
    if (access.wallet === "disconnected") {
      return { kind: "connect", label: "Connect wallet", hint: access.connectWallet ? null : "Connect a wallet using the button at the top of the page." }
    }
    if (access.wallet === "wrong-network") {
      return { kind: "switch", label: "Switch to GIWA Sepolia", hint: access.switchNetwork ? null : "Switch your wallet to GIWA Sepolia (chain 91342) in your wallet app." }
    }
    if (access.wallet === "unavailable") return { kind: "wallet-unavailable", label: "Wallet cannot sign here", hint: "Your wallet is not ready to sign a message, so it cannot sign in to Stocks on this page." }
    if (access.host === "signing-in") return { kind: "signing-in", label: "Signing in…", hint: "Complete the sign-in message in your wallet." }
    return { kind: "sign-in", label: "Sign in to trade", hint: hostErrorMessage(access) }
  }
  if (block === "NO_CLIENT" || block === "CATALOG_NOT_READY" || block === "NOT_ACTIVATED" || block === "SIGNED_OUT" || block === "AUTH_REJECTED") {
    return { kind: "blocked", label: "Get quote", hint: null }
  }
  if (!state.quantityCheck.ok) return { kind: "quantity", label: "Get quote", hint: null }
  if (state.quote.status === "loading") return { kind: "quoting", label: "Getting quote…", hint: null }
  if (state.quote.status === "ready") return { kind: "place", label: state.quote.quote.side === "SELL" ? "Place sell order" : "Place buy order", hint: null }
  if (state.quote.status === "expired") return { kind: "requote", label: "Get a new quote", hint: null }
  return { kind: "quote", label: "Get quote", hint: null }
}

/** The server portfolio's available NVDA once it has been read (never an assumed zero before that). Signed base units. */
export function availableToSell(state: StocksInvestorState): string | null {
  if (state.portfolio.status !== "ready") return null
  return state.portfolio.portfolio.holdings.find((holding) => holding.symbol === "NVDA")?.availableQuantity ?? "0"
}

/** The NVDA logo at chip size (StockLogo's smallest box, scaled into 20px). Decorative: "NVDA" follows. */
function NvdaMark() {
  return (
    <span className="inline-flex size-5 shrink-0 [&>span]:size-5 [&>span]:text-[10px]">
      <StockLogo symbol="NVDA" size={32} />
    </span>
  )
}

function TestNote({ children }: { children: ReactNode }) {
  return <DemoDetails><span className={CHIP_NOTE}>{children}</span></DemoDetails>
}

export type TradePanelProps = {
  state: StocksInvestorState
  actions: StocksInvestorActions
  /** Heading id. The inline (desktop) panel uses the detail title id. Default: a generated id. */
  titleId?: string
  /** Makes the heading focusable (the detail view focuses it after "View"). */
  headingRef?: RefObject<HTMLHeadingElement>
}

export function TradePanel({ state, actions, titleId, headingRef }: TradePanelProps) {
  const demo = useDemoPresentation()
  const access = useStocksAccess()
  const inputId = useId()
  const hintId = `${inputId}-hint`
  const availableId = `${inputId}-available`
  const noticeId = `${inputId}-notice`
  const ctaHintId = `${inputId}-cta-hint`
  const detailsId = `${inputId}-details`
  const headingId = titleId ?? `${inputId}-title`
  const inputRef = useRef<HTMLInputElement>(null)
  const quoteRef = useRef<HTMLDivElement>(null)
  const catalog = state.catalog.status === "ready" ? state.catalog.catalog : null
  const instrument = catalog?.instruments.find((item) => item.symbol === "NVDA") ?? null
  const cashSymbol = catalog?.cashSymbol ?? null
  const cash = demo ? "USDC" : cashSymbol ?? "test cash"
  const block = tradeBlock(state)
  const attempt = state.attempt
  const showForm = attempt === null || attempt.status === "REJECTED"
  const quote = state.quote.status === "ready" || state.quote.status === "expired" ? state.quote.quote : null
  // Back to the form after "Start a new order" or "Discard quote": the quantity field. A new quote replaces the button
  // that asked for it: the quote summary (never the order button, so a held or repeated key cannot place an order).
  useRescueFocus(quote ? quoteRef : inputRef, `${showForm}:${state.quote.status}`)
  const invalid = state.quantityInput !== "" && !state.quantityCheck.ok
  const step = tradeStep(state, access)
  const sell = state.side === "SELL"
  const available = sell ? availableToSell(state) : null
  // MAX fills the exact available quantity as typed text (no grouping), only for a positive server value.
  const maxInput = available !== null && !available.startsWith("-") && available !== "0" ? formatBaseUnits(available, STOCKS_QUANTITY_SCALE) : null
  const overAvailable = sell && available !== null && state.quantityCheck.ok && BigInt(state.quantityCheck.baseUnits) > BigInt(available)
  const blockNotice = !(demo && block === "SIGNED_OUT" && sessionEndedMessage(access) === null) && block !== null && block !== "ATTEMPT_UNRESOLVED" && block !== "ATTEMPT_OPEN"
  // An expired, rejected or other-wallet session says so instead of the generic "Sign-in required" text.
  const sessionEnded = state.session.status === "verified" && !state.authRejected ? null : sessionEndedMessage(access)
  const overAvailableShown = overAvailable && available !== null && state.portfolio.status === "ready"

  const nvdaField = (
    <AmountField
      key="nvda"
      id={inputId}
      tone="soft"
      copyButton={false}
      caption={
        <>
          {sell ? "You sell" : "You receive"}
          <span className="sr-only"> · Quantity (NVDA)</span>
        </>
      }
      symbol="NVDA"
      icon={<NvdaMark />}
      symbolNote={<TestNote>Test units</TestNote>}
      value={state.quantityInput}
      // Exact base units of the typed quantity, like the cash side's (also keeps both fields the same height).
      subValue={demo ? undefined : state.quantityCheck.ok ? `${state.quantityCheck.baseUnits} base units (9 decimals)` : "9 decimals max"}
      onChange={actions.setQuantity}
      filter={(next) => isDecimalKeystroke(next, STOCKS_QUANTITY_SCALE)}
      balanceLabel="Available to sell"
      balance={available === null ? undefined : `${formatSignedQuantity(available)} NVDA`}
      onMax={maxInput === null ? undefined : () => actions.setQuantity(maxInput)}
      maxClassName={FOCUS_RING}
      className={FIELD_FOCUS}
      inputRef={inputRef}
      inputProps={{ autoComplete: "off", spellCheck: false, placeholder: "0.5", "aria-describedby": overAvailableShown ? `${hintId} ${availableId}` : hintId, "aria-invalid": invalid }}
    />
  )
  const cashField = (
    <AmountField
      key="cash"
      display
      tone="soft"
      copyButton={false}
      caption={sell ? "You receive" : "You pay"}
      symbol={demo ? "USDC" : cashSymbol ?? "Test cash"}
      symbolNote={<TestNote>TEST</TestNote>}
      value={quote ? formatCash(quote.cashAmount) : "—"}
      subValue={demo ? undefined : quote ? `${quote.cashAmount} base units (6 decimals)` : "서버 견적 후 표시"}
    />
  )

  const signIn = step.kind === "sign-in" && access?.canSignIn ? access.signIn : undefined
  const accessAction =
    step.kind === "connect"
      ? access?.connectWallet
      : step.kind === "switch"
        ? access?.switchNetwork
        : signIn
          ? // The user states Buy or Sell before signing in; the controller keeps that one choice through this sign-in.
            () => {
              actions.noteSignInIntent()
              signIn()
            }
          : undefined
  // Wallet, network and sign-in are the steps BEFORE the form can be used. Their action goes with the reason, above the
  // disabled form, so the whole next-step button is in the first screen of the detail instead of below 400 px of preview.
  const accessStep = step.kind === "connect" || step.kind === "switch" || step.kind === "sign-in" || step.kind === "signing-in" || step.kind === "wallet-unavailable"
  const describedBy = step.hint ? ctaHintId : blockNotice ? noticeId : undefined
  const hint = step.hint ? (
    <p id={ctaHintId} className="mt-2 text-xs leading-5 text-[var(--color-arco-text-soft)]">
      {step.hint}
    </p>
  ) : null
  let cta: ReactNode = null
  switch (step.kind) {
    case "attempt":
      break
    case "connect":
    case "switch":
    case "sign-in":
    case "wallet-unavailable":
      cta = (
        <button key="access" type="button" className={CTA_READY} onClick={accessAction} disabled={!accessAction} aria-describedby={describedBy}>
          {step.label}
        </button>
      )
      break
    case "signing-in":
      cta = (
        <button key="access" type="button" className={CTA_BUSY} aria-disabled="true" aria-busy="true" aria-describedby={describedBy}>
          <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
          {step.label}
        </button>
      )
      break
    case "place":
      cta = (
        <button key="place" type="button" className={CTA_READY} onClick={actions.placeOrder} disabled={block !== null}>
          {step.label}
        </button>
      )
      break
    case "quoting":
      cta = (
        <button key="submit" type="submit" className={CTA_BUSY} aria-disabled="true" aria-busy="true">
          <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
          {step.label}
        </button>
      )
      break
    default:
      // blocked · quantity · quote · requote: the form's submit button (Enter in the quantity field asks for a quote).
      cta = (
        <button key="submit" type="submit" className={CTA_READY} disabled={step.kind === "blocked" || step.kind === "quantity"} aria-describedby={describedBy}>
          {step.label}
        </button>
      )
  }

  return (
    <section className={`flex w-full flex-col gap-4 ${INVEST_PANEL_CARD}`} aria-labelledby={headingId} data-testid="stocks-trade-panel">
      <Heading id={headingId} headingRef={headingRef}>
        Trade NVDA
      </Heading>
      <p className="sr-only" aria-live="polite" data-testid="stocks-trade-status">
        {statusAnnouncement(state)}
      </p>

      {blockNotice || accessStep ? (
        <div className={accessStep ? "flex w-full flex-col" : undefined}>
          {blockNotice ? (
            <div id={noticeId}>
              {sessionEnded !== null && (block === "SIGNED_OUT" || block === "AUTH_REJECTED") ? (
                <Notice tone="info" title="Sign-in required">
                  {sessionEnded}
                </Notice>
              ) : block === "SIGNED_OUT" && state.session.status === "signed-out" ? (
                <Notice tone="info" title="Sign-in required">
                  {signedOutMessage(state.session.reason)}
                </Notice>
              ) : (
                <Notice tone={block === "AUTH_REJECTED" ? "warning" : "info"}>{tradeBlockMessage(block)}</Notice>
              )}
            </div>
          ) : null}
          {accessStep ? (
            <>
              {cta}
              {hint}
            </>
          ) : null}
        </div>
      ) : null}

      {attempt !== null ? <AttemptView attempt={attempt} state={state} cashSymbol={cashSymbol} actions={actions} /> : null}

      {showForm ? (
        <form
          className="flex w-full flex-col"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            if (step.kind === "quote" || step.kind === "requote" || step.kind === "place") actions.requestQuote()
          }}
        >
          <fieldset className="flex w-full min-w-0 flex-col" disabled={block !== null}>
            <legend className="sr-only">Order side and quantity</legend>
            <div role="radiogroup" aria-label="Order side" className={`grid w-full grid-cols-2 ${INVEST_TAB_TRACK}`}>
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
                  className={`${INVEST_TAB} min-h-10 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING} ${
                    state.side === side ? SIDE_ACTIVE : "text-[var(--color-arco-text-soft)] hover:text-[var(--color-arco-ink)]"
                  }`}
                >
                  {side === "BUY" ? "Buy" : "Sell"}
                </button>
              ))}
            </div>

            <div className="mt-4">
              <AmountBlock tone="soft" invalid={invalid}>
                {sell ? [nvdaField, cashField] : [cashField, nvdaField]}
              </AmountBlock>
            </div>
            <p id={hintId} className={`mt-2 text-xs ${invalid ? "font-medium text-[var(--color-arco-ink)]" : "text-[var(--color-arco-text-soft)]"}`}>
              {invalid ? QUANTITY_REASON[state.quantityCheck.ok ? "" : state.quantityCheck.reason] ?? "Enter a valid quantity." : demo ? "" : "Up to 9 decimal places. The server calculates the exact test cash amount."}
            </p>
            {overAvailableShown && available !== null && state.portfolio.status === "ready" ? (
              <div className="mt-3" id={availableId}>
                <Notice tone="warning">
                  This is more than the {formatSignedQuantity(available)} NVDA available to sell as of {formatUtc(state.portfolio.observedAt)}. The server checks
                  availability when the order is placed; reserved and escrowed units cannot be sold again.
                </Notice>
              </div>
            ) : null}
          </fieldset>

          <div className="mt-3">
            {instrument ? <InfoRow label={demo ? "Order price" : "Price"} value={`${formatPrice(instrument.price)} ${cash} / NVDA${demo ? "" : " (fixed, test)"}`} /> : null}
            {quote ? (
              <div ref={quoteRef} tabIndex={-1} role="group" aria-label="Quote" data-testid="stocks-quote" className={FOCUS_RING}>
                <InfoRow
                  label="Quote"
                  value={state.quote.status === "ready" ? `Valid for ${Math.max(0, Math.ceil((state.quote.deadlineMs - state.nowMs) / 1000))} s on this device` : "Expired"}
                />
              </div>
            ) : null}
            <InfoRow label="Order details" expandable tone="soft" bodyId={detailsId} buttonClassName={FOCUS_RING}>
              <dl className="w-full">
                <Field label="Side">{(quote?.side ?? state.side) === "SELL" ? "Sell" : "Buy"}</Field>
                <Field label="Quantity">
                  {quote ? `${formatQuantity(quote.quantity)} NVDA` : state.quantityCheck.ok ? `${formatQuantity(state.quantityCheck.baseUnits)} NVDA` : "—"}
                </Field>
                {quote ? (
                  <>
                    <Field label={quote.side === "SELL" ? (demo ? "You receive" : "You receive (test cash)") : (demo ? "You pay" : "You pay (test cash)")}>
                      {formatCash(quote.cashAmount)} {cash}
                    </Field>
                    <DemoDetails><Field label="Exact amount" mono>
                      {quote.cashAmount} base units (6 decimals)
                    </Field>
                    <Field label="Server deadline">{formatUtc(quote.expiresAt)}</Field></DemoDetails>
                  </>
                ) : null}
                {/* Off the front of the panel (the block notice says when trading is not activated), with the rest of the order's small print. */}
                {instrument ? <Field label="Order capability">{instrument.orderCapability === "CHECK_PAUSE_AT_ORDER" ? "Open unless paused" : "Not activated"}</Field> : null}
                <DemoDetails>{cashSymbol ? <Field label="Test cash">{cashLabel(cashSymbol)}</Field> : null}
                {catalog ? (
                  <Field label="Deployment" mono>
                    {catalog.deploymentId}
                  </Field>
                ) : null}</DemoDetails>
              </dl>
            </InfoRow>
          </div>

          {state.quote.status === "error" ? (
            <div className="mt-4">
              <Notice tone="error">{errorMessage(state.quote.error)}</Notice>
            </div>
          ) : null}
          {state.quote.status === "expired" ? (
            <div className="mt-4">
              <Notice tone="warning" title="Quote expired">
                <p>No order was placed. Request a new quote to continue; it may have a different amount.</p>
              </Notice>
            </div>
          ) : null}

          {accessStep ? null : cta}
          {step.kind === "place" ? (
            <button type="button" className={`${BUTTON_SECONDARY} mt-2 w-full`} onClick={actions.discardQuote}>
              Discard quote
            </button>
          ) : null}
          {accessStep ? null : hint}
        </form>
      ) : null}
    </section>
  )
}
