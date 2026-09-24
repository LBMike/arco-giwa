import { ORDER_LIST_LIMIT } from "./client"
import { CASH_SCALE, CASH_UNIT, QUANTITY_SCALE, formatCount, sumCounts } from "./format"
import { CATEGORY_LABEL, isInProgress, stateInfo, stateRank } from "./states"
import type { OrderRow, OrderSide, OverviewRow, ResourceState } from "./types"
import { Amount, Button, Card, DataList, EmptyRow, Mono, Notice, Pill, ResourceMeta, Time, errorCopy, toneOf } from "./ui"

type Props = {
  overview: ResourceState<readonly OverviewRow[]>
  orders: ResourceState<readonly OrderRow[]>
  now: number
  onRefresh: () => void
  onOpenOrder: (orderId: string) => void
}

export function OverviewPanel({ overview, orders, now, onRefresh, onOpenOrder }: Props) {
  const rows = overview.value?.data ?? null
  const inProgressCounted = rows
    ? sumCounts(rows.filter((row) => isInProgress(stateInfo(row.side, row.state).category)).map((row) => row.count))
    : null

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <ResourceMeta state={overview} now={now} onRefresh={onRefresh} what="overview" />
      {rows === null ? (
        overview.phase === "error" && overview.error ? null : <EmptyRow>Loading order states…</EmptyRow>
      ) : (
        <div className="grid min-w-0 gap-4 2xl:grid-cols-2">
          {(["BUY", "SELL"] as const).map((side) => (
            <SideStates key={side} side={side} rows={rows.filter((row) => row.side === side)} />
          ))}
        </div>
      )}
      <InProgressOrders orders={orders} inProgressCounted={inProgressCounted} now={now} onOpenOrder={onOpenOrder} />
    </div>
  )
}

function SideStates({ side, rows }: { side: OrderSide; rows: readonly OverviewRow[] }) {
  const sorted = [...rows].sort((a, b) => stateRank(side, a.state) - stateRank(side, b.state))
  const total = sumCounts(rows.map((row) => row.count))
  const inProgress = sumCounts(rows.filter((row) => isInProgress(stateInfo(side, row.state).category)).map((row) => row.count))
  return (
    <Card
      title={`${side} orders by state`}
      description={
        rows.length === 0
          ? "The server reported no orders on this side for the deployment."
          : `${formatCount(total)} orders · ${formatCount(inProgress)} not finished. Counts cover every order in the deployment; cash is the server's per-state sum and is not added across states.`
      }
    >
      {rows.length === 0 ? (
        <EmptyRow>No {side} orders recorded.</EmptyRow>
      ) : (
        <DataList
          label={`${side} order states`}
          wideClass="md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,0.6fr)_minmax(0,1.6fr)]"
          stackClass="grid-cols-2"
          columns={[
            { key: "state", header: "State" },
            { key: "status", header: "Status" },
            { key: "count", header: "Orders", align: "end" },
            { key: "cash", header: "Cash in state" },
          ]}
          rows={sorted.map((row) => {
            const info = stateInfo(side, row.state)
            return {
              key: row.state,
              cells: {
                state: (
                  <>
                    <span className="break-words font-mono">{row.state}</span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-[var(--color-arco-text-soft)]">{info.description}</span>
                  </>
                ),
                status: <Pill tone={toneOf(info.category)}>{CATEGORY_LABEL[info.category]}</Pill>,
                count: <span className="font-mono tabular-nums">{formatCount(row.count)}</span>,
                cash: <Amount value={row.cashAmount} scale={CASH_SCALE} unit={CASH_UNIT} />,
              },
            }
          })}
        />
      )}
    </Card>
  )
}

function InProgressOrders({ orders, inProgressCounted, now, onOpenOrder }: {
  orders: ResourceState<readonly OrderRow[]>
  inProgressCounted: string | null
  now: number
  onOpenOrder: (orderId: string) => void
}) {
  const rows = orders.value?.data ?? null
  const listed = rows
    ? rows
        .filter((row) => isInProgress(stateInfo(row.side, row.state).category))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    : null
  const notListed = listed && inProgressCounted !== null ? BigInt(inProgressCounted) - BigInt(listed.length) : null

  return (
    <Card
      title="Unfinished orders"
      description={
        rows
          ? `From the latest ${formatCount(String(rows.length))} orders the server returned (limit ${ORDER_LIST_LIMIT}), oldest first.`
          : "Built from the orders list, which has not loaded."
      }
    >
      {orders.phase === "error" && orders.error && (
        <div className="mb-3">
          <Notice tone="error" title={`Orders list: ${errorCopy(orders.error).title}`}>
            {rows ? "Showing the last successful list." : "Unfinished orders cannot be listed. This is not a zero count."}
          </Notice>
        </div>
      )}
      {notListed !== null && notListed > 0n && (
        <div className="mb-3">
          <Notice tone="attention" title={`${notListed.toString()} unfinished orders are not in the loaded list`}>
            The overview counts {inProgressCounted} unfinished orders, but only {listed?.length} appear in the latest {ORDER_LIST_LIMIT} orders.
          </Notice>
        </div>
      )}
      {listed === null ? (
        orders.phase === "error" ? null : <EmptyRow>Loading orders…</EmptyRow>
      ) : listed.length === 0 ? (
        <EmptyRow>No unfinished orders in the loaded list.</EmptyRow>
      ) : (
        <DataList
          label="Unfinished orders"
          stackClass="grid-cols-2"
          wideClass="xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.5fr)_minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto]"
          columns={[
            { key: "created", header: "Created" },
            { key: "side", header: "Side" },
            { key: "stage", header: "Stage" },
            { key: "quantity", header: "Quantity" },
            { key: "order", header: "Order" },
            { key: "updated", header: "Last update" },
            { key: "action", header: "Actions", visuallyHiddenHeader: true },
          ]}
          rows={listed.map((row) => {
            const info = stateInfo(row.side, row.state)
            return {
              key: row.id,
              cells: {
                created: <Time iso={row.createdAt} now={now} elapsed />,
                side: <span className="font-mono">{row.side}</span>,
                stage: <Pill tone={toneOf(info.category)} title={info.description}>{row.state}</Pill>,
                quantity: <Amount value={row.quantity} scale={QUANTITY_SCALE} unit={row.symbol} showBase={false} />,
                order: <Mono value={row.id} short />,
                updated: <Time iso={row.updatedAt} now={now} elapsed />,
                action: (
                  <Button onClick={() => onOpenOrder(row.id)} label={`Open order ${row.id}`}>
                    Open detail
                  </Button>
                ),
              },
            }
          })}
        />
      )}
    </Card>
  )
}
