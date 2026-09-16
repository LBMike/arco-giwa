// Catalog list, instrument detail, orders and portfolio. Pure views over controller state.

import { useRef } from "react"

import type { CatalogState, SideOrders, StocksInvestorState } from "./controller"
import type { StocksInvestorActions } from "./actions"
import { cashLabel, errorMessage, formatCash, formatPrice, formatQuantity, formatSignedQuantity, formatUtc, signedOutMessage } from "./display"
import { OrderStatusCard } from "./OrderStatusCard"
import { CATEGORY_TONE, orderStatusMeaning } from "./status"
import { TradePanel } from "./TradePanel"
import type { StocksCatalog, StocksOrder } from "./types"
import { BUTTON_PRIMARY, BUTTON_SECONDARY, Chip, Field, Heading, Notice, PANEL, useRescueFocus } from "./ui"

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
                  className="grid w-full grid-cols-1 items-center gap-3 rounded-[var(--radius-row)] border border-[var(--color-arco-border)] p-4 md:grid-cols-[minmax(0,1fr)_auto_auto_auto]"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span aria-hidden className="inline-flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] text-xs font-medium text-[var(--color-arco-chip-ink)]">
                      NV
                    </span>
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-medium text-[var(--color-arco-ink)]">{instrument.symbol}</p>
                      <p className="text-xs text-[var(--color-arco-text-soft)]">Test units · {instrument.quantityScale} decimals</p>
                    </div>
                  </div>
                  <div className="text-sm tabular-nums text-[var(--color-arco-ink)] md:text-right">
                    {formatPrice(instrument.price)} {catalog.cashSymbol}
                    <p className="text-xs text-[var(--color-arco-text-soft)]">Fixed mock price</p>
                  </div>
                  <div>
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

export function StockDetailView({ state, actions, onBack }: { state: StocksInvestorState; actions: StocksInvestorActions; onBack: () => void }) {
  const catalog = catalogOf(state.catalog)
  const instrument = catalog?.instruments.find((item) => item.symbol === "NVDA") ?? null
  const headingRef = useRef<HTMLHeadingElement>(null)
  useRescueFocus(headingRef, "detail")
  return (
    <div className="flex w-full flex-col gap-4">
      <div>
        <button type="button" className={BUTTON_SECONDARY} onClick={onBack}>
          All stocks
        </button>
      </div>
      <CatalogStatus state={state} actions={actions} />
      {catalog && instrument ? (
        <div className="grid w-full grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <section className={`${PANEL} lg:self-start`} aria-labelledby="giwa-stocks-detail-title">
            <p className="font-mono text-sm text-[var(--color-arco-text-soft)]">NVDA</p>
            <h2
              id="giwa-stocks-detail-title"
              ref={headingRef}
              tabIndex={-1}
              className="mt-1 text-2xl font-medium tabular-nums text-[var(--color-arco-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
            >
              {formatPrice(instrument.price)} <span className="text-base font-normal text-[var(--color-arco-text-soft)]">{catalog.cashSymbol}</span>
            </h2>
            <p className="mt-1 text-xs text-[var(--color-arco-text-soft)]">Fixed mock price · as of {formatUtc(catalog.observedAt)}</p>
            <dl className="mt-4 w-full">
              <Field label="Order capability">{instrument.orderCapability === "CHECK_PAUSE_AT_ORDER" ? "Open unless paused (checked per order)" : "Not activated"}</Field>
              <Field label="Quantity precision">{instrument.quantityScale} decimal places</Field>
              <Field label="Test cash">{cashLabel(catalog.cashSymbol)}</Field>
              <Field label="Deployment" mono>
                {catalog.deploymentId}
              </Field>
            </dl>
          </section>
          <section className={PANEL}>
            <TradePanel state={state} actions={actions} />
          </section>
        </div>
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
        <button type="button" className={BUTTON_SECONDARY} onClick={actions.loadOrders} disabled={orders.status === "loading"} aria-busy={orders.status === "loading"}>
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
          <ul className="flex w-full flex-col gap-2">
            {merged.map((order) => {
              const side = order.side === "SELL" ? orders.status === "ready" && orders.sell.status === "ready" ? orders.sell.observedAt : null : orders.status === "ready" && orders.buy.status === "ready" ? orders.buy.observedAt : null
              const meaning = orderStatusMeaning(order, side)
              return (
                <li key={`${order.side}:${order.id}`}>
                  <button
                    type="button"
                    onClick={() => actions.selectOrder(order)}
                    className="grid w-full grid-cols-1 gap-2 rounded-[var(--radius-row)] border border-[var(--color-arco-border)] p-4 text-left hover:bg-[var(--color-row-hover-weak)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)] md:grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-center"
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
        <button type="button" className={BUTTON_SECONDARY} onClick={actions.loadPortfolio} disabled={portfolio.status === "loading"} aria-busy={portfolio.status === "loading"}>
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
                <Heading level={3}>NVDA</Heading>
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
