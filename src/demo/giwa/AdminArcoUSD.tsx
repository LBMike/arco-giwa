import { useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { useSearchParams } from "react-router-dom"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { ExternalLink, Loader2 } from "lucide-react"
import { giwaApi } from "./api"
import { AdminWriteGroup, useGiwaAdmin } from "./admin-context"
import { afterConfirmedReceipt, readableError, sendPreparedTransaction } from "./contracts"
import { explorerAddress, explorerTx } from "./wallet"
import { Pill, type Tone } from "./stocks-admin/ui"
import {
  ARCOUSD_ADMIN_TABS,
  FLOW_WINDOWS,
  QUEUE_FILTERS,
  amountText,
  arcoUSDAdminTab,
  batchSize,
  countText,
  bpsText,
  durationText,
  eventLabel,
  gateText,
  headVerdict,
  mintHeadroomUsd,
  pauseRows,
  queueFilter,
  shortAddress,
  usdCompact,
  usdText,
  type ArcoUSDAdminTab,
} from "./arcousd-admin"
import type {
  GiwaArcoUSDFlows,
  GiwaArcoUSDProcessQueue,
  GiwaArcoUSDQueue,
  GiwaArcoUSDQueueFilter,
  GiwaArcoUSDReserve,
  GiwaArcoUSDSnapshots,
} from "./types"

// Admin · ArcoUSD (docs/admin-console.md "ArcoUSD 관리자 API"): the reserve at a glance, the
// Standard queue with the manual processQueue (operator-signed), and reserve flows. Reads the
// public reserve state plus the operator-only snapshots / queue / flows routes; the only write is
// a transaction the server builds and the operator wallet signs.

const REFRESH_FAST = 30_000
const REFRESH_SLOW = 60_000

export default function GiwaAdminArcoUSDPage() {
  const { auth, wallet } = useGiwaAdmin()
  const [params, setParams] = useSearchParams()
  const tab = arcoUSDAdminTab(params.get("tab"))
  const filter = queueFilter(params.get("status"))
  const [trendDays, setTrendDays] = useState(30)
  const [flowDays, setFlowDays] = useState(30)

  const reserveQuery = useQuery({
    queryKey: ["giwa", "arcousd", "reserve"],
    queryFn: () => giwaApi.arcousd.reserve(),
    refetchInterval: REFRESH_FAST,
  })
  const snapshotsQuery = useQuery({
    queryKey: ["giwa", "arcousd-admin", "snapshots", trendDays],
    queryFn: () => giwaApi.admin.arcousdSnapshots(auth, trendDays),
    enabled: auth.ready && tab === "overview",
    refetchInterval: REFRESH_SLOW,
    placeholderData: keepPreviousData,
  })
  const queueQuery = useQuery({
    queryKey: ["giwa", "arcousd-admin", "queue", filter],
    queryFn: () => giwaApi.admin.arcousdQueue(auth, filter),
    enabled: auth.ready && tab === "queue",
    refetchInterval: REFRESH_FAST,
    // A filter change keeps the cards (and any processQueue in flight) on screen while it loads.
    placeholderData: keepPreviousData,
  })
  const flowsQuery = useQuery({
    queryKey: ["giwa", "arcousd-admin", "flows", flowDays],
    queryFn: () => giwaApi.admin.arcousdFlows(auth, flowDays),
    enabled: auth.ready && tab === "flows",
    refetchInterval: REFRESH_SLOW,
    placeholderData: keepPreviousData,
  })

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params)
    if (value === null) next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
  }

  async function sendProcessQueue(prepared: GiwaArcoUSDProcessQueue, onSigned: (hash: string) => void): Promise<string> {
    if (!wallet.address) throw new Error("Connect the operator wallet first")
    const hash = await sendPreparedTransaction(wallet.address, prepared.transaction)
    onSigned(hash)
    await afterConfirmedReceipt(hash, async () => {
      await Promise.all([queueQuery.refetch(), reserveQuery.refetch()])
    })
    return hash
  }

  return (
    <ArcoUSDAdminView
      tab={tab}
      onTabChange={(next) => setParam("tab", next === "overview" ? null : next)}
      hasAuth={auth.ready}
      reserve={reserveQuery.data ?? null}
      reserveLoading={reserveQuery.isLoading}
      reserveError={reserveQuery.isError ? readableError(reserveQuery.error) : null}
      overview={{
        snapshots: snapshotsQuery.data ?? null,
        loading: snapshotsQuery.isLoading,
        error: snapshotsQuery.isError ? readableError(snapshotsQuery.error) : null,
        days: trendDays,
        onDaysChange: setTrendDays,
      }}
      queue={{
        queue: queueQuery.data ?? null,
        loading: queueQuery.isLoading,
        error: queueQuery.isError ? readableError(queueQuery.error) : null,
        filter,
        onFilterChange: (next) => setParam("status", next === "open" ? null : next),
        walletAddress: wallet.address ?? null,
        onConnectWallet: () => void wallet.connect(),
        onPrepare: (asset, maxCount) => giwaApi.admin.arcousdProcessQueue(auth, asset, maxCount),
        onSend: sendProcessQueue,
      }}
      flows={{
        flows: flowsQuery.data ?? null,
        loading: flowsQuery.isLoading,
        error: flowsQuery.isError ? readableError(flowsQuery.error) : null,
        days: flowDays,
        onDaysChange: setFlowDays,
      }}
    />
  )
}

// ─────────────────────────────── pure views ───────────────────────────────

type OverviewProps = {
  snapshots: GiwaArcoUSDSnapshots | null
  loading?: boolean
  error?: string | null
  days: number
  onDaysChange: (days: number) => void
}

type QueueProps = {
  queue: GiwaArcoUSDQueue | null
  loading?: boolean
  error?: string | null
  filter: GiwaArcoUSDQueueFilter
  onFilterChange: (filter: GiwaArcoUSDQueueFilter) => void
  walletAddress: string | null
  onConnectWallet: () => void
  onPrepare: (asset: string, maxCount: number) => Promise<GiwaArcoUSDProcessQueue>
  onSend: (prepared: GiwaArcoUSDProcessQueue, onSigned: (hash: string) => void) => Promise<string>
  now?: number
}

type FlowsProps = {
  flows: GiwaArcoUSDFlows | null
  loading?: boolean
  error?: string | null
  days: number
  onDaysChange: (days: number) => void
}

/** The whole page over already-fetched data (rendered and tested without the query layer). */
export function ArcoUSDAdminView({
  tab,
  onTabChange,
  hasAuth,
  reserve,
  reserveLoading,
  reserveError,
  overview,
  queue,
  flows,
}: {
  tab: ArcoUSDAdminTab
  onTabChange: (tab: ArcoUSDAdminTab) => void
  hasAuth: boolean
  reserve: GiwaArcoUSDReserve | null
  reserveLoading?: boolean
  reserveError?: string | null
  overview: OverviewProps
  queue: QueueProps
  flows: FlowsProps
}) {
  return (
    <div className="w-full space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-[var(--color-arco-muted)]">Admin · ArcoUSD</p>
          <h1 className="mt-1 text-3xl font-semibold text-[var(--color-arco-ink)]">ArcoUSD reserve</h1>
        </div>
        {reserve && <ReserveStatusLine reserve={reserve} />}
      </section>

      <div role="tablist" aria-label="ArcoUSD sections" className="inline-flex rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] p-0.5 text-sm">
        {ARCOUSD_ADMIN_TABS.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`arcousd-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls="arcousd-tabpanel"
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => onTabChange(item.id)}
            onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
              const last = ARCOUSD_ADMIN_TABS.length - 1
              const next =
                event.key === "ArrowRight" ? (index + 1) % (last + 1) : event.key === "ArrowLeft" ? (index + last) % (last + 1) : event.key === "Home" ? 0 : event.key === "End" ? last : null
              if (next === null) return
              event.preventDefault()
              onTabChange(ARCOUSD_ADMIN_TABS[next].id)
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus()
            }}
            className={`rounded-[var(--radius-pill)] px-4 py-1.5 ${FOCUS_RING} ${
              tab === item.id
                ? "bg-[var(--color-arco-surface)] font-medium text-[var(--color-arco-ink)] shadow-[var(--shadow-control)]"
                : "text-[var(--color-arco-muted)]"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {reserveError && <ErrorLine>Could not load the reserve: {reserveError}</ErrorLine>}
      {!hasAuth && tab !== "overview" ? (
        <Card>
          <p className="text-sm text-[var(--color-arco-muted)]">Sign in as an operator to load this section.</p>
        </Card>
      ) : (
        <div id="arcousd-tabpanel" role="tabpanel" aria-labelledby={`arcousd-tab-${tab}`}>
          {tab === "overview" && <OverviewView reserve={reserve} reserveLoading={reserveLoading} hasAuth={hasAuth} {...overview} />}
          {tab === "queue" && <QueueView reserve={reserve} {...queue} />}
          {tab === "flows" && <FlowsView {...flows} />}
        </div>
      )}
    </div>
  )
}

function ReserveStatusLine({ reserve }: { reserve: GiwaArcoUSDReserve }) {
  const tone: Tone = reserve.status === "live" ? "positive" : reserve.status === "unavailable" ? "negative" : "neutral"
  const label = reserve.status === "live" ? "Live" : reserve.status === "unavailable" ? "Unavailable" : "Not deployed"
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-arco-muted)]">
      <Pill tone={tone}>{label}</Pill>
      {reserve.reserve && <span>Block {reserve.reserve.blockNumber}</span>}
      <span>Read {timeText(reserve.readAt)}</span>
    </div>
  )
}

// ── Overview ──────────────────────────────────────────────────────────────

function OverviewView({
  reserve,
  reserveLoading,
  hasAuth,
  snapshots,
  loading,
  error,
  days,
  onDaysChange,
}: OverviewProps & { reserve: GiwaArcoUSDReserve | null; reserveLoading?: boolean; hasAuth: boolean }) {
  if (reserveLoading && !reserve) return <LoadingNote>Loading the reserve…</LoadingNote>
  if (!reserve) return null
  if (reserve.status === "not-deployed") {
    return (
      <Card>
        <p className="text-sm text-[var(--color-arco-ink)]">ArcoUSD is not deployed yet.</p>
        <p className="mt-1 text-sm text-[var(--color-arco-muted)]">
          This page fills in once the deploy script has written deployments/91342/arcousd-giwa.json and the API has been redeployed.
        </p>
      </Card>
    )
  }
  const state = reserve.reserve
  const gate = gateText(reserve.gate)
  const headroom = state ? mintHeadroomUsd(state) : null
  return (
    <div className="space-y-6">
      {reserve.status === "unavailable" && (
        <Card>
          <p className="text-sm text-[var(--color-arco-down)]">The API could not read the reserve. Fund buys are blocked until it can.</p>
        </Card>
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <TotalCard label="Total backing" sub="buffers + MMF value + pending recalls" value={state ? usdText(state.totalBackingUsd) : null} />
        <TotalCard label="ArcoUSD supply" sub="total liabilities (escrow included)" value={state ? usdText(state.totalLiabilitiesUsd) : null} />
        <TotalCard
          label="Surplus"
          sub={state && !state.navOk ? "NAV unavailable: strategies valued at 0" : "fees kept in the reserve"}
          value={state ? usdText(Number(state.surplus) / 1e18) : null}
          negative={state ? BigInt(state.surplus) < 0n : false}
        />
        <TotalCard
          label="MMF allocation"
          sub={state ? `target ${bpsText(state.mmfTargetBps)} · buffer floor ${bpsText(state.bufferFloorBps)}` : "of total backing"}
          value={state ? bpsText(state.mmfBps) : null}
        />
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardTitle>Fund buy gate</CardTitle>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Pill tone={gate.status === "open" ? "positive" : gate.status === "closed" ? "negative" : "neutral"}>{gate.label}</Pill>
            {gate.detail && <span className="text-sm text-[var(--color-arco-text-soft)]">{gate.detail}</span>}
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            <Row label={`Settlement buffer (${reserve.gate.asset})`} value={reserve.gate.available !== null ? usdText(reserve.gate.available) : "—"} />
            <Row label="Gate threshold" value={usdText(reserve.gate.threshold)} />
            <Row label="Room under the mint cap" value={headroom !== null ? usdText(headroom) : "—"} />
            <Row label="Queue min delay" value={state ? durationText(state.queueMinDelay) : "—"} />
          </dl>
        </Card>
        <Card>
          <CardTitle>Pauses</CardTitle>
          {state ? (
            <ul className="mt-3 divide-y divide-[var(--color-arco-border)]">
              {pauseRows(state).map((row) => (
                <li key={row.label} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div>
                    <p className="text-sm text-[var(--color-arco-ink)]">{row.label}</p>
                    <p className="text-[11px] text-[var(--color-arco-muted)]">{row.effect}</p>
                  </div>
                  <Pill tone={row.paused ? "negative" : "neutral"}>{row.paused ? "Paused" : "Running"}</Pill>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-[var(--color-arco-muted)]">—</p>
          )}
        </Card>
      </section>

      <Card>
        <CardTitle>Reserve assets</CardTitle>
        <Table
          caption="Reserve assets"
          head={["Asset", "Balance", "Queued", "Available", "Backlog", "Swap fee", "Instant fee", "Deposit", "Redeem"]}
          rows={(state?.assets ?? []).map((asset) => [
            <span key="s" className="font-medium text-[var(--color-arco-ink)]">{asset.symbol}</span>,
            amountText(asset.balanceHuman),
            amountText(asset.queuedHuman),
            amountText(asset.availableHuman),
            String(asset.queueBacklog),
            bpsText(asset.swapFeeBps),
            bpsText(asset.instantFeeBps),
            asset.depositEnabled ? "On" : "Off",
            asset.redeemEnabled ? "On" : "Off",
          ])}
          numeric={[1, 2, 3, 4, 5, 6]}
          empty="No reserve assets"
        />
      </Card>

      <Card>
        <CardTitle>MMF strategies</CardTitle>
        <Table
          caption="MMF strategies"
          head={["Strategy", "Product", "Value", "NAV", "Pending recall", "Max allocation", "Status"]}
          rows={(state?.strategies ?? []).map((strategy) => [
            `#${strategy.strategyId}`,
            strategy.productId ?? shortAddress(strategy.productToken),
            usdText(strategy.valueUsd),
            strategy.navOk ? "OK" : "Unavailable",
            strategy.pendingRecall === "0" ? "—" : amountText(Number(strategy.pendingRecall) / 1e18),
            usdText(Number(strategy.maxAllocation) / 1e18),
            strategy.enabled ? "Enabled" : "Disabled",
          ])}
          numeric={[2, 4, 5]}
          empty="No strategies"
        />
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Backing and supply</CardTitle>
          <WindowPicker days={days} onChange={onDaysChange} label="Trend window" />
        </div>
        {!hasAuth ? (
          <p className="mt-3 text-sm text-[var(--color-arco-muted)]">Sign in as an operator to load the history.</p>
        ) : loading ? (
          <LoadingNote>Loading snapshots…</LoadingNote>
        ) : error ? (
          <ErrorLine>Could not load snapshots: {error}</ErrorLine>
        ) : (
          <BackingChart snapshots={snapshots} />
        )}
      </Card>

      {reserve.contracts && (
        <Card>
          <CardTitle>Contracts</CardTitle>
          <dl className="mt-3 space-y-2 text-sm">
            <AddressRow label="ArcoUSD" address={reserve.contracts.arcoUSD} />
            <AddressRow label="Reserve" address={reserve.contracts.reserve} />
            <AddressRow label="Lens" address={reserve.contracts.lens} />
            <AddressRow label="Router" address={reserve.contracts.router} />
            <Row label="Router buys" value={reserve.contracts.routerProducts.length ? reserve.contracts.routerProducts.join(", ") : "—"} />
          </dl>
        </Card>
      )}
    </div>
  )
}

function BackingChart({ snapshots }: { snapshots: GiwaArcoUSDSnapshots | null }) {
  const points = (snapshots?.points ?? []).map((point) => ({
    label: shortDateTime(point.takenAt, (snapshots?.days ?? 30) <= 7),
    backing: Number(point.totalBackingUsd),
    supply: Number(point.totalLiabilitiesUsd),
    surplus: Number(point.surplusUsd),
  }))
  return (
    <>
      <Legend items={[{ label: "Total backing", color: SERIES_A }, { label: "ArcoUSD supply", color: SERIES_B, dashed: true }]} />
      <div className="mt-2 h-[220px] w-full">
        {points.length === 0 ? (
          <EmptyChart>No snapshots in this window yet</EmptyChart>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--color-arco-border)" vertical={false} />
              <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis width={64} tick={AXIS_TICK} tickLine={false} axisLine={false} domain={["auto", "auto"]} tickFormatter={(value) => usdCompact(Number(value))} />
              <Tooltip formatter={(value) => usdText(Number(value))} labelStyle={TOOLTIP_LABEL} contentStyle={TOOLTIP_BOX} />
              <Line type="monotone" dataKey="backing" name="Total backing" stroke={SERIES_A} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              <Line type="monotone" dataKey="supply" name="ArcoUSD supply" stroke={SERIES_B} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      {points.length > 0 && (
        <>
          {/* Backing and supply move together; the gap between them (fees kept, or a shortfall
              when NAV is unavailable) is the health signal, so it gets its own scale. */}
          <h3 className="mt-5 text-xs font-medium text-[var(--color-arco-text-soft)]">Surplus (backing − supply)</h3>
          <div className="mt-2 h-[140px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="arcousd-surplus" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-arco-chart-area)" />
                    <stop offset="100%" stopColor="var(--color-arco-chart-area)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--color-arco-border)" vertical={false} />
                <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis width={64} tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(value) => usdCompact(Number(value))} />
                <Tooltip formatter={(value) => usdText(Number(value))} labelStyle={TOOLTIP_LABEL} contentStyle={TOOLTIP_BOX} />
                <Area type="linear" dataKey="surplus" name="Surplus" stroke="var(--color-arco-chart-line)" strokeWidth={2} fill="url(#arcousd-surplus)" dot={false} activeDot={{ r: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
      {snapshots?.sampled && (
        <p className="mt-2 text-[11px] text-[var(--color-arco-muted)]">
          {snapshots.total} snapshots, shown as {snapshots.points.length} points (the last of each interval).
          {snapshots.truncated ? " The oldest part of the window is not shown." : ""}
        </p>
      )}
    </>
  )
}

// ── Queue ─────────────────────────────────────────────────────────────────

function QueueView({
  reserve,
  queue,
  loading,
  error,
  filter,
  onFilterChange,
  walletAddress,
  onConnectWallet,
  onPrepare,
  onSend,
  now = Date.now(),
}: QueueProps & { reserve: GiwaArcoUSDReserve | null }) {
  if (loading && !queue) return <LoadingNote>Loading the queue…</LoadingNote>
  // A failed refresh keeps the last queue (and any processQueue in flight) on screen.
  if (error && !queue) return <ErrorLine>Could not load the queue: {error}</ErrorLine>
  if (!queue) return null
  if (queue.status === "not-deployed") {
    return (
      <Card>
        <p className="text-sm text-[var(--color-arco-muted)]">ArcoUSD is not deployed yet: there is no queue.</p>
      </Card>
    )
  }
  const reserveAssets = reserve?.reserve?.assets ?? []
  const state = reserve?.reserve
  const payoutPaused = Boolean(state && (state.reservePaused || state.arcoUSDPaused || state.arcoUSDBurnPaused))
  return (
    <div className="space-y-6">
      {error && <ErrorLine>Could not refresh the queue: {error}. Showing the last loaded data.</ErrorLine>}
      {queue.status === "unavailable" && <ErrorLine>The queue is unavailable: {queue.error ?? "unknown error"}</ErrorLine>}
      <p className="text-sm text-[var(--color-arco-text-soft)]">
        Standard redemptions are paid in request order once they are {durationText(queue.queueMinDelay)} old
        {queue.queueMinDelaySource === "registry" ? " (deploy-time value; the live delay could not be read)" : ""} and the Reserve
        holds the head&apos;s payout. The target is T+2 ({durationText(queue.targetSeconds)}).
      </p>

      <section className="grid gap-3 lg:grid-cols-3">
        {queue.assets.map((asset) => {
          const verdict = headVerdict(asset, reserveAssets, now, payoutPaused)
          return (
            <Card key={asset.asset}>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>{asset.symbol}</CardTitle>
                <HeadPill verdict={verdict} />
              </div>
              <dl className="mt-3 space-y-2 text-sm">
                <Row label="Queued" value={`${asset.queuedCount} · ${amountText(asset.queuedAmountHuman)} ${asset.symbol}`} />
                <Row label="Oldest" value={asset.oldestRequestedAt ? `${durationText((now - Date.parse(asset.oldestRequestedAt)) / 1000)} ago` : "—"} />
                <Row label="Past T+2" value={String(asset.overdueCount)} attention={asset.overdueCount > 0} />
                <Row label="Payout failed" value={String(asset.failedCount)} attention={asset.failedCount > 0} />
                <Row
                  label="Next to pay"
                  value={asset.head ? `#${asset.head.requestId} · ${amountText(asset.head.assetAmountHuman)} ${asset.symbol}` : "—"}
                />
              </dl>
              <ProcessQueueControl
                symbol={asset.symbol}
                disabled={asset.queuedCount === 0}
                walletAddress={walletAddress}
                onConnectWallet={onConnectWallet}
                onPrepare={(count) => onPrepare(asset.symbol, count)}
                onSend={onSend}
              />
            </Card>
          )
        })}
      </section>
      {queue.summaryTruncated && <p className="text-[11px] text-[var(--color-arco-muted)]">The summary covers the first 10,000 open requests per status.</p>}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Requests</CardTitle>
          <label className="flex items-center gap-2 text-sm text-[var(--color-arco-text-soft)]">
            Show
            <select
              value={filter}
              onChange={(event) => onFilterChange(event.target.value as GiwaArcoUSDQueueFilter)}
              className={`rounded-[var(--radius-card)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-2 py-1 text-sm text-[var(--color-arco-ink)] ${FOCUS_RING}`}
            >
              {QUEUE_FILTERS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <Table
          caption="Redemption requests"
          head={["Request", "Status", "Asset", "Payout", "Swap fee", "Owner", "Requested", "Waited", "Tx"]}
          rows={queue.requests.map((row) => [
            `#${row.requestId}`,
            <span key="status" className="inline-flex flex-wrap gap-1">
              <Pill tone={statusTone(row.status)}>{row.status}</Pill>
              {row.overdue && <Pill tone="attention">Past T+2</Pill>}
              {row.status === "QUEUED" && Date.parse(row.eligibleAt) > now && <Pill tone="neutral">In delay</Pill>}
            </span>,
            row.symbol,
            row.assetAmountHuman !== null ? amountText(row.assetAmountHuman) : row.assetAmount,
            row.feeUsd !== null && Number(row.feeUsd) > 0 ? usdText(row.feeUsd) : "—",
            <AddressLink key="owner" address={row.owner} />,
            timeText(row.requestedAt),
            durationText(row.waitSeconds),
            <TxLink key="tx" hash={row.closedTxHash ?? row.queuedTxHash} />,
          ])}
          numeric={[3, 4, 7]}
          empty={filter === "open" ? "Nothing waiting in the queue" : "No requests"}
        />
        {queue.truncated && <p className="mt-2 text-[11px] text-[var(--color-arco-muted)]">Showing the first 500 requests.</p>}
      </Card>
    </div>
  )
}

function HeadPill({ verdict }: { verdict: ReturnType<typeof headVerdict> }) {
  if (verdict.kind === "empty") return <Pill tone="neutral">Empty</Pill>
  if (verdict.kind === "paused") return <Pill tone="negative">Payouts paused</Pill>
  if (verdict.kind === "payable") return <Pill tone="positive">Payable now</Pill>
  if (verdict.kind === "waiting-delay") return <Pill tone="active">{`In delay until ${timeText(verdict.until)}`}</Pill>
  if (verdict.kind === "waiting-liquidity") return <Pill tone="attention">{`Short ${verdict.shortBy}`}</Pill>
  return <Pill tone="neutral">Unknown</Pill>
}

type ControlPhase = "idle" | "preparing" | "prepared" | "signing" | "confirming" | "done" | "failed"

/** Preview (server dry-run) → Sign & send (operator wallet) for one asset's processQueue. */
export function ProcessQueueControl({
  symbol,
  disabled = false,
  walletAddress,
  onConnectWallet,
  onPrepare,
  onSend,
}: {
  symbol: string
  disabled?: boolean
  walletAddress: string | null
  onConnectWallet: () => void
  onPrepare: (maxCount: number) => Promise<GiwaArcoUSDProcessQueue>
  onSend: (prepared: GiwaArcoUSDProcessQueue, onSigned: (hash: string) => void) => Promise<string>
}) {
  const [count, setCount] = useState("20")
  // Only the latest preview may land: an older reply (for another batch) is dropped.
  const previewSeq = useRef(0)
  const [phase, setPhase] = useState<ControlPhase>("idle")
  const [prepared, setPrepared] = useState<GiwaArcoUSDProcessQueue | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [hash, setHash] = useState<string | null>(null)
  const size = batchSize(count)
  const busy = phase === "preparing" || phase === "signing" || phase === "confirming"
  const inputId = `arcousd-batch-${symbol}`

  async function preview() {
    if (size === null) return
    const seq = ++previewSeq.current
    setPhase("preparing")
    setMessage(null)
    setHash(null)
    try {
      const reply = await onPrepare(size)
      if (seq !== previewSeq.current) return
      setPrepared(reply.maxCount === size ? reply : null)
      setPhase(reply.maxCount === size ? "prepared" : "idle")
    } catch (error) {
      if (seq !== previewSeq.current) return
      setPrepared(null)
      setPhase("failed")
      setMessage(readableError(error))
    }
  }

  async function send() {
    if (!prepared) return
    const sending = prepared
    setPhase("signing")
    setMessage(null)
    setHash(null)
    try {
      // The hash is kept from the moment the wallet sends, so a revert still links the transaction.
      await onSend(sending, (sent) => {
        setHash(sent)
        setPhase("confirming")
      })
      setPrepared(null)
      setPhase("done")
    } catch (error) {
      setPrepared(null)
      setPhase("failed")
      setMessage(readableError(error))
    }
  }

  const willPay = prepared && "paid" in prepared.preview ? prepared.preview.paid : null
  // Nothing to send when the dry run pays nothing or would revert.
  const sendable = prepared !== null && willPay !== null && willPay > 0
  return (
    <AdminWriteGroup className="mt-4 border-t border-[var(--color-arco-border)] pt-3">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={inputId} className="block text-[11px] text-[var(--color-arco-muted)]">
            Batch (1–50)
          </label>
          <input
            id={inputId}
            inputMode="numeric"
            value={count}
            onChange={(event) => {
              setCount(event.target.value)
              setPrepared(null)
              if (phase === "prepared" || phase === "failed" || phase === "done") setPhase("idle")
            }}
            aria-invalid={size === null}
            disabled={busy}
            className={`mt-1 w-20 rounded-[var(--radius-card)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-2 py-1 text-sm tabular-nums text-[var(--color-arco-ink)] ${FOCUS_RING}`}
          />
        </div>
        <SmallButton onClick={() => void preview()} disabled={disabled || busy || size === null}>
          {phase === "preparing" ? "Previewing…" : "Preview"}
        </SmallButton>
        {walletAddress ? (
          <SmallButton primary onClick={() => void send()} disabled={!sendable || busy}>
            {phase === "signing" ? "Confirm in wallet…" : phase === "confirming" ? "Confirming…" : "Sign & send"}
          </SmallButton>
        ) : (
          <SmallButton onClick={onConnectWallet}>Connect wallet</SmallButton>
        )}
      </div>
      <div aria-live="polite" className="mt-2 text-[11px]">
        {prepared && "paid" in prepared.preview && (
          <p className={willPay === 0 ? "text-[var(--color-arco-down)]" : "text-[var(--color-arco-text-soft)]"}>
            {willPay === 0
              ? `Would pay nothing now (block ${prepared.preview.blockNumber}): the head is still in its delay or the Reserve lacks ${symbol}.`
              : `Would pay ${willPay} request${willPay === 1 ? "" : "s"} now (block ${prepared.preview.blockNumber}).`}
          </p>
        )}
        {prepared && "error" in prepared.preview && <p className="text-[var(--color-arco-down)]">{prepared.preview.error}</p>}
        {phase === "failed" && message && (
          <p className="text-[var(--color-arco-down)]">
            {message}
            {hash && (
              <>
                {" "}
                <TxLink hash={hash} label="View transaction" />
              </>
            )}
          </p>
        )}
        {phase === "done" && hash && (
          <p className="text-[var(--color-arco-text-soft)]">
            Sent. <TxLink hash={hash} label="View transaction" />
          </p>
        )}
      </div>
    </AdminWriteGroup>
  )
}

// ── Flows ─────────────────────────────────────────────────────────────────

function FlowsView({ flows, loading, error, days, onDaysChange }: FlowsProps) {
  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-[var(--color-arco-text-soft)]">
        Reserve and Router events, in USD. A fund bought with a stablecoin appears as a deposit, a settlement and a Router buy:
        the rows overlap and are not meant to be added up.
      </p>
      <WindowPicker days={days} onChange={onDaysChange} label="Flow window" />
    </div>
  )
  if (loading && !flows) {
    return (
      <div className="space-y-4">
        {header}
        <LoadingNote>Loading flows…</LoadingNote>
      </div>
    )
  }
  if (error && !flows) {
    return (
      <div className="space-y-4">
        {header}
        <ErrorLine>Could not load flows: {error}</ErrorLine>
      </div>
    )
  }
  if (!flows) return header
  if (flows.status === "not-deployed") {
    return (
      <div className="space-y-4">
        {header}
        <Card>
          <p className="text-sm text-[var(--color-arco-muted)]">ArcoUSD is not deployed yet: no flows.</p>
        </Card>
      </div>
    )
  }
  const { totals } = flows
  const daily = flows.daily.map((day) => ({
    label: shortDate(day.day),
    deposits: Number(day.depositsUsd),
    redemptions: Number(day.instantRedemptionsUsd) + Number(day.queuedPaidUsd),
    fees: Number(day.feesUsd),
  }))
  return (
    <div className="space-y-6">
      {header}
      {error && <ErrorLine>Could not refresh flows: {error}. Showing the last loaded data.</ErrorLine>}
      {flows.status === "unavailable" && <ErrorLine>Flows are unavailable: {flows.error ?? "unknown error"}</ErrorLine>}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <TotalCard label="Deposits" sub={`${countText(totals.deposits, "deposit")} · gross, fees included`} value={usdText(totals.depositsUsd)} />
        <TotalCard
          label="Redemptions paid"
          sub={`${totals.instantRedemptions} instant · ${totals.queuedPaid} from the queue`}
          value={usdText(Number(totals.instantRedemptionsUsd) + Number(totals.queuedPaidUsd))}
        />
        <TotalCard label="Queued requests" sub={`${countText(totals.queuedRedemptions, "request")} · escrowed amount`} value={usdText(totals.queuedRedemptionsUsd)} />
        <TotalCard label="Fund settlements" sub={countText(totals.settlements, "settleFor call")} value={usdText(totals.settlementsUsd)} />
        <TotalCard label="Router buys" sub={countText(totals.routerBuys, "buy")} value={usdText(totals.routerBuysUsd)} />
        <TotalCard label="Fees kept" sub="deposit + instant + queue swap fees" value={usdText(totals.feesUsd)} />
      </section>

      <Card>
        <CardTitle>Deposits and redemptions per day</CardTitle>
        <Legend items={[{ label: "Deposits", color: SERIES_A, bar: true }, { label: "Redemptions paid", color: SERIES_B, bar: true }]} />
        <div className="mt-2 h-[220px] w-full">
          {daily.every((day) => day.deposits === 0 && day.redemptions === 0) ? (
            <EmptyChart>No deposits or redemptions in this window</EmptyChart>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={daily} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
                <CartesianGrid stroke="var(--color-arco-border)" vertical={false} />
                <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={16} />
                <YAxis width={64} tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(value) => usdCompact(Number(value))} />
                <Tooltip formatter={(value) => usdText(Number(value))} labelStyle={TOOLTIP_LABEL} contentStyle={TOOLTIP_BOX} cursor={{ fill: "var(--color-arco-chip)" }} />
                <Bar dataKey="deposits" name="Deposits" fill={SERIES_A} radius={[4, 4, 0, 0]} maxBarSize={18} />
                <Bar dataKey="redemptions" name="Redemptions paid" fill={SERIES_B} radius={[4, 4, 0, 0]} maxBarSize={18} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>

      <Card>
        <CardTitle>Fees kept per day</CardTitle>
        <div className="mt-3 h-[160px] w-full">
          {daily.every((day) => day.fees === 0) ? (
            <EmptyChart>No fees in this window</EmptyChart>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={daily} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="arcousd-fees" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-arco-chart-area)" />
                    <stop offset="100%" stopColor="var(--color-arco-chart-area)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--color-arco-border)" vertical={false} />
                <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={16} />
                <YAxis width={64} tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(value) => usdCompact(Number(value))} />
                <Tooltip formatter={(value) => usdText(Number(value))} labelStyle={TOOLTIP_LABEL} contentStyle={TOOLTIP_BOX} />
                <Area type="linear" dataKey="fees" name="Fees" stroke="var(--color-arco-chart-line)" strokeWidth={2} fill="url(#arcousd-fees)" dot={false} activeDot={{ r: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>

      <section className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardTitle>By asset</CardTitle>
          <Table
            caption="Flows by asset"
            head={["Asset", "Deposits", "Instant out", "Queue paid", "Settled", "Fees"]}
            rows={flows.byAsset.map((asset) => [
              asset.symbol,
              usdText(asset.depositsUsd),
              usdText(asset.instantRedemptionsUsd),
              usdText(asset.queuedPaidUsd),
              usdText(asset.settlementsUsd),
              usdText(asset.feesUsd),
            ])}
            numeric={[1, 2, 3, 4, 5]}
            empty="No flows in this window"
          />
        </Card>
        <Card>
          <CardTitle>Router buys by pay asset</CardTitle>
          <Table
            caption="Router buys by pay asset"
            head={["Paid with", "Buys", "Volume"]}
            rows={flows.routerBuysByPayAsset.map((row) => [row.symbol, String(row.count), usdText(row.volumeUsd)])}
            numeric={[1, 2]}
            empty="No Router buys in this window"
          />
        </Card>
      </section>

      <Card>
        <CardTitle>Recent events</CardTitle>
        <Table
          caption="Recent ArcoUSD events"
          head={["Event", "Contract", "Asset", "Amount", "Fee", "Account", "Time", "Tx"]}
          rows={flows.recent.map((event) => [
            eventLabel(event.eventName),
            event.contract === "router" ? "Router" : "Reserve",
            event.symbol ?? "—",
            event.amountUsd !== null ? usdText(event.amountUsd) : "—",
            event.feeUsd !== null && Number(event.feeUsd) > 0 ? usdText(event.feeUsd) : "—",
            event.account ? <AddressLink key="a" address={event.account} /> : "—",
            event.at ? timeText(event.at) : `#${event.blockNumber}`,
            <TxLink key="tx" hash={event.txHash} />,
          ])}
          numeric={[3, 4]}
          empty="No events in this window"
        />
        {(flows.truncated || flows.unknownAssetEvents > 0) && (
          <p className="mt-2 text-[11px] text-[var(--color-arco-muted)]">
            {flows.truncated ? "Only the newest 20,000 events are counted. " : ""}
            {flows.unknownAssetEvents > 0 ? `${flows.unknownAssetEvents} events on an unlisted asset were left unvalued.` : ""}
          </p>
        )}
      </Card>
    </div>
  )
}

// ─────────────────────────── presentational pieces ───────────────────────────

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
// Brand chart ramp: darkest and mid step (separable for colour-vision deficiency; the second
// series is also dashed where it is a line, and every chart has a legend).
const SERIES_A = "var(--color-arco-chart-1)"
const SERIES_B = "var(--color-arco-chart-5)"
const AXIS_TICK = { fontSize: 11, fill: "var(--color-arco-muted)" }
const TOOLTIP_LABEL = { color: "var(--color-arco-muted)" }
const TOOLTIP_BOX = {
  borderRadius: "var(--radius-card)",
  border: "1px solid var(--color-arco-border)",
  background: "var(--color-arco-surface)",
  fontSize: 12,
}

function Card({ children }: { children: ReactNode }) {
  return <div className="min-w-0 rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-5 shadow-[var(--shadow-control)]">{children}</div>
}

function CardTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-semibold text-[var(--color-arco-ink)]">{children}</h2>
}

function TotalCard({ label, sub, value, negative = false }: { label: string; sub: string; value: string | null; negative?: boolean }) {
  return (
    <div className="min-w-0 rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-4 shadow-[var(--shadow-control)]">
      <p className="text-xs text-[var(--color-arco-muted)]">{label}</p>
      <p className={`mt-1 tabular-nums text-2xl font-semibold ${negative ? "text-[var(--color-arco-down)]" : "text-[var(--color-arco-ink)]"}`}>
        {value ?? "—"}
      </p>
      <p className="mt-1 text-[11px] text-[var(--color-arco-muted)]">{sub}</p>
    </div>
  )
}

function Row({ label, value, attention = false }: { label: string; value: ReactNode; attention?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <dt className="text-[var(--color-arco-muted)]">{label}</dt>
      <dd className={`tabular-nums ${attention ? "font-medium text-[var(--color-arco-down)]" : "text-[var(--color-arco-ink)]"}`}>{value}</dd>
    </div>
  )
}

function AddressRow({ label, address }: { label: string; address: string | null }) {
  return <Row label={label} value={address ? <AddressLink address={address} /> : "Not deployed"} />
}

function AddressLink({ address }: { address: string }) {
  return (
    <a
      href={explorerAddress(address)}
      target="_blank"
      rel="noreferrer"
      title={address}
      className={`inline-flex items-center gap-1 font-mono text-[var(--color-arco-text-soft)] underline-offset-2 hover:underline ${FOCUS_RING}`}
    >
      {shortAddress(address)}
    </a>
  )
}

function TxLink({ hash, label }: { hash: string; label?: string }) {
  return (
    <a
      href={explorerTx(hash)}
      target="_blank"
      rel="noreferrer"
      title={hash}
      className={`inline-flex items-center gap-1 font-mono text-[var(--color-arco-text-soft)] underline-offset-2 hover:underline ${FOCUS_RING}`}
    >
      {label ?? shortAddress(hash)}
      <ExternalLink aria-hidden="true" className="size-3" />
    </a>
  )
}

function SmallButton({ children, onClick, disabled = false, primary = false }: { children: ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-8 items-center rounded-[var(--radius-card)] px-3 text-sm font-medium disabled:opacity-50 ${FOCUS_RING} ${
        primary
          ? "bg-[var(--color-arco-ink)] text-[var(--color-arco-on-dark)]"
          : "border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] text-[var(--color-arco-ink)] hover:bg-[var(--color-arco-chip)]"
      }`}
    >
      {children}
    </button>
  )
}

function WindowPicker({ days, onChange, label }: { days: number; onChange: (days: number) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] p-0.5 text-xs">
      {FLOW_WINDOWS.map((window) => (
        <button
          key={window}
          type="button"
          aria-pressed={days === window}
          onClick={() => onChange(window)}
          className={`rounded-[var(--radius-pill)] px-2.5 py-1 ${FOCUS_RING} ${
            days === window ? "bg-[var(--color-arco-surface)] font-medium text-[var(--color-arco-ink)] shadow-[var(--shadow-control)]" : "text-[var(--color-arco-muted)]"
          }`}
        >
          {window}d
        </button>
      ))}
    </div>
  )
}

function Legend({ items }: { items: { label: string; color: string; dashed?: boolean; bar?: boolean }[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-4 text-[11px] text-[var(--color-arco-text-soft)]">
      {items.map((item) => (
        <li key={item.label} className="inline-flex items-center gap-1.5">
          {item.bar ? (
            <svg aria-hidden="true" width="10" height="10">
              <rect width="10" height="10" rx="2" fill={item.color} />
            </svg>
          ) : (
            <svg aria-hidden="true" width="16" height="8">
              <line x1="0" y1="4" x2="16" y2="4" stroke={item.color} strokeWidth="2" strokeDasharray={item.dashed ? "5 4" : undefined} />
            </svg>
          )}
          {item.label}
        </li>
      ))}
    </ul>
  )
}

function Table({ caption, head, rows, numeric = [], empty }: { caption: string; head: string[]; rows: ReactNode[][]; numeric?: number[]; empty: string }) {
  if (rows.length === 0) return <p className="mt-3 text-sm text-[var(--color-arco-muted)]">{empty}</p>
  return (
    <div className="mt-3 w-full overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-[var(--color-arco-border)] text-[11px] text-[var(--color-arco-muted)]">
            {head.map((cell, index) => (
              <th key={cell} scope="col" className={`whitespace-nowrap px-2 py-2 font-medium ${numeric.includes(index) ? "text-right" : "text-left"}`}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-[var(--color-arco-border)] last:border-b-0">
              {row.map((cell, index) => (
                <td
                  key={index}
                  className={`whitespace-nowrap px-2 py-2 text-[var(--color-arco-ink)] ${numeric.includes(index) ? "text-right tabular-nums" : "text-left"}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EmptyChart({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center text-sm text-[var(--color-arco-muted)]">{children}</div>
}

function LoadingNote({ children }: { children: ReactNode }) {
  return (
    <p className="text-sm text-[var(--color-arco-muted)]">
      <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
      {children}
    </p>
  )
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-[var(--color-arco-down)]">
      {children}
    </p>
  )
}

function statusTone(status: string): Tone {
  if (status === "PAID") return "positive"
  if (status === "PAYOUT_FAILED") return "negative"
  if (status === "QUEUED") return "active"
  return "neutral"
}

function timeText(iso: string): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return "—"
  return new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
}

function shortDate(day: string): string {
  const at = Date.parse(`${day}T00:00:00Z`)
  return Number.isFinite(at) ? new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : day
}

function shortDateTime(iso: string, withTime: boolean): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return iso
  return new Date(at).toLocaleString("en-US", withTime ? { month: "short", day: "numeric", hour: "2-digit", hour12: false } : { month: "short", day: "numeric" })
}
