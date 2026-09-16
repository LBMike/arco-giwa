import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import type { Chart, Envelope, Quote } from "./contracts"
import { chartPoints, dollars, priceLabel, FEED_LABELS, time, windowChange } from "./display"
export function MarketChart({ response, quote }: { response: Envelope<Chart>; quote: Quote | null }) {
  const chart = response.data
  // The containing detail is keyed by API/symbol/range, so selection never crosses scopes.
  const [selected, setSelected] = useState<number | null>(null)
  const sliderId = useId()
  const selectionScope = useRef<HTMLElement>(null)
  // Touch range controls need not take focus, so blur alone cannot end selection.
  useEffect(() => {
    if (selected === null) return
    const scope = selectionScope.current
    const endOutside = (event: Event) => { if (event.target instanceof Node && !scope?.contains(event.target)) setSelected(null) }
    document.addEventListener("pointerdown", endOutside, true)
    document.addEventListener("focusin", endOutside, true)
    return () => { document.removeEventListener("pointerdown", endOutside, true); document.removeEventListener("focusin", endOutside, true) }
  }, [selected])
  const points = useMemo(() => chart ? chartPoints(chart) : [], [chart])
  const segments = [...new Set(points.map(point => point.segment))]
  const drawing = points.map(point => ({ ...point, [`segment${point.segment}`]: point.coordinate }))
  const bar = selected === null ? null : points[selected]?.bar ?? null
  const change = chart ? windowChange(chart) : "—"
  const message = response.status === "UNCONFIGURED" ? "시세 연결 준비 중" : response.status === "UNAVAILABLE" ? "시세를 불러올 수 없습니다" : response.status === "STALE" ? "마지막 확인 시세 · 오래된 데이터" : null
  const onMove = (event: { activeTooltipIndex?: string | number | null }) => { const index = Number(event.activeTooltipIndex); if (event.activeTooltipIndex !== null && event.activeTooltipIndex !== undefined && Number.isInteger(index) && points[index]) setSelected(index) }
  return <section ref={selectionScope} aria-label="Underlying security chart" className="w-full min-w-0 space-y-4">
    <div aria-live="polite" aria-atomic="true">
      <p className="text-xs text-[var(--color-arco-text-soft)]">{bar ? `${chart?.interval} 구간 종가 · 시각은 봉 시작` : "기초 주식 시세 · USD"}</p>
      <p title={dollars(bar?.close ?? quote?.price ?? null)} className="mt-1 break-all text-3xl font-medium tracking-tight text-[var(--color-arco-ink)]">{bar ? dollars(bar.close) : priceLabel(quote?.price ?? null)}</p>
      <p className="mt-1 text-xs text-[var(--color-arco-text-soft)]">{time(bar?.timestamp ?? quote?.sourceTimestamp ?? null)} · {FEED_LABELS[response.feedDelay]}</p>
    </div>
    <p className="text-sm">반환 관측 구간 등락 <strong className={change.startsWith("−") ? "text-[var(--color-arco-down)]" : "text-[var(--color-arco-up)]"}>{change}</strong><span className="text-xs text-[var(--color-arco-text-soft)]"> · 분할 조정 종가 기준</span></p>
    {message && <p role="status" className="text-sm text-[var(--color-arco-text-soft)]">{message}</p>}
    {quote?.status === "STALE" && response.status !== "STALE" && <p className="text-sm text-[var(--color-arco-text-soft)]">마지막 확인 시세 · 오래된 데이터 · {time(quote.sourceTimestamp)}</p>}
    {!chart || !points.length ? <div className="flex min-h-48 items-center justify-center rounded-xl bg-[var(--color-arco-page)] p-6 text-sm text-[var(--color-arco-text-soft)]">{message ?? "반환된 차트 관측값이 없습니다"}</div> : <>
      <p className="text-xs text-[var(--color-arco-text-soft)]">{time(chart.bars[0].timestamp)} — {time(chart.bars[chart.bars.length - 1].timestamp)} · {chart.range === "1D" ? "최근 24시간(rolling)" : chart.range} · {chart.interval} · New York 시간</p>
      <div className="h-64 w-full min-w-0 touch-pan-y" aria-label="반환된 종가 차트. 아래 관측값 선택과 원자료 표에서도 확인할 수 있습니다.">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <AreaChart data={drawing} onMouseMove={onMove} onMouseLeave={() => setSelected(null)} margin={{ top: 12, right: 10, bottom: 4, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-arco-border)" />
            <XAxis dataKey="timestamp" type="number" domain={["dataMin", "dataMax"]} tickFormatter={value => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(new Date(value))} minTickGap={48} tick={{ fill: "var(--color-arco-text-soft)", fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis hide domain={["dataMin", "dataMax"]} />
            <Tooltip content={() => null} cursor={false} />
            {segments.map(segment => <Area key={segment} type="linear" dataKey={`segment${segment}`} connectNulls={false} stroke="var(--color-arco-chart-line)" fill="var(--color-arco-chart-area)" fillOpacity={0.16} strokeWidth={1.5} isAnimationActive={false} dot={points.filter(point => point.segment === segment).length === 1 ? { r: 3 } : false} activeDot={false} />)}
            {bar && <ReferenceDot x={Date.parse(bar.timestamp)} y={Number(bar.close)} r={4} fill="var(--color-arco-chart-line)" stroke="var(--color-arco-surface)" />}
            {bar && <ReferenceLine x={Date.parse(bar.timestamp)} stroke="var(--color-arco-text-soft)" strokeDasharray="3 3" />}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="space-y-2">
        <label htmlFor={sliderId} className="block text-xs text-[var(--color-arco-text-soft)]">관측값 선택 · 방향키로 이동 · 종가와 봉 시작 시각</label>
        <input id={sliderId} type="range" min={0} max={points.length - 1} step={1} value={selected ?? points.length - 1} onChange={event => setSelected(Number(event.target.value))} onBlur={() => setSelected(null)} aria-valuetext={bar ? `${dollars(bar.close)}, ${time(bar.timestamp)}` : `${dollars(points[points.length - 1].bar.close)}, ${time(points[points.length - 1].bar.timestamp)}`} className="w-full accent-[var(--color-arco-ink)]" />
        {points.length === 1 && <p className="text-xs">관측값 1개 · 구간 등락을 계산할 수 없습니다.</p>}
      </div>
      <p className="text-xs text-[var(--color-arco-text-soft)]">{chart.history === "TRUNCATED" ? "일부 이력만 반환됨 · 선택 기간 전체 수익률이 아닙니다." : "반환된 관측값만 표시합니다. 모든 거래일·구간의 이력을 보장하지 않습니다."} {segments.length > 1 ? "관측 공백은 선을 연결하지 않았습니다." : "누락된 관측값은 보간하지 않습니다."}</p>
      <details className="min-w-0"><summary className="cursor-pointer text-sm">정확한 OHLCV 원자료 ({points.length}개)</summary><div className="mt-2 max-h-64 overflow-auto rounded-lg border border-[var(--color-arco-border)]" tabIndex={0} role="region" aria-label="OHLCV 원자료 스크롤"><table className="w-full whitespace-nowrap text-left text-xs"><thead><tr>{["봉 시작 (New York)", "시가 USD", "고가 USD", "저가 USD", "종가 USD", "기초자산 거래량"].map(label => <th key={label} className="p-2 font-medium">{label}</th>)}</tr></thead><tbody>{chart.bars.map(item => <tr key={item.timestamp}><td className="p-2">{time(item.timestamp)}</td>{[item.open, item.high, item.low, item.close, item.volume].map((value, index) => <td key={index} className="p-2 font-mono">{value}</td>)}</tr>)}</tbody></table></div></details>
    </>}
  </section>
}
