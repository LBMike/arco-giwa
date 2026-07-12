import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Check, Copy, Loader2 } from "lucide-react"
import {
  giwaApi,
  type GiwaMonitoringDetail,
  type GiwaMonitoringFlowPoint,
  type GiwaMonitoringOverview,
  type GiwaMonitoringTrendPoint,
  type GiwaMonitoringVault,
} from "./api"
import { GIWA_CHAIN_ID } from "./config"
import { useGiwaAdmin } from "./GiwaAdminLayout"
import { explorerAddress } from "./wallet"

// v1 monitoring: aggregated on-the-fly from indexed events (no snapshots). Deposit/redeem
// events carry no block timestamp, so flow trends are ordered by event, not by calendar;
// only NAV/APY (PriceUpdated.updatedAt) have true time axes. Calendar-accurate flow trends
// and depositor-count-over-time arrive with block-timestamp indexing (v2).

export default function GiwaAdminMonitoringPage() {
  const { operatorToken } = useGiwaAdmin()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const overviewQuery = useQuery({
    queryKey: ["giwa", "monitoring-overview"],
    queryFn: () => giwaApi.monitoring.overview(operatorToken, GIWA_CHAIN_ID),
    enabled: Boolean(operatorToken),
    refetchInterval: 60_000,
  })
  const vaultsQuery = useQuery({
    queryKey: ["giwa", "monitoring-vaults"],
    queryFn: () => giwaApi.monitoring.vaults(operatorToken, GIWA_CHAIN_ID),
    enabled: Boolean(operatorToken),
    refetchInterval: 60_000,
  })
  const detailQuery = useQuery({
    queryKey: ["giwa", "monitoring-detail", selectedId],
    queryFn: () => giwaApi.monitoring.detail(operatorToken, GIWA_CHAIN_ID, selectedId as string),
    enabled: Boolean(operatorToken && selectedId),
    refetchInterval: 60_000,
  })

  return (
    <MonitoringView
      hasToken={Boolean(operatorToken)}
      overview={overviewQuery.data ?? null}
      overviewLoading={overviewQuery.isLoading}
      overviewError={overviewQuery.isError ? errorText(overviewQuery.error) : null}
      vaults={vaultsQuery.data?.vaults ?? []}
      vaultsLoading={vaultsQuery.isLoading}
      vaultsError={vaultsQuery.isError ? errorText(vaultsQuery.error) : null}
      detail={detailQuery.data ?? null}
      detailLoading={detailQuery.isLoading}
      detailError={detailQuery.isError ? errorText(detailQuery.error) : null}
      selectedId={selectedId}
      onSelect={setSelectedId}
    />
  )
}

// Pure view over already-fetched monitoring data (exported so it can be rendered and
// verified without the query/operator-token layer).
export function MonitoringView({
  hasToken,
  overview,
  overviewLoading,
  overviewError,
  vaults,
  vaultsLoading,
  vaultsError,
  detail,
  detailLoading,
  detailError,
  selectedId,
  onSelect,
}: {
  hasToken: boolean
  overview: GiwaMonitoringOverview | null
  overviewLoading?: boolean
  overviewError?: string | null
  vaults: GiwaMonitoringVault[]
  vaultsLoading?: boolean
  vaultsError?: string | null
  detail: GiwaMonitoringDetail | null
  detailLoading?: boolean
  detailError?: string | null
  selectedId: string | null
  onSelect: (productId: string) => void
}) {
  const selected = vaults.find((vault) => vault.productId === selectedId) ?? null

  return (
    <div className="w-full space-y-6">
      <section>
        <p className="text-sm text-[var(--color-arco-muted)]">Admin · Monitoring</p>
        <h1 className="mt-1 text-3xl font-semibold text-[var(--color-arco-ink)]">Monitoring dashboard</h1>
      </section>

      {!hasToken ? (
        <Card>
          <p className="text-sm text-[var(--color-arco-muted)]">
            Enter the operator token above to load monitoring data.
          </p>
        </Card>
      ) : (
        <>
          {/* ── 4a Totals ─────────────────────────────────────────────────── */}
          <section className="grid gap-3 md:grid-cols-3">
            <TotalCard
              label="TVL"
              sub="total value of all vault shares"
              value={overview ? usdLabel(overview.tvlUsd) : null}
              loading={overviewLoading}
            />
            <TotalCard
              label="Pending Withdrawals (outstanding)"
              sub={`currently pending (REQUESTED + SETTLING) value${overview ? ` · ${overview.pendingOutstandingCount} requests` : ""}`}
              value={overview ? usdLabel(overview.pendingOutstandingUsd) : null}
              loading={overviewLoading}
            />
            <TotalCard
              label="Pending Withdrawals (today)"
              sub={`pending requests created today${overview ? ` · ${overview.pendingTodayCount} requests` : ""}`}
              value={overview ? usdLabel(overview.pendingTodayUsd) : null}
              loading={overviewLoading}
            />
          </section>
          {overviewError && (
            <p className="text-sm text-[var(--color-arco-down)]">Could not load totals: {overviewError}</p>
          )}

          {/* ── 4b Vault list ─────────────────────────────────────────────── */}
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-[var(--color-arco-ink)]">Vaults</h2>
              <span className="text-[11px] text-[var(--color-arco-muted)]">Click a row for the vault detail below</span>
            </div>
            {vaultsLoading ? (
              <LoadingNote>Loading vault metrics…</LoadingNote>
            ) : vaultsError ? (
              <p className="mt-3 text-sm text-[var(--color-arco-down)]">Could not load vaults: {vaultsError}</p>
            ) : vaults.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--color-arco-muted)]">No vaults in the registry yet.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[860px] text-left text-xs">
                  <thead>
                    <tr className="text-[var(--color-arco-muted)]">
                      <th className="py-1.5 pr-3 font-normal">Product</th>
                      <th className="py-1.5 pr-3 font-normal">TVL</th>
                      <th className="py-1.5 pr-3 font-normal">Token price</th>
                      <th className="py-1.5 pr-3 font-normal">APY</th>
                      <th className="py-1.5 pr-3 font-normal">Net deposit</th>
                      <th className="py-1.5 pr-3 font-normal">Depositors</th>
                      <th className="py-1.5 font-normal">Pending withdrawals</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vaults.map((vault) => (
                      <VaultRow
                        key={vault.productId}
                        vault={vault}
                        selected={vault.productId === selectedId}
                        onSelect={() => onSelect(vault.productId)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* ── 4c Vault detail ───────────────────────────────────────────── */}
          {selected &&
            (detailLoading ? (
              <Card>
                <LoadingNote>Loading {selected.symbol} detail…</LoadingNote>
              </Card>
            ) : detailError ? (
              <Card>
                <p className="text-sm text-[var(--color-arco-down)]">Could not load the vault detail: {detailError}</p>
              </Card>
            ) : detail ? (
              // navBase comes from the already-fetched vaults row (no extra fetch) — prices the
              // LP breakdown's Value column; null → "—".
              <VaultDetail detail={detail} navBase={selected.navBase} />
            ) : null)}
        </>
      )}
    </div>
  )
}

/* ── 4b row + sparkline ───────────────────────────────────────────────────── */

function VaultRow({ vault, selected, onSelect }: { vault: GiwaMonitoringVault; selected: boolean; onSelect: () => void }) {
  const lastNet = vault.trends.netDeposit[vault.trends.netDeposit.length - 1]
  return (
    <tr
      onClick={onSelect}
      className={`cursor-pointer border-t border-[var(--color-arco-border)] ${selected ? "bg-[var(--color-arco-surface-muted)]" : ""}`}
    >
      <td className="py-2 pr-3">
        <span className="font-semibold text-[var(--color-arco-ink)]">{vault.symbol}</span>
        <span className="ml-2 rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[11px] text-[var(--color-arco-text-soft)]">
          {vault.paymentAssetSymbol}
        </span>
      </td>
      <td className="py-2 pr-3 tabular-nums text-[var(--color-arco-ink)]">{usdLabel(vault.tvlUsd)}</td>
      <td className="py-2 pr-3 tabular-nums text-[var(--color-arco-ink)]">{usdLabel(vault.navUsd)}</td>
      <td className="py-2 pr-3">
        <span className="tabular-nums text-[var(--color-arco-ink)]">{vault.apy != null ? `${trimNum(vault.apy, 2)}%` : "—"}</span>
        <Sparkline values={vault.trends.apy} />
      </td>
      <td className="py-2 pr-3">
        <span className="tabular-nums text-[var(--color-arco-ink)]">
          {lastNet != null ? `${trimNum(lastNet, 2)} ${vault.paymentAssetSymbol}` : "—"}
        </span>
        <Sparkline values={vault.trends.netDeposit} />
      </td>
      <td className="py-2 pr-3 tabular-nums text-[var(--color-arco-ink)]">{vault.depositorCount ?? "—"}</td>
      <td className="py-2 tabular-nums text-[var(--color-arco-ink)]">
        {vault.pendingCount}
        <span className="ml-1.5 text-[var(--color-arco-muted)]">{usdLabel(vault.pendingUsd)}</span>
      </td>
    </tr>
  )
}

// Dependency-free inline sparkline; a trend hint, not a scaled chart.
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const points = values
    .map((value, index) => `${(index / (values.length - 1)) * 96},${26 - ((value - min) / span) * 24 + 1}`)
    .join(" ")
  return (
    <svg viewBox="0 0 96 28" className="mt-0.5 block h-[28px] w-[96px]" aria-hidden="true">
      <polyline points={points} fill="none" stroke="var(--color-arco-chart-line)" strokeWidth="1.5" />
    </svg>
  )
}

/* ── 4c detail ────────────────────────────────────────────────────────────── */

function VaultDetail({ detail, navBase }: { detail: GiwaMonitoringDetail; navBase: number | null }) {
  return (
    <section className="w-full space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-[var(--color-arco-ink)]">{detail.symbol} detail</h2>
        <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[11px] text-[var(--color-arco-text-soft)]">
          {detail.paymentAssetSymbol}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <TrendChart
          id="nav"
          title="NAV"
          points={timePoints(detail.trends.nav)}
          format={(value) => trimNum(value, 6)}
        />
        <TrendChart
          id="apy"
          title="Implied APY"
          caption="implied by the NAV change between posts"
          points={timePoints(detail.trends.apy)}
          format={(value) => `${trimNum(value, 2)}%`}
        />
        <TrendChart
          id="net-deposit"
          title={`Net deposit (${detail.paymentAssetSymbol})`}
          caption="cumulative, by event — calendar bucketing pending block timestamps (v2)"
          points={flowPoints(detail.trends.netDeposit)}
          format={(value) => trimNum(value, 2)}
        />
        <TrendChart
          id="token-share"
          title="Total token share"
          caption="cumulative, by event — calendar bucketing pending block timestamps (v2)"
          points={flowPoints(detail.trends.totalTokenShare)}
          format={(value) => trimNum(value, 2)}
        />
        <TrendChart
          id="pending"
          title="Pending withdrawals (count)"
          caption="approximate — bucketed on index time, not block time"
          points={timePoints(detail.trends.pendingWithdrawals)}
          format={(value) => trimNum(value, 0)}
        />
        <Card>
          <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">Depositor count over time</h3>
          <p className="mt-2 text-sm text-[var(--color-arco-muted)]">
            Coming in v2 — exact active-holder history needs block-timestamped events or periodic snapshots.
            The current depositor list below is live on-chain data.
          </p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">Depositor wallets ({detail.depositors.length})</h3>
          {/* LP breakdown: Value = shares × navBase (payment-asset units); the raw share balance
              keeps its own column so nothing is lost when navBase is unavailable ("—"). */}
          <p className="mt-0.5 text-[11px] text-[var(--color-arco-muted)]">
            Deposit recipients only — holders via plain token transfers aren&apos;t captured (Transfer events aren&apos;t
            indexed); balances are current on-chain.
          </p>
          {detail.depositors.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--color-arco-muted)]">
              No depositors yet — appears once the indexer has run and deposits exist.
            </p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[400px] text-left text-xs">
                <thead>
                  <tr className="text-[var(--color-arco-muted)]">
                    <th className="py-1.5 pr-3 font-normal">LP address</th>
                    <th className="py-1.5 pr-3 font-normal">Value ({detail.paymentAssetSymbol})</th>
                    <th className="py-1.5 font-normal">Shares ({detail.symbol})</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.depositors.map((row) => (
                    <tr key={row.address} className="border-t border-[var(--color-arco-border)]">
                      <td className="py-2 pr-3">
                        <span className="inline-flex items-center gap-1.5">
                          <a
                            href={explorerAddress(row.address)}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-[var(--color-arco-ink)] underline"
                            title={row.address}
                          >
                            {shortAddr(row.address)}
                          </a>
                          <CopyAddressButton address={row.address} />
                        </span>
                      </td>
                      <td className="py-2 pr-3 tabular-nums text-[var(--color-arco-ink)]">
                        {navBase != null ? trimNum(row.balanceHuman * navBase, 2) : "—"}
                      </td>
                      <td className="py-2 tabular-nums text-[var(--color-arco-text-soft)]">{trimNum(row.balanceHuman, 4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card>
          <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">Withdrawal requesters ({detail.requesters.length})</h3>
          {detail.requesters.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--color-arco-muted)]">No pending withdrawal requests.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {detail.requesters.map((row) => (
                <li key={`${row.address}-${row.requestId}`} className="flex items-center justify-between gap-3 text-xs">
                  <span className="flex items-center gap-2">
                    <a
                      href={explorerAddress(row.address)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-[var(--color-arco-ink)] underline"
                      title={row.address}
                    >
                      {shortAddr(row.address)}
                    </a>
                    <span className="font-mono text-[var(--color-arco-muted)]">ARCO-{row.requestId}</span>
                    <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[10px] text-[var(--color-arco-text-soft)]">
                      {row.status}
                    </span>
                  </span>
                  <span className="tabular-nums text-[var(--color-arco-text-soft)]">{usdLabel(row.valueUsd)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </section>
  )
}

// Recharts trend chart modeled on GiwaPortfolioChart (same tokens/gradient), with a
// value formatter instead of that component's hardcoded USD labels.
function TrendChart({
  id,
  title,
  caption,
  points,
  format,
}: {
  id: string
  title: string
  caption?: string
  points: { label: string; value: number }[]
  format: (value: number) => string
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">{title}</h3>
        {caption && <span className="text-[11px] text-[var(--color-arco-muted)]">{caption}</span>}
      </div>
      <div className="mt-3 h-[200px] w-full">
        {points.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-arco-muted)]">
            No indexed data yet
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={`giwa-monitoring-${id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-arco-chart-area)" />
                  <stop offset="100%" stopColor="var(--color-arco-chart-area)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--color-arco-border)" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "var(--color-arco-muted)" }}
                tickLine={false}
                axisLine={false}
                minTickGap={16}
              />
              <YAxis
                width={64}
                tick={{ fontSize: 11, fill: "var(--color-arco-muted)" }}
                tickLine={false}
                axisLine={false}
                domain={["dataMin", "dataMax"]}
                tickFormatter={(value) => format(Number(value))}
              />
              <Tooltip
                formatter={(value) => format(Number(value))}
                labelStyle={{ color: "var(--color-arco-muted)" }}
                contentStyle={{
                  borderRadius: "var(--radius-card)",
                  border: "1px solid var(--color-arco-border)",
                  background: "var(--color-arco-surface)",
                  fontSize: 12,
                }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke="var(--color-arco-chart-line)"
                strokeWidth={1.5}
                fill={`url(#giwa-monitoring-${id})`}
                dot={false}
                activeDot={{ r: 3 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  )
}

/* ── presentational + formatting helpers (tokens only) ────────────────────── */

// Copy-to-clipboard for a full LP address (the cell shows it truncated) with a brief ✓ flash.
// navigator.clipboard precedent: AdminConfig deploy-params + the legacy SmartContractsCard.
function CopyAddressButton({ address }: { address: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      /* clipboard unavailable — no-op */
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={`Copy ${address}`}
      className="inline-flex text-[var(--color-arco-muted)]"
    >
      {copied ? <Check className="size-3 text-[var(--color-arco-up)]" /> : <Copy className="size-3" />}
    </button>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-5" style={{ boxShadow: "var(--shadow-control)" }}>
      {children}
    </div>
  )
}

function TotalCard({ label, sub, value, loading }: { label: string; sub: string; value: string | null; loading?: boolean }) {
  return (
    <div className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-4" style={{ boxShadow: "var(--shadow-control)" }}>
      <p className="text-xs text-[var(--color-arco-muted)]">{label}</p>
      <p className="mt-1 tabular-nums text-2xl font-semibold text-[var(--color-arco-ink)]">
        {loading ? <Loader2 className="size-5 animate-spin" /> : value ?? "—"}
      </p>
      <p className="mt-1 text-[11px] text-[var(--color-arco-muted)]">{sub}</p>
    </div>
  )
}

function LoadingNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 text-sm text-[var(--color-arco-muted)]">
      <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
      {children}
    </p>
  )
}

function timePoints(points: GiwaMonitoringTrendPoint[]): { label: string; value: number }[] {
  return points.map((point) => ({ label: dayLabel(point.t), value: point.value }))
}

function flowPoints(points: GiwaMonitoringFlowPoint[]): { label: string; value: number }[] {
  return points.map((point) => ({ label: `#${point.blockNumber}`, value: point.value }))
}

function dayLabel(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function usdLabel(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
}

function trimNum(value: number, maxDecimals: number): string {
  const fixed = value.toFixed(maxDecimals).replace(/\.?0+$/, "")
  return fixed === "" || fixed === "-0" ? "0" : fixed
}

function shortAddr(address: string): string {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—"
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
