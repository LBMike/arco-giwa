// Page-level owner of wallet execution for /stocks. One registry per host identity (session, wallet address,
// chain, wallet epoch, captured wallet source, API base), created in a layout effect and disposed in its
// cleanup, so React StrictMode's setup → cleanup → setup never reuses a disposed registry. The render-time
// check below never hands a previous identity's registry to the new scope, even before effects run.
//
// Nothing here calls prepare, approve or submit. The panel does, and only from its own buttons.
//
// Kept hashes (../stocks-known-hash-recovery): when an owner's original gate could not record a hash its original
// wallet request returned, the hash is kept in this tab's memory. It is shown only to the same owner (session wallet,
// chain, API base, frontend origin) on the order it belongs to, filtered during render, and recorded only by that
// owner's explicit click with a new gate pinned to the current session.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"

import type { HostSession } from "../stocks-host/session"
import { useGiwaStocksHost } from "../stocks-host/StocksHostProvider"
import type { OrderExecutionSlot } from "../stocks-investor/execution-slot"
import type { StocksOrder } from "../stocks-investor/types"
import { BUTTON_SECONDARY, Notice } from "../stocks-investor/ui"
import { KNOWN_HASH_CHAIN_ID, KnownHashRecoveryCard, recoverKnownHash, sameOwner, tabKnownHashStore, type KnownHashEntry, type KnownHashScope, type KnownHashStore, type RecoveryResult } from "../stocks-known-hash-recovery"
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
  /** Where hashes are kept. Normal runtime uses this tab's module memory (lost on reload). */
  knownHashes?: KnownHashStore
  /** The frontend origin of this page. Normal runtime reads window.location.origin; without one nothing is kept. */
  origin?: string | null
  children: ReactNode
}

type Held = Readonly<{ key: string; fetch: StocksExecutionProviderProps["fetch"]; clock: ExecutionClockSeam | undefined; activeSource: () => ActiveWalletSource | null; knownHashes: KnownHashStore; origin: string | null; registry: ExecutionRegistry }>
type Ended = Readonly<{ wallet: string | null }>
type ExecutionHostValue = Readonly<{
  registry: ExecutionRegistry | null
  capability: ExecutionCapability
  endedWithAttempt: Ended | null
  wallet: string | null
  signedIn: boolean
  knownHashes: KnownHashStore
  /** The signed-in owner of kept hashes, from this render's view. Null unless the session wallet is the shown wallet. */
  ownerScope: KnownHashScope | null
  /** The signed-out wallet's scope, for the session-end notice only (it names no order or hash). */
  walletScope: KnownHashScope | null
  /** The live view (read synchronously) and what an explicit recovery needs. */
  liveView: () => ExecutionHostView
  invalidate: (capturedSessionId: string) => void
  fetch: StocksExecutionProviderProps["fetch"]
  clock: ExecutionClockSeam | undefined
  origin: string | null
}>

const UPDATING: ExecutionCapability = Object.freeze({ status: "UNAVAILABLE", code: "CONTEXT_CHANGED" })
const ExecutionHostContext = createContext<ExecutionHostValue | null>(null)

function pageOrigin(): string | null {
  try {
    return typeof window !== "undefined" && typeof window.location?.origin === "string" && window.location.origin !== "null" ? window.location.origin : null
  } catch {
    return null
  }
}

/** The owner of kept hashes on screen: signed in, the session wallet is the shown wallet, chain 91342, API base and origin. */
export function knownHashOwnerScope(view: ExecutionHostView, origin: string | null): KnownHashScope | null {
  const session = view.session
  if (!session || origin === null || view.apiBase === null || view.wallet.address === null) return null
  if (view.wallet.address.toLowerCase() !== session.walletAddress.toLowerCase() || view.wallet.chainId !== KNOWN_HASH_CHAIN_ID || session.chainId !== KNOWN_HASH_CHAIN_ID) return null
  return Object.freeze({ wallet: session.walletAddress.toLowerCase(), chainId: KNOWN_HASH_CHAIN_ID, apiBase: view.apiBase, origin })
}

/**
 * The signed-out wallet's scope for the session-end notice only. Kept hashes are always on chain 91342; the notice names
 * no order or hash, so the wallet's current network does not hide it (another network must not switch it to the
 * no-hash wording while this tab still keeps a hash).
 */
function walletScopeOf(view: ExecutionHostView, origin: string | null): KnownHashScope | null {
  if (origin === null || view.apiBase === null || view.wallet.address === null) return null
  return Object.freeze({ wallet: view.wallet.address.toLowerCase(), chainId: KNOWN_HASH_CHAIN_ID, apiBase: view.apiBase, origin })
}

function useKnownHashVersion(store: KnownHashStore) {
  return useSyncExternalStore(store.subscribe, store.version, store.version)
}

export function StocksExecutionProvider({ apiBase, fetch, clock, activeSource = currentActiveWalletSource, knownHashes = tabKnownHashStore, origin, children }: StocksExecutionProviderProps) {
  const host = useGiwaStocksHost()
  const view: ExecutionHostView = { session: host.snapshot.session, wallet: host.wallet, apiBase }
  const pageOriginValue = origin === undefined ? pageOrigin() : origin
  // Assigned during render: a controller read during this render (panel adapter) already sees this view.
  const live = useRef(view)
  live.current = view
  const invalidate = useRef(host.invalidate)
  invalidate.current = host.invalidate
  const key = executionIdentityKey(view)
  const [held, setHeld] = useState<Held | null>(null)
  const [ended, setEnded] = useState<Ended | null>(null)
  const current = held !== null && held.key === key && held.fetch === fetch && held.clock === clock && held.activeSource === activeSource && held.knownHashes === knownHashes && held.origin === pageOriginValue && !held.registry.disposed() ? held.registry : null

  useLayoutEffect(() => {
    const registry = createExecutionRegistry({
      view: () => live.current,
      invalidate: (capturedSessionId) => invalidate.current(capturedSessionId),
      fetch,
      now: clock?.now,
      monotonicNow: clock?.monotonicNow,
      activeSource,
      knownHashes,
      origin: pageOriginValue,
    })
    setHeld({ key, fetch, clock, activeSource, knownHashes, origin: pageOriginValue, registry })
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
  }, [key, fetch, clock, activeSource, knownHashes, pageOriginValue])

  const wallet = view.wallet.address
  const signedIn = view.session !== null
  const ownerScope = knownHashOwnerScope(view, pageOriginValue)
  const walletScope = walletScopeOf(view, pageOriginValue)
  const ownerScopeKey = ownerScope ? JSON.stringify(ownerScope) : null
  const walletScopeKey = walletScope ? JSON.stringify(walletScope) : null
  const liveView = useCallback(() => live.current, [])
  const invalidateSession = useCallback((capturedSessionId: string) => invalidate.current(capturedSessionId), [])
  const value = useMemo<ExecutionHostValue>(
    () => ({
      registry: current,
      capability: current?.capability ?? UPDATING,
      endedWithAttempt: ended,
      wallet,
      signedIn,
      knownHashes,
      ownerScope: ownerScopeKey ? (JSON.parse(ownerScopeKey) as KnownHashScope) : null,
      walletScope: walletScopeKey ? (JSON.parse(walletScopeKey) as KnownHashScope) : null,
      liveView,
      invalidate: invalidateSession,
      fetch,
      clock,
      origin: pageOriginValue,
    }),
    [current, ended, wallet, signedIn, knownHashes, ownerScopeKey, walletScopeKey, liveView, invalidateSession, fetch, clock, pageOriginValue],
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
 * request, or while this tab keeps a hash for that wallet. It names no order, amount or hash.
 *
 * The request itself is always on the server by then (its claim is reserved before the wallet opens); what may be
 * missing is the wallet's answer. A check never records that answer: an expired session's gate refuses it before any
 * request. Two variants:
 * - a hash was kept in this tab: only the user's explicit action after signing in again can record it, and only in
 *   this tab (a reload loses it);
 * - no hash was kept: the check only reads the server's record, so the copy promises no recovery, never allows a
 *   repeat, and sends an unknown or uncheckable result to operations.
 */
export function StocksExecutionSessionNotice() {
  const host = useContext(ExecutionHostContext)
  const store = host?.knownHashes ?? tabKnownHashStore
  useKnownHashVersion(store)
  if (!host || host.signedIn || host.wallet === null) return null
  const kept = host.walletScope ? store.entries(host.walletScope).filter((entry) => entry.state.kind === "KEPT").length : 0
  const ended = host.endedWithAttempt
  const endedHere = ended !== null && ended.wallet !== null && ended.wallet.toLowerCase() === host.wallet.toLowerCase()
  if (!endedHere && kept === 0) return null
  if (kept > 0) {
    return (
      <Notice tone="warning" title="This tab kept a transaction hash the server may not have recorded">
        <p>Your wallet returned a transaction hash that an earlier Stocks session could not record, so this tab kept it. The server may not have it yet, even though the transaction was sent.</p>
        <p className="mt-2">Sign in to Stocks again with the same wallet in this tab and open the order. You can record the kept hash there; nothing is recorded or sent automatically. The hash is kept only in this tab's memory: reloading or closing the page loses it.</p>
        <p className="mt-2">Do not send the approval, deposit or escrow again from this or any other app or wallet. If the kept hash cannot be recorded, or the order still shows the result as unknown after you record it, contact operations to confirm what happened.</p>
      </Notice>
    )
  }
  return (
    <Notice tone="warning" title="A wallet request from your last Stocks session may still be open or its answer unrecorded">
      <p>If your wallet answered after that session ended, the server may not have recorded that answer, even if the transaction was sent.</p>
      <p className="mt-2">Sign in to Stocks again with the same wallet, open the order and check it. The check only shows what the server has already recorded. It cannot add a wallet answer the server never received.</p>
      <p className="mt-2">Do not send the approval, deposit or escrow again from this or any other app or wallet. If the check shows the result as unknown, or the order can no longer be checked, contact operations to confirm what happened.</p>
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

/** One kept hash of the signed-in owner on its order, with the explicit recovery action. */
function KnownHashRecoveryAction({ entry }: { entry: KnownHashEntry }) {
  const host = useContext(ExecutionHostContext)
  const [last, setLast] = useState<RecoveryResult | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  if (!host) return null
  const onRecover = () => {
    const view = host.liveView()
    const session: HostSession | null = view.session
    const scope = knownHashOwnerScope(view, host.origin)
    // Pinned for the whole run: this session, this owner, this identity.
    if (!session || !scope || !sameOwner(entry, scope) || view.apiBase === null) return
    const pinnedKey = executionIdentityKey(view)
    void recoverKnownHash({
      candidate: entry,
      session,
      apiBase: view.apiBase,
      store: host.knownHashes,
      alive: () => mounted.current && executionIdentityKey(host.liveView()) === pinnedKey,
      onSessionRejected: host.invalidate,
      fetch: host.fetch,
      now: host.clock?.now,
      monotonicNow: host.clock?.monotonicNow,
    }).then(
      (result) => {
        if (mounted.current && result.kind !== "STOPPED" && result.kind !== "BUSY") setLast(result)
      },
      () => {
        if (mounted.current) setLast(Object.freeze({ kind: "FAILED", code: "REQUEST_FAILED" }))
      },
    )
  }
  return <KnownHashRecoveryCard entry={entry} lastResult={last} onRecover={onRecover} />
}

/** The wallet execution panel for one accepted order of the signed-in wallet. Null outside the provider. */
export function StocksOrderExecution({ order, observedAt, refreshing, onRefresh }: StocksOrderExecutionProps) {
  const host = useContext(ExecutionHostContext)
  const registry = host?.registry ?? null
  useKnownHashVersion(host?.knownHashes ?? tabKnownHashStore)
  // A moved-on order gets no panel unless this identity already has an owner for it (a pinned attempt to show).
  const payable = order.state === (order.side === "SELL" ? "AWAITING_ESCROW" : "AWAITING_FUNDING")
  const lookup = registry && (payable || registry.hasPinned(order.side, order.id)) ? registry.ownerFor(order.side, order) : null
  const owner = lookup?.owner ?? null
  useOwnerVersion(owner)
  const [, setRestarts] = useState(0)
  const serverOrder = useMemo(() => ({ orderId: order.id, side: order.side, state: order.state, observedAt }), [order.id, order.side, order.state, observedAt])
  // Kept hashes of THIS render's signed-in owner for this order and deployment only; another wallet, chain, API base,
  // origin, order or deployment never sees them, from the first render on.
  const deploymentDigest = (order as { deploymentDigest?: unknown }).deploymentDigest
  const kept = host && host.ownerScope && typeof deploymentDigest === "string" ? host.knownHashes.forOrder(host.ownerScope, order.side, order.id, deploymentDigest) : []
  if (!host || (!owner && !payable && kept.length === 0)) return null
  const showPanel = owner !== null || payable
  const unavailableCode = owner ? null : lookup ? lookup.code : host.capability.status === "UNAVAILABLE" ? host.capability.code : "CONTEXT_CHANGED"
  const healthy = owner ? owner.healthy() : true
  return (
    <div className="flex w-full flex-col gap-3" data-testid="stocks-order-execution">
      {kept.map((entry) => (
        <KnownHashRecoveryAction key={entry.claimId} entry={entry} />
      ))}
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
      {showPanel ? (
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
      ) : null}
    </div>
  )
}
