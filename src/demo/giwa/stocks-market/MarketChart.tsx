import { DemoDetails, useDemoPresentation } from "../demo-presentation"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import type { Bar, Chart, Envelope, FeedDelay, Quote } from "./contracts"
import { axisPrice, axisTicks, axisTime, chartLineRuns, chartPoints, chartTooltip, time, windowChange } from "./display"
import { scaled } from "./validate"
/** The observation a user picked on the chart; the price card shows it in place of the quote while it lasts. */
export type ChartSelection = { bar: Bar; interval: Chart["interval"]; feedDelay: FeedDelay }
const TICK = { fill: "var(--color-arco-text-soft)", fontSize: 11 }
/** The chart and its own envelope status. The quote's status (e.g. STALE) is the price card's, shown whatever state this chart is in. */
export function MarketChart({ response, latestQuote = null, onSelection }: { response: Envelope<Chart>; latestQuote?: Quote | null; onSelection?: (selection: ChartSelection | null) => void }) {
  const chart = response.data
  // The containing read is keyed by API/symbol/range, so selection never crosses scopes.
  const [selected, setOwnSelected] = useState<number | null>(null)
  const demo = useDemoPresentation()
  const sliderId = useId()
  const gradientId = `market-area-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const selectionScope = useRef<HTMLElement>(null)
  const points = useMemo(() => chart ? chartPoints(chart, latestQuote) : [], [chart, latestQuote])
  // Whole-cent ticks, so each two-decimal label is exactly its gridline; the domain is the ticks' span (it holds every close).
  const yTicks = useMemo(() => axisTicks(points.map(point => point.coordinate)), [points])
  // The card header (outside this range-keyed subtree) shows the picked bar. It is told in the same event, so header and chart
  // change in one render; unmounting (a new range or symbol) clears it.
  const report = useRef(onSelection); report.current = onSelection
  const setSelected = (index: number | null) => {
    setOwnSelected(index)
    const point = index === null ? null : points[index] ?? null
    const bar = point?.liveQuote ? null : point?.bar ?? null
    report.current?.(bar && chart ? { bar, interval: chart.interval, feedDelay: response.feedDelay } : null)
  }
  useEffect(() => () => report.current?.(null), [])
  // Touch range controls need not take focus, so blur alone cannot end selection.
  useEffect(() => {
    if (selected === null) return
    const scope = selectionScope.current
    const endOutside = (event: Event) => { if (event.target instanceof Node && !scope?.contains(event.target)) setSelected(null) }
    document.addEventListener("pointerdown", endOutside, true)
    document.addEventListener("focusin", endOutside, true)
    return () => { document.removeEventListener("pointerdown", endOutside, true); document.removeEventListener("focusin", endOutside, true) }
  }, [selected])
  const rolling = chart?.range === "1D"
  const runs = chartLineRuns(points, rolling)
  const drawing = points.map(point => ({ ...point, ...Object.fromEntries(runs.flatMap((run, index) => run.points.includes(point) ? [[`segment${index}`, point.coordinate]] : [])) }))
  const picked = selected === null ? null : points[selected] ?? null
  const change = chart ? windowChange(chart, latestQuote) : "—"
  // Line and area follow the returned window's direction (graphic colours; the change text keeps the AA text token).
  const first = points.length >= 2 ? scaled(points[0].price) : null
  const last = points.length >= 2 ? scaled(points[points.length - 1].price) : null
  const tone = first === null || last === null || first === last ? "text-[var(--color-arco-chart-line)]" : last > first ? "text-[var(--color-arco-stock-chart-up)]" : "text-[var(--color-arco-down)]"
  // Scoped to the chart: the price card above states the quote's own status in the same words.
  const status = response.status === "UNCONFIGURED" ? "Market data connection pending" : response.status === "UNAVAILABLE" ? "Market data unavailable" : response.status === "STALE" ? demo ? "Last observed prices" : "Last observed prices · stale data" : null
  const message = status && `Chart · ${status}`
  const onMove = (event: { activeTooltipIndex?: string | number | null }) => { const index = Number(event.activeTooltipIndex); if (event.activeTooltipIndex !== null && event.activeTooltipIndex !== undefined && Number.isInteger(index) && points[index]) setSelected(index) }
  const fallback = chart?.range === "1D" && chart.fallback === "PREVIOUS_SESSION" && chart.fallbackBars.length >= 2
  const shownBars = fallback && chart ? chart.fallbackBars : chart?.bars ?? []
  return <section ref={selectionScope} aria-label="Underlying security chart" className="w-full min-w-0 space-y-4">
    {message && !(demo && response.status === "STALE") && <p role="status" className="text-sm text-[var(--color-arco-text-soft)]">{message}</p>}
    {!chart || !points.length ? <div className="flex min-h-48 items-center justify-center rounded-2xl bg-[var(--color-arco-page)] p-6 text-sm text-[var(--color-arco-text-soft)]">{message ?? "No chart observations returned"}</div> : <>
      <div data-chart-tone="" className={`relative h-[240px] w-full min-w-0 touch-pan-y sm:h-[300px] ${tone}`} tabIndex={demo ? 0 : undefined} onKeyDown={demo ? event => {
        const index = selected ?? points.length - 1
        const next = event.key === "ArrowLeft" ? Math.max(0, index - 1) : event.key === "ArrowRight" ? Math.min(points.length - 1, index + 1) : event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : undefined
        if (next !== undefined) { event.preventDefault(); setSelected(next) }
        if (event.key === "Escape") setSelected(null)
      } : undefined} onBlur={demo ? () => setSelected(null) : undefined} aria-label={rolling ? fallback ? "Previous session price chart · use arrow keys to explore prices" : "24-hour price chart · use arrow keys to explore prices" : demo ? "Closing price chart · use arrow keys to explore prices" : "Returned closing price chart. Select an observation below or review the raw data table."}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <AreaChart data={drawing} onMouseMove={onMove} onMouseLeave={() => setSelected(null)} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
            <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="currentColor" stopOpacity={0.18} /><stop offset="100%" stopColor="currentColor" stopOpacity={0} /></linearGradient></defs>
            <CartesianGrid vertical={false} stroke="var(--color-arco-stock-chart-grid)" strokeDasharray="2 2" />
            <XAxis dataKey="timestamp" type="number" domain={["dataMin", "dataMax"]} tickFormatter={value => axisTime(value, chart.range)} minTickGap={56} height={28} tick={TICK} axisLine={false} tickLine={false} />
            <YAxis orientation="right" ticks={yTicks} domain={[yTicks[0], yTicks[yTicks.length - 1]]} interval={0} width={64} tickFormatter={axisPrice} tick={TICK} axisLine={false} tickLine={false} />
            <Tooltip content={() => null} cursor={false} />
            {runs.map((run, index) => <Area key={index} type={rolling ? "stepAfter" : "linear"} dataKey={`segment${index}`} connectNulls={false} stroke="currentColor" strokeOpacity={run.muted ? 0.38 : 1} fill={`url(#${gradientId})`} fillOpacity={run.muted ? 0.08 : 1} strokeWidth={1.75} isAnimationActive={false} dot={!rolling && run.points.length === 1 ? { r: 3, fill: "currentColor", stroke: "currentColor" } : false} activeDot={false} />)}
            {picked && <ReferenceDot x={picked.timestamp} y={picked.coordinate} r={4} fill="currentColor" stroke="var(--color-arco-surface)" />}
            {picked && <ReferenceLine x={picked.timestamp} stroke="var(--color-arco-text-soft)" strokeDasharray="3 3" />}
          </AreaChart>
        </ResponsiveContainer>
        {picked && <div role="status" className="pointer-events-none absolute right-2 top-2 max-w-[min(92%,260px)] rounded-lg border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-2 py-1 text-right text-xs text-[var(--color-arco-ink)] shadow-sm">{chartTooltip(picked)}</div>}
      </div>
      <DemoDetails><div className="space-y-2">
        <label htmlFor={sliderId} className="block text-xs text-[var(--color-arco-text-soft)]">{rolling ? "Select a 24-hour observation · use arrow keys" : "Select an observation · use arrow keys · closing price and bar start time"}</label>
        <input id={sliderId} type="range" min={0} max={points.length - 1} step={1} value={selected ?? points.length - 1} onChange={event => setSelected(Number(event.target.value))} onBlur={() => setSelected(null)} aria-valuetext={chartTooltip(picked ?? points[points.length - 1])} className="w-full accent-[var(--color-arco-ink)]" />
        {points.length === 1 && <p className="text-xs">One observation · period change cannot be calculated.</p>}
      </div></DemoDetails>
    </>}
    <DemoDetails><p className="text-sm">{rolling ? fallback ? "Previous trading session change" : chart?.seed ? "Change over recent 24 hours" : "Change over returned observations" : "Change over returned observations"} <strong className={change === "—" ? "text-[var(--color-arco-text-soft)]" : change.startsWith("−") ? "text-[var(--color-arco-down)]" : "text-[var(--color-arco-up-text)]"}>{change}</strong><span className="text-xs text-[var(--color-arco-text-soft)]"> · Based on split-adjusted closing prices</span></p>
    {chart && points.length ? <>
      <p className="text-xs text-[var(--color-arco-text-soft)]">{time(new Date(points[0].timestamp).toISOString())} — {time(new Date(points[points.length - 1].timestamp).toISOString())} · {chart.range === "1D" ? fallback ? "Previous trading session" : "Recent 24 hours" : chart.range} · {chart.interval} · New York time</p>
      <p className="text-xs text-[var(--color-arco-text-soft)]">{chart.history === "TRUNCATED" ? "Partial history returned · this is not the return for the full selected period." : rolling ? "Empty 5-minute slots carry the last observed price; source observations remain separate." : "Only returned observations are shown. History for every trading day or interval is not guaranteed."} {!rolling && runs.length > 1 ? "Long gaps between observations are left disconnected." : ""}</p>
      <details className="min-w-0"><summary className="cursor-pointer text-sm">Exact OHLCV source data ({shownBars.length} observations)</summary><div className="mt-2 max-h-64 overflow-auto rounded-lg border border-[var(--color-arco-border)]" tabIndex={0} role="region" aria-label="Scrollable OHLCV source data"><table className="w-full whitespace-nowrap text-left text-xs"><thead><tr>{["Bar start (New York)", "Open (USD)", "High (USD)", "Low (USD)", "Close (USD)", "Underlying asset volume"].map(label => <th key={label} className="p-2 font-medium">{label}</th>)}</tr></thead><tbody>{shownBars.map(item => <tr key={item.timestamp}><td className="p-2">{time(item.timestamp)}</td>{[item.open, item.high, item.low, item.close, item.volume].map((value, index) => <td key={index} className="p-2 font-mono">{value}</td>)}</tr>)}</tbody></table></div></details>
    </> : null}</DemoDetails>
  </section>
}
