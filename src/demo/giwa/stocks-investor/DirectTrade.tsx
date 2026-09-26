// The customer presentation's trade without sign-in. The wallet's own transaction is the order (../stocks-direct): a
// Buy deposits the typed tUSDC to the deployment's funding vault, a Sell escrows the typed NVDA to its redemption escrow,
// each under a new random order key. The server prices it when GIWA confirms it and settles it on the usual path; this
// panel shows the wallet steps, GIWA's receipt and then only the server's progress. It computes no outcome itself: the
// amounts shown before the server answers are the page's estimate at the price on screen.

import { assetLabel } from "../asset-label"
import { useEffect, useId, useMemo, useRef } from "react"
import { Loader2 } from "lucide-react"

import { AmountBlock, AmountField, InfoRow } from "../invest-panel-ui"
import { useStocksFundingReadContext } from "../stocks-execution-host/StocksExecutionProvider"
import {
  clearDirectTrade,
  directTradeActive,
  platformDirectPorts,
  resumeDirectTrade,
  startDirectTrade,
  useDirectTrade,
  type DirectContracts,
  type DirectTrade,
  type DirectTradeCode,
} from "../stocks-direct"
import { useStocksAccess, type GiwaStocksAccess } from "./access"
import type { StocksInvestorActions } from "./actions"
import { approvalMessage, useStocksTokenApproval, type TokenApprovalState } from "./cash-approval"
import { tradeBlock, type StocksInvestorState, type TradeBlock } from "./controller"
import { formatBaseUnits, isDecimalKeystroke, parseHumanDecimal } from "./decimal"
import { formatCash, formatQuantity, formatUsd, tradeBlockMessage } from "./display"
import { SIGNED_OUT_FUNDING, StocksFundingStatus, useStocksWalletCash } from "./funding-status"
import { BURN_FEE_BPS, buyCost, buyQuantity, formatFee, MINT_FEE_BPS, perShareCash, priceUnits, sellPayout } from "./pricing"
import { orderStatusMeaning } from "./status"
import { CTA_BUSY, CTA_READY, FIELD_FOCUS, NvdaMark, TestNote } from "./trade-parts"
import { STOCKS_CASH_SCALE, STOCKS_QUANTITY_SCALE, type HexAddress, type StocksDirectStatus, type StocksSide } from "./types"
import { BUTTON_SECONDARY, Field, FOCUS_RING, Heading, Notice, useRescueFocus } from "./ui"

/** Why the typed tUSDC ("You pay") cannot be used. */
const PAY_REASON: Record<string, string> = {
  FORMAT: "Enter a plain decimal number, for example 60.",
  PRECISION: "Use at most 6 decimal places.",
  ZERO: "Enter an amount greater than zero.",
  TOO_LARGE: "This amount is above the accepted maximum.",
}

/** Why the typed NVDA quantity cannot be used. */
const QUANTITY_REASON: Record<string, string> = {
  FORMAT: "Enter a plain decimal number, for example 0.5.",
  PRECISION: "Use at most 9 decimal places.",
  ZERO: "Enter a quantity greater than zero.",
  TOO_LARGE: "This quantity is above the accepted maximum.",
}

// ── the next step (one primary action) ────────────────────────────────────

export type DirectStepKind =
  | "connect"
  | "switch"
  | "wallet-unavailable"
  /** No API, catalog not ready, or trading not activated. */
  | "blocked"
  | "amount"
  | "too-small"
  /** The wallet's balances could not be read: refresh first. */
  | "unreadable"
  | "checking"
  | "short"
  | "approve-wallet"
  | "approving"
  | "approve"
  | "trade"

export type DirectStep = Readonly<{ kind: DirectStepKind; label: string; hint: string | null }>

export type DirectStepInput = {
  access: GiwaStocksAccess | null
  /** The connected wallet on GIWA Sepolia, or null. */
  owner: string | null
  block: TradeBlock
  side: StocksSide
  /** What the transaction moves (tUSDC base units for Buy, NVDA base units for Sell), or null without a usable amount. */
  amount: string | null
  tooSmall: boolean
  short: boolean
  /** Null while the wallet's allowance is not known. */
  approvalNeeded: boolean | null
  wallet: "unavailable" | "loading" | "ready" | "error"
  approval: TokenApprovalState["status"]
  cashSymbol: string
}

/** The single next step, in order: wallet → network → catalog → amount → approval → Buy or Sell. There is no sign-in. */
export function directStep(input: DirectStepInput): DirectStep {
  const trade = input.side === "SELL" ? "Sell NVDA" : "Buy NVDA"
  const symbol = input.side === "SELL" ? "NVDA" : input.cashSymbol
  const access = input.access
  if (access?.wallet === "wrong-network") {
    return { kind: "switch", label: "Switch to GIWA Sepolia", hint: access.switchNetwork ? null : "Switch your wallet to GIWA Sepolia (chain 91342) in your wallet app." }
  }
  if (access?.wallet === "unavailable") return { kind: "wallet-unavailable", label: "Wallet not available", hint: "Your wallet cannot send transactions on this page. Reconnect it, then try again." }
  if (access?.wallet === "disconnected" || input.owner === null) {
    return { kind: "connect", label: "Connect wallet", hint: access?.connectWallet ? null : "Connect a wallet using the button at the top of the page." }
  }
  if (input.block === "NO_CLIENT" || input.block === "CATALOG_NOT_READY" || input.block === "NOT_ACTIVATED") return { kind: "blocked", label: trade, hint: null }
  if (input.amount === null) return { kind: "amount", label: trade, hint: null }
  if (input.tooSmall) return { kind: "too-small", label: trade, hint: null }
  if (input.approval === "wallet") return { kind: "approve-wallet", label: "Approve in your wallet…", hint: null }
  if (input.approval === "pending" || (input.approval === "confirmed" && input.approvalNeeded === true)) return { kind: "approving", label: "Confirming approval on GIWA…", hint: null }
  if (input.approvalNeeded === null) return input.wallet === "error" ? { kind: "unreadable", label: trade, hint: null } : { kind: "checking", label: "Checking your wallet…", hint: null }
  if (input.short) return { kind: "short", label: `Not enough ${symbol}`, hint: null }
  if (input.approvalNeeded) return { kind: "approve", label: `Approve ${symbol}`, hint: null }
  return { kind: "trade", label: trade, hint: null }
}

/** Nothing moved: what the wallet or GIWA answered, and what to do next. */
export function directFailureMessage(code: DirectTradeCode, side: StocksSide): string {
  const what = side === "SELL" ? "escrow" : "payment"
  switch (code) {
    case "WALLET_REQUEST_REJECTED":
      return `The ${what} was declined in your wallet. Nothing was sent.`
    case "WALLET_REQUEST_PENDING":
      return "A wallet request is already open. Complete or cancel it in your wallet, then try again."
    case "NOT_ACCEPTED":
      return `GIWA would not accept this ${what}, so your wallet was not asked. Refresh the balance and try again.`
    case "REVERTED":
      return `The ${what} failed on GIWA, so nothing was ${side === "SELL" ? "escrowed" : "paid"}. Check the wallet's test ETH for gas, then try again.`
    default:
      return "The wallet could not send the transaction. Unlock your wallet and try again."
  }
}

/** Why a confirmed transaction was held instead of settled. */
export function directHeldMessage(status: StocksDirectStatus): string {
  const sell = status.side === "SELL"
  switch (status.hold) {
    case "TRADING_PAUSED":
      return `Trading was paused when GIWA confirmed your ${sell ? "escrow" : "payment"}, so it is held for review. Nothing was ${sell ? "sold" : "bought"}.`
    case "PRICE_UNAVAILABLE":
      return `No price could be read when GIWA confirmed your ${sell ? "escrow" : "payment"}, so it is held for review. Nothing was ${sell ? "sold" : "bought"}.`
    case "BELOW_ONE_UNIT":
      return sell
        ? "This quantity pays out less than 0.000001 USDC, so it is held for review. Nothing was sold."
        : "This amount buys less than 0.000000001 NVDA, so it is held for review. Nothing was bought."
    default:
      return orderStatusMeaning({ side: status.side, state: status.state }).detail
  }
}

// ── the trade's progress (instead of the form) ────────────────────────────

function Busy({ children }: { children: string }) {
  return (
    <p className="flex items-center gap-2 text-sm leading-6 text-[var(--color-arco-ink)]">
      <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
      {children}
    </p>
  )
}

/** One line for the polite status region: where the trade stands. */
export function directTradeAnnouncement(trade: DirectTrade | null): string {
  if (trade === null) return ""
  const sell = trade.input.side === "SELL"
  const state = trade.state
  switch (state.phase) {
    case "WALLET":
      return "Confirm the transaction in your wallet."
    case "CONFIRMING":
      return `Waiting for GIWA to confirm your ${sell ? "escrow" : "payment"}.`
    case "SETTLING":
      return sell ? "GIWA confirmed your NVDA. Paying out." : "GIWA confirmed your payment. Delivering NVDA."
    case "DONE":
      return sell ? `Sold. ${formatCash(state.status.cashAmount)} USDC is in your wallet.` : `Bought. ${formatQuantity(state.status.quantity)} NVDA is in your wallet.`
    case "HELD":
      return directHeldMessage(state.status)
    case "SLOW":
      return "Still settling."
    case "FAILED":
      return directFailureMessage(state.code, trade.input.side)
  }
}

export function DirectTradeView({ trade, onMore, onCheckAgain }: { trade: DirectTrade; onMore: () => void; onCheckAgain: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const { state, input } = trade
  const sell = input.side === "SELL"
  useRescueFocus(headingRef, `${trade.id}:${state.phase}`)
  const status = "status" in state ? state.status : null
  // What the transaction moved is exact; what comes back is the page's estimate until the server has priced it.
  const nvda = sell ? `${formatQuantity(input.amount)} NVDA` : status !== null ? `${formatQuantity(status.quantity)} NVDA` : input.estimate !== null ? `≈${formatQuantity(input.estimate)} NVDA` : "NVDA"
  const cash = sell ? (status !== null ? `${formatCash(status.cashAmount)} USDC` : input.estimate !== null ? `≈${formatCash(input.estimate)} USDC` : "USDC") : `${formatCash(input.amount)} USDC`
  const held = state.phase === "HELD"
  const title =
    state.phase === "DONE" ? (sell ? `Sold ${nvda}` : `Bought ${nvda}`)
      : held ? (sell ? "Sale held for review" : "Purchase held for review")
        : sell ? `Selling ${nvda}` : "Buying NVDA"
  const liquidity = state.phase === "SETTLING" && status?.side === "SELL" && status.state === "LIQUIDITY_PENDING"
  return (
    <div className="flex w-full flex-col gap-3" data-testid="stocks-direct-trade" data-phase={state.phase.toLowerCase()}>
      <Heading level={3} headingRef={headingRef}>
        {title}
      </Heading>
      <dl className="w-full">
        <Field label={sell ? "You sell" : "You pay"}>{sell ? nvda : cash}</Field>
        {held ? null : <Field label={state.phase === "DONE" ? "You received" : "You receive"}>{sell ? cash : nvda}</Field>}
      </dl>
      {state.phase === "WALLET" ? <Busy>Confirm the transaction in your wallet…</Busy> : null}
      {state.phase === "CONFIRMING" ? <Busy>{sell ? "Waiting for GIWA to confirm your escrow…" : "Waiting for GIWA to confirm your payment…"}</Busy> : null}
      {state.phase === "SETTLING" ? (
        <Busy>{liquidity ? "Waiting for payout liquidity. Your NVDA stays held until it is paid out." : sell ? "GIWA confirmed your NVDA. Paying out USDC…" : "GIWA confirmed your payment. Delivering NVDA…"}</Busy>
      ) : null}
      {state.phase === "DONE" ? (
        <Notice tone="success" announce="polite">
          {sell ? `${formatCash(state.status.cashAmount)} USDC is in your wallet.` : `${formatQuantity(state.status.quantity)} NVDA is in your wallet.`}
        </Notice>
      ) : null}
      {held ? (
        <Notice tone="warning" announce="polite">
          {directHeldMessage(state.status)}
        </Notice>
      ) : null}
      {state.phase === "SLOW" ? (
        <>
          <Notice tone="info">
            {state.stage === "RECEIPT" ? "Your transaction was sent. GIWA has not confirmed it yet." : "GIWA confirmed your transaction. Settlement is taking longer than usual."}
          </Notice>
          <div className="flex flex-wrap gap-3">
            <button type="button" className={BUTTON_SECONDARY} onClick={onCheckAgain}>
              Check again
            </button>
            {/* The sent transaction still settles on its own; this only leaves this view. */}
            <button type="button" className={BUTTON_SECONDARY} onClick={onMore}>
              Start a new trade
            </button>
          </div>
        </>
      ) : null}
      {state.phase === "DONE" || held ? (
        <button type="button" className={BUTTON_SECONDARY} onClick={onMore}>
          {sell ? "Sell more" : "Buy more"}
        </button>
      ) : null}
    </div>
  )
}

// ── the panel ─────────────────────────────────────────────────────────────

export type DirectTradePanelProps = {
  state: StocksInvestorState
  actions: StocksInvestorActions
  contracts: DirectContracts
  /** The live NVDA price the market chart shows; amounts are previewed at it (else at the catalog price). */
  marketPrice?: string | null
}

/** The quote row's "?": what its per-share price is and when the real one is set. */
const QUOTE_HELP = "What one NVDA costs (Buy) or pays out (Sell) at the live price above, fees included. The server sets the final price when GIWA confirms your transaction."

export function DirectTradePanel({ state, actions, contracts, marketPrice = null }: DirectTradePanelProps) {
  const access = useStocksAccess()
  const host = useStocksFundingReadContext()
  const view = host?.view
  const owner = view?.wallet.address && view.wallet.chainId === 91342 ? (view.wallet.address.toLowerCase() as HexAddress) : null
  const apiBase = view?.apiBase ?? null
  const hostFetch = host?.fetch
  const ports = useMemo(() => (apiBase === null ? null : platformDirectPorts({ apiBase, fetch: hostFetch })), [apiBase, hostFetch])
  const inputId = useId()
  const payId = `${inputId}-pay`
  const hintId = `${inputId}-hint`
  const ctaHintId = `${inputId}-cta-hint`
  const detailsId = `${inputId}-details`
  const inputRef = useRef<HTMLInputElement>(null)
  const catalog = state.catalog.status === "ready" ? state.catalog.catalog : null
  const instrument = catalog?.instruments.find((item) => item.symbol === "NVDA") ?? null
  const sell = state.side === "SELL"
  // The wallet's tUSDC, NVDA and what it has approved to the funding vault and the escrow, at one GIWA head block.
  const walletCash = useStocksWalletCash(true, contracts.fundingVault, undefined, undefined, { token: contracts.stockToken, spender: contracts.redemptionEscrow }, true)
  const approval = useStocksTokenApproval(walletCash.refresh)
  const trade = useDirectTrade(owner)
  const showTrade = trade !== null && trade.state.phase !== "FAILED"
  const read = walletCash.data
  const cashSymbol = assetLabel(read?.cashSymbol ?? "tUSDC")

  // Amounts: a Buy pays the typed tUSDC (or, with NVDA typed, its cost at the price on screen); a Sell escrows the typed NVDA.
  const unitPrice = priceUnits(marketPrice) ?? priceUnits(instrument?.price)
  const payCheck = !sell && state.payInput !== "" ? parseHumanDecimal(state.payInput, STOCKS_CASH_SCALE) : null
  const quantityTyped = state.quantityInput !== "" && payCheck === null
  const invalid = payCheck !== null ? !payCheck.ok : quantityTyped && !state.quantityCheck.ok
  const buyCash = sell ? null : payCheck !== null ? (payCheck.ok ? payCheck.baseUnits : null) : state.quantityCheck.ok && unitPrice !== null ? buyCost(BigInt(state.quantityCheck.baseUnits), unitPrice).toString() : null
  const sellQuantity = sell && state.quantityCheck.ok ? state.quantityCheck.baseUnits : null
  const amount = sell ? sellQuantity : buyCash
  const estimate = amount === null || unitPrice === null ? null : (sell ? sellPayout(BigInt(amount), unitPrice) : buyQuantity(BigInt(amount), unitPrice)).toString()
  const tooSmall = estimate === "0"
  const allowed = read === null ? null : sell ? (read.stockSpender === contracts.redemptionEscrow ? read.stockAllowance : null) : read.spender === contracts.fundingVault ? read.allowance : null
  const spendable = read === null ? null : sell ? read.stockBalance : read.balance
  const short = amount !== null && spendable !== null && BigInt(spendable) < BigInt(amount)
  const approvalNeeded = amount === null || allowed === null ? null : BigInt(allowed) < BigInt(amount)
  const block = tradeBlock(state)
  const step = directStep({ access, owner, block, side: state.side, amount, tooSmall, short, approvalNeeded, wallet: walletCash.status, approval: approval.state.status, cashSymbol })
  const blockNotice = block === "NO_CLIENT" || block === "CATALOG_NOT_READY" || block === "NOT_ACTIVATED" ? block : null

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
  // Balances change when GIWA confirms the transaction and again when it settles.
  const phase = trade?.state.phase ?? null
  useEffect(() => {
    if (phase === "SETTLING" || phase === "DONE" || phase === "HELD") refreshWallet()
  }, [phase, refreshWallet])

  // A new amount or side forgets a failed attempt's message; an active trade is never forgotten.
  const forget = () => clearDirectTrade(owner)
  const setPay = (next: string) => { forget(); actions.setPayAmount(next, marketPrice) }
  const setQuantity = (next: string) => { forget(); actions.setQuantity(next) }
  const more = () => {
    clearDirectTrade(owner)
    if (sell) actions.setQuantity("")
    else actions.setPayAmount("", marketPrice)
  }
  const submit = () => {
    if (step.kind !== "trade" || owner === null || amount === null || ports === null || directTradeActive(trade)) return
    startDirectTrade({ side: state.side, owner, contracts, amount, estimate }, ports)
  }
  const approve = () => {
    if (owner === null) return
    void approval.approve(sell ? { owner, token: contracts.stockToken, spender: contracts.redemptionEscrow } : { owner, token: contracts.cashToken, spender: contracts.fundingVault })
  }

  const stockBalance = read?.stockBalance ?? null
  const nvdaField = (
    <AmountField
      key="nvda"
      id={inputId}
      tone="soft"
      copyButton={false}
      caption={sell ? "You sell" : "You receive"}
      symbol="NVDA"
      icon={<NvdaMark />}
      symbolNote={<TestNote>Test units</TestNote>}
      value={sell ? state.quantityInput : payCheck !== null ? (estimate !== null && estimate !== "0" ? formatBaseUnits(estimate, STOCKS_QUANTITY_SCALE) : "") : state.quantityInput}
      onChange={setQuantity}
      filter={(next) => isDecimalKeystroke(next, STOCKS_QUANTITY_SCALE)}
      balance={stockBalance === null ? "--" : `${formatQuantity(stockBalance)} NVDA`}
      onMax={sell && stockBalance !== null && stockBalance !== "0" ? () => setQuantity(formatBaseUnits(stockBalance, STOCKS_QUANTITY_SCALE)) : undefined}
      maxClassName={FOCUS_RING}
      className={FIELD_FOCUS}
      inputRef={inputRef}
      inputProps={{ autoComplete: "off", spellCheck: false, placeholder: "0", "aria-describedby": hintId, "aria-invalid": sell || quantityTyped ? invalid : false }}
    />
  )
  const cashBalance = read?.balance ?? null
  const cashField = sell ? (
    <AmountField
      key="cash"
      display
      tone="soft"
      copyButton={false}
      caption="You receive"
      symbol={cashSymbol}
      icon={<img src="/logos/usdc.svg" alt="" width={18} height={18} />}
      balance={cashBalance === null ? "--" : `${formatCash(cashBalance)} USDC`}
      symbolNote={<TestNote>TEST</TestNote>}
      value={estimate !== null && estimate !== "0" ? formatCash(estimate) : "0"}
    />
  ) : (
    <AmountField
      key="cash"
      id={payId}
      tone="soft"
      copyButton={false}
      caption="You pay"
      symbol={cashSymbol}
      icon={<img src="/logos/usdc.svg" alt="" width={18} height={18} />}
      balance={cashBalance === null ? "--" : `${formatCash(cashBalance)} USDC`}
      symbolNote={<TestNote>TEST</TestNote>}
      value={state.payInput !== "" ? state.payInput : buyCash !== null ? formatBaseUnits(buyCash, STOCKS_CASH_SCALE) : ""}
      onChange={setPay}
      filter={(next) => isDecimalKeystroke(next, STOCKS_CASH_SCALE)}
      onMax={cashBalance !== null && cashBalance !== "0" ? () => setPay(formatBaseUnits(cashBalance, STOCKS_CASH_SCALE)) : undefined}
      maxClassName={FOCUS_RING}
      className={FIELD_FOCUS}
      inputProps={{ autoComplete: "off", spellCheck: false, placeholder: "0", "aria-describedby": hintId, "aria-invalid": payCheck !== null && !payCheck.ok }}
    />
  )

  const busy = step.kind === "checking" || step.kind === "approve-wallet" || step.kind === "approving"
  const accessAction = step.kind === "connect" ? access?.connectWallet : step.kind === "switch" ? access?.switchNetwork : undefined
  const describedBy = step.hint ? ctaHintId : undefined
  const cta = busy ? (
    <button key="busy" type="button" className={CTA_BUSY} aria-disabled="true" aria-busy="true">
      <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
      {step.label}
    </button>
  ) : step.kind === "connect" || step.kind === "switch" || step.kind === "wallet-unavailable" ? (
    <button key="access" type="button" className={CTA_READY} onClick={accessAction} disabled={!accessAction} aria-describedby={describedBy}>
      {step.label}
    </button>
  ) : step.kind === "approve" ? (
    <button key="approve" type="button" className={CTA_READY} onClick={approve}>
      {step.label}
    </button>
  ) : (
    <button key="trade" type="submit" className={CTA_READY} disabled={step.kind !== "trade"}>
      {step.label}
    </button>
  )
  const failed = trade !== null && trade.state.phase === "FAILED" ? trade.state.code : null
  const amountHint = payCheck !== null && !payCheck.ok
    ? PAY_REASON[payCheck.reason] ?? "Enter a valid amount."
    : invalid && !state.quantityCheck.ok
      ? QUANTITY_REASON[state.quantityCheck.reason] ?? "Enter a valid quantity."
      : tooSmall
      ? sell
        ? "This quantity pays out less than 0.000001 USDC. Enter a larger quantity."
        : "This amount buys less than 0.000000001 NVDA. Enter a larger amount."
      : ""

  return (
    <section className="flex w-full flex-col" aria-label="Trade NVDA" data-testid="stocks-trade-panel" data-mode="direct">
      <p className="sr-only" aria-live="polite" data-testid="stocks-trade-status">
        {/* The result and failure notices announce themselves; the steps before them are said here. */}
        {phase === "WALLET" || phase === "CONFIRMING" || phase === "SETTLING" || phase === "SLOW" ? directTradeAnnouncement(trade) : ""}
      </p>
      {blockNotice !== null ? <Notice tone="info">{tradeBlockMessage(blockNotice)}</Notice> : null}
      {showTrade && trade !== null ? (
        <DirectTradeView trade={trade} onMore={more} onCheckAgain={() => { if (ports !== null) resumeDirectTrade(owner, ports) }} />
      ) : (
        <form
          className="flex w-full flex-col"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <fieldset className="flex w-full min-w-0 flex-col" disabled={blockNotice !== null}>
            <legend className="sr-only">Order amount</legend>
            <AmountBlock tone="soft" invalid={invalid}>
              {sell ? [nvdaField, cashField] : [cashField, nvdaField]}
            </AmountBlock>
            <StocksFundingStatus funding={SIGNED_OUT_FUNDING} wallet={walletCash} requiredCash={sell ? null : amount} />
            <p id={hintId} className={`mt-2 text-xs ${invalid ? "font-medium text-[var(--color-arco-ink)]" : "text-[var(--color-arco-text-soft)]"}`}>
              {amountHint}
            </p>
          </fieldset>
          <div className="mt-3">
            {unitPrice !== null ? (
              <InfoRow
                label="Quote"
                help={QUOTE_HELP}
                value={<>{`1 NVDA = ${formatCash(perShareCash(state.side, unitPrice).toString())} USDC`} <span className="text-[var(--color-arco-text-soft)]">{`(${formatUsd(unitPrice.toString())})`}</span></>}
              />
            ) : null}
            <InfoRow label="Order details" expandable tone="soft" bodyId={detailsId} buttonClassName={FOCUS_RING}>
              <dl className="w-full">
                <Field label="Mint fee">{formatFee(MINT_FEE_BPS)}</Field>
                <Field label="Burn fee">{formatFee(BURN_FEE_BPS)}</Field>
              </dl>
            </InfoRow>
          </div>
          {cta}
          {step.hint ? (
            <p id={ctaHintId} className="mt-2 text-xs leading-5 text-[var(--color-arco-text-soft)]">
              {step.hint}
            </p>
          ) : null}
          {approval.state.status === "error" ? (
            <div className="mt-3">
              <Notice tone="error">{approvalMessage(approval.state.code, sell ? "NVDA" : cashSymbol)}</Notice>
            </div>
          ) : null}
          {failed !== null ? (
            <div className="mt-3">
              <Notice tone="error" announce="polite">{directFailureMessage(failed, trade?.input.side ?? state.side)}</Notice>
            </div>
          ) : null}
        </form>
      )}
    </section>
  )
}
