import { useState } from "react"
import { defaultRange, filterByRange, toChartPoints, type ChartRange, type RawPoint } from "./detail-charts"
import { GiwaPortfolioChart } from "./PortfolioChart"

const RANGES: ChartRange[] = ["7D", "30D", "90D", "1Y", "All"]
export const pctLabel = (n: number) => `${n.toFixed(2).replace(/\.?0+$/, "")}%`

const SEGMENT_ACTIVE =
  "bg-[var(--color-arco-surface)] font-medium text-[var(--color-arco-ink)] shadow-[var(--shadow-control)]"
const SEGMENT_IDLE = "text-[var(--color-arco-muted)]"

// One metric the card can plot: its raw series + how to label / format / measure it.
export type ChartMetric = {
  key: string
  label: string
  series: RawPoint[]
  headline: string
  valueFormat: (n: number) => string
  delta: (points: RawPoint[]) => number | null
  emptyLabel: string
  // Optional "projected at X%" chip (vault-detail built-in price curve).
  projected?: boolean
  projectedApy?: number | null
}

// Generic legacy-style toggle chart card: a two-metric segmented toggle (left) + a
// 7D/30D/90D/1Y/All range selector (right), a headline (current value + delta over the
// range) and one plot. Reused by the vault-detail (Price/APY) and the personal portfolio
// (Net Worth/Net Rate) surfaces — the caller supplies the two metrics.
export function GiwaTwoMetricChartCard({
  metrics,
  initialIndex = 0,
  now: nowProp,
}: {
  metrics: readonly [ChartMetric, ChartMetric]
  initialIndex?: 0 | 1
  now?: number
}) {
  const [now] = useState(() => nowProp ?? Math.floor(Date.now() / 1000))
  const [index, setIndex] = useState<0 | 1>(initialIndex)
  const [range, setRange] = useState<ChartRange>(() => defaultRange(metrics[0].series))

  const active = metrics[index]
  const visible = filterByRange(active.series, range, now)
  const chartPoints = toChartPoints(visible)

  const deltaValue = active.delta(visible)
  const deltaDir = deltaValue == null ? null : deltaValue > 0.005 ? "up" : deltaValue < -0.005 ? "down" : "flat"
  const arrow = deltaDir === "up" ? "▲ " : deltaDir === "down" ? "▼ " : ""
  const deltaText = deltaValue == null ? null : `${arrow}${pctLabel(Math.abs(deltaValue))} · ${range}`
  const deltaClass =
    deltaDir === "up"
      ? "text-[var(--color-arco-up)]"
      : deltaDir === "down"
        ? "text-[var(--color-arco-down)]"
        : "text-[var(--color-arco-muted)]"

  return (
    <div
      className="w-full rounded-[var(--radius-strategy)] bg-[var(--color-arco-surface)] p-5"
      style={{ boxShadow: "var(--shadow-control)" }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-grid grid-cols-2 rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] p-0.5 text-sm">
          {metrics.map((metric, i) => (
            <button
              key={metric.key}
              type="button"
              onClick={() => setIndex(i as 0 | 1)}
              className={`rounded-[var(--radius-pill)] px-4 py-1.5 ${index === i ? SEGMENT_ACTIVE : SEGMENT_IDLE}`}
            >
              {metric.label}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] p-0.5 text-xs">
          {RANGES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setRange(option)}
              className={`rounded-[var(--radius-pill)] px-2.5 py-1 ${range === option ? SEGMENT_ACTIVE : SEGMENT_IDLE}`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <span className="text-3xl font-semibold text-[var(--color-arco-ink)]">{active.headline}</span>
        {deltaText && <span className={`pb-1 text-sm font-medium ${deltaClass}`}>{deltaText}</span>}
        {active.projected && (
          <span className="mb-1 rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[11px] text-[var(--color-arco-text-soft)]">
            projected at {active.projectedApy != null ? pctLabel(active.projectedApy) : "APY"}
          </span>
        )}
      </div>

      <div className="mt-4">
        <GiwaPortfolioChart
          variant="plot"
          points={chartPoints}
          projected={active.projected ?? false}
          apy={active.projectedApy ?? null}
          valueFormat={active.valueFormat}
          emptyLabel={active.emptyLabel}
        />
      </div>
    </div>
  )
}
