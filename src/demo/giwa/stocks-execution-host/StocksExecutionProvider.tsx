// Page-level owner of wallet execution for /stocks. One registry per host identity (session, wallet address,
// chain, wallet epoch, captured wallet source, API base), created in a layout effect and disposed in its
// cleanup, so React StrictMode's setup → cleanup → setup never reuses a disposed registry. The render-time
// check below never hands a previous identity's registry to the new scope, even before effects run.
//
// Nothing here calls prepare, approve or submit. The panel does, and only from its own buttons.

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"

import { useGiwaStocksHost } from "../stocks-host/StocksHostProvider"
import type { OrderExecutionSlot } from "../stocks-investor/execution-slot"
import type { StocksOrder } from "../stocks-investor/types"
import { BUTTON_SECONDARY, Notice } from "../stocks-investor/ui"
import { currentActiveWalletSource, type ActiveWalletSource } from "../stocks-wallet-source"
import { StocksWalletExecutionPanel } from "../stocks-wallet-ui"
import { createExecutionRegistry, executionIdentityKey, type ExecutionCapability, type ExecutionHostView, type ExecutionOwner, type ExecutionRegistry } from "./registry"

export type ExecutionClockSeam = Readonly<{ now: () => number; monotonicNow: () => number }>

export type StocksExecutionProviderProps = {
  /** The one validated API base the page uses for every Stocks client; null when it is not configured. */
  apiBase: string | null
  /** Offline verification seam. Normal runtime uses the browser fetch. */
  fetch?: typeof globalThis.fetch
  /** Offline verification seam for the wall and monotonic clocks. Normal runtime uses Date.now and performance.now. */
  clock?: ExecutionClockSeam
  /** Normal runtime reads the wallet module's active source. */
  activeSource?: () => ActiveWalletSource | null
  children: ReactNode
}

type Held = Readonly<{ key: string; fetch: StocksExecutionProviderProps["fetch"]; clock: ExecutionClockSeam | undefined; activeSource: () => ActiveWalletSource | null; registry: ExecutionRegistry }>
type Ended = Readonly<{ wallet: string | null }>
type ExecutionHostValue = Readonly<{ registry: ExecutionRegistry | null; capability: ExecutionCapability; endedWithAttempt: Ended | null; wallet: string | null; signedIn: boolean }>

const UPDATING: ExecutionCapability = Object.freeze({ status: "UNAVAILABLE", code: "CONTEXT_CHANGED" })
const ExecutionHostContext = createContext<ExecutionHostValue | null>(null)

export function StocksExecutionProvider({ apiBase, fetch, clock, activeSource = currentActiveWalletSource, children }: StocksExecutionProviderProps) {
  const host = useGiwaStocksHost()
  const view: ExecutionHostView = { session: host.snapshot.session, wallet: host.wallet, apiBase }
  // Assigned during render: a controller read during this render (panel adapter) already sees this view.
  const live = useRef(view)
  live.current = view
  const invalidate = useRef(host.invalidate)
  invalidate.current = host.invalidate
  const key = executionIdentityKey(view)
  const [held, setHeld] = useState<Held | null>(null)
  const [ended, setEnded] = useState<Ended | null>(null)
  const current = held !== null && held.key === key && held.fetch === fetch && held.clock === clock && held.activeSource === activeSource && !held.registry.disposed() ? held.registry : null

  useLayoutEffect(() => {
    const registry = createExecutionRegistry({
      view: () => live.current,
      invalidate: (capturedSessionId) => invalidate.current(capturedSessionId),
      fetch,
      now: clock?.now,
      monotonicNow: clock?.monotonicNow,
      activeSource,
    })
    setHeld({ key, fetch, clock, activeSource, registry })
    const wallet = live.current.wallet.address
    const signedIn = live.current.session !== null
    return () => {
      // A wallet request that was open, answered or uncertain when this identity ended keeps a generic
      // notice for the same wallet (no order, amount or hash), so nobody repeats it after signing in again.
      // A later session that ends without one replaces it: that session could check the order.
      if (registry.recordedAttempt()) setEnded({ wallet })
      else if (signedIn) setEnded(null)
      registry.dispose()
    }
    // live and invalidate are refs; view changes are encoded by key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fetch, clock, activeSource])

  const wallet = view.wallet.address
  const signedIn = view.session !== null
  const value = useMemo<ExecutionHostValue>(
    () => ({ registry: current, capability: current?.capability ?? UPDATING, endedWithAttempt: ended, wallet, signedIn }),
    [current, ended, wallet, signedIn],
  )
  return <ExecutionHostContext.Provider value={value}>{children}</ExecutionHostContext.Provider>
}

/** Current execution capability for page copy. Null outside the provider. */
export function useStocksExecutionCapability(): ExecutionCapability | null {
  return useContext(ExecutionHostContext)?.capability ?? null
}

/**
 * The investor feature's order slot. Null unless execution is available for this identity, so the order card keeps
 * its "not available in this app" copy (and the page header says why) instead of promising wallet steps.
 */
export function useStocksOrderExecutionSlot(): OrderExecutionSlot | null {
  const ready = useContext(ExecutionHostContext)?.capability.status === "READY"
  return useMemo(() => (ready ? (input) => <StocksOrderExecution order={input.order} observedAt={input.observedAt} refreshing={input.refreshing} onRefresh={input.onRefresh} /> : null), [ready])
}

/**
 * Shown while signed out with the same wallet after a session ended with an open, answered or uncertain wallet
 * request. It names no order, amount or hash.
 *
 * A check never records a late answer: an expired session's gate refuses it before any request, and the browser
 * does not carry that hash into the next session. The check only reads the server's record, so the copy promises
 * no recovery and sends an unknown result to operations instead.
 */
export function StocksExecutionSessionNotice() {
  const host = useContext(ExecutionHostContext)
  const ended = host?.endedWithAttempt ?? null
  if (!host || !ended || host.signedIn || ended.wallet === null || host.wallet === null || ended.wallet.toLowerCase() !== host.wallet.toLowerCase()) return null
  return (
    <Notice tone="warning" title="A wallet request from your last Stocks session may still be open or unrecorded">
      <p>If your wallet answered after that session ended, the server may not have recorded the request, even if the transaction was sent.</p>
      <p className="mt-2">Sign in to Stocks again with the same wallet, open the order and check it. The check only shows what the server has already recorded. It cannot add a request the server never received.</p>
      <p className="mt-2">If the check shows the result as unknown, do not send the approval, deposit or escrow again from this or any other app or wallet. Contact operations to confirm what happened.</p>
    </Notice>
  )
}

export type StocksOrderExecutionProps = {
  /** The latest server row the investor feature shows. Only its status is used after the first row is pinned. */
  order: StocksOrder
  observedAt: string | null
  refreshing: boolean
  onRefresh: () => void
}

function useOwnerVersion(owner: ExecutionOwner | null) {
  const subscribe = useCallback((listener: () => void) => (owner ? owner.subscribe(listener) : () => undefined), [owner])
  const read = useCallback(() => (owner ? owner.version() : -1), [owner])
  return useSyncExternalStore(subscribe, read, read)
}

/** The wallet execution panel for one accepted order of the signed-in wallet. Null outside the provider. */
export function StocksOrderExecution({ order, observedAt, refreshing, onRefresh }: StocksOrderExecutionProps) {
  const host = useContext(ExecutionHostContext)
  const registry = host?.registry ?? null
  // A moved-on order gets no panel unless this identity already has an owner for it (a pinned attempt to show).
  const payable = order.state === (order.side === "SELL" ? "AWAITING_ESCROW" : "AWAITING_FUNDING")
  const lookup = registry && (payable || registry.hasPinned(order.side, order.id)) ? registry.ownerFor(order.side, order) : null
  const owner = lookup?.owner ?? null
  useOwnerVersion(owner)
  const [, setRestarts] = useState(0)
  const serverOrder = useMemo(() => ({ orderId: order.id, side: order.side, state: order.state, observedAt }), [order.id, order.side, order.state, observedAt])
  if (!host || (!owner && !payable)) return null
  const unavailableCode = owner ? null : lookup ? lookup.code : host.capability.status === "UNAVAILABLE" ? host.capability.code : "CONTEXT_CHANGED"
  const healthy = owner ? owner.healthy() : true
  return (
    <div className="flex w-full flex-col gap-3" data-testid="stocks-order-execution">
      {owner && !healthy ? (
        <Notice tone="warning" title="Wallet checks stopped">
          <p>This page's clock reported an impossible time, so time limits can no longer be checked. Nothing is sent again automatically.</p>
          <button
            type="button"
            className={`${BUTTON_SECONDARY} mt-3`}
            onClick={() => {
              registry?.restart(owner)
              setRestarts((value) => value + 1)
            }}
          >
            Start a new check
          </button>
        </Notice>
      ) : null}
      <StocksWalletExecutionPanel
        controller={owner?.controller ?? null}
        ports={owner?.ports ?? null}
        // Without an owner the panel shows only why execution is unavailable; order details stay hidden.
        selection={owner?.selection ?? { side: order.side, order }}
        serverOrder={serverOrder}
        onRefreshServerOrder={onRefresh}
        serverOrderRefreshing={refreshing}
        refreshEvidence={owner?.refreshEvidence ?? null}
        evidenceFailure={owner?.evidenceFailure() ?? null}
        unavailableCode={unavailableCode}
        headingLevel={3}
      />
    </div>
  )
}
