// GiwaStocksFeature — the independently renderable GIWA Stocks investor module.
//
// The host supplies an API client and a VERIFIED session (SIWE token for the connected wallet).
// Without a verified session only the public catalog is read. Wallet deposit and escrow signing are
// outside this module: an accepted order shows the exact funding/escrow it waits for, and every
// later state comes from the server.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react"

import type { GiwaStocksAccess } from "./access"
import { actionsFor, type StocksInvestorActions } from "./actions"
import type { GiwaStocksClient } from "./client"
import { createStocksInvestorController, orderIsTerminal, type StocksInvestorState } from "./controller"
import { shortAddress, signedOutMessage } from "./display"
import { OrderExecutionSlotContext, type OrderExecutionSlot } from "./execution-slot"
import { OrdersView, PortfolioView, StockDetailView, StocksListView } from "./StocksViews"
import type { GiwaStocksHostWallet, GiwaStocksSession, GiwaStocksTab } from "./types"
import { FOCUS_RING, Notice, UserInteractionContext } from "./ui"

export type GiwaStocksFeatureProps = {
  /** From createGiwaStocksHttpClient({ baseUrl }). Null renders the "not configured" state; it never falls back to data. */
  client: GiwaStocksClient | null
  /** Host-verified SIWE session, or { status: "signed-out" }. A connected wallet alone is not verified. */
  session: GiwaStocksSession
  /** The host wallet's current account and chain. A mismatch with the session is treated as signed out. */
  hostWallet?: GiwaStocksHostWallet | null
  /** Called once per session when the server answers 401, so the host can run SIWE again. */
  onSessionRejected?: (event: { walletAddress: string }) => void
  /** Interval for re-reading a displayed, non-terminal order. 0 disables. Default 10 000 ms. */
  statusPollMs?: number
  initialTab?: GiwaStocksTab
  /** Monotonic clock for quote deadlines (tests). Default performance.now. */
  now?: () => number
  /** Order request key factory (tests). Must match ^[a-zA-Z0-9:_-]{8,128}$. */
  newIdempotencyKey?: () => string
  /** Host wallet steps shown with an accepted order (for example the /stocks execution panel). Absent: status only. */
  renderOrderExecution?: OrderExecutionSlot | null
  /** Host steps before a request (wallet, network, sign-in) so the trade panel can offer them. Absent: session only. */
  access?: GiwaStocksAccess | null
  /**
   * Controlled NVDA detail (the /stocks page owns list/detail). When given, `onDetailChange` must be given too, and the
   * feature does not render its own "All stocks" back control (the page provides one). Absent: internal state.
   */
  detailOpen?: boolean
  onDetailChange?: (open: boolean) => void
}

const TABS: { id: GiwaStocksTab; label: string }[] = [
  { id: "stocks", label: "Stocks" },
  { id: "orders", label: "Orders" },
  { id: "portfolio", label: "Portfolio" },
]

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect

export type GiwaStocksFeatureViewProps = {
  state: StocksInvestorState
  actions: StocksInvestorActions
  tab: GiwaStocksTab
  onTabChange: (tab: GiwaStocksTab) => void
  detailOpen: boolean
  onDetailChange: (open: boolean) => void
  /** True while the host's new context is being applied: nothing from the previous session is painted. */
  switching?: boolean
  renderOrderExecution?: OrderExecutionSlot | null
}

export function GiwaStocksFeatureView({ state, actions, tab, onTabChange, detailOpen, onDetailChange, switching = false, renderOrderExecution = null }: GiwaStocksFeatureViewProps) {
  const interacted = useRef(false)
  const tabRefs = useRef<Record<GiwaStocksTab, HTMLButtonElement | null>>({ stocks: null, orders: null, portfolio: null })
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = TABS.length - 1
    const target = event.key === "ArrowRight" ? (index === last ? 0 : index + 1) : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1) : event.key === "Home" ? 0 : event.key === "End" ? last : null
    if (target === null) return
    event.preventDefault()
    onTabChange(TABS[target].id)
    tabRefs.current[TABS[target].id]?.focus()
  }

  return (
    <OrderExecutionSlotContext.Provider value={renderOrderExecution}>
    <UserInteractionContext.Provider value={interacted}>
    <section
      className="arco-demo w-full bg-[var(--color-arco-surface)] text-[var(--color-arco-ink)]"
      aria-labelledby="giwa-stocks-title"
      data-testid="giwa-stocks-feature"
      onPointerDownCapture={() => {
        interacted.current = true
      }}
      onKeyDownCapture={() => {
        interacted.current = true
      }}
    >
      <div className="flex w-full flex-col gap-6 px-4 py-6 md:px-8 md:py-8">
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            {/* A section of the host page (the /stocks page's h1 is the market section's "Stocks"). */}
            <h2 id="giwa-stocks-title" className="text-2xl font-medium text-[var(--color-arco-ink)]">
              Stocks
            </h2>
            <p className="text-sm text-[var(--color-arco-text-soft)]" data-testid="giwa-stocks-session">
              {switching ? (
                "Updating session…"
              ) : state.session.status === "verified" ? (
                <>
                  Signed in as <span className="font-mono">{shortAddress(state.session.wallet)}</span> · GIWA Sepolia
                </>
              ) : (
                "Not signed in"
              )}
            </p>
          </div>
          <p className="text-xs leading-5 text-[var(--color-arco-text-soft)]">GIWA Sepolia testnet · Test value only · Mock broker · Fixed mock price. No real shares, cash or broker execution.</p>
        </header>

        <div role="tablist" aria-label="Stocks sections" className="flex w-full flex-wrap gap-2 border-b border-[var(--color-arco-border)]">
          {TABS.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => {
                tabRefs.current[item.id] = node
              }}
              id={`giwa-stocks-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`giwa-stocks-panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => onTabChange(item.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              className={`-mb-px min-h-11 border-b-2 px-3 text-sm font-medium ${FOCUS_RING} ${
                tab === item.id ? "border-[var(--color-arco-ink)] text-[var(--color-arco-ink)]" : "border-transparent text-[var(--color-arco-text-soft)] hover:text-[var(--color-arco-ink)]"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div id={`giwa-stocks-panel-${tab}`} role="tabpanel" aria-labelledby={`giwa-stocks-tab-${tab}`} className="w-full">
          {switching ? (
            <Notice tone="info">Updating session…</Notice>
          ) : tab === "stocks" ? (
            detailOpen ? (
              <StockDetailView state={state} actions={actions} onBack={() => onDetailChange(false)} />
            ) : (
              <StocksListView state={state} actions={actions} onOpen={() => onDetailChange(true)} />
            )
          ) : tab === "orders" ? (
            <OrdersView state={state} actions={actions} />
          ) : (
            <PortfolioView state={state} actions={actions} />
          )}
        </div>

        {!switching && state.session.status === "signed-out" && tab === "stocks" && !detailOpen && state.catalog.status === "ready" ? (
          <p className="text-xs text-[var(--color-arco-text-soft)]">{signedOutMessage(state.session.reason)}</p>
        ) : null}
      </div>
    </section>
    </UserInteractionContext.Provider>
    </OrderExecutionSlotContext.Provider>
  )
}

export function GiwaStocksFeature(props: GiwaStocksFeatureProps) {
  const { client, session, hostWallet, onSessionRejected, statusPollMs = 10_000, initialTab = "stocks", now, newIdempotencyKey, renderOrderExecution = null } = props
  const [controller] = useState(() => createStocksInvestorController({ now, newIdempotencyKey }))
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const actions = useMemo(() => actionsFor(controller), [controller])
  const [tab, setTab] = useState<GiwaStocksTab>(initialTab)
  const [detailOpen, setDetailOpen] = useState(false)

  const context = { client, session, hostWallet, onSessionRejected }
  // Applied before paint on every render; a context with the same identity is a no-op.
  useIsomorphicLayoutEffect(() => {
    controller.setContext(context)
  })
  useEffect(() => () => controller.suspend(), [controller])
  const switching = controller.identityFor(context) !== state.identityKey

  // Quote countdown and local expiry. Expiry never requests a replacement.
  const quoteReady = state.quote.status === "ready"
  useEffect(() => {
    if (!quoteReady) return
    const timer = window.setInterval(() => controller.tick(), 1_000)
    return () => window.clearInterval(timer)
  }, [controller, quoteReady, state.generation])

  // Section reads, once per generation (and after a manual refresh).
  const verified = state.session.status === "verified" && !state.authRejected
  const catalogReady = state.catalog.status === "ready"
  useEffect(() => {
    if (switching || !verified || !catalogReady) return
    if (tab === "orders" && state.orders.status === "idle") actions.loadOrders()
    if (tab === "portfolio" && state.portfolio.status === "idle") actions.loadPortfolio()
  }, [actions, switching, verified, catalogReady, tab, state.generation, state.orders.status, state.portfolio.status])

  // Re-read a displayed order that can still change, while the page is visible.
  const pollOrder = useCallback(
    (refresh: () => void) => {
      if (statusPollMs <= 0) return () => undefined
      const timer = window.setInterval(() => {
        if (typeof document === "undefined" || document.visibilityState === "visible") refresh()
      }, statusPollMs)
      return () => window.clearInterval(timer)
    },
    [statusPollMs],
  )
  const attemptOrder = state.attempt?.status === "ACCEPTED" ? state.attempt.order : null
  const attemptPolling = attemptOrder !== null && !orderIsTerminal(attemptOrder)
  useEffect(() => (attemptPolling ? pollOrder(actions.refreshAttemptOrder) : undefined), [attemptPolling, pollOrder, actions, state.generation])
  const selectedPolling = tab === "orders" && state.selectedOrder !== null && !orderIsTerminal(state.selectedOrder.order)
  useEffect(() => (selectedPolling ? pollOrder(actions.refreshSelectedOrder) : undefined), [selectedPolling, pollOrder, actions, state.generation])

  return (
    <GiwaStocksFeatureView
      state={state}
      actions={actions}
      tab={tab}
      onTabChange={setTab}
      detailOpen={detailOpen}
      onDetailChange={setDetailOpen}
      switching={switching}
      renderOrderExecution={renderOrderExecution}
    />
  )
}
