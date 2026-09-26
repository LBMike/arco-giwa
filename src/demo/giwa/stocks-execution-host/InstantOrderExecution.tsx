// The customer presentation's one-click trade, host side: the accepted order's one wallet request (the tUSDC deposit of a
// Buy, the NVDA escrow of a Sell) as one compact line instead of the step-by-step panel.
//
// It starts that request by itself only for the order the user's own Buy or Sell press has just placed (`autoStart`),
// and only once per order in this tab; any other order waits for the explicit "Confirm in wallet" press. The wallet
// controller still runs every fresh check (deployment evidence, order, policy, journal, allowance) first and asks the
// wallet exactly once; a recorded or uncertain request is never repeated from here.

import { useEffect, useMemo, type ReactNode } from "react"
import { Loader2 } from "lucide-react"

import type { StocksOrder } from "../stocks-investor/types"
import { BUTTON_PRIMARY, BUTTON_SECONDARY, Notice } from "../stocks-investor/ui"
import { useStocksWalletPanel } from "../stocks-wallet-ui/adapter"
import { describeCode } from "../stocks-wallet-ui/messages"
import { EVIDENCE_CODES } from "../stocks-wallet-ui/model"
import type { ExecutionOwner } from "./registry"

/** Orders whose one-click request this tab has started: a remount (StrictMode, a session swap) never starts one twice. */
const started = new Set<string>()

export type InstantOrderExecutionProps = {
  owner: ExecutionOwner | null
  order: StocksOrder
  observedAt: string | null
  /** Why the host has no owner for this order (used only when `owner` is null). */
  unavailableCode: string | null
  autoStart: boolean
}

function Busy({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm leading-6 text-[var(--color-arco-ink)]" data-testid="stocks-instant-wallet-step">
      <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
      <span>{children}</span>
    </p>
  )
}

export function InstantOrderExecution({ owner, order, observedAt, unavailableCode, autoStart }: InstantOrderExecutionProps) {
  const side = order.side
  const serverOrder = useMemo(() => ({ orderId: order.id, side, state: order.state, observedAt }), [order.id, side, order.state, observedAt])
  const binding = useStocksWalletPanel({
    controller: owner?.controller ?? null,
    ports: owner?.ports ?? null,
    // Without an owner nothing can be signed; the order row only names what is unavailable.
    selection: owner?.selection ?? { side, order },
    serverOrder,
    tickMs: 0,
    refreshEvidence: owner?.refreshEvidence ?? null,
    evidenceFailure: owner?.evidenceFailure() ?? null,
    unavailableCode,
  })
  const deposit = binding.actions?.deposit
  const payable = order.state === (side === "SELL" ? "AWAITING_ESCROW" : "AWAITING_FUNDING")
  const key = `${side}:${order.id}`
  useEffect(() => {
    if (!autoStart || !payable || !deposit || started.has(key)) return
    started.add(key)
    void deposit()
  }, [autoStart, payable, deposit, key])

  if (!payable) return null
  const noun = side === "SELL" ? "NVDA escrow" : "USDC payment"
  if (owner === null || !deposit) {
    const reason = describeCode(unavailableCode ?? (owner === null ? "CONTEXT_CHANGED" : "NOT_CONFIGURED"), side)
    return (
      <Notice tone="warning">
        <p>{reason.reason}</p>
        <p className="mt-1">{reason.next}</p>
      </Notice>
    )
  }
  const retry = () => void deposit()
  const snapshot = binding.snapshot
  switch (snapshot.status) {
    case "SIGNING":
      return <Busy>Confirm the {noun} in your wallet.</Busy>
    case "SUBMITTED":
      return <Busy>{side === "SELL" ? "Escrow sent. Waiting for GIWA to confirm it…" : "Payment sent. Waiting for GIWA to confirm it…"}</Busy>
    case "UNKNOWN":
    case "APPROVAL_SUBMITTED":
      return (
        <Notice tone="warning" title="Check your wallet">
          <p>Your wallet did not report whether it sent the {noun}. Check its activity before doing anything else.</p>
          <p className="mt-1">Do not send it again from another app or wallet. The server matches only one {side === "SELL" ? "escrow" : "payment"} to this order.</p>
        </Notice>
      )
    case "BLOCKED": {
      const reason = describeCode(snapshot.error ?? "INVALID_CONTEXT", side)
      return (
        <Notice tone={reason.step === "CHECK_AGAIN" ? "warning" : "error"}>
          <p>{reason.reason}</p>
          <p className="mt-1">{reason.next}</p>
          {reason.step === "CHECK_AGAIN" ? (
            <button type="button" className={`${BUTTON_SECONDARY} mt-3`} onClick={retry}>
              Try again
            </button>
          ) : null}
        </Notice>
      )
    }
    case "IDLE": {
      // Started, but the controller never ran: the review evidence could not be read, or the page's wallet or session is
      // not the one this order needs. Say which, and offer the same explicit retry.
      const stopped = binding.evidenceFailure ?? (binding.availability.status === "UNAVAILABLE" && !EVIDENCE_CODES.has(binding.availability.code) ? binding.availability.code : null)
      if (started.has(key) && stopped !== null) {
        const reason = describeCode(stopped, side)
        return (
          <Notice tone="warning">
            <p>{reason.reason}</p>
            <p className="mt-1">{reason.next}</p>
            <button type="button" className={`${BUTTON_SECONDARY} mt-3`} onClick={retry}>
              Try again
            </button>
          </Notice>
        )
      }
      // Not started by a press in this tab (for example after a reload of the order): the user starts it explicitly.
      if (!autoStart && !started.has(key)) {
        return (
          <button type="button" className={`${BUTTON_PRIMARY} w-full`} onClick={() => { started.add(key); retry() }}>
            {side === "SELL" ? "Confirm sale in wallet" : "Confirm purchase in wallet"}
          </button>
        )
      }
      return <Busy>Checking your order…</Busy>
    }
    default:
      return <Busy>Checking your order…</Busy>
  }
}
