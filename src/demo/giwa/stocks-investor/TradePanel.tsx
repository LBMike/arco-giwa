import { DemoDetails, useDemoPresentation } from "../demo-presentation"
// Quote → order for NVDA, in the GIWA invest-panel look. The quote is the server's; this panel never computes an amount,
// never replaces an expired quote on its own, and never turns an unconfirmed request into a new one. Cash reads are
// informational, scoped to the verified host wallet and v3 deployment; execution still performs its own fresh checks.

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react"
import { Loader2 } from "lucide-react"

import { AmountBlock, AmountField, INVEST_PANEL_CARD, INVEST_TAB, INVEST_TAB_ACTIVE, INVEST_TAB_TRACK, InfoRow } from "../invest-panel-ui"
import { directContracts } from "../stocks-direct"
import { DirectTradePanel } from "./DirectTrade"
import { CTA_BUSY, CTA_READY, FIELD_FOCUS, NvdaMark, TestNote } from "./trade-parts"
import { signInFailureMessage } from "../stocks-host/sign-in-errors"
import { useStocksAccess, type GiwaStocksAccess } from "./access"
import type { StocksInvestorActions } from "./actions"
import { isUnresolved, tradeBlock, type OrderAttempt, type StocksInvestorState, type TradeBlock } from "./controller"
import { formatBaseUnits, isDecimalKeystroke, parseHumanDecimal } from "./decimal"
import { attemptErrorMessage, cashLabel, errorMessage, formatCash, formatPrice, formatQuantity, formatSignedQuantity, formatUtc, signedOutMessage, tradeBlockMessage } from "./display"
import { OrderStatusCard } from "./OrderStatusCard"
import { StocksFundingStatus, useStocksFundingStatus, useStocksWalletCash } from "./funding-status"
import { approvalMessage, useStocksTokenApproval } from "./cash-approval"
import { BURN_FEE_BPS, buyCost, buyQuantity, formatFee, MINT_FEE_BPS, priceUnits, sellPayout } from "./pricing"
import { InstantTradeView } from "./InstantTrade"
import { orderStatusMeaning } from "./status"
import { STOCKS_CASH_SCALE, STOCKS_QUANTITY_SCALE, type StocksCashSymbol } from "./types"
import { BUTTON_PRIMARY, BUTTON_SECONDARY, FOCUS_RING, Field, Heading, Notice, useRescueFocus } from "./ui"

const QUANTITY_REASON: Record<string, string> = {
  FORMAT: "Enter a plain decimal number, for example 0.5.",
  PRECISION: "Use at most 9 decimal places.",
  ZERO: "Enter a quantity greater than zero.",
  TOO_LARGE: "This quantity is above the accepted maximum.",
}

/** Customer presentation, Buy: why the typed tUSDC amount cannot be used. */
const PAY_REASON: Record<string, string> = {
  FORMAT: "Enter a plain decimal number, for example 60.",
  PRECISION: "Use at most 6 decimal places.",
  ZERO: "Enter an amount greater than zero.",
  TOO_LARGE: "This amount is above the accepted maximum.",
}

/** Native `disabled` drops keyboard focus: while a read is in flight the button stays focusable, aria-disabled, and has no click handler. */
const BUSY = "aria-disabled:cursor-not-allowed aria-disabled:opacity-40"

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
  const tusdc = state.catalog.status === "ready" && state.catalog.catalog.cashSymbol === "tUSDC"
  const cash = tusdc ? cashSymbol ?? "test cash" : demo ? "USDC" : cashSymbol ?? "test cash"
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
  return signInFailureMessage(access.hostError)
}

/**
 * The single next step the panel offers, in order: wallet → network → sign-in → catalog → quantity → quote → order.
 * Without host access (standalone feature) the wallet and sign-in steps belong to the host: the form stays disabled with
 * the reason shown, as before. With `quoteSignsIn` (the customer presentation) the sign-in step is the form's own
 * "Get quote": the quantity is typed first, and that press signs in and then quotes it.
 */
export function tradeStep(state: StocksInvestorState, access: GiwaStocksAccess | null, quoteSignsIn = false): TradeStep {
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
    // The customer presentation's first Buy or Sell press signs in; only a sign-in failure is explained under it.
    if (quoteSignsIn) return { kind: "sign-in", label: state.side === "SELL" ? "Sell NVDA" : "Buy NVDA", hint: hostErrorMessage(access) }
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
/**
 * The order's small print inside "Order details". The customer presentation shows only the fees: side, amounts and
 * order capability are already on the panel's face. The technical preview keeps every order fact.
 */
export function OrderDetailFields({ demo, side, quantity, quote, cash, orderCapability, cashSymbol, deploymentId }: {
  demo: boolean
  side: "BUY" | "SELL"
  /** NVDA base units, or null while none is entered. */
  quantity: string | null
  quote: { side: "BUY" | "SELL"; cashAmount: string; expiresAt: string } | null
  cash: string
  orderCapability: "CHECK_PAUSE_AT_ORDER" | "NOT_ACTIVATED" | null
  cashSymbol: StocksCashSymbol | null
  deploymentId: string | null
}) {
  if (demo) return (
    <>
      <Field label="Mint fee">{formatFee(MINT_FEE_BPS)}</Field>
      <Field label="Burn fee">{formatFee(BURN_FEE_BPS)}</Field>
    </>
  )
  return (
    <>
      <Field label="Side">{side === "SELL" ? "Sell" : "Buy"}</Field>
      <Field label="Quantity">{quantity !== null ? `${formatQuantity(quantity)} NVDA` : "—"}</Field>
      {quote ? (
        <>
          <Field label={quote.side === "SELL" ? "You receive (test cash)" : "You pay (test cash)"}>
            {formatCash(quote.cashAmount)} {cash}
          </Field>
          <DemoDetails><Field label="Exact amount" mono>
            {quote.cashAmount} base units (6 decimals)
          </Field>
          <Field label="Server deadline">{formatUtc(quote.expiresAt)}</Field></DemoDetails>
        </>
      ) : null}
      {/* Off the front of the panel (the block notice says when trading is not activated), with the rest of the order's small print. */}
      {orderCapability ? <Field label="Order capability">{orderCapability === "CHECK_PAUSE_AT_ORDER" ? "Open unless paused" : "Not activated"}</Field> : null}
      <DemoDetails>{cashSymbol ? <Field label="Test cash">{cashLabel(cashSymbol)}</Field> : null}
      {deploymentId ? (
        <Field label="Deployment" mono>
          {deploymentId}
        </Field>
      ) : null}</DemoDetails>
    </>
  )
}

export function availableToSell(state: StocksInvestorState): string | null {
  if (state.portfolio.status !== "ready") return null
  return state.portfolio.portfolio.holdings.find((holding) => holding.symbol === "NVDA")?.availableQuantity ?? "0"
}

/** The NVDA the wallet holds (server portfolio, finalized, including reserved units) once read; null before that. Signed. */
export function walletHolding(state: StocksInvestorState): string | null {
  if (state.portfolio.status !== "ready") return null
  return state.portfolio.portfolio.holdings.find((holding) => holding.symbol === "NVDA")?.walletQuantity ?? "0"
}


export type TradePanelProps = {
  state: StocksInvestorState
  actions: StocksInvestorActions
  /** Heading id. The inline (desktop) panel uses the detail title id. Default: a generated id. */
  titleId?: string
  /** Makes the heading focusable (the detail view focuses it after "View"). */
  headingRef?: RefObject<HTMLHeadingElement>
  /**
   * The live NVDA price the market chart shows. The customer presentation previews amounts at it (the server quotes at its
   * own read of the same live price). Absent: the catalog price.
   */
  marketPrice?: string | null
}

/**
 * The customer presentation trades directly when the server publishes its contracts (the wallet's own deposit or escrow
 * is the order: no sign-in). An order this tab placed through a session is finished on the session panel first. The
 * technical preview, and an older server, keep the quote → order panel.
 */
export function TradePanel(props: TradePanelProps) {
  const demo = useDemoPresentation()
  const catalog = props.state.catalog.status === "ready" ? props.state.catalog.catalog : null
  const contracts = demo && props.state.attempt === null ? directContracts(catalog) : null
  return contracts !== null ? <DirectTradePanel state={props.state} actions={props.actions} contracts={contracts} marketPrice={props.marketPrice ?? null} /> : <SessionTradePanel {...props} />
}

function SessionTradePanel({ state, actions, titleId, headingRef, marketPrice = null }: TradePanelProps) {
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
  const tusdcCatalog = catalog?.cashSymbol === "tUSDC"
  const funding = useStocksFundingStatus(tusdcCatalog ? catalog.deploymentId : null)
  // The wallet's tUSDC is public: shown as soon as the wallet is on GIWA, before and after Stocks sign-in (as on Funds).
  // In the customer presentation the verified deployment (known after sign-in) adds what this wallet has approved to its
  // funding vault (Buy) and its redemption escrow (Sell), and the wallet's NVDA at the same head block.
  const walletCash = useStocksWalletCash(
    tusdcCatalog,
    demo ? funding.data?.fundingVault ?? null : null,
    undefined,
    undefined,
    demo && funding.data ? { token: funding.data.stockToken, spender: funding.data.redemptionEscrow } : null,
  )
  // The one-time approval of the one-click trade (Savings and Funds approve their vaults the same way).
  const approval = useStocksTokenApproval(walletCash.refresh)
  const cashBalance = walletCash.data?.balance ?? funding.data?.balance ?? null
  const cashSymbol = tusdcCatalog ? walletCash.data?.cashSymbol ?? funding.data?.cashSymbol ?? null : catalog?.cashSymbol ?? null
  const cash = tusdcCatalog ? cashSymbol ?? "test cash" : demo ? "USDC" : cashSymbol ?? "test cash"
  const block = tradeBlock(state)
  const attempt = state.attempt
  const showForm = attempt === null || attempt.status === "REJECTED"
  const quote = state.quote.status === "ready" || state.quote.status === "expired" ? state.quote.quote : null
  // Back to the form after "Start a new order" or "Discard quote": the quantity field. A new quote replaces the button
  // that asked for it: the quote summary (never the order button, so a held or repeated key cannot place an order).
  useRescueFocus(quote && !demo ? quoteRef : inputRef, `${showForm}:${state.quote.status}`)
  const invalid = state.quantityInput !== "" && !state.quantityCheck.ok
  const step = tradeStep(state, access, demo)
  // Customer presentation: the quantity is typed before signing in, and "Get quote" signs in, then quotes it.
  const quoteSignsIn = demo && step.kind === "sign-in"
  const sell = state.side === "SELL"
  const available = sell ? availableToSell(state) : null
  // The NVDA field's balance: available to sell on Sell; on Buy (demo presentation) what the wallet holds.
  const shownHolding = sell ? available : demo ? walletCash.data?.stockBalance ?? walletHolding(state) : null
  // MAX fills the exact available quantity as typed text (no grouping), only for a positive server value.
  const maxInput = available !== null && !available.startsWith("-") && available !== "0" ? formatBaseUnits(available, STOCKS_QUANTITY_SCALE) : null
  const overAvailable = sell && available !== null && state.quantityCheck.ok && BigInt(state.quantityCheck.baseUnits) > BigInt(available)
  const blockNotice = !(demo && block === "SIGNED_OUT" && sessionEndedMessage(access) === null) && block !== null && block !== "ATTEMPT_UNRESOLVED" && block !== "ATTEMPT_OPEN"
  // An expired, rejected or other-wallet session says so instead of the generic "Sign-in required" text.
  const sessionEnded = state.session.status === "verified" && !state.authRejected ? null : sessionEndedMessage(access)
  const overAvailableShown = overAvailable && available !== null && state.portfolio.status === "ready"

  // ── customer presentation: the one-click trade ──
  const signedIn = state.session.status === "verified" && !state.authRejected
  // Previews at the chart's live price (else the catalog's); the server's quote at its own read of that price is what counts.
  const unitPrice = priceUnits(demo ? marketPrice : null) ?? priceUnits(instrument?.price)
  const payCheck = demo && !sell && state.payInput !== "" ? parseHumanDecimal(state.payInput, STOCKS_CASH_SCALE) : null
  const payInvalid = payCheck !== null && !payCheck.ok
  // A typed tUSDC amount is paid exactly; the NVDA it buys follows the price on screen.
  const payQuantity = payCheck !== null && payCheck.ok && unitPrice !== null ? buyQuantity(BigInt(payCheck.baseUnits), unitPrice) : null
  const typedQuantity = payCheck !== null ? (payQuantity !== null && payQuantity > 0n ? payQuantity.toString() : null) : state.quantityCheck.ok ? state.quantityCheck.baseUnits : null
  // The trade's cost (Buy) or payout (Sell) by the server's own rounding. The server's quote is still what is paid.
  const tradeCash =
    payCheck !== null && payCheck.ok ? payCheck.baseUnits
      : typedQuantity !== null && unitPrice !== null ? (sell ? sellPayout(BigInt(typedQuantity), unitPrice) : buyCost(BigInt(typedQuantity), unitPrice)).toString()
        : null
  const payValue = state.payInput !== "" ? state.payInput : !sell && tradeCash !== null ? formatBaseUnits(tradeCash, STOCKS_CASH_SCALE) : ""
  const receiveValue = payCheck !== null ? (typedQuantity !== null ? formatBaseUnits(typedQuantity, STOCKS_QUANTITY_SCALE) : "") : state.quantityInput
  const tooSmall = demo && ((payCheck !== null && payCheck.ok && typedQuantity === null) || (sell && tradeCash === "0"))
  // What the trade takes from the wallet: tUSDC base units for Buy, NVDA base units for Sell.
  const required = sell ? typedQuantity : tradeCash
  const target = demo && funding.data ? (sell ? { token: funding.data.stockToken, spender: funding.data.redemptionEscrow } : { token: funding.data.cashToken, spender: funding.data.fundingVault }) : null
  const walletRead = walletCash.data
  const allowed = target === null || walletRead === null ? null : sell ? (walletRead.stockSpender === target.spender ? walletRead.stockAllowance : null) : walletRead.spender === target.spender ? walletRead.allowance : null
  const approvalNeeded = required === null || allowed === null ? null : BigInt(allowed) < BigInt(required)
  const spendable = sell ? available ?? walletRead?.stockBalance ?? null : cashBalance
  const short = demo && !tooSmall && required !== null && spendable !== null && BigInt(spendable) < BigInt(required)
  const approving = approval.state.status === "wallet" || approval.state.status === "pending" || (approval.state.status === "confirmed" && approvalNeeded === true)
  const approveSymbol = sell ? "NVDA" : cashSymbol ?? "tUSDC"
  const tradeLabel = sell ? "Sell NVDA" : "Buy NVDA"
  const sessionWallet = state.session.status === "verified" ? state.session.wallet : null

  // GIWA's RPC can briefly serve the old allowance after a confirmed approval: read again until it shows (as Funds does).
  const approvalConfirmed = approval.state.status === "confirmed"
  const refreshWallet = walletCash.refresh
  useEffect(() => {
    if (!approvalConfirmed || approvalNeeded !== true) return
    let reads = 0
    const timer = setInterval(() => {
      reads += 1
      if (reads > 10) clearInterval(timer)
      else refreshWallet()
    }, 1_500)
    return () => clearInterval(timer)
  }, [approvalConfirmed, approvalNeeded, refreshWallet])
  // A one-click trade carried through sign-in continues once nothing comes first (approval, balance), else it stops there.
  const carried = demo && state.tradeWhenReady && signedIn && block === null
  useEffect(() => {
    if (!carried) return
    if (short || tooSmall || approvalNeeded === true) actions.clearTradeWhenReady()
    else if (approvalNeeded === false || funding.status === "error" || walletCash.status === "error") actions.tradeNow()
  }, [carried, short, tooSmall, approvalNeeded, funding.status, walletCash.status, actions])
  // A finished trade changed both balances.
  const settled = demo && attempt?.status === "ACCEPTED" && attempt.order?.state === "COMPLETED"
  useEffect(() => {
    if (settled) refreshWallet()
  }, [settled, refreshWallet])

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
      value={demo && !sell ? receiveValue : state.quantityInput}
      // Exact base units of the typed quantity, like the cash side's (also keeps both fields the same height).
      subValue={demo ? undefined : state.quantityCheck.ok ? `${state.quantityCheck.baseUnits} base units (9 decimals)` : "9 decimals max"}
      onChange={actions.setQuantity}
      filter={(next) => isDecimalKeystroke(next, STOCKS_QUANTITY_SCALE)}
      balanceLabel={demo ? "Balance" : "Available to sell"}
      balance={shownHolding === null ? (demo ? "--" : undefined) : `${formatSignedQuantity(shownHolding)} NVDA`}
      onMax={maxInput === null ? undefined : () => actions.setQuantity(maxInput)}
      maxClassName={FOCUS_RING}
      className={FIELD_FOCUS}
      inputRef={inputRef}
      inputProps={{ autoComplete: "off", spellCheck: false, placeholder: demo ? "0" : "0.5", "aria-describedby": overAvailableShown ? `${hintId} ${availableId}` : hintId, "aria-invalid": invalid }}
    />
  )
  const payId = `${inputId}-pay`
  const cashField = demo && !sell ? (
    <AmountField
      key="cash"
      id={payId}
      tone="soft"
      copyButton={false}
      caption="You pay"
      symbol={tusdcCatalog ? cashSymbol ?? "Test cash" : "USDC"}
      icon={<img src="/logos/usdc.svg" alt="" width={18} height={18} />}
      balance={tusdcCatalog && cashBalance !== null ? `${formatCash(cashBalance)} tUSDC` : "--"}
      symbolNote={<TestNote>TEST</TestNote>}
      value={payValue}
      onChange={(next) => actions.setPayAmount(next, marketPrice)}
      filter={(next) => isDecimalKeystroke(next, STOCKS_CASH_SCALE)}
      onMax={cashBalance !== null && cashBalance !== "0" ? () => actions.setPayAmount(formatBaseUnits(cashBalance, STOCKS_CASH_SCALE), marketPrice) : undefined}
      maxClassName={FOCUS_RING}
      className={FIELD_FOCUS}
      inputProps={{ autoComplete: "off", spellCheck: false, placeholder: "0", "aria-describedby": hintId, "aria-invalid": payInvalid }}
    />
  ) : (
    <AmountField
      key="cash"
      display
      tone="soft"
      copyButton={false}
      caption={sell ? "You receive" : "You pay"}
      symbol={tusdcCatalog ? cashSymbol ?? "Test cash" : demo ? "USDC" : cashSymbol ?? "Test cash"}
      icon={demo ? <img src="/logos/usdc.svg" alt="" width={18} height={18} /> : undefined}
      balance={tusdcCatalog ? cashBalance !== null ? `${formatCash(cashBalance)} tUSDC` : "--" : demo ? "--" : undefined}
      symbolNote={<TestNote>TEST</TestNote>}
      value={quote ? formatCash(quote.cashAmount) : demo ? (tradeCash !== null && tradeCash !== "0" ? formatCash(tradeCash) : "0") : "—"}
      subValue={demo ? undefined : quote ? `${quote.cashAmount} base units (6 decimals)` : "Shown after the server quote"}
    />
  )

  const signIn = step.kind === "sign-in" && access?.canSignIn ? access.signIn : undefined
  const accessAction =
    step.kind === "connect"
      ? access?.connectWallet
      : step.kind === "switch"
        ? access?.switchNetwork
        : signIn
          ? // The user states Buy or Sell before signing in; the controller keeps that one choice through this sign-in,
            // and in the customer presentation also the typed quantity, which it quotes once the session lands.
            () => {
              actions.noteSignInIntent(quoteSignsIn && state.quantityCheck.ok ? state.quantityInput : null, quoteSignsIn && state.payInput !== "" ? state.payInput : null)
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
        <button key="access" type="button" className={CTA_READY} onClick={accessAction} disabled={!accessAction || (quoteSignsIn && (!state.quantityCheck.ok || short || tooSmall))} aria-describedby={describedBy}>
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
          {demo ? tradeLabel : step.label}
        </button>
      )
  }
  // Customer presentation, signed in with an amount: approve once, then Buy or Sell in one press (quote → order → the one
  // wallet request). Every busy step stays a focusable, aria-disabled button with its reason.
  const demoTrade = demo && (step.kind === "quote" || step.kind === "requote" || step.kind === "place" || step.kind === "quoting")
  let tradeReady = false
  const busy = (label: string) => (
    <button key="busy" type="button" className={CTA_BUSY} aria-disabled="true" aria-busy="true">
      <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
      {label}
    </button>
  )
  if (demoTrade) {
    if (step.kind === "quoting") cta = busy("Getting price…")
    else if (tooSmall) {
      cta = <button key="submit" type="submit" className={CTA_READY} disabled>{tradeLabel}</button>
    } else if (short) {
      cta = <button key="short" type="button" className={CTA_READY} disabled>{`Not enough ${approveSymbol}`}</button>
    } else if (approval.state.status === "wallet") cta = busy("Approve in your wallet…")
    else if (approving) cta = busy("Confirming approval on GIWA…")
    else if (approvalNeeded === true && target !== null && sessionWallet !== null) {
      const approveTarget = target
      const owner = sessionWallet
      cta = (
        <button key="approve" type="button" className={CTA_READY} onClick={() => void approval.approve({ owner, token: approveTarget.token, spender: approveTarget.spender })}>
          {`Approve ${approveSymbol}`}
        </button>
      )
    } else if (approvalNeeded === null && (funding.status === "loading" || walletCash.status === "loading")) cta = busy("Checking your wallet…")
    else {
      tradeReady = true
      cta = (
        <button key="submit" type="submit" className={CTA_READY}>
          {tradeLabel}
        </button>
      )
    }
  }
  return (
    <section className={demo ? "flex w-full flex-col" : `flex w-full flex-col gap-4 ${INVEST_PANEL_CARD}`} aria-labelledby={demo ? undefined : headingId} aria-label={demo ? "Trade NVDA" : undefined} data-testid="stocks-trade-panel">
      <DemoDetails><Heading id={headingId} headingRef={headingRef}>
        Trade NVDA
      </Heading></DemoDetails>
      <p className="sr-only" aria-live="polite" data-testid="stocks-trade-status">
        {/* The one-click trade's own result view announces its outcome; there is no "order accepted" step to say. */}
        {demo && attempt?.status === "ACCEPTED" ? "" : statusAnnouncement(state)}
      </p>

      {blockNotice || (accessStep && !demo) ? (
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
          {accessStep && !demo ? (
            <>
              {cta}
              {hint}
            </>
          ) : null}
        </div>
      ) : null}

      {attempt === null ? null : demo && (attempt.status === "SUBMITTING" || attempt.status === "ACCEPTED") ? (
        <InstantTradeView attempt={attempt} state={state} actions={actions} cashSymbol={cash} />
      ) : demo && attempt.status === "REJECTED" ? (
        <Notice tone="error">{attempt.error ? attemptErrorMessage(attempt.error, attempt.outcomeUnknown) : "The server refused the order."}</Notice>
      ) : (
        <AttemptView attempt={attempt} state={state} cashSymbol={cashSymbol} actions={actions} />
      )}

      {showForm ? (
        <form
          className="flex w-full flex-col"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            if (demoTrade) {
              if (tradeReady) actions.tradeNow()
            } else if (step.kind === "quote" || step.kind === "requote" || step.kind === "place") actions.requestQuote()
            else if (quoteSignsIn && state.quantityCheck.ok) accessAction?.()
          }}
        >
          <fieldset className="flex w-full min-w-0 flex-col" disabled={block !== null && !quoteSignsIn}>
            <legend className="sr-only">Order side and quantity</legend>
            <DemoDetails><div role="radiogroup" aria-label="Order side" className={`grid w-full grid-cols-2 ${INVEST_TAB_TRACK}`}>
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
            </div></DemoDetails>

            <div className={demo ? "" : "mt-4"}>
              <AmountBlock tone="soft" invalid={invalid}>
                {sell ? [nvdaField, cashField] : [cashField, nvdaField]}
              </AmountBlock>
            </div>
            {tusdcCatalog ? <StocksFundingStatus funding={funding} wallet={walletCash} requiredCash={sell ? null : quote ? quote.cashAmount : demo ? tradeCash : null} /> : null}
            <p id={hintId} className={`mt-2 text-xs ${invalid ? "font-medium text-[var(--color-arco-ink)]" : "text-[var(--color-arco-text-soft)]"}`}>
              {payCheck !== null && !payCheck.ok
                ? PAY_REASON[payCheck.reason] ?? "Enter a valid amount."
                : tooSmall
                  ? sell
                    ? "This quantity pays out less than 0.000001 tUSDC. Enter a larger quantity."
                    : "This amount buys less than 0.000000001 NVDA. Enter a larger amount."
                  : invalid
                    ? QUANTITY_REASON[state.quantityCheck.ok ? "" : state.quantityCheck.reason] ?? "Enter a valid quantity."
                    : demo
                      ? ""
                      : "Up to 9 decimal places. The server calculates the exact test cash amount."}
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
            {/* The customer presentation prices at the chart above; the technical preview shows the catalog price here. */}
            {instrument && !demo ? <InfoRow label="Price" value={`${formatPrice(instrument.price)} ${cash} / NVDA (fixed, test)`} /> : null}
            {quote && !demo ? (
              <div ref={quoteRef} tabIndex={-1} role="group" aria-label="Quote" data-testid="stocks-quote" className={FOCUS_RING}>
                <InfoRow
                  label="Quote"
                  value={state.quote.status === "ready" ? `Valid for ${Math.max(0, Math.ceil((state.quote.deadlineMs - state.nowMs) / 1000))} s on this device` : "Expired"}
                />
              </div>
            ) : null}
            <InfoRow label="Order details" expandable tone="soft" bodyId={detailsId} buttonClassName={FOCUS_RING}>
              <dl className="w-full">
                <OrderDetailFields
                  demo={demo}
                  side={quote?.side ?? state.side}
                  quantity={quote ? quote.quantity : state.quantityCheck.ok ? state.quantityCheck.baseUnits : null}
                  quote={quote}
                  cash={cash}
                  orderCapability={instrument?.orderCapability ?? null}
                  cashSymbol={cashSymbol}
                  deploymentId={catalog?.deploymentId ?? null}
                />
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

          {accessStep && !demo ? null : cta}
          {demoTrade && approval.state.status === "error" ? (
            <div className="mt-3">
              <Notice tone="error">{approvalMessage(approval.state.code, approveSymbol)}</Notice>
            </div>
          ) : null}
          {step.kind === "place" && !demo ? (
            <button type="button" className={`${BUTTON_SECONDARY} mt-2 w-full`} onClick={actions.discardQuote}>
              Discard quote
            </button>
          ) : null}
          {accessStep && !demo ? null : hint}
        </form>
      ) : null}
    </section>
  )
}
