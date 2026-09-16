import { useId, useMemo, useState } from "react"
import { ORDER_LIST_LIMIT } from "./client"
import { CASH_SCALE, CASH_UNIT, QUANTITY_SCALE, formatCount } from "./format"
import { OrderDetailView } from "./OrderDetail"
import { CATEGORY_LABEL, isInProgress, stateInfo, type StateCategory } from "./states"
import type { DetailState, OrderRow, ResourceState } from "./types"
import { Amount, DataList, EmptyRow, FOCUS_RING, Mono, Notice, Pill, ResourceMeta, Time, toneOf } from "./ui"

export type OrderFilters = {
  readonly side: "ALL" | "BUY" | "SELL"
  readonly category: "ALL" | "IN_PROGRESS" | StateCategory
  readonly state: string
  readonly query: string
}

export const DEFAULT_FILTERS: OrderFilters = { side: "ALL", category: "ALL", state: "ALL", query: "" }

/** Filters only the rows the server returned; it never implies anything about unloaded orders. */
export function filterOrders(rows: readonly OrderRow[], filters: OrderFilters): OrderRow[] {
  const query = filters.query.trim().toLowerCase()
  return rows.filter((row) => {
    if (filters.side !== "ALL" && row.side !== filters.side) return false
    const category = stateInfo(row.side, row.state).category
    if (filters.category === "IN_PROGRESS" && !isInProgress(category)) return false
    if (filters.category !== "ALL" && filters.category !== "IN_PROGRESS" && category !== filters.category) return false
    if (filters.state !== "ALL" && row.state !== filters.state) return false
    if (query && ![row.id, row.wallet, row.orderKey, row.symbol].some((value) => value.toLowerCase().includes(query))) return false
    return true
  })
}

type Props = {
  orders: ResourceState<readonly OrderRow[]>
  detail: DetailState
  now: number
  onRefresh: () => void
  onSelect: (orderId: string) => void
  onRefreshDetail: () => void
}

const INPUT = `h-9 w-full min-w-0 rounded-[var(--radius-control)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-2 text-xs text-[var(--color-arco-ink)] ${FOCUS_RING}`

export function OrdersPanel({ orders, detail, now, onRefresh, onSelect, onRefreshDetail }: Props) {
  const [filters, setFilters] = useState<OrderFilters>(DEFAULT_FILTERS)
  const ids = useId()
  const rows = orders.value?.data ?? null
  const states = useMemo(() => (rows ? [...new Set(rows.map((row) => row.state))].sort() : []), [rows])
  const visible = useMemo(() => (rows ? filterOrders(rows, filters) : []), [rows, filters])
  const update = (patch: Partial<OrderFilters>) => setFilters((current) => ({ ...current, ...patch }))

  return (
    <div className="grid w-full min-w-0 gap-4 2xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <section aria-labelledby={`${ids}-list`} className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-4 shadow-[var(--shadow-control)]">
        <h3 id={`${ids}-list`} className="text-sm font-semibold text-[var(--color-arco-ink)]">Orders</h3>
        <ResourceMeta state={orders} now={now} onRefresh={onRefresh} what="orders" />
        {rows && (
          <>
            <p className="text-xs leading-5 text-[var(--color-arco-text-soft)]">
              The server returned the latest {formatCount(String(rows.length))} BUY and SELL orders (newest first, limit {ORDER_LIST_LIMIT}). It
              provides no pagination, total count or server-side filter; filters and search below only apply to these rows.
            </p>
            {rows.length >= ORDER_LIST_LIMIT && (
              <Notice tone="attention" title={`Limit of ${ORDER_LIST_LIMIT} reached`}>
                Older orders may exist and are not loaded. A missing order here is not proof that it does not exist.
              </Notice>
            )}
            <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <label className="min-w-0 text-[11px] font-medium text-[var(--color-arco-text-soft)]">
                Side
                <select className={`mt-1 ${INPUT}`} value={filters.side} onChange={(event) => update({ side: event.target.value as OrderFilters["side"] })}>
                  <option value="ALL">All sides</option>
                  <option value="BUY">BUY</option>
                  <option value="SELL">SELL</option>
                </select>
              </label>
              <label className="min-w-0 text-[11px] font-medium text-[var(--color-arco-text-soft)]">
                Status
                <select className={`mt-1 ${INPUT}`} value={filters.category} onChange={(event) => update({ category: event.target.value as OrderFilters["category"] })}>
                  <option value="ALL">All statuses</option>
                  <option value="IN_PROGRESS">Not finished</option>
                  {(Object.keys(CATEGORY_LABEL) as StateCategory[]).map((category) => (
                    <option key={category} value={category}>{CATEGORY_LABEL[category]}</option>
                  ))}
                </select>
              </label>
              <label className="min-w-0 text-[11px] font-medium text-[var(--color-arco-text-soft)]">
                State
                <select className={`mt-1 ${INPUT}`} value={filters.state} onChange={(event) => update({ state: event.target.value })}>
                  <option value="ALL">All states</option>
                  {states.map((state) => (
                    <option key={state} value={state}>{state}</option>
                  ))}
                </select>
              </label>
              <label className="min-w-0 text-[11px] font-medium text-[var(--color-arco-text-soft)]">
                Search loaded orders
                <input
                  type="search"
                  className={`mt-1 ${INPUT}`}
                  placeholder="Order id, wallet, order key"
                  value={filters.query}
                  onChange={(event) => update({ query: event.target.value })}
                />
              </label>
            </div>
            <p aria-live="polite" className="text-[11px] text-[var(--color-arco-text-soft)]">
              Showing {formatCount(String(visible.length))} of {formatCount(String(rows.length))} loaded orders
            </p>
            {rows.length === 0 ? (
              <EmptyRow>The server returned no orders for this deployment.</EmptyRow>
            ) : visible.length === 0 ? (
              <EmptyRow>No loaded order matches these filters.</EmptyRow>
            ) : (
              <DataList
                label="Loaded orders"
                stackClass="grid-cols-2"
                wideClass="lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.5fr)_minmax(0,1.3fr)_minmax(0,2fr)_minmax(0,1.3fr)]"
                columns={[
                  { key: "order", header: "Order" },
                  { key: "side", header: "Side" },
                  { key: "state", header: "State" },
                  { key: "amounts", header: "Quantity · cash" },
                  { key: "created", header: "Created" },
                ]}
                rows={visible.map((row) => {
                  const info = stateInfo(row.side, row.state)
                  const selected = detail.orderId === row.id
                  return {
                    key: row.id,
                    current: selected,
                    cells: {
                      order: (
                        <button
                          type="button"
                          onClick={() => onSelect(row.id)}
                          aria-pressed={selected}
                          aria-label={`Show detail for ${row.side} order ${row.id}`}
                          className={`min-h-8 rounded-[var(--radius-control)] text-left underline decoration-[var(--color-arco-border)] underline-offset-2 ${FOCUS_RING}`}
                        >
                          <Mono value={row.id} short />
                        </button>
                      ),
                      side: <span className="font-mono">{row.side}</span>,
                      state: <Pill tone={toneOf(info.category)} title={info.description}>{row.state}</Pill>,
                      amounts: (
                        <>
                          <Amount value={row.quantity} scale={QUANTITY_SCALE} unit={row.symbol} showBase={false} />
                          <span className="mt-0.5 block">
                            <Amount value={row.cashAmount} scale={CASH_SCALE} unit={CASH_UNIT} showBase={false} />
                          </span>
                        </>
                      ),
                      created: <Time iso={row.createdAt} />,
                    },
                  }
                })}
              />
            )}
          </>
        )}
        {!rows && orders.phase !== "error" && <EmptyRow>Loading orders…</EmptyRow>}
      </section>
      <OrderDetailView detail={detail} now={now} onRefresh={onRefreshDetail} />
    </div>
  )
}
