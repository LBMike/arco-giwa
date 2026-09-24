import { DemoDetails, useDemoPresentation } from "../demo-presentation"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import type { Bar, Chart, Envelope, FeedDelay } from "./contracts"
import { axisPrice, axisTicks, axisTime, chartPoints, dollars, time, windowChange } from "./display"
import { scaled } from "./validate"
/** The observation a user picked on the chart; the price card shows it in place of the quote while it lasts. */
export type ChartSelection = { bar: Bar; interval: Chart["interval"]; feedDelay: FeedDelay }
const TICK = { fill: "var(--color-arco-text-soft)", fontSize: 11 }
/** The chart and its own envelope status. The quote's status (e.g. STALE) is the price card's, shown whatever state this chart is in. */
export function MarketChart({ response, onSelection }: { response: Envelope<Chart>; onSelection?: (selection: ChartSelection | null) => void }) {
  const chart = response.data
  // The containing read is keyed by API/symbol/range, so selection never crosses scopes.
  const [selected, setOwnSelected] = useState<number | null>(null)
  const demo = useDemoPresentation()
  const sliderId = useId()
  const gradientId = `market-area-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const selectionScope = useRef<HTMLElement>(null)
  const points = useMemo(() => chart ? chartPoints(chart) : [], [chart])
  // Whole-cent ticks, so each two-decimal label is exactly its gridline; the domain is the ticks' span (it holds every close).
  const yTicks = useMemo(() => axisTicks(points.map(point => point.coordinate)), [points])
  // The card header (outside this range-keyed subtree) shows the picked bar. It is told in the same event, so header and chart
  // change in one render; unmounting (a new range or symbol) clears it.
  const report = useRef(onSelection); report.current = onSelection
  const setSelected = (index: number | null) => {
    setOwnSelected(index)
    const bar = index === null ? null : points[index]?.bar ?? null
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
  const segments = [...new Set(points.map(point => point.segment))]
  const drawing = points.map(point => ({ ...point, [`segment${point.segment}`]: point.coordinate }))
  const bar = selected === null ? null : points[selected]?.bar ?? null
  const change = chart ? windowChange(chart) : "—"
  // Line and area follow the returned window's direction (graphic colours; the change text keeps the AA text token).
  const first = chart && chart.bars.length >= 2 ? scaled(chart.bars[0].close) : null
  const last = chart && chart.bars.length >= 2 ? scaled(chart.bars[chart.bars.length - 1].close) : null
  const tone = first === null || last === null || first === last ? "text-[var(--color-arco-chart-line)]" : last > first ? "text-[var(--color-arco-stock-chart-up)]" : "text-[var(--color-arco-down)]"
  // Scoped to the chart: the price card above states the quote's own status in the same words.
  const status = response.status === "UNCONFIGURED" ? "시세 연결 준비 중" : response.status === "UNAVAILABLE" ? "시세를 불러올 수 없습니다" : response.status === "STALE" ? demo ? "마지막 관측 시세" : "마지막 확인 시세 · 오래된 데이터" : null
  const message = status && `차트 · ${status}`
  const onMove = (event: { activeTooltipIndex?: string | number | null }) => { const index = Number(event.activeTooltipIndex); if (event.activeTooltipIndex !== null && event.activeTooltipIndex !== undefined && Number.isInteger(index) && points[index]) setSelected(index) }
  return <section ref={selectionScope} aria-label="Underlying security chart" className="w-full min-w-0 space-y-4">
    {message && !(demo && response.status === "STALE") && <p role="status" className="text-sm text-[var(--color-arco-text-soft)]">{message}</p>}
    {!chart || !points.length ? <div className="flex min-h-48 items-center justify-center rounded-2xl bg-[var(--color-arco-page)] p-6 text-sm text-[var(--color-arco-text-soft)]">{message ?? "반환된 차트 관측값이 없습니다"}</div> : <>
      <div data-chart-tone="" className={`h-[240px] w-full min-w-0 touch-pan-y sm:h-[300px] ${tone}`} tabIndex={demo ? 0 : undefined} onKeyDown={demo ? event => {
        const index = selected ?? points.length - 1
        const next = event.key === "ArrowLeft" ? Math.max(0, index - 1) : event.key === "ArrowRight" ? Math.min(points.length - 1, index + 1) : event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : undefined
        if (next !== undefined) { event.preventDefault(); setSelected(next) }
        if (event.key === "Escape") setSelected(null)
      } : undefined} onBlur={demo ? () => setSelected(null) : undefined} aria-label={demo ? "종가 차트 · 방향키로 가격 탐색" : "반환된 종가 차트. 아래 관측값 선택과 원자료 표에서도 확인할 수 있습니다."}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <AreaChart data={drawing} onMouseMove={onMove} onMouseLeave={() => setSelected(null)} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
            <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="currentColor" stopOpacity={0.18} /><stop offset="100%" stopColor="currentColor" stopOpacity={0} /></linearGradient></defs>
            <CartesianGrid vertical={false} stroke="var(--color-arco-stock-chart-grid)" strokeDasharray="2 2" />
            <XAxis dataKey="timestamp" type="number" domain={["dataMin", "dataMax"]} tickFormatter={value => axisTime(value, chart.range)} minTickGap={56} height={28} tick={TICK} axisLine={false} tickLine={false} />
            <YAxis orientation="right" ticks={yTicks} domain={[yTicks[0], yTicks[yTicks.length - 1]]} interval={0} width={64} tickFormatter={axisPrice} tick={TICK} axisLine={false} tickLine={false} />
            <Tooltip content={() => null} cursor={false} />
            {segments.map(segment => <Area key={segment} type="linear" dataKey={`segment${segment}`} connectNulls={false} stroke="currentColor" fill={`url(#${gradientId})`} strokeWidth={1.75} isAnimationActive={false} dot={points.filter(point => point.segment === segment).length === 1 ? { r: 3, fill: "currentColor", stroke: "currentColor" } : false} activeDot={false} />)}
            {bar && <ReferenceDot x={Date.parse(bar.timestamp)} y={Number(bar.close)} r={4} fill="currentColor" stroke="var(--color-arco-surface)" />}
            {bar && <ReferenceLine x={Date.parse(bar.timestamp)} stroke="var(--color-arco-text-soft)" strokeDasharray="3 3" />}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <DemoDetails><div className="space-y-2">
        <label htmlFor={sliderId} className="block text-xs text-[var(--color-arco-text-soft)]">관측값 선택 · 방향키로 이동 · 종가와 봉 시작 시각</label>
        <input id={sliderId} type="range" min={0} max={points.length - 1} step={1} value={selected ?? points.length - 1} onChange={event => setSelected(Number(event.target.value))} onBlur={() => setSelected(null)} aria-valuetext={bar ? `${dollars(bar.close)}, ${time(bar.timestamp)}` : `${dollars(points[points.length - 1].bar.close)}, ${time(points[points.length - 1].bar.timestamp)}`} className="w-full accent-[var(--color-arco-ink)]" />
        {points.length === 1 && <p className="text-xs">관측값 1개 · 구간 등락을 계산할 수 없습니다.</p>}
      </div></DemoDetails>
    </>}
    <DemoDetails><p className="text-sm">반환 관측 구간 등락 <strong className={change === "—" ? "text-[var(--color-arco-text-soft)]" : change.startsWith("−") ? "text-[var(--color-arco-down)]" : "text-[var(--color-arco-up-text)]"}>{change}</strong><span className="text-xs text-[var(--color-arco-text-soft)]"> · 분할 조정 종가 기준</span></p>
    {chart && points.length ? <>
      <p className="text-xs text-[var(--color-arco-text-soft)]">{time(chart.bars[0].timestamp)} — {time(chart.bars[chart.bars.length - 1].timestamp)} · {chart.range === "1D" ? "최근 관측 거래일" : chart.range} · {chart.interval} · New York 시간</p>
      <p className="text-xs text-[var(--color-arco-text-soft)]">{chart.history === "TRUNCATED" ? "일부 이력만 반환됨 · 선택 기간 전체 수익률이 아닙니다." : "반환된 관측값만 표시합니다. 모든 거래일·구간의 이력을 보장하지 않습니다."} {segments.length > 1 ? "긴 관측 공백은 선을 연결하지 않았습니다." : "관측값 사이에 가격 봉을 추가하지 않았습니다."}</p>
      <details className="min-w-0"><summary className="cursor-pointer text-sm">정확한 OHLCV 원자료 ({points.length}개)</summary><div className="mt-2 max-h-64 overflow-auto rounded-lg border border-[var(--color-arco-border)]" tabIndex={0} role="region" aria-label="OHLCV 원자료 스크롤"><table className="w-full whitespace-nowrap text-left text-xs"><thead><tr>{["봉 시작 (New York)", "시가 USD", "고가 USD", "저가 USD", "종가 USD", "기초자산 거래량"].map(label => <th key={label} className="p-2 font-medium">{label}</th>)}</tr></thead><tbody>{chart.bars.map(item => <tr key={item.timestamp}><td className="p-2">{time(item.timestamp)}</td>{[item.open, item.high, item.low, item.close, item.volume].map((value, index) => <td key={index} className="p-2 font-mono">{value}</td>)}</tr>)}</tbody></table></div></details>
    </> : null}</DemoDetails>
  </section>
}
