import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { aumLabel } from "../data/products"

export type GiwaChartPoint = { t: string; value: number }

// Portfolio USD performance. Styling/charting mirror the legacy PortfolioChart (same
// gradient/axes/tooltip + tokens). When `projected` is true the series is an APY-implied
// curve (not realized history) and is labelled as such.
export function GiwaPortfolioChart({
  points,
  projected,
  apy,
  title = "Performance",
  valueFormat = aumLabel,
  emptyLabel = "No performance data yet",
  variant = "card",
}: {
  points: GiwaChartPoint[]
  projected: boolean
  apy?: number | null
  // Optional overrides so the same chart serves the price (navSharePrice) and APY (%)
  // series; defaults keep the portfolio USD chart byte-identical.
  title?: string
  valueFormat?: (n: number) => string
  emptyLabel?: string
  // "plot" renders just the chart body (no card chrome/header) so the Performance card
  // can own the outer card + toggle/range header. "card" is the standalone byte-identical form.
  variant?: "card" | "plot"
}) {
  const body =
    points.length === 0 ? (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-arco-muted)]">
        {emptyLabel}
      </div>
    ) : (
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="giwa-portfolio-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-arco-chart-area)" />
              <stop offset="100%" stopColor="var(--color-arco-chart-area)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--color-arco-border)" vertical={false} />
          <XAxis
            dataKey="t"
            tick={{ fontSize: 11, fill: "var(--color-arco-muted)" }}
            tickLine={false}
            axisLine={false}
            minTickGap={16}
          />
          <YAxis
            width={56}
            tick={{ fontSize: 11, fill: "var(--color-arco-muted)" }}
            tickLine={false}
            axisLine={false}
            domain={["dataMin", "dataMax"]}
            tickFormatter={(v) => valueFormat(Number(v))}
          />
          <Tooltip
            formatter={(v) => valueFormat(Number(v))}
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
            fill="url(#giwa-portfolio-area)"
            dot={false}
            activeDot={{ r: 3 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    )

  // touch-pan-y: let vertical finger drags scroll the page (recharts preventDefaults touchmove
  // for its tooltip, which would otherwise trap page scroll); tooltips still fire on tap.
  if (variant === "plot") return <div className="h-[240px] w-full touch-pan-y">{body}</div>

  return (
    <div className="rounded-[var(--radius-strategy)] bg-[var(--color-arco-surface)] p-5" style={{ boxShadow: "var(--shadow-control)" }}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-[var(--color-arco-ink)]">{title}</span>
        {projected && (
          <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[11px] text-[var(--color-arco-text-soft)]">
            projected at {apy != null ? `${trimPct(apy)}%` : "APY"}
          </span>
        )}
      </div>
      <div className="mt-3 h-[240px] w-full touch-pan-y">{body}</div>
    </div>
  )
}

function trimPct(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, "")
}
