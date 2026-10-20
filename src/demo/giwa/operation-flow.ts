// Savings and Funds in the transaction modal: the steps one press of Invest or Redeem runs (an approval first when the
// vault may not take the payment asset yet, then the operation itself), the words each step and the result screen use,
// and the runner that moves the steps along. Savings reads as a deposit, Funds as an investment, Get ArcoUSD as a
// conversion (either way), and each operation has its own words. Pure: no React, no wallet, no contracts (the hook
// passes the wallet calls in).

import type { ProductOperation } from "./operation-routing"

export type FlowOperation = Exclude<ProductOperation, "claimRedeem">
export type OperationKind = "savings" | "funds" | "convert"
export type OperationStepId = "approve" | "submit"
export type OperationStepState = "upcoming" | "wallet" | "processing" | "done" | "failed"

export type ReviewAmount = Readonly<{
  /** Display text ("1,000"), or null when the panel had no quote for it. */
  amount: string | null
  symbol: string
  /** Logo URL, or null for the letter mark. */
  icon: string | null
  /** The line under the amount ("~$1000.00"), or null. */
  sub: string | null
}>

/** What the panel showed when the user pressed the button. The modal keeps showing it while the steps run. */
export type OperationReview = Readonly<{
  kind: OperationKind
  operation: FlowOperation
  productName: string
  pay: ReviewAmount
  receive: ReviewAmount
  /** Savings: the APY the panel shows ("4.52%"); "—" or null when it is not known. */
  apyText: string | null
}>

export type OperationOutcome =
  | Readonly<{ kind: "success"; hash: string; received: string | null }>
  | Readonly<{ kind: "requested"; hash: string }>
  | Readonly<{ kind: "failed"; message: string }>

export type OperationFlowStep = Readonly<{ id: OperationStepId; state: OperationStepState }>

export type OperationFlow = Readonly<{
  id: number
  review: OperationReview
  steps: readonly OperationFlowStep[]
  outcome: OperationOutcome | null
  /** False once the user closed the modal: nothing more is shown, and no new wallet request starts. */
  open: boolean
}>

export function initialOperationSteps(withApproval: boolean): OperationFlowStep[] {
  return withApproval
    ? [
        { id: "approve", state: "wallet" },
        { id: "submit", state: "upcoming" },
      ]
    : [{ id: "submit", state: "wallet" }]
}

/** Operations whose result follows later (a request), not in the same transaction. */
export function isRequestOperation(operation: FlowOperation): boolean {
  return operation === "requestDeposit" || operation === "requestRedeem"
}

/** A plain decimal for display: thousands grouped, at most `maxDecimals` (cut, never rounded up), no trailing zeros. */
export function displayAmount(value: string, maxDecimals = 6): string {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(value.trim())
  if (match === null) return value
  const whole = (match[1] || "0").replace(/^0+(?=\d)/, "")
  const fraction = (match[2] ?? "").slice(0, maxDecimals).replace(/0+$/, "")
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return fraction === "" ? grouped : `${grouped}.${fraction}`
}

// ── the runner ────────────────────────────────────────────────────────────

export type StepOutcome = Readonly<{ ok: true; hash: string; received?: string | null }> | Readonly<{ ok: false; message: string }>

export type OperationFlowDriver = Readonly<{
  /** The approval, or null when the vault can already take the amount. `onSent` fires once the wallet sent it. */
  approve: ((onSent: () => void) => Promise<StepOutcome>) | null
  submit: (onSent: () => void) => Promise<StepOutcome>
  /** True once the user closed the modal: the next wallet request is not started. */
  stopped: () => boolean
  step: (id: OperationStepId, state: OperationStepState) => void
  finish: (outcome: OperationOutcome) => void
  /** A request (requestDeposit / requestRedeem): it ends as "requested", not "success". */
  requested: boolean
}>

/**
 * The approval when needed, then the operation, one wallet request at a time. A failure stops the flow at its step.
 * Closing the modal lets a transaction already sent finish, but starts no new wallet request.
 */
export async function runOperationFlow(driver: OperationFlowDriver): Promise<void> {
  if (driver.approve !== null) {
    const approved = await driver.approve(() => driver.step("approve", "processing"))
    if (!approved.ok) {
      driver.step("approve", "failed")
      driver.finish({ kind: "failed", message: approved.message })
      return
    }
    driver.step("approve", "done")
    if (driver.stopped()) return
    driver.step("submit", "wallet")
  }
  const submitted = await driver.submit(() => driver.step("submit", "processing"))
  if (!submitted.ok) {
    driver.step("submit", "failed")
    driver.finish({ kind: "failed", message: submitted.message })
    return
  }
  driver.step("submit", "done")
  driver.finish(
    driver.requested
      ? { kind: "requested", hash: submitted.hash }
      : { kind: "success", hash: submitted.hash, received: submitted.received ?? null },
  )
}

// ── the words ─────────────────────────────────────────────────────────────

type Words = Readonly<{ title: string; payCaption: string; confirm: string; pending: string; success: string }>

const WORDS: Readonly<Record<OperationKind, Readonly<Record<FlowOperation, Words>>>> = {
  savings: {
    deposit: { title: "Review deposit", payCaption: "You deposit", confirm: "Confirm deposit", pending: "Deposit pending…", success: "Deposit successful!" },
    requestDeposit: { title: "Review deposit request", payCaption: "You deposit", confirm: "Confirm deposit request", pending: "Deposit request pending…", success: "Deposit requested" },
    redeemInstant: { title: "Review withdrawal", payCaption: "You withdraw", confirm: "Confirm withdrawal", pending: "Withdrawal pending…", success: "Withdrawal complete!" },
    requestRedeem: { title: "Review withdrawal request", payCaption: "You withdraw", confirm: "Confirm withdrawal request", pending: "Withdrawal request pending…", success: "Withdrawal requested" },
  },
  funds: {
    deposit: { title: "Review investment", payCaption: "You pay", confirm: "Confirm investment", pending: "Investment pending…", success: "Investment successful!" },
    requestDeposit: { title: "Review investment request", payCaption: "You pay", confirm: "Confirm investment request", pending: "Investment request pending…", success: "Investment requested" },
    redeemInstant: { title: "Review redemption", payCaption: "You redeem", confirm: "Confirm redemption", pending: "Redemption pending…", success: "Redemption complete!" },
    requestRedeem: { title: "Review redemption request", payCaption: "You redeem", confirm: "Confirm redemption request", pending: "Redemption request pending…", success: "Redemption requested" },
  },
  // Get ArcoUSD: a stablecoin to ArcoUSD (deposit) or back (instant redemption), the same words either way.
  convert: {
    deposit: { title: "Review conversion", payCaption: "You convert", confirm: "Confirm conversion", pending: "Conversion pending…", success: "Conversion complete!" },
    requestDeposit: { title: "Review conversion request", payCaption: "You convert", confirm: "Confirm conversion request", pending: "Conversion request pending…", success: "Conversion requested" },
    redeemInstant: { title: "Review conversion", payCaption: "You convert", confirm: "Confirm conversion", pending: "Conversion pending…", success: "Conversion complete!" },
    requestRedeem: { title: "Review conversion request", payCaption: "You convert", confirm: "Confirm conversion request", pending: "Conversion request pending…", success: "Conversion requested" },
  },
}

function knownApy(text: string | null): text is string {
  return text !== null && text.trim() !== "" && text !== "—"
}

/** The result screen's line: Savings talks about the yield, Funds about the shares held, a redemption about the payout. */
export function operationResultMessage(review: OperationReview, outcome: Exclude<OperationOutcome, { kind: "failed" }>): string {
  const { kind, operation, pay, receive } = review
  if (kind === "convert") {
    if (outcome.kind === "requested") return `Your ${receive.symbol} arrives in your wallet once the conversion is processed.`
    return outcome.received === null ? `Your ${receive.symbol} is in your wallet.` : `${outcome.received} ${receive.symbol} is in your wallet.`
  }
  if (outcome.kind === "requested") {
    if (operation === "requestDeposit") {
      return kind === "savings"
        ? `Your deposit is queued. Your ${receive.symbol} arrives once it is processed.`
        : `Your investment is queued. Your ${receive.symbol} arrives once it is processed.`
    }
    return kind === "savings"
      ? `Your ${receive.symbol} arrives in your wallet once the withdrawal is processed. Track it in the Pending tab.`
      : `Your ${receive.symbol} payout follows once the redemption is processed. Track it in the Pending tab.`
  }
  const received = outcome.received
  if (operation === "deposit" || operation === "requestDeposit") {
    if (kind === "savings") {
      return knownApy(review.apyText) ? `You're now earning ${review.apyText} APY on your ${pay.symbol}.` : `Your ${pay.symbol} is now earning yield.`
    }
    if (received === null) return `Your ${receive.symbol} is now in your wallet.`
    const place = review.productName.trim() !== "" && review.productName !== receive.symbol ? ` in ${review.productName}` : ""
    return `You now hold ${received} ${receive.symbol}${place}.`
  }
  return received === null ? `Your ${receive.symbol} is back in your wallet.` : `${received} ${receive.symbol} is back in your wallet.`
}

export type OperationStepView = Readonly<{
  id: OperationStepId
  label: string
  walletLabel: string
  processingLabel: string
  hint: string | null
  help: Readonly<{ question: string; answer: string }> | null
  state: OperationStepState
  /** Whose mark the step shows: the paying token (the approval) or the one received (the operation). */
  token: "pay" | "receive"
}>

export type OperationResultView = Readonly<{
  tone: "success" | "pending"
  title: string
  message: string
  from: Readonly<{ amount: string; symbol: string }>
  /** Null when nothing is received yet (a request) or no amount is known. */
  to: Readonly<{ amount: string; symbol: string }> | null
  hash: string
}>

export type OperationFlowView = Readonly<{
  title: string
  payCaption: string
  receiveCaption: string
  steps: readonly OperationStepView[]
  result: OperationResultView | null
  error: string | null
}>

export function operationFlowView(flow: OperationFlow): OperationFlowView {
  const { review, outcome } = flow
  const words = WORDS[review.kind][review.operation]
  const place = review.kind === "savings" ? "savings account" : review.kind === "convert" ? "converter" : "fund"
  const pay = review.pay.symbol
  const steps = flow.steps.map((step): OperationStepView =>
    step.id === "approve"
      ? {
          id: step.id,
          label: `Approve ${pay}`,
          walletLabel: `Approve ${pay} in your wallet`,
          processingLabel: `Approving ${pay}…`,
          hint: step.state === "processing" ? "Waiting for GIWA to confirm the approval." : null,
          help: { question: "Why do I have to approve?", answer: `Approving lets this ${place} take ${pay} from your wallet. You only do this once.` },
          state: step.state,
          token: "pay",
        }
      : {
          id: step.id,
          label: words.confirm,
          walletLabel: `${words.confirm} in your wallet`,
          processingLabel: words.pending,
          hint: step.state === "processing" ? "Waiting for GIWA to confirm your transaction." : null,
          help: null,
          state: step.state,
          token: "receive",
        },
  )
  let result: OperationResultView | null = null
  if (outcome !== null && outcome.kind !== "failed") {
    const received = outcome.kind === "success" ? (outcome.received ?? (review.receive.amount === null ? null : `≈${review.receive.amount}`)) : null
    result = {
      tone: outcome.kind === "success" ? "success" : "pending",
      title: words.success,
      message: operationResultMessage(review, outcome),
      from: { amount: review.pay.amount ?? "", symbol: pay },
      to: received === null ? null : { amount: received, symbol: review.receive.symbol },
      hash: outcome.hash,
    }
  }
  return {
    title: words.title,
    payCaption: words.payCaption,
    receiveCaption: "You receive",
    steps,
    result,
    error: outcome?.kind === "failed" ? outcome.message : null,
  }
}
