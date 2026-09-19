// Pure view model for the wallet execution panel.
//
// Input: the controller's WalletSnapshot, the accepted order Selection, the host account, the local
// availability result, the clock value and an optional, separately injected server order status.
// Output: what is shown and which single explicit action may be offered. No I/O, no controller call.
//
// Invariants:
//   • A snapshot is painted only for the order and account on screen (bindSnapshot).
//   • Order details are shown only to the wallet that placed the order.
//   • Amounts are exact base-unit renderings; a small amount is never rounded to zero.
//   • A transaction hash, a confirmed approval or a submitted transfer is never the order result.
//     Only the injected server order state can say COMPLETED.

import type { Hex } from "viem"

import { formatBaseUnits } from "../stocks-investor/decimal"
import { formatUtc } from "../stocks-investor/display"
import { deadlinePassed, orderStatusMeaning, type OrderStatusCategory } from "../stocks-investor/status"
import { BUY_ORDER_STATES, SELL_ORDER_STATES, type StocksOrder } from "../stocks-investor/types"
import { parseOrder } from "../stocks-wallet/planner"
import type { Order, Plan, Selection, Side, Stage, WalletSnapshot } from "../stocks-wallet/types"
import { describeCode } from "./messages"
import type { StocksServerOrderStatus, StocksWalletAvailability, StocksWalletPanelActions } from "./types"

export type PanelKind = WalletSnapshot["status"] | "UNAVAILABLE"
export type PanelAction = keyof StocksWalletPanelActions
export type PanelTone = "info" | "action" | "warning" | "error"
export type PanelButton = Readonly<{ action: PanelAction; label: string; enabled: boolean; opensWallet: boolean }>
export type StepStatus = "todo" | "current" | "done" | "problem"
export type PanelStep = Readonly<{ label: string; status: StepStatus; detail: string }>
export type PanelAmount = Readonly<{ text: string; baseUnits: string; scale: 6 | 9 }>
export type PanelOrder = Readonly<{
  side: Side
  orderId: string
  quantity: PanelAmount
  /** Exact allowance requested from the wallet. Equal to the transfer amount. */
  approval: PanelAmount
  /** Exact deposit (BUY, test cash) or escrow (SELL, NVDA units). */
  transfer: PanelAmount
  /** SELL only: test cash the server pays out if it completes the order. */
  payout: PanelAmount | null
  deadline: string
  expired: boolean
  remaining: string | null
}>
export type PanelServerStatus = Readonly<{ label: string; detail: string; category: OrderStatusCategory | "UNRECOGNIZED"; completed: boolean; observedAt: string | null }>
export type PanelModel = Readonly<{
  kind: PanelKind
  side: Side | null
  /** Null whenever order details must not be shown (no order, invalid order, signed out, other wallet). */
  order: PanelOrder | null
  plan: Plan | null
  /** The scope-bound snapshot actually displayed. */
  snapshot: WalletSnapshot
  tone: PanelTone
  title: string
  paragraphs: readonly string[]
  code: string | null
  stage: Stage | null
  txHash: Hex | null
  txLabel: string | null
  buttons: readonly PanelButton[]
  steps: readonly PanelStep[]
  server: PanelServerStatus | null
  announcement: string
}>

export type PanelInput = {
  snapshot: WalletSnapshot
  selection: Selection | null
  /** The signed-in account of the host scope; null when signed out or mismatched. */
  account: string | null
  availability: StocksWalletAvailability
  /** Same wall clock as the controller (ports.now). */
  now: number
  serverOrder?: StocksServerOrderStatus | null
  /**
   * The host loads current deployment review evidence as the first part of an explicit check. Missing or
   * ended evidence then leaves read-only checks available; wallet-opening steps still need current evidence.
   */
  evidenceRefreshable?: boolean
  /** Stable code of the host's last failed evidence read, shown with the check it belongs to. */
  evidenceFailure?: string | null
}

/** Availability codes that an explicit check can resolve by loading current review evidence. */
export const EVIDENCE_CODES: ReadonlySet<string> = new Set(["DEPLOYMENT_NOT_REVIEWED", "DEPLOYMENT_EVIDENCE_EXPIRED"])

export const IDLE_SNAPSHOT: WalletSnapshot = Object.freeze({ status: "IDLE", orderId: null, intentKey: null, stage: null, txHash: null, error: null, plan: null })

const CASH = "ARCO_TEST_USDC"
const STOCK = "NVDA"

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase()
}

function planMatches(plan: Plan, order: Order, side: Side, account: string): boolean {
  return plan.side === side && plan.order.id === order.id && plan.order.orderKey === order.orderKey && same(plan.order.wallet, order.wallet) && same(order.wallet, account)
}

/**
 * A snapshot is shown only for the order and account on screen. Anything else (a previous account's
 * or order's attempt, or a late result painted for another scope) renders as "not checked": its
 * hash, stage and amounts are never displayed.
 */
export function bindSnapshot(snapshot: WalletSnapshot, order: Order | null, side: Side | null, account: string | null): WalletSnapshot {
  if (snapshot.status === "IDLE") return IDLE_SNAPSHOT
  const plan = snapshot.plan
  if (plan === null) {
    // Only an error-only BLOCKED snapshot has no plan, and it carries no transaction identity.
    const errorOnly = snapshot.status === "BLOCKED" && snapshot.txHash === null && snapshot.stage === null && snapshot.orderId === null && snapshot.intentKey === null
    return errorOnly && order !== null && account !== null ? snapshot : IDLE_SNAPSHOT
  }
  if (order === null || side === null || account === null) return IDLE_SNAPSHOT
  if (!planMatches(plan, order, side, account) || snapshot.orderId !== order.id || snapshot.intentKey !== plan.intentKey) return IDLE_SNAPSHOT
  return snapshot
}

function amount(baseUnits: string, scale: 6 | 9, unit: string): PanelAmount {
  return { text: `${formatBaseUnits(baseUnits, scale, { group: true })} ${unit}`, baseUnits, scale }
}

function remainingText(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours} h ${minutes} min left`
  if (minutes > 0) return `${minutes} min ${rest} s left`
  return `${rest} s left`
}

function summarize(order: Order, side: Side, now: number): PanelOrder {
  const deadline = Date.parse(order.quoteExpiresAt)
  // An unusable clock or deadline fails closed as expired.
  const expired = !Number.isFinite(now) || !Number.isFinite(deadline) || now >= deadline
  const cash = amount(order.cashAmount, 6, CASH)
  const units = amount(order.quantity, 9, STOCK)
  return {
    side,
    orderId: order.id,
    quantity: units,
    approval: side === "SELL" ? units : cash,
    transfer: side === "SELL" ? units : cash,
    payout: side === "SELL" ? cash : null,
    deadline: formatUtc(order.quoteExpiresAt),
    expired,
    remaining: expired ? null : remainingText(deadline - now),
  }
}

function serverStatus(serverOrder: StocksServerOrderStatus | null | undefined, order: Order, side: Side): PanelServerStatus | null {
  if (!serverOrder || serverOrder.orderId !== order.id || serverOrder.side !== side) return null
  const known: readonly string[] = side === "SELL" ? SELL_ORDER_STATES : BUY_ORDER_STATES
  if (typeof serverOrder.state !== "string" || !known.includes(serverOrder.state)) {
    return {
      label: "Unrecognized status",
      detail: "The server reported a status this screen does not recognize. It is not treated as completed.",
      category: "UNRECOGNIZED",
      completed: false,
      observedAt: serverOrder.observedAt,
    }
  }
  const row = { side, state: serverOrder.state, quoteExpiresAt: order.quoteExpiresAt } as unknown as Pick<StocksOrder, "side" | "state" | "quoteExpiresAt">
  const meaning = orderStatusMeaning(row, serverOrder.observedAt)
  return { label: meaning.label, detail: meaning.detail, category: meaning.category, completed: meaning.category === "COMPLETED", observedAt: serverOrder.observedAt }
}

function serverDeadlinePassed(serverOrder: StocksServerOrderStatus | null | undefined, order: Order, side: Side): boolean {
  if (!serverOrder || serverOrder.orderId !== order.id || serverOrder.side !== side) return false
  if (side === "SELL" && serverOrder.state === "EXPIRED") return true
  const row = { state: serverOrder.state, quoteExpiresAt: order.quoteExpiresAt } as unknown as Pick<StocksOrder, "state" | "quoteExpiresAt">
  return deadlinePassed(row, serverOrder.observedAt)
}

/**
 * The controller publishes BLOCKED together with a recorded stage only for a server-verified REVERTED
 * attempt of that stage (inspect, run failure and cancel paths). Error-only BLOCKED has no stage.
 */
function revertedStage(snapshot: WalletSnapshot): Stage | null {
  if (snapshot.status !== "BLOCKED") return null
  if (snapshot.stage !== null) return snapshot.stage
  return snapshot.error === "APPROVAL_REVERTED" ? "APPROVAL" : snapshot.error === "TRANSFER_REVERTED" ? "TRANSFER" : null
}

/**
 * APPROVAL_SUBMITTED means "not yet confirmed" only without a code (the wallet just returned the hash and
 * server verification is starting; if the controller could not start it, for example because the wallet
 * moved to another network, the code stays empty until the next explicit check shows the reason) or with
 * RECEIPT_PENDING (the server's verification said it is still pending). The controller also publishes
 * RECOVERY_REQUIRED for an approval the server already CONFIRMED (for example after cancel), so that code
 * only means "check again", never "unconfirmed".
 */
function approvalAwaitingConfirmation(snapshot: WalletSnapshot): boolean {
  return snapshot.status === "APPROVAL_SUBMITTED" && (snapshot.error === null || snapshot.error === "RECEIPT_PENDING")
}

/** A matching server order state that ends the order (status table `terminal`): COMPLETED, REFUNDED, RETURNED. */
function finalResult(server: PanelServerStatus | null): boolean {
  return server !== null && (server.category === "COMPLETED" || server.category === "RETURNED")
}

/** What the screen can say about the order result for a recorded deposit/escrow request. Never derived from a hash. */
function orderResultSentence(server: PanelServerStatus | null): string {
  if (finalResult(server)) return "The server reports a final result for this order; see the order result below."
  // An unrecognized state is neither called final nor non-final.
  if (server !== null && server.category === "UNRECOGNIZED") return "The server reported an order status this screen does not recognize; see the order result below."
  if (server !== null) return "The server's latest order status is not a final result yet; see the order result below."
  return "No final order result from the server is shown for this order yet."
}

/** Why a displayed wallet step cannot be taken now. */
type StepBlock = "expired" | "movedOn" | "unavailable" | null

const BLOCK_DETAIL: Record<Exclude<StepBlock, null>, string> = { expired: "Deadline passed", movedOn: "Not needed — order moved on", unavailable: "Unavailable" }

function steps(snapshot: WalletSnapshot, side: Side | null, server: PanelServerStatus | null, block: StepBlock): PanelStep[] {
  const { status, stage } = snapshot
  const reverted = revertedStage(snapshot)
  const transferWord = side === "SELL" ? "Escrow" : "Deposit"
  const allowanceInPlace = status === "READY_TRANSFER" || reverted === "TRANSFER" || (stage === "TRANSFER" && (status === "SIGNING" || status === "SUBMITTED" || status === "UNKNOWN"))
  /** Past the deadline or for a moved-on order no deposit/escrow will be offered, whatever the approval does. */
  const noTransfer = block === "expired" || block === "movedOn"

  let approval: PanelStep
  if (status === "APPROVAL_REQUIRED") approval = block ? { label: "Approve exact amount", status: "problem", detail: BLOCK_DETAIL[block] } : { label: "Approve exact amount", status: "current", detail: "Required" }
  else if (status === "SIGNING" && stage === "APPROVAL") approval = { label: "Approve exact amount", status: "current", detail: "Waiting for wallet" }
  else if (status === "APPROVAL_SUBMITTED") approval = { label: "Approve exact amount", status: "current", detail: approvalAwaitingConfirmation(snapshot) && !noTransfer ? "Confirming" : "Approval sent" }
  else if (status === "UNKNOWN" && stage === "APPROVAL") approval = { label: "Approve exact amount", status: "problem", detail: "Result unknown" }
  else if (reverted === "APPROVAL") approval = { label: "Approve exact amount", status: "problem", detail: "Reverted" }
  else if (allowanceInPlace) approval = { label: "Approve exact amount", status: "done", detail: "Allowance in place" }
  // A running check has not decided yet; it never shows an approval it may already have confirmed as "Not checked".
  else if (status === "CHECKING") approval = { label: "Approve exact amount", status: "current", detail: "Checking" }
  else approval = { label: "Approve exact amount", status: "todo", detail: "Not checked" }

  let transfer: PanelStep
  if (status === "READY_TRANSFER") transfer = block ? { label: transferWord, status: "problem", detail: BLOCK_DETAIL[block] } : { label: transferWord, status: "current", detail: "Ready — needs your click" }
  else if (status === "SIGNING" && stage === "TRANSFER") transfer = { label: transferWord, status: "current", detail: "Waiting for wallet" }
  else if (status === "SUBMITTED") transfer = { label: transferWord, status: "done", detail: "Submitted — not the order result" }
  else if (status === "UNKNOWN" && stage === "TRANSFER") transfer = { label: transferWord, status: "problem", detail: "Result unknown" }
  else if (reverted === "TRANSFER") transfer = { label: transferWord, status: "problem", detail: "Reverted" }
  else if (noTransfer) transfer = { label: transferWord, status: "problem", detail: BLOCK_DETAIL[block] }
  else transfer = { label: transferWord, status: "todo", detail: "After approval" }

  let result: PanelStep
  if (server === null) result = { label: "Order result (server)", status: status === "SUBMITTED" ? "current" : "todo", detail: status === "SUBMITTED" ? "Waiting for the server" : "Not reported" }
  else if (server.category === "COMPLETED" || server.category === "RETURNED") result = { label: "Order result (server)", status: "done", detail: server.label }
  else if (server.category === "ACTION_REQUIRED") result = { label: "Order result (server)", status: "todo", detail: server.label }
  else if (server.category === "PROCESSING" || server.category === "CHECKING_RESULT" || server.category === "LIQUIDITY_PENDING") result = { label: "Order result (server)", status: "current", detail: server.label }
  else result = { label: "Order result (server)", status: "problem", detail: server.label }

  return [approval, transfer, result]
}

type Body = { kind: PanelKind; tone: PanelTone; title: string; paragraphs: string[]; code: string | null; buttons: PanelButton[]; txLabel: string | null }
type Context = { side: Side | null; order: PanelOrder | null; plan: Plan | null; snapshot: WalletSnapshot; server: PanelServerStatus | null; block: StepBlock }

function sentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * Everything that can change for the user is in the announcement, so a check that ends in the same
 * status but a different reason, or a new server order result, still changes the status region.
 */
function announce(body: Body, server: PanelServerStatus | null): string {
  const text = [body.title, ...body.paragraphs].map(sentence).join(" ")
  return server ? `${text} Order result from the server: ${sentence(server.label)}` : text
}

function finish(body: Body, { block, ...context }: Context): PanelModel {
  const showTx = context.snapshot.txHash !== null
  return Object.freeze({
    ...body,
    ...context,
    paragraphs: Object.freeze([...body.paragraphs]),
    buttons: Object.freeze([...body.buttons]),
    stage: context.snapshot.stage,
    txHash: showTx ? context.snapshot.txHash : null,
    txLabel: showTx ? body.txLabel : null,
    steps: Object.freeze(steps(context.snapshot, context.side, context.server, block)),
    announcement: announce(body, context.server),
  })
}

function unavailableBody(code: string, side: Side | null): Body {
  const described = describeCode(code, side)
  return {
    kind: "UNAVAILABLE",
    tone: "warning",
    title: code === "ORDER_EXPIRED" ? "Quote deadline passed" : "Wallet execution unavailable",
    paragraphs: [described.reason, described.next],
    code,
    buttons: [{ action: "prepare", label: "Check order", enabled: false, opensWallet: false }],
    txLabel: null,
  }
}

/**
 * True unless the injected server status for THIS order shows it no longer waits for the deposit or
 * escrow (funded elsewhere, processing, completed, expired, under review or unrecognized). With no
 * matching server status the controller's own fresh order read decides.
 */
export function serverOrderAwaitsTransfer(serverOrder: StocksServerOrderStatus | null | undefined, orderId: string | null, side: Side | null): boolean {
  if (!serverOrder || orderId === null || side === null || serverOrder.orderId !== orderId || serverOrder.side !== side) return true
  return serverOrder.state === (side === "BUY" ? "AWAITING_FUNDING" : "AWAITING_ESCROW")
}

/** Codes offering a read-only "Check again" on BLOCKED: nothing else in the host has to change first. */
const CHECKABLE_STEPS = new Set(["CHECK_AGAIN", "SWITCH_NETWORK", "RECOVERY"])

export function derivePanelModel(input: PanelInput): PanelModel {
  const { selection, now } = input
  const side: Side | null = selection && (selection.side === "BUY" || selection.side === "SELL") ? selection.side : null
  let order: Order | null = null
  let summary: PanelOrder | null = null
  if (selection && side) {
    try {
      order = parseOrder(selection)
      summary = summarize(order, side, now)
    } catch {
      order = null
      summary = null
    }
  }
  // Hidden screens carry no side either: not even Buy/Sell of an order this viewer may not see.
  const hidden = (code: string) => finish(unavailableBody(code, side), { side: null, order: null, plan: null, snapshot: IDLE_SNAPSHOT, server: null, block: null })
  if (!selection) return hidden("ORDER_REQUIRED")
  if (!order || !summary || !side) return hidden("INVALID_ORDER")
  // Order details are shown only to the signed-in wallet that placed the order.
  if (!input.account) {
    const passThrough = ["CONFIGURATION", "SIGN_IN", "SWITCH_WALLET", "SWITCH_NETWORK"]
    const code = input.availability.status === "UNAVAILABLE" && passThrough.includes(describeCode(input.availability.code, side).step) ? input.availability.code : "SESSION_REQUIRED"
    return hidden(code)
  }
  const account = input.account
  if (!same(account, order.wallet)) return hidden("WALLET_MISMATCH")

  let availability = input.availability
  if (availability.status === "READY" && !planMatches(availability.plan, order, side, account)) availability = { status: "UNAVAILABLE", code: "ORDER_SCOPE_MISMATCH" }
  const snapshot = bindSnapshot(input.snapshot, order, side, account)
  const server = serverStatus(input.serverOrder, order, side)
  const expired = summary.expired || serverDeadlinePassed(input.serverOrder, order, side)
  const movedOn = !serverOrderAwaitsTransfer(input.serverOrder, order.id, side)
  /** Only the review evidence is missing and the host loads it as part of the explicit check. */
  const evidenceCode = input.evidenceRefreshable === true && availability.status === "UNAVAILABLE" && EVIDENCE_CODES.has(availability.code) ? availability.code : null
  const loadsEvidence = evidenceCode !== null
  /** Read-only checks. */
  const ready = (availability.status === "READY" || loadsEvidence) && !expired
  /** Wallet-opening actions need current evidence and a server that has not moved the order on. */
  const readyToSign = availability.status === "READY" && !expired && !movedOn
  const plan = snapshot.plan ?? (availability.status === "READY" ? availability.plan : null)
  const unavailableCode = !expired && availability.status === "UNAVAILABLE" && !loadsEvidence ? availability.code : null
  const block: StepBlock = expired ? "expired" : movedOn ? "movedOn" : unavailableCode !== null ? "unavailable" : null
  const context: Context = { side, order: expired === summary.expired ? summary : { ...summary, expired: true, remaining: null }, plan, snapshot, server, block }

  const exact = summary.transfer.text
  const word = side === "SELL" ? "escrow" : "deposit"
  const Word = side === "SELL" ? "Escrow" : "Deposit"
  const spender = side === "SELL" ? "the redemption escrow" : "the funding vault"
  const expiredNote =
    side === "SELL"
      ? "The quote deadline has passed. Do not escrow units for this order: a late escrow is held for review, not sold."
      : "The quote deadline has passed. Do not send test cash for this order: a late payment buys nothing and is held for review."
  const movedOnText = describeCode("ORDER_NOT_PAYABLE", side)
  const unavailable = unavailableCode !== null ? { code: unavailableCode, ...describeCode(unavailableCode, side) } : null
  /** Code shown when the controller reported none: why the offered check is disabled. */
  const fallbackCode = snapshot.error ?? (expired ? "ORDER_EXPIRED" : (unavailable?.code ?? null))
  const noLongerCheckable = "The quote deadline has passed, so this screen can no longer check it. Contact operations if it stays unresolved."
  /** The host's last evidence read failed while the check loads evidence: said on every screen that offers the check. */
  const evidenceNote = loadsEvidence && input.evidenceFailure ? `The deployment review could not be loaded for the last check. ${describeCode(input.evidenceFailure, side).reason} Try the check again later; nothing is sent again.` : null
  /** Why a read-only check is disabled although the screen offers it, or why the last check could not run. */
  const withCheckNote = (paragraphs: string[], shownCode: string | null) =>
    unavailable && unavailable.code !== shownCode ? [...paragraphs, `Checking is unavailable right now. ${unavailable.reason} ${unavailable.next}`] : evidenceNote ? [...paragraphs, evidenceNote] : paragraphs
  /** A wallet step that must not be taken now: the reason replaces the call to action. */
  const signingStop = (verb: string, noun: string): { title: string; lead: string[]; code: string } | null => {
    if (expired) return { title: `Quote deadline passed — do not ${verb}`, lead: [expiredNote], code: "ORDER_EXPIRED" }
    if (movedOn) return { title: `Order moved on — do not ${verb}`, lead: [movedOnText.reason, movedOnText.next], code: "ORDER_NOT_PAYABLE" }
    if (unavailable) return { title: `${noun} unavailable`, lead: [unavailable.reason, unavailable.next], code: unavailable.code }
    if (evidenceCode !== null) return { title: `${noun} needs a new check`, lead: ["The deployment review evidence for this step ended.", "Check the order again to load current review evidence before this step is offered."], code: evidenceCode }
    return null
  }

  switch (snapshot.status) {
    case "IDLE": {
      if (expired) return finish(unavailableBody("ORDER_EXPIRED", side), context)
      if (availability.status === "UNAVAILABLE" && !loadsEvidence) return finish(unavailableBody(availability.code, side), context)
      const failure = loadsEvidence && input.evidenceFailure ? describeCode(input.evidenceFailure, side) : null
      return finish(
        {
          kind: "IDLE",
          tone: failure ? "warning" : "info",
          title: failure ? "Review evidence not loaded" : "Not checked yet",
          paragraphs: [
            ...(failure ? [failure.reason, "Try the check again later."] : []),
            loadsEvidence
              ? "Checking first loads the current deployment review from the server, then reads the accepted order, the current execution policy, your wallet's network and its allowance."
              : "Checking reads the accepted order, the current execution policy, your wallet's network and its allowance.",
            "It does not open your wallet or send anything.",
          ],
          code: failure ? input.evidenceFailure ?? null : null,
          buttons: [{ action: "prepare", label: "Check order", enabled: true, opensWallet: false }],
          txLabel: null,
        },
        context,
      )
    }
    case "CHECKING":
      return finish(
        {
          kind: "CHECKING",
          tone: "info",
          title: "Checking execution conditions",
          paragraphs: ["Reading the order, the execution policy, your wallet's network and its allowance. Nothing is signed or sent."],
          code: null,
          buttons: [{ action: "prepare", label: "Checking…", enabled: false, opensWallet: false }],
          txLabel: null,
        },
        context,
      )
    case "APPROVAL_REQUIRED": {
      const stop = signingStop("approve", "Approval")
      const detail = [
        `Approve exactly ${exact} for ${spender} of this Stocks deployment. The approval does not ${side === "SELL" ? "escrow the units" : "pay for the order"}.`,
        `The ${word} is a separate step, offered only after the server confirms the approval.`,
      ]
      // A stop screen describes the step; it never repeats the call to approve.
      const stopDetail = `This step would approve exactly ${exact} for ${spender} of this Stocks deployment; the approval does not ${side === "SELL" ? "escrow the units" : "pay for the order"}.`
      return finish(
        {
          kind: "APPROVAL_REQUIRED",
          tone: stop ? "warning" : "action",
          title: stop?.title ?? "Approval required",
          paragraphs: stop ? [...stop.lead, stopDetail] : detail,
          code: stop?.code ?? null,
          buttons: [{ action: "approve", label: `Approve ${exact}`, enabled: readyToSign, opensWallet: true }],
          txLabel: null,
        },
        context,
      )
    }
    case "SIGNING": {
      const transfer = snapshot.stage === "TRANSFER"
      return finish(
        {
          kind: "SIGNING",
          tone: "info",
          title: "Confirm in your wallet",
          paragraphs: [
            transfer
              ? `${side === "SELL" ? "An escrow" : "A deposit"} request for exactly ${exact} to ${spender} is open in your wallet. Confirm or reject it there.`
              : `An approval request for exactly ${exact} is open in your wallet. Confirm or reject it there.`,
            "The buttons stay disabled until the wallet answers. Leaving this page does not cancel the wallet request.",
          ],
          code: null,
          buttons: [{ action: transfer ? "submit" : "approve", label: "Waiting for wallet…", enabled: false, opensWallet: true }],
          txLabel: null,
        },
        context,
      )
    }
    case "APPROVAL_SUBMITTED": {
      // The controller also republishes this status, with the failing code, for an approval the server
      // already confirmed when a later deposit/escrow check fails. Only these codes mean "not yet confirmed",
      // and only while this screen can still check it and the order still waits for the deposit/escrow.
      const confirming = approvalAwaitingConfirmation(snapshot) && !expired && !movedOn
      // Past the deadline or for a moved-on order no deposit/escrow will be offered, so none is promised here.
      const paragraphs = [expired || movedOn ? "The approval transaction was sent." : `The approval transaction was sent. The server verifies it on chain before the ${word} is offered; the ${word} is never sent automatically.`]
      let tone: PanelTone = "info"
      if (snapshot.error === "RECEIPT_PENDING")
        paragraphs.push(ready ? "The server has not confirmed the approval yet. Check again in a moment; the approval is not sent again." : "The server has not confirmed the approval yet; the approval is not sent again.")
      // Ambiguous: pending verification, a cancelled check of an already confirmed approval, or an unrecorded hash.
      // Past the deadline or for a moved-on order no deposit/escrow will be offered, so none is promised here.
      else if (snapshot.error === "RECOVERY_REQUIRED")
        paragraphs.push(
          expired || movedOn
            ? "The approval's status needs another check; the approval is not sent again."
            : ready
              ? `The approval's status needs another check before the ${word} can be offered. Check the approval status; the approval is not sent again.`
              : `The approval's status needs another check before the ${word} can be offered; the approval is not sent again.`,
        )
      else if (snapshot.error === "ORDER_CHANGED" || snapshot.error === "ORDER_NOT_PAYABLE") paragraphs.push("The order has moved on at the server; see the order result below. The approval is not sent again.")
      else if (snapshot.error !== null) {
        const described = describeCode(snapshot.error, side)
        // A retryable check never says what was or was not sent: the approval hash is already recorded.
        paragraphs.push(described.reason, described.step === "CHECK_AGAIN" ? "The approval hash is kept and the approval is not sent again." : `${sentence(described.next)} The approval is not sent again.`)
        tone = described.step === "RECOVERY" ? "error" : "warning"
      }
      if (expired) paragraphs.push(`The quote deadline has passed, so no ${word} will be offered for this order and this screen can no longer check the approval. An allowance left by this approval is not revoked automatically.`)
      else if (movedOn && snapshot.error !== "ORDER_CHANGED" && snapshot.error !== "ORDER_NOT_PAYABLE") paragraphs.push(`${movedOnText.reason} An allowance left by this approval is not revoked automatically.`)
      const code = fallbackCode
      return finish(
        {
          kind: "APPROVAL_SUBMITTED",
          tone,
          // Past the deadline this screen can no longer check a pending approval, so that title asks for no check. The
          // RECOVERY_REQUIRED and failing-code titles are unchanged (003A review).
          title: confirming
            ? "Approval submitted — confirming"
            : expired && approvalAwaitingConfirmation(snapshot)
              ? "Approval sent — quote deadline passed"
              : "Approval sent — check needed",
          paragraphs: withCheckNote(paragraphs, snapshot.error),
          code,
          buttons: [{ action: "prepare", label: "Check approval status", enabled: ready, opensWallet: false }],
          txLabel: "Approval transaction",
        },
        context,
      )
    }
    case "READY_TRANSFER": {
      const stop = signingStop(word, Word)
      const detail = [
        `The allowance for exactly ${exact} is in place. ${Word} sends exactly ${exact} to ${spender} for this order with ${side === "SELL" ? "escrowForOrder" : "depositForOrder"}.`,
        "This is a separate wallet request. Nothing is sent until you press the button.",
      ]
      return finish(
        {
          kind: "READY_TRANSFER",
          tone: stop ? "warning" : "action",
          title: stop?.title ?? `Ready to ${word}`,
          paragraphs: stop ? [...stop.lead, detail[0]!] : detail,
          code: stop?.code ?? null,
          buttons: [{ action: "submit", label: `${Word} ${exact}`, enabled: readyToSign, opensWallet: true }],
          txLabel: null,
        },
        context,
      )
    }
    case "SUBMITTED": {
      const paragraphs = [
        "The transaction hash is not the order result. Holdings and balances change only after the server reports this order completed.",
        `This screen does not send the ${word} again.`,
      ]
      let tone: PanelTone = "info"
      if (snapshot.error === "ORDER_CHANGED" || snapshot.error === "ORDER_NOT_PAYABLE") paragraphs.push("The order has moved on at the server; see the order result below.")
      // An explicit check of a recorded transfer ends in RECOVERY_REQUIRED whatever the order state is:
      // only the matching injected server status can say whether the order has a final result.
      else if (snapshot.error === "RECOVERY_REQUIRED") paragraphs.push(orderResultSentence(server))
      else if (snapshot.error !== null) {
        const described = describeCode(snapshot.error, side)
        paragraphs.push(described.reason, described.step === "CHECK_AGAIN" ? "The transaction hash is kept and nothing is sent again." : described.next)
        tone = described.step === "RECOVERY" ? "error" : "warning"
      }
      // A final server result already answers what happened; review and "unresolved" wording would contradict it.
      if (expired && !finalResult(server)) paragraphs.push("If the transaction was included after the quote deadline, the server holds it for review.", noLongerCheckable)
      const code = fallbackCode
      return finish(
        {
          kind: "SUBMITTED",
          tone,
          // The only order result shown is the injected server status for this order.
          title: server ? `${Word} submitted — server status: ${server.label}` : `${Word} submitted — waiting for the order result`,
          paragraphs: withCheckNote(paragraphs, snapshot.error),
          code,
          buttons: [{ action: "prepare", label: "Check transaction status", enabled: ready, opensWallet: false }],
          txLabel: `${Word} transaction`,
        },
        context,
      )
    }
    case "UNKNOWN": {
      const transfer = snapshot.stage === "TRANSFER"
      const settled = transfer && finalResult(server)
      const paragraphs = [
        transfer ? `${side === "SELL" ? "An escrow" : "A deposit"} request may have reached your wallet, but no transaction hash was received.` : "An approval request may have reached your wallet, but no transaction hash was received.",
        settled
          ? "This screen does not send it again. Do not repeat it from another app or wallet; check your wallet activity."
          : "This screen does not send it again. Do not repeat it from another app or wallet; check your wallet activity. The recorded request needs a server check before anything else can happen.",
      ]
      if (settled) paragraphs.push(orderResultSentence(server))
      // A reserved claim stopped by a review-evidence change: say why nothing continued (no hash exists).
      if (snapshot.error === "EXECUTION_AUTHORITY_CHANGED") paragraphs.push(describeCode(snapshot.error, side).reason)
      if (transfer && side === "BUY") paragraphs.push("A second deposit would not be refunded automatically.")
      if (expired && !settled) paragraphs.push("The quote deadline has passed, so this screen can no longer check the recorded request. Contact operations if it stays unresolved.")
      const code = fallbackCode
      return finish(
        {
          kind: "UNKNOWN",
          tone: "warning",
          title: settled ? "Wallet result unknown — the server reports a final order result" : "Wallet result unknown — check required",
          paragraphs: withCheckNote(paragraphs, snapshot.error),
          code,
          buttons: [{ action: "prepare", label: "Check again", enabled: ready, opensWallet: false }],
          txLabel: transfer ? `${Word} transaction` : "Approval transaction",
        },
        context,
      )
    }
    case "BLOCKED": {
      const reverted = revertedStage(snapshot)
      // The recorded REVERTED status decides the screen; the controller's follow-up code (for example
      // RECOVERY_REQUIRED from the check that found it) would only obscure it.
      const code = reverted === "APPROVAL" ? "APPROVAL_REVERTED" : reverted === "TRANSFER" ? "TRANSFER_REVERTED" : (snapshot.error ?? "REQUEST_FAILED")
      const described = describeCode(code, side)
      const paragraphs = [described.reason, described.next]
      if (expired && code !== "ORDER_EXPIRED") paragraphs.push(expiredNote)
      // A read-only check is the way out once a transient, network or recovery condition clears. It never
      // signs: the controller re-reads the journal first. Reverted attempts get no button at all.
      const checkable = reverted === null && CHECKABLE_STEPS.has(described.step)
      if (checkable && expired && code !== "ORDER_EXPIRED") paragraphs.push("Checking from this screen is no longer possible after the quote deadline.")
      return finish(
        {
          kind: "BLOCKED",
          tone: reverted !== null || described.step === "RECOVERY" ? "error" : "warning",
          title: reverted === "APPROVAL" ? "Approval reverted" : reverted === "TRANSFER" ? `${Word} reverted` : "Execution blocked",
          paragraphs: checkable ? withCheckNote(paragraphs, code) : paragraphs,
          code,
          buttons: checkable ? [{ action: "prepare", label: "Check again", enabled: ready, opensWallet: false }] : [],
          txLabel: reverted === "APPROVAL" ? "Approval transaction" : `${Word} transaction`,
        },
        context,
      )
    }
  }
  // Unreachable for the controller's statuses; anything else fails closed without transaction details.
  return hidden("INVALID_CONTEXT")
}
