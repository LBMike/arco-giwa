import { DemoDetails } from "../demo-presentation"
// GiwaStocksFeature — the independently renderable GIWA Stocks investor module.
//
// The host supplies an API client and a VERIFIED session (SIWE token for the connected wallet).
// Without a verified session only the public catalog is read. Wallet deposit and escrow signing are
// outside this module: an accepted order shows the exact funding/escrow it waits for, and every
// later state comes from the server.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react"

import { StocksAccessContext, type GiwaStocksAccess } from "./access"
import { actionsFor, type StocksInvestorActions } from "./actions"
import type { GiwaStocksClient } from "./client"
import { createStocksInvestorController, orderIsTerminal, type StocksInvestorState } from "./controller"
import { shortAddress, signedOutMessage } from "./display"
import { OrderExecutionSlotContext, type OrderExecutionSlot } from "./execution-slot"
import { OrdersView, PortfolioView, StockDetailView, StocksListView } from "./StocksViews"
import type { GiwaStocksHostWallet, GiwaStocksSession, GiwaStocksTab } from "./types"
import { FOCUS_RING, Notice, UserInteractionContext, useIsDesktop } from "./ui"

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
  /** Host steps before a request (wallet, network, sign-in), offered by the trade panel. Absent: session only. */
  access?: GiwaStocksAccess | null
  /** The detail's own "All stocks" control. False when the host page owns list/detail and renders its own way back. */
  showAllStocks?: boolean
}

export function GiwaStocksFeatureView({
  state,
  actions,
  tab,
  onTabChange,
  detailOpen,
  onDetailChange,
  switching = false,
  renderOrderExecution = null,
  access = null,
  showAllStocks = true,
}: GiwaStocksFeatureViewProps) {
  const interacted = useRef(false)
  // The mobile trade sheet's open state lives here, above the `switching` swap below: signing in from inside the sheet
  // replaces the detail for one render, and the sheet must come back open. Leaving the NVDA detail, the Stocks tab or the
  // mobile layout closes it (adjusted during render, so a closed sheet never reappears later).
  const desktop = useIsDesktop()
  const [sheetOpen, setSheetOpen] = useState(false)
  if (sheetOpen && (tab !== "stocks" || !detailOpen || desktop)) setSheetOpen(false)
  const sheet = useMemo(() => ({ open: sheetOpen, onOpenChange: setSheetOpen }), [sheetOpen])
  // The page owns list/detail (controlled): its detail is a compact column, so the header keeps only the session line and
  // the test-value note above the tabs (the title stays for assistive technology).
  const compact = !showAllStocks && detailOpen
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
    <StocksAccessContext.Provider value={access}>
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
      <div className={`flex w-full flex-col ${showAllStocks ? "gap-6 px-4 py-6 md:px-8 md:py-8" : compact ? "gap-3 px-4 py-4 md:px-6" : "gap-6 px-4 py-5 md:px-6 md:py-6"}`}>
        <header className={`flex flex-col ${compact ? "gap-1" : "gap-2"}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            {/* A section of the host page (the /stocks page's h1 is the market section's "Stocks"). */}
            <h2 id="giwa-stocks-title" className={compact ? "sr-only" : "text-2xl font-medium text-[var(--color-arco-ink)]"}>
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
          <DemoDetails><p className="text-xs leading-5 text-[var(--color-arco-text-soft)]">GIWA Sepolia testnet · Test value only · Mock broker · Fixed mock price. No real shares, cash or broker execution.</p></DemoDetails>
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
              <StockDetailView state={state} actions={actions} onBack={showAllStocks ? () => onDetailChange(false) : null} sheet={sheet} />
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
    </StocksAccessContext.Provider>
  )
}

export function GiwaStocksFeature(props: GiwaStocksFeatureProps) {
  const { client, session, hostWallet, onSessionRejected, statusPollMs = 10_000, initialTab = "stocks", now, newIdempotencyKey, renderOrderExecution = null, access = null } = props
  const [controller] = useState(() => createStocksInvestorController({ now, newIdempotencyKey }))
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const actions = useMemo(() => actionsFor(controller), [controller])
  const [tab, setTab] = useState<GiwaStocksTab>(initialTab)
  // Controlled by the host page when it passes detailOpen (it owns list/detail and the way back); otherwise local.
  const [localDetailOpen, setLocalDetailOpen] = useState(false)
  const controlledDetail = props.detailOpen !== undefined
  const detailOpen = controlledDetail ? props.detailOpen === true : localDetailOpen
  // A detail opened from outside (a market row, Back/Forward, a deep link) lands on the trade view, not on Orders or
  // Portfolio. Adjusted during render, so the trade panel (or the dock) is in the same commit as the detail. Only the
  // closed → open change moves the tab: the user's own tab choices while the detail stays open are kept.
  const [shownDetail, setShownDetail] = useState(detailOpen)
  if (shownDetail !== detailOpen) {
    setShownDetail(detailOpen)
    if (detailOpen && tab !== "stocks") setTab("stocks")
  }
  const hostDetailChange = props.onDetailChange
  const onDetailChange = useCallback(
    (open: boolean) => {
      if (controlledDetail) hostDetailChange?.(open)
      else setLocalDetailOpen(open)
    },
    [controlledDetail, hostDetailChange],
  )

  const context = { client, session, hostWallet, onSessionRejected }
  // The note the panel took for a sign-in the user started belongs to THIS trade view with THIS wallet connected, and only
  // until that sign-in is over. Leaving the NVDA detail or the Stocks tab, losing the connected wallet, or a sign-in the
  // host reports as failed drops it, so a session that lands after that starts on Buy like any other. Declared before
  // setContext so that in a commit which does both, the note is gone before the new identity is entered.
  const tradeShown = tab === "stocks" && detailOpen && access !== null && access.wallet === "ready" && access.host !== "error"
  useIsomorphicLayoutEffect(() => {
    if (!tradeShown) controller.forgetSignInIntent()
  }, [controller, tradeShown])
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

  // The Sell side shows the server's available NVDA (and MAX): read the portfolio each time the Sell form comes into view
  // through the user's own action (choosing Sell; Start a new order, or a refused order, returning to the form on Sell).
  // Edge-triggered on that form, not on the portfolio's status, so a finished read never starts another one. The trade
  // panel itself never requests anything.
  const sellForm = state.side === "SELL" && (state.attempt === null || state.attempt.status === "REJECTED")
  // A refusal shown on the Sell form (it may arrive without the "placing" state ever being painted). Editing after it
  // clears the refusal while the form stays in view, which is not a new appearance.
  const refusedKey = state.attempt?.status === "REJECTED" ? state.attempt.body.idempotencyKey : null
  // The generation is part of "seen": signing in while the Sell form is on screen makes a new identity whose holdings have
  // not been read yet, so that first appearance under the new identity is a new appearance.
  const seenSellForm = useRef<{ shown: boolean; refusedKey: string | null; generation: number }>({ shown: false, refusedKey: null, generation: state.generation })
  useEffect(() => {
    const previous = seenSellForm.current
    seenSellForm.current = { shown: sellForm, refusedKey, generation: state.generation }
    if (switching || !verified || !catalogReady || !sellForm) return
    if (!previous.shown || previous.generation !== state.generation || (refusedKey !== null && refusedKey !== previous.refusedKey)) actions.loadPortfolio()
  }, [actions, switching, verified, catalogReady, sellForm, refusedKey, state.generation])

  // A SELL order that has just been accepted reserves units: refresh the available quantity once. An attempt restored as
  // already accepted (a remount, or a new session generation after signing in again) is not a new acceptance.
  const generation = state.generation
  const attemptKey = state.attempt?.body.idempotencyKey ?? null
  const attemptStatus = state.attempt?.status ?? null
  const attemptSide = state.attempt?.side ?? null
  const seenAttempt = useRef({ generation, key: attemptKey, status: attemptStatus })
  useEffect(() => {
    const previous = seenAttempt.current
    seenAttempt.current = { generation, key: attemptKey, status: attemptStatus }
    if (switching || attemptKey === null || attemptSide !== "SELL" || attemptStatus !== "ACCEPTED" || previous.generation !== generation) return
    // Same request seen before its acceptance, or a new request of this generation accepted before it was painted.
    if (previous.key !== attemptKey || previous.status !== "ACCEPTED") actions.loadPortfolio()
  }, [actions, switching, generation, attemptKey, attemptStatus, attemptSide])

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
      onDetailChange={onDetailChange}
      switching={switching}
      renderOrderExecution={renderOrderExecution}
      access={access}
      showAllStocks={!controlledDetail}
    />
  )
}
