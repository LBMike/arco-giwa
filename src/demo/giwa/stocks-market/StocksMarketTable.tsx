import { DemoDetails, useDemoPresentation } from "../demo-presentation"
import { useCallback, useId, useMemo, useState, type MouseEvent, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { CirclePause, Search } from "lucide-react"
import type { Catalog, Chart, Envelope, Profile, Quote } from "./contracts"
import { CURATED_SELECTION, curatedStock, matchesCuratedSelection, type CuratedStock } from "./curated"
import { changeParts, chartPoints, dollars, compactDollars, volumeDollars, FEED_LABELS, priceLabel, windowChange } from "./display"
import { StockLogo } from "./StockLogo"
import { useOwnedRead, type ReadState } from "./useOwnedRead"
import { scaled } from "./validate"

export type OrderCapability = "CHECK_PAUSE_AT_ORDER" | "NOT_ACTIVATED"
export type Capabilities = { phase: "loading" } | { phase: "error" } | { phase: "ready"; bySymbol: ReadonlyMap<string, OrderCapability> }
/** The public order catalog (no auth): only its per-symbol order capability is read, for the Asset Status column. */
export type OrdersCatalogClient = { getCatalog(signal: AbortSignal): Promise<{ instruments: readonly { symbol: string; orderCapability: OrderCapability }[] }> }
/** One read per mount; no polling. A missing client is reported as an error, never as "market data only". */
export function useOrderCapabilities(client: OrdersCatalogClient | null): Capabilities {
  const load = useCallback((signal: AbortSignal) => client ? client.getCatalog(signal) : Promise.reject(new Error("ORDERS_CLIENT_UNAVAILABLE")), [client])
  const orders = useOwnedRead("orders-catalog", load)
  return useMemo(() => !client || orders.phase === "error" ? { phase: "error" } : orders.phase === "loading" ? { phase: "loading" } : { phase: "ready", bySymbol: new Map(orders.value.instruments.map(item => [item.symbol, item.orderCapability])) }, [client, orders])
}
/** The full table's toolbar state. The /stocks page keeps it above the list so it survives a detail visit; absent, the table keeps its own. */
export type TableView = { filter: TableFilter; query: string; sort: TableSort }
export const DEFAULT_TABLE_VIEW: TableView = Object.freeze({ filter: "ALL", query: "", sort: "rank" })
export type StocksMarketTableProps = { catalog: Catalog; quotes: ReadState<Envelope<Quote[]>>; capabilities: Capabilities; series: Readonly<Record<string, Chart>>; profiles?: Readonly<Record<string, Profile>>; variant: "full" | "home"; selectedSymbol?: string; onSelect?: (symbol: string) => void; rowHref?: (symbol: string) => string; limit?: number; view?: TableView; onViewChange?: (view: TableView) => void }

export function MarketStatus({ status }: { status: string }) { const demo = useDemoPresentation(); if (demo && status === "STALE") return null; return <p role="status" className="text-sm text-[var(--color-arco-text-soft)]">{status === "loading" ? "시장정보 불러오는 중…" : status === "UNCONFIGURED" ? "시세 연결 준비 중" : status === "STALE" ? "마지막 확인 시세 · 오래된 데이터" : "시세를 불러올 수 없습니다"}</p> }

type Row = { symbol: string; name: string; rank: number | null; position: number; curated: CuratedStock | null; quote: Quote | null }
export type TableSort = "rank" | "gainer" | "loser" | "priceHigh" | "priceLow"
export type TableFilter = "ALL" | "STOCK" | "ETF"
type Sort = TableSort
type Filter = TableFilter
const SORTS: readonly (readonly [Sort, string])[] = [["rank", "Rank"], ["gainer", "Top Gainer"], ["loser", "Top Loser"], ["priceHigh", "Price: High to Low"], ["priceLow", "Price: Low to High"]]
const FILTERS: readonly (readonly [Filter, string])[] = [["ALL", "All assets"], ["STOCK", "Stocks"], ["ETF", "ETF"]]
const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
// One template for header and rows (≈ Figma 9:122 at 1273px); the min width scrolls inside the region, never the page.
// The region is `relative` so absolutely positioned sr-only text is clipped by it instead of widening the page.
const WIDTH = { full: "md:min-w-[1044px]", home: "md:min-w-[868px]" }
const COLS = { full: "md:grid-cols-[44px_minmax(184px,215fr)_repeat(5,minmax(104px,144fr))_160px]", home: "md:grid-cols-[44px_minmax(184px,215fr)_repeat(5,minmax(104px,144fr))]" }
const GRID = "grid grid-cols-[28px_minmax(0,1fr)_auto] gap-x-3 md:gap-x-4 md:px-3"
// # and Asset Name stay pinned while the table scrolls sideways; negative margins let the opaque cells cover the gutters.
const STICKY_RANK = "md:sticky md:left-0 md:z-[1] md:-ml-3 md:pl-3 md:self-stretch md:flex md:items-center"
const STICKY_ASSET = "md:sticky md:left-14 md:z-[1] md:-ml-4 md:pl-4 md:self-stretch md:flex md:items-center"
const HEAD = "text-base font-medium leading-[21px] tracking-[-0.01em] text-[var(--color-arco-chip-ink)]"
const RESET = "md:col-start-auto md:row-start-auto"

function value(row: Row, sort: Sort): bigint | null {
  const raw = sort === "gainer" || sort === "loser" ? row.quote?.changePercent : row.quote?.price
  return raw === null || raw === undefined ? null : scaled(raw)
}
function compare(sort: Sort) {
  const byRank = (a: Row, b: Row) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.position - b.position
  if (sort === "rank") return byRank
  const descending = sort === "gainer" || sort === "priceHigh"
  return (a: Row, b: Row) => {
    const x = value(a, sort), y = value(b, sort)
    if (x === null || y === null) return x === y ? byRank(a, b) : x === null ? 1 : -1
    return (x === y ? 0 : (x < y ? -1 : 1) * (descending ? -1 : 1)) || byRank(a, b)
  }
}

export function Triangle({ up }: { up: boolean }) {
  return <svg aria-hidden="true" width={12} height={10} viewBox="0 0 12 10" fill="currentColor" className="shrink-0"><path d={up ? "M4.82 1.29C5.33.57 6.42.57 6.93 1.29l4.21 5.98c.59.84-.02 1.98-1.05 1.98H1.66C.62 9.25.02 8.11.61 7.27z" : "M6.93 8.71c-.51.72-1.6.72-2.11 0L.61 2.73C.02 1.89.62.75 1.66.75h8.43c1.03 0 1.64 1.14 1.05 1.98z"} /></svg>
}
function Change({ raw, unit }: { raw: string | null; unit: "$" | "%" }) {
  const parts = changeParts(raw)
  if (!parts) return <span className="text-[var(--color-arco-text-soft)]">—</span>
  const text = unit === "$" ? `$${parts.magnitude}` : `${parts.magnitude}%`
  if (parts.direction === "flat") return <span className="text-[var(--color-arco-text-soft)]">{text}</span>
  const up = parts.direction === "up"
  return <span className={`inline-flex items-center gap-1 ${up ? "text-[var(--color-arco-up-text)]" : "text-[var(--color-arco-down)]"}`}><Triangle up={up} /><span className="sr-only">{up ? "상승 " : "하락 "}</span>{text}</span>
}
/** Order capability for one symbol, as the Asset Status column and the detail header show it. */
export function StatusBadge({ symbol, capabilities }: { symbol: string; capabilities: Capabilities }) {
  const capability = capabilities.phase === "ready" ? capabilities.bySymbol.get(symbol) ?? null : null
  const base = "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full bg-[var(--color-arco-chip)] px-2 text-xs font-medium"
  const badge = `${base} text-[var(--color-arco-ink)]`, quiet = `${base} text-[var(--color-arco-chip-ink)]`
  const demo = useDemoPresentation()
  if (demo) return <span className={badge}>{capabilities.phase !== "ready" ? "—" : capability === "CHECK_PAUSE_AT_ORDER" ? "Available" : "Coming soon"}</span>
  if (capabilities.phase === "loading") return <span className={badge}>확인 중</span>
  if (capabilities.phase === "error") return <span className={badge}>상태 확인 불가</span>
  if (capability === "CHECK_PAUSE_AT_ORDER") return <span className={badge} title="테스트넷 모의 주문 · 주문 시점에 일시중지 여부 확인"><span aria-hidden="true" className="relative inline-flex size-3 shrink-0 items-center justify-center"><span className="absolute inset-0 rounded-full bg-[var(--color-arco-up)] opacity-40" /><span className="relative size-2 rounded-full bg-[var(--color-arco-up)]" /></span>모의 주문</span>
  if (capability === "NOT_ACTIVATED") return <span className={quiet}><CirclePause aria-hidden="true" className="size-4 shrink-0" />미활성</span>
  return <span className={badge}>시장정보만</span>
}
function Sparkline({ chart }: { chart: Chart }) {
  const id = `spark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const points = chartPoints(chart)
  const first = scaled(chart.bars[0].close), last = scaled(chart.bars[chart.bars.length - 1].close)
  const direction = last > first ? "up" : last < first ? "down" : "flat"
  const values = points.map(point => point.coordinate); const min = Math.min(...values), max = Math.max(...values)
  const t0 = points[0].timestamp, t1 = points[points.length - 1].timestamp
  const x = (t: number) => (t1 === t0 ? 74 : 1 + ((t - t0) / (t1 - t0)) * 146).toFixed(2)
  const y = (v: number) => (max === min ? 24 : 2 + (1 - (v - min) / (max - min)) * 44).toFixed(2)
  const segments = [...new Set(points.map(point => point.segment))].map(segment => points.filter(point => point.segment === segment))
  const change = windowChange(chart).slice(1)
  return <svg role="img" aria-label={`최근 24시간 종가 추이 · ${direction === "up" ? "상승" : direction === "down" ? "하락" : "보합"} ${change}`} width={148} height={48} viewBox="0 0 148 48" className={direction === "up" ? "text-[var(--color-arco-up)]" : direction === "down" ? "text-[var(--color-arco-down)]" : "text-[var(--color-arco-text-soft)]"}>
    <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity={0.24} /><stop offset="1" stopColor="currentColor" stopOpacity={0} /></linearGradient></defs>
    {segments.map(segment => {
      if (segment.length === 1) return <circle key={segment[0].index} cx={x(segment[0].timestamp)} cy={y(segment[0].coordinate)} r={1.5} fill="currentColor" />
      const line = segment.map((point, index) => `${index ? "L" : "M"}${x(point.timestamp)} ${y(point.coordinate)}`).join("")
      return <g key={segment[0].index}><path d={`${line}L${x(segment[segment.length - 1].timestamp)} 48L${x(segment[0].timestamp)} 48Z`} fill={`url(#${id})`} /><path d={line} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></g>
    })}
  </svg>
}

export function StocksMarketTable({ catalog, quotes, capabilities, series, profiles = {}, variant, selectedSymbol, onSelect, rowHref, limit, view, onViewChange }: StocksMarketTableProps) {
  const full = variant === "full"
  const [ownView, setOwnView] = useState<TableView>(DEFAULT_TABLE_VIEW)
  const { filter, query, sort } = view ?? ownView
  const change = (patch: Partial<TableView>) => { const next = { filter, query, sort, ...patch }; if (view) onViewChange?.(next); else setOwnView(next) }
  const setFilter = (next: Filter) => change({ filter: next }), setQuery = (next: string) => change({ query: next }), setSort = (next: Sort) => change({ sort: next })
  const searchId = useId(), sortId = useId()
  const rows = useMemo(() => {
    const bySymbol = new Map((quotes.phase === "ready" ? quotes.value.data ?? [] : []).map(quote => [quote.symbol, quote]))
    // Server ranks are shown as given; catalog position stands in only when the server ranks no row at all.
    const ranked = catalog.securities.some(security => security.rank !== undefined)
    return catalog.securities.map((security, position): Row => ({ symbol: security.symbol, name: security.name, rank: security.rank ?? (ranked ? null : position + 1), position, curated: curatedStock(security.symbol), quote: bySymbol.get(security.symbol) ?? null }))
  }, [catalog, quotes])
  const counts: Record<Filter, number> = { ALL: rows.length, STOCK: rows.filter(row => row.curated?.kind === "STOCK").length, ETF: rows.filter(row => row.curated?.kind === "ETF").length }
  const hasChange = rows.some(row => row.quote?.changePercent != null), hasPrice = rows.some(row => row.quote?.price != null)
  const enabled = (option: Sort) => option === "rank" || (option === "gainer" || option === "loser" ? hasChange : hasPrice)
  const activeSort = enabled(sort) ? sort : "rank"
  const activeFilter = counts[filter] ? filter : "ALL"
  const needle = query.trim().toLowerCase()
  const shown = full
    ? rows.filter(row => (activeFilter === "ALL" || row.curated?.kind === activeFilter) && (!needle || [row.symbol, row.name, row.curated?.name ?? ""].some(text => text.toLowerCase().includes(needle)))).sort(compare(activeSort))
    : [...rows].sort(compare("rank")).slice(0, limit ?? rows.length)
  const feed = FEED_LABELS[quotes.phase === "ready" ? quotes.value.feedDelay : "UNKNOWN"]
  const provenance = catalog.provenance
  const asOf = provenance.asOfDate ? `선정 기준일 ${provenance.asOfDate}` : "선정 기준일 미확인"
  const source = provenance.verification === "PILOT" ? `NVDA 파일럿 목록 · 40종목 선정 완료를 의미하지 않습니다. ${asOf}` : [`서버 선정 목록 · ${catalog.securities.length}종목 · ${provenance.verification}`, provenance.rankingMetric && `기준 ${provenance.rankingMetric}`, provenance.period && `기간 ${provenance.period}`, asOf].filter(Boolean).join(" · ")
  const curated = matchesCuratedSelection(catalog.securities.map(security => security.symbol))
  // A click anywhere on the row activates its primary control, unless it already landed on a control.
  const activate = (event: MouseEvent<HTMLElement>) => { if ((event.target as Partial<HTMLElement>).closest?.("a,button,input,select")) return; event.currentTarget.querySelector<HTMLElement>("[data-row-primary]")?.click() }
  const cell = (extra: string, children: ReactNode) => <div role="cell" className={`min-w-0 ${extra}`}>{children}</div>
  return <div className="w-full min-w-0">
    {full && <>
      <div className="flex items-end border-b border-[var(--color-arco-border)]"><div className="relative flex items-center py-4"><h2 className="text-base font-medium leading-[21px] text-[var(--color-arco-ink)]">Stocks &amp; ETFs</h2><span className="ml-2 rounded-full bg-[var(--color-arco-chip)] px-2 py-px text-sm font-medium tabular-nums text-[var(--color-arco-text)]">{catalog.securities.length}<span className="sr-only">개 종목</span></span><span aria-hidden="true" className="absolute inset-x-0 -bottom-px h-0.5 bg-[var(--color-arco-ink)]" /></div></div>
      <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div role="group" aria-label="Asset type" className="flex flex-wrap gap-2">{FILTERS.map(([key, label]) => <button key={key} type="button" aria-pressed={activeFilter === key} disabled={!counts[key]} onClick={() => setFilter(key)} className={`h-9 rounded-full px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS} ${activeFilter === key ? "bg-[var(--color-arco-chip)] text-[var(--color-arco-ink)]" : "text-[var(--color-arco-chip-ink)] hover:bg-[var(--color-row-hover-weak)]"}`}>{label}</button>)}</div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative w-full sm:w-72"><label htmlFor={searchId} className="sr-only">Search asset name or ticker</label><Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-arco-ink)]" /><input id={searchId} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search asset name or ticker" autoComplete="off" className={`h-9 w-full rounded-lg bg-[var(--color-arco-chip)] pl-9 pr-3 text-sm text-[var(--color-arco-ink)] placeholder:text-[var(--color-arco-chip-ink)] ${FOCUS}`} /></div>
          <div className="flex items-center"><label htmlFor={sortId} className="sr-only">Sort</label><select id={sortId} value={activeSort} onChange={event => setSort(event.target.value as Sort)} className={`h-9 w-full rounded-lg bg-[var(--color-arco-chip)] px-3 text-sm font-medium text-[var(--color-arco-ink)] sm:w-auto ${FOCUS}`}>{SORTS.map(([key, label]) => <option key={key} value={key} disabled={!enabled(key)}>{label}</option>)}</select></div>
        </div>
      </div>
      <p role="status" className="sr-only">{shown.length}개 표시 · 전체 {rows.length}개</p>
    </>}
    <div role="region" aria-label="Stocks & ETFs 표 · 좌우로 스크롤" tabIndex={0} className={`${full ? "mt-4" : ""} relative w-full min-w-0 overflow-x-auto ${FOCUS}`}>
      <div role="table" aria-label="Stocks & ETFs" className={`w-full ${WIDTH[variant]}`}>
        <div role="rowgroup">
          <div role="row" className={`sr-only md:not-sr-only md:grid md:h-12 md:items-center md:border-y md:border-[var(--color-arco-border)] ${GRID} ${COLS[variant]}`}>
            <div role="columnheader" className={`${HEAD} ${STICKY_RANK} md:bg-[var(--color-arco-surface)]`}>#</div>
            <div role="columnheader" className={`${HEAD} ${STICKY_ASSET} md:bg-[var(--color-arco-surface)]`}>Asset Name</div>
            <div role="columnheader" className={`${HEAD} md:px-3`}>Price<DemoDetails><sup aria-hidden="true" className="ml-0.5 text-xs text-[var(--color-arco-muted)]">1</sup></DemoDetails></div>
            <div role="columnheader" className={`${HEAD} md:px-3`}>24H (%)</div>
            <div role="columnheader" className={`${HEAD} hidden md:block md:px-3`}>Market Cap / AUM</div>
            <div role="columnheader" className={`${HEAD} hidden md:block md:pl-3`} title="Estimated session turnover: shares traded × displayed price">Volume (USD)</div>
            <div role="columnheader" className={HEAD}>Asset Status</div>
            {full && <div role="columnheader" className={`${HEAD} hidden md:block md:px-1.5`}>24h Chart</div>}
          </div>
        </div>
        <div role="rowgroup">
          {shown.map(row => {
            // A pressed state only where a selection is shown next to the list; a row that opens a detail page is a plain button.
            const selected = full && row.symbol === selectedSymbol
            const surface = selected ? "md:bg-[var(--color-arco-page)]" : "md:bg-[var(--color-arco-surface)] md:group-hover:bg-[linear-gradient(var(--color-row-hover-weak),var(--color-row-hover-weak))]"
            const label = <><StockLogo symbol={row.symbol} size={40} /><span className="min-w-0"><span className="block truncate text-base font-medium leading-[21px] tracking-[-0.01em] text-[var(--color-arco-ink)]">{row.symbol}</span>{" "}<span className="mt-1 block truncate text-sm font-medium leading-[18px] tracking-[-0.01em] text-[var(--color-arco-chip-ink)]">{row.name}</span></span></>
            const primary = `flex w-full min-w-0 items-center gap-2 rounded-lg text-left ${FOCUS}`
            const quote = row.quote
            const profile = profiles[row.symbol]
            const etf = row.curated?.kind === "ETF" || profile?.securityType === "ETF"
            const size = etf ? profile?.aum ?? null : profile?.marketCap ?? null
            const volume = volumeDollars(quote?.price ?? null, quote?.sessionVolume ?? null)
            return <div role="row" key={row.symbol} onClick={activate} className={`group cursor-pointer items-center gap-y-2 border-b border-[var(--color-arco-border)] py-3 md:min-h-[73px] md:py-0 ${GRID} ${COLS[variant]} ${selected ? "bg-[var(--color-arco-page)]" : "hover:bg-[var(--color-row-hover-weak)]"}`}>
              {cell(`col-start-1 row-start-1 text-base font-medium tabular-nums text-[var(--color-arco-chip-ink)] ${RESET} ${STICKY_RANK} ${surface}`, row.rank ?? "—")}
              {cell(`col-start-2 row-start-1 ${RESET} ${STICKY_ASSET} ${surface}`, full
                ? <button type="button" data-row-primary="" data-symbol={row.symbol} aria-pressed={selectedSymbol === undefined ? undefined : selected} onClick={() => onSelect?.(row.symbol)} className={primary}>{label}</button>
                : rowHref ? <Link to={rowHref(row.symbol)} data-row-primary="" className={primary}>{label}</Link> : <span className={primary}>{label}</span>)}
              {cell(`col-start-3 row-start-1 text-right text-base font-medium tabular-nums text-[var(--color-arco-ink)] md:px-3 md:text-left ${RESET}`, <><span title={quote?.price ? dollars(quote.price) : undefined}>{priceLabel(quote?.price ?? null)}</span><DemoDetails>{quote?.status === "STALE" && <span className="block text-xs font-normal text-[var(--color-arco-text-soft)]">오래된 데이터</span>}</DemoDetails></>)}
              {cell(`col-start-3 row-start-2 text-right text-sm tabular-nums md:px-3 md:text-left ${RESET}`, <Change raw={quote?.changePercent ?? null} unit="%" />)}
              {cell("hidden text-sm font-medium tabular-nums text-[var(--color-arco-ink)] md:block md:px-3", <span title={`${etf ? "AUM" : "Market cap"}: ${dollars(size)}${etf && profile?.aumAsOf ? ` · ${profile.aumAsOf}` : ""}`}>{compactDollars(size)}</span>)}
              {cell("hidden text-sm font-medium tabular-nums text-[var(--color-arco-ink)] md:block md:pl-3", <span title={volume === null ? undefined : `Estimated session turnover: ${dollars(volume)} (shares × price)`}>{compactDollars(volume)}</span>)}
              {cell(`col-start-2 row-start-2 ${RESET}`, <StatusBadge symbol={row.symbol} capabilities={capabilities} />)}
              {full && cell("hidden md:flex md:h-12 md:w-40 md:items-center md:justify-center", series[row.symbol] && series[row.symbol].bars.length >= 2 ? <Sparkline chart={series[row.symbol]} /> : <><span aria-hidden="true" className="text-[var(--color-arco-muted)]">—</span><span className="sr-only">24시간 차트 데이터 없음</span></>)}
            </div>
          })}
        </div>
      </div>
    </div>
    {shown.length === 0 && <p className="border-b border-[var(--color-arco-border)] py-6 text-center text-sm text-[var(--color-arco-text-soft)]">검색 결과가 없습니다.</p>}
    <DemoDetails><div className="mt-4 space-y-1 text-xs leading-5 text-[var(--color-arco-text-soft)]">
      <p>{`¹ Price는 기초 미국 주식·ETF의 USD 시세(Massive, ${feed})이며 ARCO 토큰 가격이나 모의 체결가가 아닙니다. 24H (%)는 공급자가 제공한 전일 종가 대비 변동입니다. Market Cap은 주식 시가총액, AUM은 ETF 운용자산입니다. Volume (USD)은 세션 거래량 × 표시 가격으로 계산한 추정 거래대금입니다.${full ? " 24h Chart는 각 종목의 1D(rolling 24시간) 종가입니다." : ""}`}</p>
      <p>{source}</p>
      {curated && <p>선정 참고: {CURATED_SELECTION.source} · {CURATED_SELECTION.metric} · {CURATED_SELECTION.period} · {CURATED_SELECTION.retrievedDate} 조회 · {CURATED_SELECTION.note}</p>}
    </div></DemoDetails>
  </div>
}
