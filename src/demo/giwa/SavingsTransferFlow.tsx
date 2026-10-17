// Deposit and withdraw on the Savings page, as a full-screen flow: the amount, a review, the wallet steps, then the
// result. The contract calls are the product page's (useGiwaProductOperation): one press starts the approval when one
// is needed, then the deposit or withdrawal, and closing the screen mid-way lets a sent transaction finish.
//
// Safety: the hook's operation (which sets the amount's decimals) is only switched to this screen's kind once no
// earlier transaction is in flight, and Confirm re-checks every prerequisite, so a reopened screen can never start a
// second transaction next to one still running.

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react"
import { AlertCircle, ArrowDown, ArrowLeft, Check, Loader2, Sprout, Wallet, X } from "lucide-react"
import { BrandMark } from "../components/BrandMark"
import { vaultConfigOf, vaultDisplayName } from "./catalog"
import { GiwaNetworkIcon, PendingRedemptionList } from "./components"
import { GIWA_FAUCET_URL } from "./config"
import { displayAmount, operationFlowView, type FlowOperation, type OperationFlowView, type OperationReview } from "./operation-flow"
import { computeQuote, navSharePrice, navSharePriceValue } from "./price-policy"
import { SavingsDialog } from "./SavingsDialog"
import { groupDigits, shortAddress, tokenAmount, usd } from "./savings-format"
import {
  BUSY_PHASES,
  amountForPercent,
  operationMatchesMode,
  pendingWithdrawals,
  percentOfBalance,
  redemptionTimelineText,
  sanitizeAmountInput,
  transferCta,
  type TransferCta,
  type TransferMode,
} from "./savings-transfer"
import type { GiwaVaultDetail } from "./useGiwaVaultDetail"
import { explorerTx } from "./wallet"

const SHARE_DECIMALS = 18
const CARD = "rounded-[20px] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)]"
const SOFT = "text-[var(--color-arco-text-soft)]"
const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
const PRIMARY = `inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[var(--radius-pill)] bg-[var(--color-arco-ink)] px-5 text-sm font-medium text-[var(--color-arco-on-dark)] disabled:bg-[var(--color-arco-muted)] ${FOCUS}`
const SECONDARY = `inline-flex min-h-12 w-full items-center justify-center rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-5 text-sm font-medium text-[var(--color-arco-ink)] hover:bg-[var(--color-arco-border)] ${FOCUS}`
const SHORTCUT = `inline-flex min-h-8 items-center rounded-[var(--radius-pill)] px-2.5 text-[11px] font-medium text-[var(--color-arco-ink)] ring-1 ring-[var(--color-arco-border)] hover:bg-[var(--color-arco-chip)] disabled:opacity-50 ${FOCUS}`
// The native range keeps the keyboard and screen-reader behaviour; its track is transparent so the four-segment track
// drawn under it shows through, and only its thumb is painted.
const SLIDER =
  "relative z-10 h-5 w-full cursor-pointer appearance-none bg-transparent focus-visible:outline-none disabled:cursor-not-allowed " +
  "[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent " +
  "[&::-webkit-slider-thumb]:-mt-1.5 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-[var(--radius-pill)] " +
  "[&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-[var(--color-arco-border)] [&::-webkit-slider-thumb]:bg-[var(--color-arco-surface)] " +
  "[&::-webkit-slider-thumb]:shadow-[0_1px_3px_var(--color-arco-ink-40)] " +
  "focus-visible:[&::-webkit-slider-thumb]:outline focus-visible:[&::-webkit-slider-thumb]:outline-2 focus-visible:[&::-webkit-slider-thumb]:outline-[var(--color-arco-ink)] " +
  "[&::-moz-range-track]:h-1 [&::-moz-range-track]:bg-transparent " +
  "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-[var(--radius-pill)] [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-[var(--color-arco-border)] " +
  "[&::-moz-range-thumb]:bg-[var(--color-arco-surface)] [&::-moz-range-thumb]:shadow-[0_1px_3px_var(--color-arco-ink-40)]"

type Step = "input" | "review" | "flow"

/** What was left running when the screen closed. `approvalOnly`: the approval finishes but the deposit is not sent. */
export type TransferLeftRunning = Readonly<{ mode: TransferMode; approvalOnly: boolean }>

export type SavingsTransferFlowProps = {
  open: boolean
  mode: TransferMode
  /** Null when nothing was in flight; otherwise what keeps running after the screen closed. */
  onClose: (leftRunning: TransferLeftRunning | null) => void
  detail: Pick<GiwaVaultDetail, "panel" | "market" | "instantLiquidityUsd" | "baseUsd" | "vaultImage">
  /** The wallet coin ("USDC", "tWETH") and its mark. */
  paySymbol: string
  payIcon: string | undefined
  tokenSymbol: string
  tokenIcon: string | undefined
  apyPercent: number | null
  apyText: string
  /** The savings balance before this transfer, in USD (for "You are now earning"); null while unknown. */
  savingsUsd: number | null
  /** The connected wallet, shown as the recipient. */
  recipient: string | null
}

const numberOr = (value: string, fallback: number) => {
  const parsed = Number(value)
  return value.trim() !== "" && Number.isFinite(parsed) ? parsed : fallback
}

const balanceText = (balance: string) => (balance === "--" ? "—" : tokenAmount(numberOr(balance, 0)))

function stepText(step: OperationFlowView["steps"][number]): string {
  return step.state === "wallet" ? step.walletLabel : step.state === "processing" ? step.processingLabel : step.label
}

/** A segmented four-quarter track, filled in ink up to `percent`. */
function SegmentedTrack({ percent }: { percent: number }) {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 gap-[3px]">
      {[0, 1, 2, 3].map((quarter) => {
        const fill = Math.min(100, Math.max(0, (percent - quarter * 25) * 4))
        return (
          <span
            key={quarter}
            className="h-1 flex-1 rounded-[var(--radius-pill)]"
            style={{ backgroundImage: `linear-gradient(to right, var(--color-arco-ink) ${fill}%, var(--color-arco-chip) ${fill}%)` }}
          />
        )
      })}
    </span>
  )
}

function TokenMark({ src, label, size = 36 }: { src: string | undefined; label: string; size?: number }) {
  return (
    <span className="relative inline-flex shrink-0">
      <BrandMark src={src} label={label} size={size} />
      <span className="absolute -bottom-1 -left-1 inline-flex size-4 items-center justify-center overflow-hidden rounded-[5px] bg-[var(--color-arco-surface)] ring-1 ring-[var(--color-arco-border)]">
        <GiwaNetworkIcon size={14} />
      </span>
    </span>
  )
}

function TokenRow({ icon, symbol, balance, right }: { icon: string | undefined; symbol: string; balance: string; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-[14px] bg-[var(--color-arco-page)] px-3 py-2.5">
      <TokenMark src={icon} label={symbol} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[var(--color-arco-ink)]">{symbol}</p>
        <p className={`text-xs tabular-nums ${SOFT}`}>
          <span className="sr-only">Balance </span>
          {balance}
        </p>
      </div>
      {right}
    </div>
  )
}

function ReceiveFigure({ amount, value }: { amount: string; value: string }) {
  return (
    <span className="text-right">
      <span className="block text-base font-medium tabular-nums text-[var(--color-arco-up-text)]">+{amount}</span>
      <span className={`block text-xs tabular-nums ${SOFT}`}>{value}</span>
    </span>
  )
}

function SavingsBadge({ apyText }: { apyText: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-1">
      <span className="flex items-center gap-1.5 text-sm font-semibold tracking-tight text-[var(--color-arco-ink)]">
        Arco
        <span className="rounded-[var(--radius-pill)] px-2 py-px text-[11px] font-medium tracking-[0.08em] ring-1 ring-[var(--color-arco-ink)]">SAVINGS</span>
      </span>
      <span className={`text-xs ${SOFT}`}>Current APY: {apyText}</span>
    </div>
  )
}

function Divider() {
  return (
    <div aria-hidden="true" className="relative z-10 -my-2.5 flex justify-center">
      <span className="inline-flex size-7 items-center justify-center rounded-[var(--radius-pill)] border border-[var(--color-arco-border)] bg-[var(--color-arco-page)] text-[var(--color-arco-text-soft)]">
        <ArrowDown className="size-3.5" />
      </span>
    </div>
  )
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className={`mt-3 flex items-start gap-2 rounded-[14px] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-3 text-xs leading-5 ${SOFT}`}>
      <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  )
}

function AmountEntry({
  inputRef,
  label,
  amount,
  onAmount,
  decimals,
  balance,
  valueText,
}: {
  inputRef: RefObject<HTMLInputElement>
  label: string
  amount: string
  onAmount: (value: string) => void
  decimals: number
  balance: string
  valueText: string
}) {
  // Thousands separators only while the field is not being typed in: a typed comma may be a decimal comma.
  const [focused, setFocused] = useState(false)
  const percent = percentOfBalance(amount, balance, decimals)
  const canFill = numberOr(balance, 0) > 0
  return (
    <div className="px-1 pb-1 pt-4">
      <input
        ref={inputRef}
        aria-label={label}
        inputMode="decimal"
        autoComplete="off"
        placeholder="0"
        value={focused ? amount : groupDigits(amount)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => onAmount(sanitizeAmountInput(event.target.value, Math.min(decimals, 6)))}
        className="w-full bg-transparent text-center text-[44px] font-medium leading-[52px] tabular-nums text-[var(--color-arco-ink)] outline-none placeholder:text-[var(--color-arco-muted)]"
      />
      <p className={`mt-0.5 text-center text-sm tabular-nums ${SOFT}`}>{valueText}</p>
      <div className="relative mt-5">
        <SegmentedTrack percent={percent} />
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(percent)}
          disabled={!canFill}
          aria-label="Share of your balance"
          aria-valuetext={`${Math.round(percent)}%`}
          onChange={(event) => onAmount(amountForPercent(balance, Number(event.target.value), decimals))}
          className={SLIDER}
        />
      </div>
      <div className="mt-3 flex items-center justify-between gap-1.5">
        <button type="button" className={SHORTCUT} onClick={() => onAmount("")}>
          CLEAR
        </button>
        {[25, 50, 75].map((share) => (
          <button key={share} type="button" className={SHORTCUT} disabled={!canFill} onClick={() => onAmount(amountForPercent(balance, share, decimals))}>
            {share}%
          </button>
        ))}
        <button type="button" className={SHORTCUT} disabled={!canFill} onClick={() => onAmount(amountForPercent(balance, 100, decimals))}>
          MAX
        </button>
      </div>
    </div>
  )
}

function StepList({ steps }: { steps: OperationFlowView["steps"] }) {
  return (
    <ol aria-label="Transaction steps" className="space-y-2">
      {steps.map((step, index) => {
        const active = step.state === "wallet" || step.state === "processing"
        return (
          <li key={step.id} data-step={step.id} data-state={step.state} aria-current={active ? "step" : undefined} className="flex items-center gap-3">
            <span aria-hidden="true" className="inline-flex size-6 shrink-0 items-center justify-center">
              {step.state === "done" ? (
                <Check className="size-4 text-[var(--color-arco-up)]" strokeWidth={3} />
              ) : step.state === "processing" ? (
                <Loader2 className="size-4 animate-spin text-[var(--color-arco-ink)] motion-reduce:animate-none" />
              ) : step.state === "failed" ? (
                <X className="size-4 text-[var(--color-arco-down)]" />
              ) : step.state === "wallet" ? (
                <Wallet className="size-4 text-[var(--color-arco-ink)]" />
              ) : (
                <span className="size-1.5 rounded-[var(--radius-pill)] bg-[var(--color-arco-text-soft)]" />
              )}
            </span>
            <span className={`min-w-0 flex-1 text-sm ${active || step.state === "failed" ? "font-medium text-[var(--color-arco-ink)]" : SOFT}`}>
              {stepText(step)}
              {step.state === "done" && <span className="sr-only"> (done)</span>}
            </span>
            {active && (
              <span className={`shrink-0 text-xs ${SOFT}`}>
                Step {index + 1} of {steps.length}
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

export function SavingsTransferFlow({
  open,
  mode,
  onClose,
  detail,
  paySymbol,
  payIcon,
  tokenSymbol,
  tokenIcon,
  apyPercent,
  apyText,
  savingsUsd,
  recipient,
}: SavingsTransferFlowProps) {
  const { panel, market, instantLiquidityUsd, baseUsd } = detail
  const titleId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const stepsRef = useRef<HTMLDivElement>(null)
  const [step, setStep] = useState<Step>("input")
  const [startedFlow, setStartedFlow] = useState<number | null>(null)
  const [earningPerYear, setEarningPerYear] = useState<number | null>(null)
  const [resetPending, setResetPending] = useState(false)
  const panelRef = useRef(panel)
  panelRef.current = panel
  const busy = BUSY_PHASES.includes(panel.phase)

  // Every opening starts on the amount screen. The hook is switched to this operation with an empty amount, but only
  // once nothing is in flight: switching resets its phase, which would let a second transaction start beside the first.
  useEffect(() => {
    if (!open) return
    setStep("input")
    setStartedFlow(null)
    setEarningPerYear(null)
    setResetPending(true)
  }, [open, mode])
  useEffect(() => {
    if (!open || !resetPending || busy) return
    setResetPending(false)
    panelRef.current.onOperationChange(mode === "deposit" ? "deposit" : "redeemInstant")
    panelRef.current.onAmountChange("")
  }, [open, resetPending, busy, mode])

  const deposit = mode === "deposit"
  const decimals = deposit ? (panel.product.paymentAsset?.decimals ?? 18) : SHARE_DECIMALS
  const balance = deposit ? panel.paymentBalance : panel.productBalance
  const otherBalance = deposit ? panel.productBalance : panel.paymentBalance
  const amountNumber = numberOr(panel.amount, 0)
  const price = typeof panel.price === "number" ? panel.price : null
  const quote = price !== null ? computeQuote({ payAmount: amountNumber, price, side: deposit ? "invest" : "redeem" }) : null
  const navUsd = market?.navUsd ?? null
  const amountUsd = deposit ? (baseUsd !== null ? amountNumber * baseUsd : null) : navUsd !== null ? amountNumber * navUsd : null
  const payoutUsd = !deposit && quote !== null && baseUsd !== null ? quote * baseUsd : null
  const liquidityShort = payoutUsd !== null && instantLiquidityUsd !== null && payoutUsd > instantLiquidityUsd
  const liquidityInPay = instantLiquidityUsd !== null && baseUsd !== null && baseUsd > 0 ? instantLiquidityUsd / baseUsd : null
  const operation: FlowOperation = deposit ? "deposit" : liquidityShort ? "requestRedeem" : "redeemInstant"
  const sendSymbol = deposit ? paySymbol : tokenSymbol
  const sendIcon = deposit ? payIcon : tokenIcon
  const getSymbol = deposit ? tokenSymbol : paySymbol
  const getIcon = deposit ? tokenIcon : payIcon
  const yearlyEarn = deposit && apyPercent !== null && amountNumber > 0 ? amountNumber * (apyPercent / 100) : null
  const timeline = redemptionTimelineText(vaultConfigOf(panel.product).redemptionTimelineDays)
  const pendingRows = pendingWithdrawals(panel.pendingRedemptions, panel.product.productId)
  const receiveText = quote !== null ? tokenAmount(quote) : "—"
  const receiveValue = deposit ? (amountUsd !== null ? usd(amountUsd) : "") : payoutUsd !== null ? usd(payoutUsd) : ""

  const flow = startedFlow !== null && panel.flow !== null && panel.flow.id >= startedFlow ? panel.flow : null
  const view = flow !== null ? operationFlowView(flow) : null
  const synced = !resetPending && operationMatchesMode(panel.operation, mode)
  const cta = transferCta({ phase: panel.phase, amount: panel.amount, balance, decimals, paused: Boolean(panel.pausedNotice), synced })

  // Focus follows the screen: the amount, the confirm button, the wallet steps. The result focuses its own action.
  useEffect(() => {
    if (!open) return
    if (step === "input") inputRef.current?.focus({ preventScroll: true })
    else if (step === "review") confirmRef.current?.focus({ preventScroll: true })
    else if (flow !== null) stepsRef.current?.focus({ preventScroll: true })
  }, [open, step, flow !== null])

  function close() {
    const running = panel.flow !== null && panel.flow.outcome === null
    // A flow closed before its approval is done stops after the approval: the operation itself is not sent.
    const approvalOnly = running && panel.flow!.steps.some((item) => item.id === "approve" && item.state !== "done")
    if (panel.flow !== null) panel.onFlowClose()
    onClose(running || busy ? { mode, approvalOnly } : null)
  }

  function runPrerequisite(next: TransferCta) {
    if (next.action === "connect") return panel.onConnect()
    if (next.action === "switch-network") return panel.onSwitchNetwork()
    if (next.action === "faucet") window.open(GIWA_FAUCET_URL, "_blank", "noreferrer")
  }

  function runCta() {
    if (cta.action === "review") setStep("review")
    else runPrerequisite(cta)
  }

  function review(): OperationReview {
    const sub = amountUsd !== null ? `~${usd(amountUsd)}` : null
    return {
      kind: "savings",
      operation,
      productName: vaultDisplayName(panel.product),
      pay: { amount: displayAmount(panel.amount), symbol: sendSymbol, icon: sendIcon ?? null, sub },
      receive: { amount: quote !== null ? displayAmount(quote.toFixed(6)) : null, symbol: getSymbol, icon: getIcon ?? null, sub },
      apyText,
    }
  }

  function confirm() {
    // Everything Review checked may have changed since: the wallet, the network, a pause, a transaction in flight.
    if (cta.action !== "review") {
      if (cta.action === null) setStep("input")
      else runPrerequisite(cta)
      return
    }
    setStartedFlow((panel.flow?.id ?? 0) + 1)
    setEarningPerYear(
      deposit && apyPercent !== null && amountUsd !== null && savingsUsd !== null ? (savingsUsd + amountUsd) * (apyPercent / 100) : null,
    )
    setStep("flow")
    panel.onStart(review())
  }

  function again() {
    if (panel.flow !== null) panel.onFlowClose()
    setStartedFlow(null)
    setStep("input")
    setResetPending(true)
  }

  const title = deposit ? "Deposit" : "Withdraw"
  const reviewed = step !== "input"
  const result = view?.result ?? null
  const current = view?.steps.find((item) => item.state === "wallet" || item.state === "processing") ?? null
  // One polite announcer for the whole screen, mounted from the start so every change is read.
  const announcement =
    result !== null
      ? `${result.title} ${result.message}`
      : view?.error
        ? `Transaction failed. ${view.error}`
        : current !== null
          ? stepText(current)
          : ""
  const confirmLabel =
    cta.action !== "review"
      ? cta.label
      : deposit
        ? panel.allowanceRequired
          ? "Approve and Deposit"
          : "Deposit"
        : operation === "requestRedeem"
          ? "Request withdrawal"
          : "Withdraw"

  return (
    <SavingsDialog open={open} onClose={close} labelledBy={titleId} variant="screen" initialFocus={inputRef}>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <div className="sticky top-0 z-20 border-b border-[var(--color-arco-border)] bg-[var(--color-arco-page)]">
        <div className="mx-auto grid h-14 max-w-[960px] grid-cols-[44px_1fr_44px] items-center px-2">
          {step === "review" ? (
            <button
              type="button"
              onClick={() => setStep("input")}
              aria-label="Back"
              className={`inline-flex size-11 items-center justify-center rounded-[var(--radius-pill)] ${SOFT} hover:bg-[var(--color-arco-chip)] ${FOCUS}`}
            >
              <ArrowLeft aria-hidden="true" className="size-5" />
            </button>
          ) : (
            <span />
          )}
          <h2 id={titleId} className="text-center text-sm font-medium text-[var(--color-arco-ink)]">
            {title}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className={`inline-flex size-11 items-center justify-center rounded-[var(--radius-pill)] ${SOFT} hover:bg-[var(--color-arco-chip)] ${FOCUS}`}
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
        <div aria-hidden="true" className="mx-auto -mb-px grid max-w-[380px] grid-cols-2 gap-0.5 px-4">
          <span className="h-0.5 bg-[var(--color-arco-ink)]" />
          <span className={`h-0.5 ${reviewed ? "bg-[var(--color-arco-ink)]" : "bg-transparent"}`} />
        </div>
      </div>

      <div className="mx-auto w-full max-w-[380px] px-4 pb-16 pt-8">
        {result !== null ? (
          <ResultScreen result={result} deposit={deposit} earningPerYear={earningPerYear} timeline={timeline} again={again} close={close} />
        ) : step === "input" ? (
          <>
            {deposit ? (
              <>
                <div className={`${CARD} p-2`}>
                  <TokenRow icon={payIcon} symbol={paySymbol} balance={balanceText(balance)} />
                  <AmountEntry
                    inputRef={inputRef}
                    label={`Amount in ${paySymbol}`}
                    amount={panel.amount}
                    onAmount={panel.onAmountChange}
                    decimals={decimals}
                    balance={balance}
                    valueText={amountUsd !== null ? usd(amountUsd) : "—"}
                  />
                </div>
                <Divider />
                <div className={`${CARD} space-y-2 p-2 pt-3`}>
                  <SavingsBadge apyText={apyText} />
                  {yearlyEarn !== null && (
                    <p className="flex items-center justify-center gap-1.5 rounded-[12px] bg-[var(--color-arco-page)] py-2 text-[13px] font-medium text-[var(--color-arco-up-text)]">
                      <Sprout aria-hidden="true" className="size-3.5" />
                      Earn ~{tokenAmount(yearlyEarn, 2)} {paySymbol}/year
                    </p>
                  )}
                  <TokenRow
                    icon={tokenIcon}
                    symbol={tokenSymbol}
                    balance={balanceText(otherBalance)}
                    right={amountNumber > 0 ? <ReceiveFigure amount={receiveText} value={receiveValue} /> : null}
                  />
                </div>
              </>
            ) : (
              <>
                <div className={`${CARD} space-y-2 p-2 pt-3`}>
                  <SavingsBadge apyText={apyText} />
                  <TokenRow icon={tokenIcon} symbol={tokenSymbol} balance={balanceText(balance)} />
                  <AmountEntry
                    inputRef={inputRef}
                    label={`Amount in ${tokenSymbol}`}
                    amount={panel.amount}
                    onAmount={panel.onAmountChange}
                    decimals={decimals}
                    balance={balance}
                    valueText={amountUsd !== null ? usd(amountUsd) : "—"}
                  />
                </div>
                <Divider />
                <div className={`${CARD} p-2`}>
                  <TokenRow
                    icon={payIcon}
                    symbol={paySymbol}
                    balance={balanceText(otherBalance)}
                    right={amountNumber > 0 ? <ReceiveFigure amount={receiveText} value={receiveValue} /> : null}
                  />
                </div>
              </>
            )}

            {price !== null && price > 0 && (
              <p className={`mt-3 px-3 text-xs tabular-nums ${SOFT}`}>
                {deposit
                  ? `1 ${paySymbol} = ${navSharePriceValue(1 / price)} ${tokenSymbol}${baseUsd !== null ? ` (${usd(baseUsd)})` : ""}`
                  : `1 ${tokenSymbol} = ${navSharePriceValue(price)} ${paySymbol}${navUsd !== null ? ` (${navSharePrice(navUsd)})` : ""}`}
              </p>
            )}

            {!deposit && liquidityShort && !panel.pausedNotice && (
              <Notice>
                {`Instant liquidity is ${liquidityInPay !== null ? tokenAmount(liquidityInPay, 2) : "—"} ${paySymbol}. This withdrawal is processed as a request: your ${tokenSymbol} is redeemed now and the ${paySymbol} follows after processing (${timeline}).`}
              </Notice>
            )}
            {panel.pausedNotice && <Notice>{panel.pausedNotice}</Notice>}

            <button type="button" disabled={cta.disabled} onClick={runCta} className={`${PRIMARY} mt-5`}>
              {busy && <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />}
              {cta.label}
            </button>

            {!deposit && pendingRows.length > 0 && (
              <section aria-labelledby={`${titleId}-pending`} className="mt-8">
                <h3 id={`${titleId}-pending`} className="mb-3 text-sm font-medium text-[var(--color-arco-ink)]">
                  Pending withdrawals
                </h3>
                <PendingRedemptionList rows={pendingRows} product={panel.product} price={price} />
              </section>
            )}
          </>
        ) : (
          <>
            <h3 className="mb-4 text-center text-base font-medium text-[var(--color-arco-ink)]">Review Transaction</h3>
            <div className={`${CARD} px-5 py-4`}>
              <p className={`text-xs ${SOFT}`}>You Send</p>
              <div className="mt-2 flex items-center justify-between gap-3">
                <TokenMark src={sendIcon} label={sendSymbol} />
                <span className="text-right">
                  <span className="block text-lg font-medium tabular-nums text-[var(--color-arco-ink)]">
                    −{displayAmount(panel.amount)} {sendSymbol}
                  </span>
                  <span className={`block text-xs tabular-nums ${SOFT}`}>{amountUsd !== null ? usd(amountUsd) : ""}</span>
                </span>
              </div>
            </div>
            <Divider />
            <div className={`${CARD} px-5 py-4`}>
              <p className={`text-xs ${SOFT}`}>You Receive</p>
              <div className="mt-2 flex items-center justify-between gap-3">
                <TokenMark src={getIcon} label={getSymbol} />
                <span className="text-right">
                  <span className="block text-lg font-medium tabular-nums text-[var(--color-arco-up-text)]">
                    +{receiveText} {getSymbol}
                  </span>
                  <span className={`block text-xs tabular-nums ${SOFT}`}>{receiveValue}</span>
                </span>
              </div>
            </div>
            <p className={`mt-3 flex items-center justify-between gap-3 px-3 text-xs ${SOFT}`}>
              Recipient
              <span className="flex items-center gap-1.5 font-mono text-[var(--color-arco-ink)]">
                <Wallet aria-hidden="true" className="size-3.5 text-[var(--color-arco-text-soft)]" />
                {recipient !== null ? shortAddress(recipient) : "—"}
              </span>
            </p>
            {operation === "requestRedeem" && (
              <Notice>{`This is a withdrawal request. The ${paySymbol} arrives after processing (${timeline}).`}</Notice>
            )}

            {step === "review" || flow === null ? (
              <div className="mt-5 space-y-2.5">
                <button ref={confirmRef} type="button" disabled={cta.disabled} onClick={confirm} className={PRIMARY}>
                  {confirmLabel}
                </button>
                <button type="button" onClick={() => setStep("input")} className={SECONDARY}>
                  Cancel
                </button>
              </div>
            ) : (
              <div ref={stepsRef} tabIndex={-1} className="mt-5 rounded-[16px] bg-[var(--color-arco-chip)] p-4 outline-none">
                <p className={`mb-3 text-center text-[13px] ${SOFT}`}>Continue in your wallet</p>
                <StepList steps={view!.steps} />
                {view!.error !== null && (
                  <>
                    <p role="alert" className="mt-4 flex items-start gap-2 rounded-[12px] bg-[var(--color-arco-surface)] p-3 text-xs leading-5 text-[var(--color-arco-ink)]">
                      <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--color-arco-down)]" />
                      <span className="break-words">{view!.error}</span>
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button type="button" onClick={panel.onFlowRetry} className={PRIMARY}>
                        Try again
                      </button>
                      <button type="button" onClick={again} className={`${SECONDARY} bg-[var(--color-arco-surface)]`}>
                        Cancel
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </SavingsDialog>
  )
}

function ResultScreen({
  result,
  deposit,
  earningPerYear,
  timeline,
  again,
  close,
}: {
  result: NonNullable<OperationFlowView["result"]>
  deposit: boolean
  earningPerYear: number | null
  timeline: string
  again: () => void
  close: () => void
}) {
  const pending = result.tone === "pending"
  return (
    <div className="text-center">
      <div className={`${CARD} px-5 pb-5 pt-8`}>
        <span
          aria-hidden="true"
          className={`mx-auto inline-flex size-20 items-center justify-center rounded-[var(--radius-pill)] ${
            pending ? "bg-[var(--color-arco-chip)]" : "bg-[var(--color-savings-earn-area)]"
          }`}
        >
          <span
            className={`inline-flex size-12 items-center justify-center rounded-[var(--radius-pill)] ring-2 ${
              pending ? "text-[var(--color-arco-ink)] ring-[var(--color-arco-ink)]" : "text-[var(--color-arco-up)] ring-[var(--color-arco-up)]"
            }`}
          >
            {pending ? <Loader2 className="size-6 motion-safe:animate-spin" /> : <Check className="size-6" strokeWidth={2.5} />}
          </span>
        </span>
        <p className="mt-5 text-base font-medium text-[var(--color-arco-ink)]">{result.title}</p>
        {deposit && earningPerYear !== null && !pending ? (
          <>
            <p className={`mt-1 text-sm ${SOFT}`}>You are now earning:</p>
            <div className="mt-4 rounded-[14px] bg-[var(--color-arco-page)] px-4 py-4">
              <p className="text-[28px] font-medium leading-9 tabular-nums text-[var(--color-arco-ink)]">~{usd(earningPerYear)}</p>
              <p className={`text-sm ${SOFT}`}>per year</p>
            </div>
          </>
        ) : !deposit && result.to !== null && !pending ? (
          <>
            <p className={`mt-1 text-sm ${SOFT}`}>You received:</p>
            <div className="mt-4 rounded-[14px] bg-[var(--color-arco-page)] px-4 py-4">
              <p className="text-[28px] font-medium leading-9 tabular-nums text-[var(--color-arco-ink)]">
                {result.to.amount} {result.to.symbol}
              </p>
            </div>
          </>
        ) : (
          <p className={`mx-auto mt-2 max-w-[300px] text-sm leading-6 ${SOFT}`}>
            {pending ? `Your ${result.from.symbol} was redeemed. The payout follows once the withdrawal is processed (${timeline}).` : result.message}
          </p>
        )}
        <a
          href={explorerTx(result.hash)}
          target="_blank"
          rel="noreferrer"
          className={`mt-4 inline-block text-xs font-medium text-[var(--color-arco-ink)] underline underline-offset-2 ${FOCUS}`}
        >
          View on GIWA explorer
        </a>
      </div>
      <div className="mt-5 space-y-2.5">
        {/* The result replaces the review in place, so focus moves to its first action. */}
        <button type="button" onClick={again} className={PRIMARY} autoFocus>
          {deposit ? "Deposit More" : "Withdraw More"}
        </button>
        <button type="button" onClick={close} className={SECONDARY}>
          Back to Savings
        </button>
      </div>
    </div>
  )
}

/**
 * Under the Savings card after the deposit / withdraw screen was closed with a transaction still in flight: what became
 * of it, the same inline status the product page's panel shows.
 */
export function SavingsTransferStatus({
  leftRunning,
  paySymbol,
  panel,
  onDismiss,
}: {
  leftRunning: TransferLeftRunning
  paySymbol: string
  panel: Pick<GiwaVaultDetail["panel"], "phase" | "error" | "successLabel" | "txHashes">
  onDismiss: () => void
}) {
  const busy = BUSY_PHASES.includes(panel.phase)
  const failed = panel.phase === "failed" || panel.error !== null
  const done = panel.phase === "success" || panel.phase === "pending-redemption"
  if (!busy && !failed && !done) return null
  const noun = leftRunning.mode === "deposit" ? "deposit" : "withdrawal"
  const doneText = leftRunning.approvalOnly
    ? `${paySymbol} approved. Open Deposit again to make the deposit.`
    : (panel.successLabel ?? "Transaction confirmed")
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-[16px] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-4 py-3 text-sm"
    >
      <span aria-hidden="true" className="mt-0.5 inline-flex shrink-0">
        {busy ? (
          <Loader2 className="size-4 animate-spin text-[var(--color-arco-ink)] motion-reduce:animate-none" />
        ) : failed ? (
          <AlertCircle className="size-4 text-[var(--color-arco-down)]" />
        ) : (
          <Check className="size-4 text-[var(--color-arco-up)]" strokeWidth={3} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-[var(--color-arco-ink)]">
          {busy ? `Your ${noun} is still processing…` : failed ? `Your ${noun} did not go through` : doneText}
        </p>
        {failed && panel.error && <p className={`mt-0.5 break-words text-xs leading-5 ${SOFT}`}>{panel.error}</p>}
        {!busy && panel.txHashes[0] && (
          <a
            href={explorerTx(panel.txHashes[0])}
            target="_blank"
            rel="noreferrer"
            className={`mt-1 inline-block text-xs font-medium text-[var(--color-arco-ink)] underline underline-offset-2 ${FOCUS}`}
          >
            View on GIWA explorer
          </a>
        )}
      </div>
      {!busy && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className={`-m-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-pill)] ${SOFT} hover:bg-[var(--color-arco-chip)] ${FOCUS}`}
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      )}
    </div>
  )
}
