// Thin adapter from the existing wallet controller (../stocks-wallet) to the panel props. It adds no
// transport, wallet, persistence, verification or default: the host creates the controller over its
// reviewed ports, supplies the accepted order and disposes the controller when its owner unmounts.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"

import type { ExecutionContext, Selection, Side, WalletPorts, WalletSnapshot } from "../stocks-wallet/types"
import { executionAvailability } from "./availability"
import { EVIDENCE_CODES, IDLE_SNAPSHOT, serverOrderAwaitsTransfer } from "./model"
import type { StocksServerOrderStatus, StocksWalletAvailability, StocksWalletControllerApi, StocksWalletNetwork, StocksWalletPanelActions } from "./types"

export type ExpectedScope = {
  orderId: string | null
  side: Side | null
  account: string | null
  /**
   * Fresh local availability at activation time. Every action does nothing unless it returns true.
   * Defense in depth: the controller itself also refuses a new approval without trusted
   * reconciliation, but only after its reads; this check keeps a missing port from starting them.
   */
  ready: () => boolean
  /**
   * False when the injected server status shows this order no longer waits for the deposit/escrow.
   * approve/submit then do nothing (a moved-on order must not be paid twice). Default: always true.
   */
  signable?: () => boolean
  /**
   * Host read of current deployment review evidence. When given, an explicit check runs it first (it never
   * opens the wallet), and the check may start while only the evidence is missing (see `checkable`).
   */
  refreshEvidence?: (() => Promise<unknown>) | null
  /** Fresh at activation: availability is READY, or only the review evidence is missing. Default: `ready`. */
  checkable?: () => boolean
}

/**
 * Maps the panel's explicit actions onto the controller. Each first re-checks local availability;
 * approve/submit also require the injected server status not to show the order moved on, and re-read
 * the controller snapshot: they do nothing unless it is still the displayed order, side, account and
 * step. The controller then repeats its own full preflight. prepare only reads and never opens the wallet.
 */
export function stocksWalletPanelActions(controller: StocksWalletControllerApi, expected: ExpectedScope): StocksWalletPanelActions {
  const check = (predicate: (() => boolean) | undefined, fallback: boolean) => {
    try {
      return predicate ? predicate() === true : fallback
    } catch {
      return false
    }
  }
  const available = () => check(expected.ready, false)
  const signable = () => available() && check(expected.signable, true)
  const checkable = () => (expected.checkable ? check(expected.checkable, false) : available())
  const loadEvidence = expected.refreshEvidence
  /** The one read-only controller check. Evidence is loaded first when the host provides it; the check still needs READY afterwards. */
  const runCheck = () => (available() ? controller.prepare() : undefined)
  const displayed = (status: WalletSnapshot["status"]) => {
    const snapshot = controller.getSnapshot()
    const plan = snapshot.plan
    return (
      expected.orderId !== null &&
      expected.account !== null &&
      plan !== null &&
      snapshot.status === status &&
      snapshot.orderId === expected.orderId &&
      plan.side === expected.side &&
      plan.order.wallet.toLowerCase() === expected.account.toLowerCase()
    )
  }
  return {
    prepare: () => {
      if (!loadEvidence) return runCheck()
      if (!checkable()) return undefined
      return Promise.resolve()
        .then(loadEvidence)
        .catch(() => undefined)
        .then(runCheck)
    },
    approve: () => (signable() && displayed("APPROVAL_REQUIRED") ? controller.approve() : undefined),
    submit: () => (signable() && displayed("READY_TRANSFER") ? controller.submit() : undefined),
  }
}

export type UseStocksWalletPanelOptions = {
  /** From createStocksWalletController(ports), owned and disposed by the host. Null renders "not configured". */
  controller: StocksWalletControllerApi | null
  /** The same ports object the controller was created with. Only its synchronous context() and now() are read here. */
  ports: WalletPorts | null
  /** The accepted create-order row and its side. Never a refreshed row: pass later server state as serverOrder. */
  selection: Selection | null
  /** Separately read server order status. Used only to refuse approve/submit for a moved-on order. */
  serverOrder?: StocksServerOrderStatus | null
  /** Re-render interval for the deadline display only. 0 disables. Default 1000 ms. */
  tickMs?: number
  /** Host read of current deployment review evidence, run only as the first part of an explicit check. */
  refreshEvidence?: (() => Promise<unknown>) | null
  /** Stable code of the host's last failed evidence read. */
  evidenceFailure?: string | null
  /** Why the host has no controller for this scope (for example an unsupported wallet type). Used only when `controller` is null. */
  unavailableCode?: string | null
}

export type StocksWalletPanelBinding = {
  /** Changes with account, wallet epoch, session, API, side or order. Key the panel with it. */
  scopeKey: string
  snapshot: WalletSnapshot
  selection: Selection | null
  account: string | null
  availability: StocksWalletAvailability
  now: number
  network: StocksWalletNetwork | null
  actions: StocksWalletPanelActions | null
  evidenceRefreshable: boolean
  evidenceFailure: string | null
}

function readContext(ports: WalletPorts | null): ExecutionContext | null {
  if (!ports || typeof ports.context !== "function") return null
  try {
    return ports.context()
  } catch {
    return null
  }
}

function clockOf(ports: WalletPorts | null): number {
  try {
    return ports && typeof ports.now === "function" ? ports.now() : Date.now()
  } catch {
    return Number.NaN
  }
}

function orderIdOf(selection: Selection | null): string | null {
  const order = selection?.order
  return order !== null && typeof order === "object" && typeof (order as { id?: unknown }).id === "string" ? (order as { id: string }).id : null
}

export function useStocksWalletPanel({ controller, ports, selection, serverOrder = null, tickMs = 1000, refreshEvidence = null, evidenceFailure = null, unavailableCode = null }: UseStocksWalletPanelOptions): StocksWalletPanelBinding {
  const context = readContext(ports)

  // Synchronize the displayed order before the snapshot is read. select() is idempotent for an equal
  // selection, and a changed account, wallet epoch, session, API, deployment or order resets the
  // controller snapshot synchronously, so a previous scope is not rendered even for one frame.
  let synchronized = controller !== null
  if (controller) {
    try {
      controller.select(selection)
    } catch {
      synchronized = false
    }
  }

  const subscribe = useCallback((listener: () => void) => (controller ? controller.subscribe(listener) : () => undefined), [controller])
  const getSnapshot = useCallback(() => (controller ? controller.getSnapshot() : IDLE_SNAPSHOT), [controller])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // Clock display only: re-renders the deadline. It never calls the controller's actions.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (tickMs <= 0) return
    const timer = setInterval(() => setTick((value) => value + 1), tickMs)
    return () => clearInterval(timer)
  }, [tickMs])

  const now = clockOf(ports)
  const session = context?.session ?? null
  const wallet = context?.walletAddress ?? null
  const account = session !== null && typeof wallet === "string" && typeof session.walletAddress === "string" && session.walletAddress.toLowerCase() === wallet.toLowerCase() ? wallet : null
  const computed = executionAvailability({ configured: synchronized, ports, context, selection, now })
  const availability: StocksWalletAvailability = controller === null && unavailableCode ? Object.freeze({ status: "UNAVAILABLE", code: unavailableCode }) : computed
  const evidenceRefreshable = controller !== null && typeof refreshEvidence === "function"
  const orderId = orderIdOf(selection)
  const side = selection?.side === "BUY" || selection?.side === "SELL" ? selection.side : null
  const actions = useMemo(
    () =>
      controller && synchronized
        ? stocksWalletPanelActions(controller, {
            orderId,
            side,
            account,
            // Re-evaluated at activation with the host's then-current context and clock.
            ready: () => executionAvailability({ configured: true, ports, context: readContext(ports), selection, now: clockOf(ports) }).status === "READY",
            signable: () => serverOrderAwaitsTransfer(serverOrder, orderId, side),
            refreshEvidence: evidenceRefreshable ? refreshEvidence : null,
            checkable: () => {
              const fresh = executionAvailability({ configured: true, ports, context: readContext(ports), selection, now: clockOf(ports) })
              return fresh.status === "READY" || (evidenceRefreshable && EVIDENCE_CODES.has(fresh.code))
            },
          })
        : null,
    [controller, synchronized, ports, selection, serverOrder, orderId, side, account, evidenceRefreshable, refreshEvidence],
  )
  const manifest = availability.status === "READY" ? context?.deployment?.manifest : null
  const network = manifest ? { networkInstance: manifest.networkInstance, deploymentId: manifest.deploymentId } : null
  const scopeKey = JSON.stringify([account?.toLowerCase() ?? null, context?.walletEpoch ?? null, session?.id ?? null, context?.apiBase ?? null, side, orderId])

  return { scopeKey, snapshot, selection, account, availability, now, network, actions, evidenceRefreshable, evidenceFailure: evidenceRefreshable ? evidenceFailure : null }
}
