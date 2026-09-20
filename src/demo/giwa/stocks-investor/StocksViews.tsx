// Catalog list, instrument detail, orders and portfolio. Pure views over controller state.

import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from "react"

import { BottomSheet } from "../BottomSheet"
import { INVEST_PANEL_CARD } from "../invest-panel-ui"
import { StockLogo } from "../stocks-market/StockLogo"
import { useStocksAccess } from "./access"
import type { CatalogState, SideOrders, StocksInvestorState } from "./controller"
import type { StocksInvestorActions } from "./actions"
import { cashLabel, errorMessage, formatCash, formatPrice, formatQuantity, formatSignedQuantity, formatUtc, signedOutMessage } from "./display"
import { OrderStatusCard } from "./OrderStatusCard"
import { CATEGORY_TONE, orderStatusMeaning } from "./status"
import { statusAnnouncement, TradePanel, tradeStep, type TradeStep } from "./TradePanel"
import type { StocksCatalog, StocksInstrument, StocksOrder, StocksSide } from "./types"
import { BUTTON_PRIMARY, BUTTON_SECONDARY, Chip, FOCUS_RING, Field, Heading, Notice, PANEL, UserInteractionContext, useIsDesktop, useRescueFocus } from "./ui"

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect

/** Native `disabled` drops keyboard focus: while loading the button stays focusable, aria-disabled, and has no click handler. */
const BUSY = "aria-disabled:cursor-not-allowed aria-disabled:opacity-40"

function catalogOf(catalog: CatalogState): StocksCatalog | null {
  return catalog.status === "ready" ? catalog.catalog : null
}

function CatalogStatus({ state, actions }: { state: StocksInvestorState; actions: StocksInvestorActions }) {
  const catalog = state.catalog
  if (!state.clientConfigured || catalog.status === "idle") return <Notice tone="info">The Stocks API is not configured for this app.</Notice>
  if (catalog.status === "loading") return <Notice tone="info">Loading the Stocks catalog…</Notice>
  if (catalog.status === "unavailable") {
    return (
      <Notice tone="info" title="Stocks trading is not available on this server">
        The Stocks API is not enabled here. No instrument can be shown or traded.
      </Notice>
    )
  }
  if (catalog.status === "error") {
    return (
      <Notice tone="error" title="The Stocks catalog could not be loaded">
        <p>{errorMessage(catalog.error)}</p>
        <button type="button" className={`${BUTTON_SECONDARY} mt-3`} onClick={actions.retryCatalog}>
          Try again
        </button>
      </Notice>
    )
  }
  return null
}

export function StocksListView({ state, actions, onOpen }: { state: StocksInvestorState; actions: StocksInvestorActions; onOpen: () => void }) {
  const catalog = catalogOf(state.catalog)
  const headingRef = useRef<HTMLHeadingElement>(null)
  useRescueFocus(headingRef, "list")
  return (
    <div className="flex w-full flex-col gap-4">
      <CatalogStatus state={state} actions={actions} />
      {catalog ? (
        <section className={PANEL} aria-labelledby="giwa-stocks-list-title">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <Heading id="giwa-stocks-list-title" headingRef={headingRef}>
              Available stocks
            </Heading>
            <p className="text-xs text-[var(--color-arco-text-soft)]">As of {formatUtc(catalog.observedAt)}</p>
          </div>
          {catalog.instruments.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--color-arco-text-soft)]">The server lists no instruments.</p>
          ) : (
            <ul className="mt-4 flex w-full flex-col gap-3">
              {catalog.instruments.map((instrument) => (
                <li
                  key={instrument.symbol}
                  className="flex w-full flex-wrap items-center gap-x-4 gap-y-3 rounded-[var(--radius-row)] border border-[var(--color-arco-border)] p-4"
                >
                  <div className="flex min-w-[10rem] flex-1 items-center gap-3">
                    <StockLogo symbol={instrument.symbol} />
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-medium text-[var(--color-arco-ink)]">{instrument.symbol}</p>
                      <p className="text-xs text-[var(--color-arco-text-soft)]">Test units · {instrument.quantityScale} decimals</p>
                    </div>
                  </div>
                  <div className="text-sm tabular-nums text-[var(--color-arco-ink)]">
                    {formatPrice(instrument.price)} {catalog.cashSymbol}
                    <p className="text-xs text-[var(--color-arco-text-soft)]">Fixed mock price</p>
                  </div>
                  <div className="whitespace-nowrap">
                    <Chip tone={instrument.orderCapability === "CHECK_PAUSE_AT_ORDER" ? "neutral" : "attention"}>
                      {instrument.orderCapability === "CHECK_PAUSE_AT_ORDER" ? "Orders open unless paused" : "Not activated"}
                    </Chip>
                  </div>
                  <button type="button" className={BUTTON_PRIMARY} onClick={onOpen} aria-label={`View ${instrument.symbol}`}>
                    View
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-xs leading-5 text-[var(--color-arco-text-soft)]">
            {cashLabel(catalog.cashSymbol)} · Mock broker · Test value only. Not a market price, not a security and not redeemable value.
          </p>
        </section>
      ) : null}
    </div>
  )
}

/** The detail's title id: View NVDA → Enter lands here (the desktop trade card or the mobile summary; one is mounted). */
const DETAIL_TITLE_ID = "giwa-stocks-detail-title"
// calc(env(...)) needs real spaces, so apply via inline style (Tailwind arbitrary values escape them).
const SAFE_AREA_PB = "calc(env(safe-area-inset-bottom) + 0.75rem)"
const DOCK_PRIMARY = `flex-1 min-h-11 rounded-[var(--radius-card)] bg-[var(--color-arco-ink)] py-3 text-sm font-medium text-[var(--color-arco-on-dark)] ${FOCUS_RING}`
const DOCK_SECONDARY = `flex-1 min-h-11 rounded-[var(--radius-card)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] py-3 text-sm font-medium text-[var(--color-arco-ink)] ${FOCUS_RING}`
/** Room the fixed dock takes at the bottom of the viewport (about 4.5rem plus the safe area), kept clear for focus scrolling. */
const DOCK_SCROLL_PADDING = "7rem"
/**
 * The dock's own height, published for the page shell to reserve AFTER its footer (GiwaPreprodApp reads it as the shell
 * column's padding-bottom). `pb-*` inside <main> cannot do this: the dock is fixed to the viewport, so the footer that
 * follows main still ends under it. html, body and #root are height:100%, so an element appended to <body> lands at one
 * viewport height, not at the end of the page — the reservation has to be in the shell's own flow.
 */
const DOCK_SPACE_PROPERTY = "--giwa-dock-space"
const DOCK_SPACE = "calc(env(safe-area-inset-bottom) + 4.5rem)"

/** The sheet's open state, owned above the session-switch boundary (GiwaStocksFeatureView) so a sign-in keeps it open. */
export type TradeSheetState = { open: boolean; onOpenChange: (open: boolean) => void }

/** Reports whether the sheet's content (the trade panel and its status line) is mounted, including the slide-out. */
function SheetPresence({ onPresence }: { onPresence: (present: boolean) => void }) {
  useIsomorphicLayoutEffect(() => {
    onPresence(true)
    return () => onPresence(false)
  }, [onPresence])
  return null
}

/**
 * Where the NVDA trade stands, for the mobile summary card: the order on screen, or the one next step of the panel.
 * Server amounts only (the quote's cash amount), never an estimate.
 */
function summaryStatus(state: StocksInvestorState, step: TradeStep, cash: string): string {
  const attempt = state.attempt
  if (step.kind === "attempt" && attempt !== null) {
    return attempt.status === "ACCEPTED" && attempt.order ? `${step.label} · ${orderStatusMeaning(attempt.order, attempt.orderObservedAt).label}` : step.label
  }
  if (attempt?.status === "REJECTED") return "Order not placed"
  if (step.kind === "place" && state.quote.status === "ready") return `Quote ready: ${formatCash(state.quote.quote.cashAmount)} ${cash} for ${formatQuantity(state.quote.quote.quantity)} NVDA`
  if (step.kind === "requote") return "Quote expired. No order was placed."
  return step.label
}

/**
 * Below lg: a compact summary card, a fixed Buy / Sell dock, and a bottom sheet holding THE trade panel (mounted only
 * while the sheet is open, so there is never a second panel, input or side toggle). The dock buttons carry no data-side:
 * they preset the side through the panel's own action and open the sheet.
 */
function MobileTrade({
  state,
  actions,
  catalog,
  instrument,
  headingRef,
  sheet,
}: {
  state: StocksInvestorState
  actions: StocksInvestorActions
  catalog: StocksCatalog
  instrument: StocksInstrument
  headingRef: RefObject<HTMLHeadingElement>
  sheet: TradeSheetState
}) {
  const access = useStocksAccess()
  const { open, onOpenChange: setOpen } = sheet
  // While the sheet's trade panel is mounted it carries the status line; otherwise the summary does (never both).
  const [panelMounted, setPanelMounted] = useState(open)
  const onPresence = useCallback((present: boolean) => setPanelMounted(present), [])
  const sheetId = useId()
  const openerRef = useRef<HTMLButtonElement | null>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const step = tradeStep(state, access)
  // An unresolved or accepted order: the panel shows it and the side cannot change, so the dock only opens it.
  const orderShown = step.kind === "attempt"
  const openWith = (side: StocksSide | null) => (event: MouseEvent<HTMLButtonElement>) => {
    openerRef.current = event.currentTarget
    if (side !== null && !orderShown) actions.setSide(side)
    setOpen(true)
  }
  const close = () => {
    // The opener may have been replaced meanwhile (Buy / Sell → View order): return to the dock's current first button.
    if (!openerRef.current?.isConnected) openerRef.current = dockRef.current?.querySelector("button") ?? null
    setOpen(false)
  }
  const expanded = { "aria-expanded": open, "aria-controls": sheetId }
  // The fixed dock covers the bottom of the viewport while it is mounted: keep a focused control scrolled clear of it, and
  // tell the page shell how much room to leave after its footer so the dock never covers the footer's links.
  useEffect(() => {
    const style = document.documentElement.style
    const previous: [string, string, string][] = [
      ["scroll-padding-bottom", style.getPropertyValue("scroll-padding-bottom"), DOCK_SCROLL_PADDING],
      [DOCK_SPACE_PROPERTY, style.getPropertyValue(DOCK_SPACE_PROPERTY), DOCK_SPACE],
    ]
    for (const [property, , value] of previous) style.setProperty(property, value)
    return () => {
      for (const [property, before] of previous) {
        if (before) style.setProperty(property, before)
        else style.removeProperty(property)
      }
    }
  }, [])
  return (
    <>
      <section className={`w-full ${INVEST_PANEL_CARD}`} aria-labelledby={DETAIL_TITLE_ID}>
        <div className="flex items-center gap-3">
          <StockLogo symbol="NVDA" />
          <div className="min-w-0">
            <h2 id={DETAIL_TITLE_ID} ref={headingRef} tabIndex={-1} className={`scroll-mt-24 text-lg font-medium text-[var(--color-arco-ink)] ${FOCUS_RING}`}>
              Trade NVDA
            </h2>
            <p className="text-xs text-[var(--color-arco-text-soft)]">
              Fixed mock price {formatPrice(instrument.price)} {catalog.cashSymbol} / NVDA · test value only
            </p>
          </div>
        </div>
        <dl className="mt-3 w-full">
          <Field label="Order capability">{instrument.orderCapability === "CHECK_PAUSE_AT_ORDER" ? "Open unless paused (checked per order)" : "Not activated"}</Field>
          <Field label={orderShown ? "Order" : "Next step"}>{summaryStatus(state, step, catalog.cashSymbol)}</Field>
        </dl>
        {/* The sheet's panel announces while it is mounted; with the sheet closed, quote expiry and order results are said here. */}
        {panelMounted ? null : (
          <p className="sr-only" aria-live="polite" data-testid="stocks-trade-summary-status">
            {statusAnnouncement(state)}
          </p>
        )}
      </section>
      <div ref={dockRef} className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-arco-border)] bg-[var(--color-arco-page-80)] px-4 pt-3 backdrop-blur lg:hidden" style={{ paddingBottom: SAFE_AREA_PB }}>
        <div className="mx-auto flex w-full max-w-[var(--container-page)] gap-3">
          {orderShown ? (
            <button type="button" className={DOCK_PRIMARY} onClick={openWith(null)} {...expanded}>
              View order
            </button>
          ) : (
            <>
              <button type="button" className={DOCK_PRIMARY} onClick={openWith("BUY")} {...expanded}>
                Buy
              </button>
              <button type="button" className={DOCK_SECONDARY} onClick={openWith("SELL")} {...expanded}>
                Sell
              </button>
            </>
          )}
        </div>
      </div>
      <BottomSheet open={open} onClose={close} label="Trade NVDA" returnFocusTo={openerRef} id={sheetId}>
        <div className="pb-2">
          <SheetPresence onPresence={onPresence} />
          <TradePanel state={state} actions={actions} />
        </div>
      </BottomSheet>
    </>
  )
}

/**
 * The NVDA trade view (Stocks tab, detail open). At lg and above the trade panel is inline; below lg a summary card and
 * a dock open it in a bottom sheet. A media query picks the ONE place the panel is mounted (CSS would keep a hidden copy).
 * `onBack` is null when the host page owns list/detail (it renders its own way back).
 */
export function StockDetailView({
  state,
  actions,
  onBack,
  sheet,
}: {
  state: StocksInvestorState
  actions: StocksInvestorActions
  onBack: (() => void) | null
  /** Below lg: the bottom sheet's open state, owned by the feature view. */
  sheet: TradeSheetState
}) {
  const catalog = catalogOf(state.catalog)
  const instrument = catalog?.instruments.find((item) => item.symbol === "NVDA") ?? null
  const headingRef = useRef<HTMLHeadingElement>(null)
  const interacted = useContext(UserInteractionContext)
  const desktop = useIsDesktop()
  // "View" removed the focused button: land on the detail heading. Same guard as useRescueFocus, but a layout effect on
  // mount, so it runs before the trade panel's own (passive, child) rescues move focus to the quantity field or order card.
  // In the page's detail column (the page owns list/detail) the heading is aligned to the top instead of centred, so the
  // quantity field and the next-step action are in the first viewport; its scroll margin clears the sticky header.
  const pageOwned = onBack === null
  useIsomorphicLayoutEffect(() => {
    if (typeof document === "undefined" || !interacted?.current) return
    const active = document.activeElement
    const heading = headingRef.current
    if ((active !== null && active !== document.body) || heading === null) return
    if (!pageOwned) {
      heading.focus()
      return
    }
    heading.focus({ preventScroll: true })
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    heading.scrollIntoView?.({ block: "start", behavior: reduced ? "auto" : "smooth" })
  }, [interacted, pageOwned])
  return (
    <div className="flex w-full flex-col gap-4">
      {onBack ? (
        <div>
          <button type="button" className={BUTTON_SECONDARY} onClick={onBack}>
            All stocks
          </button>
        </div>
      ) : null}
      <CatalogStatus state={state} actions={actions} />
      {catalog && instrument ? (
        desktop ? (
          <div className="w-full max-w-[488px]">
            <TradePanel state={state} actions={actions} titleId={DETAIL_TITLE_ID} headingRef={headingRef} />
          </div>
        ) : (
          <MobileTrade state={state} actions={actions} catalog={catalog} instrument={instrument} headingRef={headingRef} sheet={sheet} />
        )
      ) : catalog ? (
        <Notice tone="info">NVDA is not in the server catalog.</Notice>
      ) : null}
    </div>
  )
}

function sectionBlocked(state: StocksInvestorState): boolean {
  return !state.clientConfigured || state.catalog.status !== "ready" || state.session.status !== "verified" || state.authRejected
}

/** Why an authenticated section cannot show data yet. */
function SectionGate({ state }: { state: StocksInvestorState }) {
  if (!state.clientConfigured || state.catalog.status === "idle") return <Notice tone="info">The Stocks API is not configured for this app.</Notice>
  if (state.session.status === "signed-out" || state.authRejected) return <SignedOutPanel state={state} />
  if (state.catalog.status === "unavailable") return <Notice tone="info">Stocks trading is not available on this server.</Notice>
  if (state.catalog.status !== "ready") {
    // Orders and holdings belong to a deployment; they are read only once the catalog has named it.
    return state.catalog.status === "error" ? (
      <Notice tone="info" title="Waiting for the Stocks catalog">
        The catalog could not be loaded, so the deployment these orders belong to is unknown. Retry from the Stocks tab.
      </Notice>
    ) : (
      <Notice tone="info">Waiting for the Stocks catalog…</Notice>
    )
  }
  return null
}

function SignedOutPanel({ state }: { state: StocksInvestorState }) {
  if (state.session.status === "signed-out") {
    return (
      <Notice tone="info" title="Sign-in required">
        {signedOutMessage(state.session.reason)}
      </Notice>
    )
  }
  if (state.authRejected) return <Notice tone="warning">The server did not accept this sign-in session. Sign in again to continue.</Notice>
  return null
}

function sideErrorText(label: string, orders: SideOrders): string | null {
  return orders.status === "error" ? `${label} orders: ${errorMessage(orders.error)}` : null
}

export function OrdersView({ state, actions }: { state: StocksInvestorState; actions: StocksInvestorActions }) {
  const cashSymbol = catalogOf(state.catalog)?.cashSymbol ?? null
  if (sectionBlocked(state)) return <SectionGate state={state} />
  if (state.selectedOrder) {
    return (
      <section className={PANEL}>
        <div className="mb-4">
          <button type="button" className={BUTTON_SECONDARY} onClick={() => actions.selectOrder(null)}>
            All orders
          </button>
        </div>
        <OrderStatusCard
          order={state.selectedOrder.order}
          observedAt={state.selectedOrder.observedAt}
          cashSymbol={cashSymbol}
          refreshing={state.selectedOrder.refresh === "LOADING"}
          error={state.selectedOrder.error}
          onRefresh={actions.refreshSelectedOrder}
          headingLevel={2}
        />
      </section>
    )
  }
  return <OrdersList state={state} actions={actions} cashSymbol={cashSymbol} />
}

function OrdersList({ state, actions, cashSymbol }: { state: StocksInvestorState; actions: StocksInvestorActions; cashSymbol: StocksCatalog["cashSymbol"] | null }) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useRescueFocus(headingRef, "orders")
  const orders = state.orders
  const merged: StocksOrder[] =
    orders.status === "ready"
      ? [...(orders.buy.status === "ready" ? orders.buy.orders : []), ...(orders.sell.status === "ready" ? orders.sell.orders : [])].sort(
          (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1),
        )
      : []
  const observedAt = orders.status === "ready" ? [orders.buy, orders.sell].flatMap((side) => (side.status === "ready" ? [side.observedAt] : [])).sort()[0] : null
  return (
    <section className={PANEL} aria-labelledby="giwa-stocks-orders-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Heading id="giwa-stocks-orders-title" headingRef={headingRef}>
          Your Stocks orders
        </Heading>
        <button type="button" className={`${BUTTON_SECONDARY} ${BUSY}`} onClick={orders.status === "loading" ? undefined : actions.loadOrders} aria-disabled={orders.status === "loading" || undefined} aria-busy={orders.status === "loading"}>
          {orders.status === "loading" ? "Loading…" : "Refresh"}
        </button>
      </div>
      {observedAt ? <p className="mt-1 text-xs text-[var(--color-arco-text-soft)]">As of {formatUtc(observedAt)} · latest 100 per side</p> : null}
      <div className="mt-4 flex flex-col gap-3">
        {orders.status === "ready"
          ? [sideErrorText("Buy", orders.buy), sideErrorText("Sell", orders.sell)].map((text) => (text ? <Notice key={text} tone="error">{text}</Notice> : null))
          : null}
        {orders.status === "loading" || orders.status === "idle" ? <p className="text-sm text-[var(--color-arco-text-soft)]">Loading orders…</p> : null}
        {orders.status === "ready" && merged.length === 0 && orders.buy.status === "ready" && orders.sell.status === "ready" ? (
          <p className="text-sm text-[var(--color-arco-text-soft)]">No Stocks orders for this wallet.</p>
        ) : null}
        {merged.length > 0 ? (
          // Rows lay out by the list's own width (a 488px detail column stacks them), not the viewport.
          <ul className="flex w-full flex-col gap-2 [container-type:inline-size]">
            {merged.map((order) => {
              const side = order.side === "SELL" ? orders.status === "ready" && orders.sell.status === "ready" ? orders.sell.observedAt : null : orders.status === "ready" && orders.buy.status === "ready" ? orders.buy.observedAt : null
              const meaning = orderStatusMeaning(order, side)
              return (
                <li key={`${order.side}:${order.id}`}>
                  <button
                    type="button"
                    onClick={() => actions.selectOrder(order)}
                    className="grid w-full grid-cols-1 gap-2 rounded-[var(--radius-row)] border border-[var(--color-arco-border)] p-4 text-left hover:bg-[var(--color-row-hover-weak)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)] [@container_(min-width:36rem)]:grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] [@container_(min-width:36rem)]:items-center"
                  >
                    <span className="text-sm font-medium text-[var(--color-arco-ink)]">{order.side === "SELL" ? "Sell" : "Buy"}</span>
                    <span className="text-sm tabular-nums text-[var(--color-arco-ink)]">{formatQuantity(order.quantity)} NVDA</span>
                    <span className="text-sm tabular-nums text-[var(--color-arco-text-soft)]">
                      {formatCash(order.cashAmount)} {cashSymbol ?? "test cash"}
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <Chip tone={CATEGORY_TONE[meaning.category]}>{meaning.label}</Chip>
                      <span className="text-xs text-[var(--color-arco-text-soft)]">{formatUtc(order.createdAt)}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>
    </section>
  )
}

export function PortfolioView({ state, actions }: { state: StocksInvestorState; actions: StocksInvestorActions }) {
  if (sectionBlocked(state)) return <SectionGate state={state} />
  const portfolio = state.portfolio
  const cashSymbol = catalogOf(state.catalog)?.cashSymbol ?? "test cash"
  return (
    <section className={PANEL} aria-labelledby="giwa-stocks-portfolio-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Heading id="giwa-stocks-portfolio-title">Stocks holdings</Heading>
        <button type="button" className={`${BUTTON_SECONDARY} ${BUSY}`} onClick={portfolio.status === "loading" ? undefined : actions.loadPortfolio} aria-disabled={portfolio.status === "loading" || undefined} aria-busy={portfolio.status === "loading"}>
          {portfolio.status === "loading" ? "Loading…" : "Refresh"}
        </button>
      </div>
      {portfolio.status === "error" ? (
        <div className="mt-4">
          <Notice tone="error">{errorMessage(portfolio.error)}</Notice>
        </div>
      ) : null}
      {portfolio.status === "loading" || portfolio.status === "idle" ? <p className="mt-4 text-sm text-[var(--color-arco-text-soft)]">Loading holdings…</p> : null}
      {portfolio.status === "ready" ? (
        <div className="mt-2 flex flex-col gap-6">
          <p className="text-xs text-[var(--color-arco-text-soft)]">As of {formatUtc(portfolio.observedAt)} · finalized on-chain movements</p>
          {portfolio.portfolio.holdings.length === 0 ? (
            <p className="text-sm text-[var(--color-arco-text-soft)]">No Stocks holdings for this wallet.</p>
          ) : (
            portfolio.portfolio.holdings.map((holding) => (
              <div key={holding.wallet} className="flex flex-col gap-2" data-testid="stocks-holding">
                <div className="flex items-center gap-2">
                  <StockLogo symbol="NVDA" size={32} />
                  <Heading level={3}>NVDA</Heading>
                </div>
                {holding.availableQuantity.startsWith("-") || holding.walletQuantity.startsWith("-") ? (
                  <Notice tone="warning" title="Holding under review">
                    The server reports more units reserved or escrowed than this wallet holds. Nothing is available to sell until this is resolved.
                  </Notice>
                ) : null}
                <dl className="w-full">
                  <Field label="Total (wallet + escrow)">{formatSignedQuantity(holding.quantity)} NVDA</Field>
                  <Field label="In wallet">{formatSignedQuantity(holding.walletQuantity)} NVDA</Field>
                  <Field label="Reserved for sell orders (part of wallet)">{formatQuantity(holding.reservedQuantity)} NVDA</Field>
                  <Field label="Available to sell">{formatSignedQuantity(holding.availableQuantity)} NVDA</Field>
                  <Field label="In escrow (pending sale)">{formatQuantity(holding.escrowedQuantity)} NVDA</Field>
                  <Field label="Wallet" mono>
                    {holding.wallet}
                  </Field>
                </dl>
                <p className="text-xs leading-5 text-[var(--color-arco-text-soft)]">
                  Reserved units are part of the wallet balance and are not counted again. The total counts wallet and escrow once.
                </p>
              </div>
            ))
          )}
          <div className="flex flex-col gap-2">
            <Heading level={3}>Orders in progress</Heading>
            {portfolio.portfolio.pending.length === 0 ? (
              <p className="text-sm text-[var(--color-arco-text-soft)]">No orders in progress.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {portfolio.portfolio.pending.map((pending) => (
                  <li key={`${pending.side}:${pending.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-row)] border border-[var(--color-arco-border)] p-3 text-sm">
                    <span className="text-[var(--color-arco-ink)]">
                      {pending.side === "SELL" ? "Sell" : "Buy"} <span className="tabular-nums">{formatQuantity(pending.quantity)}</span> NVDA ·{" "}
                      <span className="tabular-nums">{formatCash(pending.cashAmount)}</span> {cashSymbol}
                    </span>
                    <Chip tone={CATEGORY_TONE[orderStatusMeaning(pending).category]}>{orderStatusMeaning(pending).label}</Chip>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs leading-5 text-[var(--color-arco-text-soft)]">Orders in progress are not holdings and are not added to the totals above.</p>
          </div>
        </div>
      ) : null}
    </section>
  )
}
