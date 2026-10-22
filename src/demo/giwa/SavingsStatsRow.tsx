// The figures under the Savings card: APY (with a sparkline and a details view of its history) and TVL.

import { useId, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react"
import { ArrowDownRight, ArrowUpRight, ChartLine, Lock, Maximize2, X } from "lucide-react"
import type { GiwaPriceHistory } from "./api"
import { buildApySeries, defaultRange, filterByRange, toChartPoints, type ChartRange, type RawPoint } from "./detail-charts"
import { GiwaPortfolioChart } from "./PortfolioChart"
import { SavingsDialog } from "./SavingsDialog"
import { SavingsInfoTip } from "./SavingsInfoTip"
import { pctLabel } from "./TwoMetricChartCard"

const RANGES: ChartRange[] = ["7D", "30D", "90D", "1Y", "All"]
const SPARK_W = 400
const SPARK_H = 40
const SECONDS_PER_DAY = 86_400

/** The sparkline's box coordinates for a series (two points or more). */
function sparklineScale(points: readonly RawPoint[]) {
  const first = points[0]!.ts
  const span = points[points.length - 1]!.ts - first
  const values = points.map((point) => point.value)
  const low = Math.min(...values)
  const high = Math.max(...values)
  const pad = 4
  const x = (ts: number) => (span > 0 ? ((ts - first) / span) * SPARK_W : SPARK_W)
  const y = (value: number) => (high > low ? pad + (1 - (value - low) / (high - low)) * (SPARK_H - pad * 2) : SPARK_H / 2)
  return { first, span, x, y }
}

/** The step line of the sparkline, in a SPARK_W × SPARK_H box; null with fewer than two points. */
export function sparklinePath(points: readonly RawPoint[]): { d: string; end: { x: number; y: number } } | null {
  if (points.length < 2) return null
  const { x, y } = sparklineScale(points)
  let d = `M0 ${y(points[0]!.value).toFixed(2)}`
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i]!
    d += ` H${x(point.ts).toFixed(2)} V${y(point.value).toFixed(2)}`
  }
  const end = { x: SPARK_W, y: y(points[points.length - 1]!.value) }
  d += ` H${SPARK_W}`
  return { d, end }
}

/**
 * Where a pointer `ratio` of the way across the box (0 to 1) sits on the step line: the point whose step covers that
 * moment, and the dot's place (at the pointer, on that step). Null with fewer than two points.
 */
export function sparklinePointAt(points: readonly RawPoint[], ratio: number): { index: number; x: number; y: number } | null {
  if (points.length < 2) return null
  const { first, span, y } = sparklineScale(points)
  const at = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 1))
  const ts = first + at * span
  let index = 0
  for (let i = 1; i < points.length && points[i]!.ts <= ts; i += 1) index = i
  return { index, x: at * SPARK_W, y: y(points[index]!.value) }
}

/** The month's APY as a step line. Pointing at it moves the dot along the line and reports the point under it. */
function Sparkline({ points, onHover }: { points: readonly RawPoint[]; onHover: (index: number | null) => void }) {
  const gradientId = useId()
  const [dot, setDot] = useState<{ x: number; y: number } | null>(null)
  const path = sparklinePath(points)
  if (path === null) return null
  const point = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const at = sparklinePointAt(points, box.width > 0 ? (event.clientX - box.left) / box.width : 1)
    if (at === null) return
    setDot({ x: at.x, y: at.y })
    onHover(at.index)
  }
  const leave = () => {
    setDot(null)
    onHover(null)
  }
  const shown = dot ?? path.end
  return (
    // Decorative for screen readers (APY Details has the full chart); scrubbed with a mouse, pen or finger.
    <div
      aria-hidden="true"
      onPointerMove={point}
      onPointerDown={point}
      onPointerLeave={leave}
      onPointerCancel={leave}
      className="relative h-10 min-w-0 flex-1 cursor-crosshair touch-pan-y"
    >
      <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--color-arco-chart-5)" stopOpacity={0} />
            <stop offset="35%" stopColor="var(--color-arco-chart-5)" stopOpacity={1} />
          </linearGradient>
        </defs>
        <path d={path.d} fill="none" stroke={`url(#${gradientId})`} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <span
        className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-pill)] bg-[var(--color-arco-chart-5)] ring-2 ring-[var(--color-arco-surface)]"
        style={{ left: `${(shown.x / SPARK_W) * 100}%`, top: `${(shown.y / SPARK_H) * 100}%` }}
      />
    </div>
  )
}

function ApyDetails({ open, onClose, apyText, series, now }: { open: boolean; onClose: () => void; apyText: string; series: readonly RawPoint[]; now: number }) {
  const titleId = useId()
  // Until a range is picked, the default follows the history (it may arrive after the page opens).
  const [picked, setRange] = useState<ChartRange | null>(null)
  const range = picked ?? defaultRange([...series])
  const points = toChartPoints(filterByRange([...series], range, now))
  return (
    <SavingsDialog open={open} onClose={onClose} labelledBy={titleId}>
      <div className="flex items-center justify-between border-b border-[var(--color-arco-border)] px-5 py-4 sm:px-6">
        <h2 id={titleId} className="text-base font-medium text-[var(--color-arco-ink)]">
          APY
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mr-2 inline-flex size-11 items-center justify-center rounded-[var(--radius-pill)] text-[var(--color-arco-text-soft)] hover:bg-[var(--color-arco-chip)] hover:text-[var(--color-arco-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)]"
        >
          <X aria-hidden="true" className="size-5" />
        </button>
      </div>
      <div className="border-b border-[var(--color-arco-border)] px-5 py-5 sm:px-6">
        <p className="flex items-center gap-1 text-[13px] text-[var(--color-arco-text-soft)]">
          APY
          <SavingsInfoTip label="About APY" text="The yearly rate implied by the price posted for this savings account, compounding included." />
        </p>
        <p className="mt-1 text-[32px] font-medium leading-10 tabular-nums text-[var(--color-arco-ink)]">{apyText}</p>
      </div>
      <div className="px-5 pb-6 pt-5 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-[var(--color-arco-text-soft)]">APY history</p>
          <div role="group" aria-label="Range" className="inline-flex rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] p-0.5 text-xs">
            {RANGES.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={range === option}
                onClick={() => setRange(option)}
                className={`min-h-8 rounded-[var(--radius-pill)] px-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)] ${
                  range === option
                    ? "bg-[var(--color-arco-surface)] font-medium text-[var(--color-arco-ink)] shadow-[var(--shadow-control)]"
                    : "text-[var(--color-arco-text-soft)]"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-4 rounded-[16px] bg-[var(--color-arco-page)] p-3">
          <GiwaPortfolioChart variant="plot" points={points} projected={false} valueFormat={pctLabel} emptyLabel="No APY data yet" />
        </div>
      </div>
    </SavingsDialog>
  )
}

/** A change in percentage points: up to two decimals, no trailing zeros ("0.8pp", "0pp"). */
export function ppLabel(points: number): string {
  return `${Number(points.toFixed(2))}pp`
}

/** "Oct 9, 2026" for a unix time in seconds. */
function dayLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function SavingsStatsRow({ apyText, history, tvlText }: { apyText: string; history: GiwaPriceHistory | undefined; tvlText: string }) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [now] = useState(() => Math.floor(Date.now() / 1000))
  const series = useMemo(() => buildApySeries(history), [history])
  // The sparkline shows the last month, or everything when the history is shorter than that.
  const recent = useMemo(() => {
    const month = series.filter((point) => point.ts >= now - 30 * SECONDS_PER_DAY)
    return month.length >= 2 ? month : series
  }, [series, now])
  // Pointing at the sparkline: the APY at that point, its date, and its change since the line's first point.
  const [hovered, setHovered] = useState<number | null>(null)
  const pointed = hovered !== null ? (recent[hovered] ?? null) : null
  const change = recent.length >= 2 ? (pointed ?? recent[recent.length - 1]!).value - recent[0]!.value : null

  return (
    <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] rounded-[22px] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)]">
      <div className="group/apy relative flex min-w-0 flex-col">
        <div className="flex min-w-0 items-center gap-6 px-5 pb-1.5 pt-4 sm:px-6">
          <div className="shrink-0">
            <p className="flex items-center gap-1.5 text-[13px] text-[var(--color-arco-text-soft)]">
              <ChartLine aria-hidden="true" className="size-3.5" />
              APY
              <SavingsInfoTip label="About APY" text="The yearly rate implied by the price posted for this savings account, compounding included." />
            </p>
            <p className="mt-1 flex items-baseline gap-1.5">
              <span className="text-2xl font-medium tabular-nums text-[var(--color-arco-ink)]">{pointed ? pctLabel(pointed.value) : apyText}</span>
              {change !== null && (
                <span className="inline-flex items-center gap-0.5 text-xs tabular-nums text-[var(--color-arco-text-soft)]">
                  {change < 0 ? <ArrowDownRight aria-hidden="true" className="size-3" /> : <ArrowUpRight aria-hidden="true" className="size-3" />}
                  {ppLabel(Math.abs(change))}
                </span>
              )}
            </p>
          </div>
          <Sparkline points={recent} onHover={setHovered} />
        </div>
        {pointed && (
          <span className="pointer-events-none absolute right-5 top-4 text-[11px] tabular-nums text-[var(--color-arco-text-soft)] sm:right-6">
            {dayLabel(pointed.ts)}
          </span>
        )}
        <button
          type="button"
          onClick={() => setDetailsOpen(true)}
          // Revealed on hover where there is a mouse; always shown on touch screens, which have no hover.
          className="flex min-h-7 items-center justify-end gap-1.5 rounded-bl-[21px] bg-[var(--color-arco-page)] px-5 text-[11px] text-[var(--color-arco-text-soft)] transition-opacity duration-150 hover:text-[var(--color-arco-ink)] focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-arco-ink)] group-hover/apy:opacity-100 motion-reduce:transition-none sm:px-6 [@media(hover:hover)_and_(min-width:640px)]:opacity-0"
        >
          APY Details
          <Maximize2 aria-hidden="true" className="size-3" />
        </button>
      </div>
      <div className="flex min-w-[112px] flex-col justify-start border-l border-[var(--color-arco-border)] px-5 pt-4 sm:min-w-[140px] sm:px-6">
        <p className="flex items-center gap-1.5 text-[13px] text-[var(--color-arco-text-soft)]">
          <Lock aria-hidden="true" className="size-3.5" />
          TVL
          <SavingsInfoTip
            label="About TVL"
            align="end"
            text="Total value locked: every share of this savings account in circulation, valued at its latest price."
          />
        </p>
        <p className="mt-1 text-2xl font-medium tabular-nums text-[var(--color-arco-ink)]">{tvlText}</p>
      </div>
      <ApyDetails open={detailsOpen} onClose={() => setDetailsOpen(false)} apyText={apyText} series={series} now={now} />
    </div>
  )
}
