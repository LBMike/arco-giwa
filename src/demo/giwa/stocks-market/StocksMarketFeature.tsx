import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { useSearchParams } from "react-router-dom"
import type { MarketClient } from "./client"
import type { Catalog, Chart, Envelope, Quote, Range, Security } from "./contracts"
import { RANGES } from "./contracts"
import { dollars, exact, FEED_LABELS, time } from "./display"
import { MarketChart } from "./MarketChart"
import { StockLogo } from "./StockLogo"
import { MarketStatus as Status, StocksMarketTable, useOrderCapabilities, type OrdersCatalogClient } from "./StocksMarketTable"
import { useOwnedRead } from "./useOwnedRead"
const button = "rounded-lg border border-[var(--color-arco-border)] px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
const scrollBehavior = (): ScrollBehavior => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
export function StocksMarketFeature({ client, ordersClient = null }: { client: MarketClient | null; ordersClient?: OrdersCatalogClient | null }) {
  if (!client) return <section aria-label="Stocks market" className="w-full rounded-2xl bg-[var(--color-arco-surface)] p-6"><h1 className="text-2xl">Stocks</h1><p role="status" className="mt-3">시장정보 API 연결 준비 중</p></section>
  return <MarketOwner key={client.baseUrl} client={client} ordersClient={ordersClient} />
}
function MarketOwner({ client, ordersClient }: { client: MarketClient; ordersClient: OrdersCatalogClient | null }) {
  const load = useCallback((signal: AbortSignal) => client.catalog(signal), [client])
  const catalog = useOwnedRead(client.baseUrl, load)
  return <section aria-label="Stocks market" className="w-full min-w-0 rounded-2xl bg-[var(--color-arco-surface)] p-4 sm:p-6">
    <header className="mb-6"><p className="text-xs text-[var(--color-arco-text-soft)]">MARKETS · DISPLAY ONLY</p><h1 className="mt-1 text-3xl font-medium">Stocks</h1><p className="mt-2 text-sm text-[var(--color-arco-text-soft)]">기초 미국 주식·ETF 시장정보. 모의 주문의 체결가는 아래 주문 섹션에서 별도로 확인하세요.</p></header>
    {catalog.phase !== "ready" ? <Status status={catalog.phase} /> : catalog.value.data ? <MarketCatalog key={JSON.stringify(catalog.value.data.securities.map(item => item.symbol))} client={client} ordersClient={ordersClient} response={catalog.value as Envelope<Catalog> & { data: Catalog }} /> : <Status status={catalog.value.status} />}
  </section>
}
function MarketCatalog({ client, ordersClient, response }: { client: MarketClient; ordersClient: OrdersCatalogClient | null; response: Envelope<Catalog> & { data: Catalog } }) {
  const catalog = response.data
  const [params, setParams] = useSearchParams()
  const requested = params.get("symbol")
  // The URL owns the selection; an absent or unknown symbol shows the first catalog security.
  const active = catalog.securities.find(item => item.symbol === requested) ?? catalog.securities[0]
  const names = useMemo(() => catalog.securities.map(item => item.symbol), [catalog])
  const load = useCallback((signal: AbortSignal) => client.quotes(names, signal), [client, names])
  const quotes = useOwnedRead(JSON.stringify([client.baseUrl, names]), load)
  const bySymbol = new Map(quotes.phase === "ready" ? (quotes.value.data ?? []).map(item => [item.symbol, item]) : [])
  const capabilities = useOrderCapabilities(ordersClient)
  // 1D charts the detail view already loaded; rows never request charts of their own.
  const [series, setSeries] = useState<Readonly<Record<string, Chart>>>({})
  // A finished 1D read either stores its series or clears the symbol's entry, so a later failed/stale read never leaves an old chart.
  const report = useCallback((symbol: string, chart: Chart | null) => setSeries(current => {
    if (chart) return current[symbol] === chart ? current : { ...current, [symbol]: chart }
    if (!(symbol in current)) return current
    const { [symbol]: _removed, ...rest } = current
    return rest
  }), [])
  const table = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [focus, setFocus] = useState<{ symbol: string; tick: number } | null>(() => requested !== null && names.includes(requested) ? { symbol: requested, tick: 0 } : null)
  const handled = useRef(-1)
  useEffect(() => {
    const target = heading.current
    if (!focus || focus.symbol !== active.symbol || handled.current === focus.tick || !target) return
    handled.current = focus.tick
    target.closest("article")?.scrollIntoView?.({ behavior: scrollBehavior(), block: "start" })
    target.focus({ preventScroll: true })
  }, [focus, active.symbol])
  const select = (symbol: string) => {
    setParams(current => { const next = new URLSearchParams(current); next.set("symbol", symbol); return next }, { preventScrollReset: true })
    setFocus(current => ({ symbol, tick: (current?.tick ?? 0) + 1 }))
  }
  const back = () => {
    const row = table.current?.querySelector<HTMLElement>(`button[data-symbol="${active.symbol}"]`)
    const target = row ?? table.current?.querySelector<HTMLElement>('[role="region"]')
    ;(row ?? table.current)?.scrollIntoView?.({ behavior: scrollBehavior(), block: row ? "center" : "start" })
    target?.focus({ preventScroll: true })
  }
  return <>
    <div className="mb-4">{quotes.phase !== "ready" ? <Status status={quotes.phase} /> : <><p className="text-xs text-[var(--color-arco-text-soft)]">Massive · {FEED_LABELS[quotes.value.feedDelay]}</p>{quotes.value.status !== "AVAILABLE" && <Status status={quotes.value.status} />}</>}</div>
    <div ref={table} className="min-w-0 scroll-mt-24"><StocksMarketTable variant="full" catalog={catalog} quotes={quotes} capabilities={capabilities} series={series} selectedSymbol={active.symbol} onSelect={select} /></div>
    <div className="mt-8 min-w-0 border-t border-[var(--color-arco-border)] pt-4">
      <SecurityDetail key={JSON.stringify([client.baseUrl, active.symbol])} client={client} security={active} quote={bySymbol.get(active.symbol) ?? null} headingRef={heading} onBack={back} onSeries={report} />
    </div>
  </>
}
function SecurityDetail({ client, security, quote, headingRef, onBack, onSeries }: { client: MarketClient; security: Security; quote: Quote | null; headingRef: RefObject<HTMLHeadingElement>; onBack: () => void; onSeries: (symbol: string, chart: Chart | null) => void }) {
  const [range, setRange] = useState<Range>("1D")
  const load = useCallback((signal: AbortSignal) => client.profile(security.symbol, signal), [client, security.symbol])
  const profile = useOwnedRead(security.symbol, load)
  const data = profile.phase === "ready" ? profile.value.data : null
  return <article className="min-w-0 scroll-mt-24 space-y-5">
    <header className="flex flex-wrap items-center gap-3 pt-3"><StockLogo symbol={security.symbol} apiLogoUrl={data?.logoUrl ?? null} /><div className="min-w-0 flex-1"><h2 ref={headingRef} tabIndex={-1} className="mb-1 w-fit max-w-full rounded-sm text-xl font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]">{data?.name ?? security.name} <span className="text-sm text-[var(--color-arco-text-soft)]">{security.symbol}</span></h2><p className="text-xs text-[var(--color-arco-text-soft)]">{data?.exchange ?? security.exchange ?? "거래소 미확인"} · {data?.securityType ?? "유형 미확인"}</p></div><button type="button" className={`${button} bg-[var(--color-arco-surface)]`} onClick={onBack}>목록으로</button></header>
    <div role="group" aria-label="차트 기간" className="flex flex-wrap gap-2">{RANGES.map(value => <button type="button" key={value} aria-pressed={range === value} className={`${button} ${range === value ? "bg-[var(--color-arco-ink)] text-[var(--color-arco-on-dark)]" : "bg-[var(--color-arco-surface)]"}`} onClick={() => setRange(value)}>{value}</button>)}</div>
    <ChartRead key={JSON.stringify([client.baseUrl, security.symbol, range])} client={client} name={security.symbol} range={range} quote={quote} onSeries={onSeries} />
    {quote?.status === "UNAVAILABLE" || quote?.status === "UNCONFIGURED" ? <Status status={quote.status} /> : null}
    <dl className="grid grid-cols-1 gap-3 border-t border-[var(--color-arco-border)] pt-4 text-xs sm:grid-cols-2"><div><dt className="text-[var(--color-arco-text-soft)]">기초 시장 세션 거래량</dt><dd className="mt-1 break-all font-mono">{exact(quote?.sessionVolume ?? null)}</dd></div><div><dt className="text-[var(--color-arco-text-soft)]">기업 시가총액 · USD</dt><dd className="mt-1 break-all font-mono">{dollars(data?.marketCap ?? null)}</dd></div></dl>
    <section aria-label="기업정보 상태" className="space-y-1 text-xs text-[var(--color-arco-text-soft)]">
      <p role="status">{profile.phase === "loading" ? "기업정보 불러오는 중…" : profile.phase === "error" ? "기업정보를 불러올 수 없습니다" : profile.value.status === "STALE" ? "기업정보 · 마지막 확인 정보 · 오래된 데이터" : profile.value.status === "UNCONFIGURED" ? "기업정보 연결 준비 중" : profile.value.status === "UNAVAILABLE" ? "기업정보를 불러올 수 없습니다" : "기업정보 · 공급자 참조 데이터"}</p>
      {profile.phase === "ready" && data && <p>기업정보 최근 수집: {time(profile.value.fetchedAt)} · 공급자 기준일: {data.sourceDate ?? "미확인"}. 시세 관측 시각과 별개입니다.</p>}
    </section>
    {data?.description && <p className="text-sm leading-6 text-[var(--color-arco-text-soft)]">{data.description}</p>}
    {profile.phase === "error" && <p className="text-xs">기업정보를 불러올 수 없습니다.</p>}
    <p className="text-xs text-[var(--color-arco-text-soft)]">시세 관측: {time(quote?.sourceTimestamp ?? null)}. 주식 시세·기업 시가총액은 ARCO 토큰 가격·유동성·보유량이 아닙니다.</p>
    {security.symbol === "NVDA" ? <p className="text-sm">NVDA 테스트 주문은 아래 모의 거래 섹션에서 확인하세요. 표시 시세는 체결에 사용하지 않습니다.</p> : <p role="status" className="text-sm">{security.symbol}은 시장정보 조회만 지원합니다. 현재 모의 주문은 NVDA만 지원하며 이 종목을 NVDA 주문으로 전환하지 않습니다.</p>}
  </article>
}
function ChartRead({ client, name, range, quote, onSeries }: { client: MarketClient; name: string; range: Range; quote: Quote | null; onSeries: (symbol: string, chart: Chart | null) => void }) {
  const load = useCallback((signal: AbortSignal) => client.chart(name, range, signal), [client, name, range])
  const chart = useOwnedRead(JSON.stringify([client.baseUrl, name, range]), load)
  // Once this owner's 1D read finishes, the list gets its series only if it is current (AVAILABLE, 2+ bars); a STALE,
  // unavailable, empty, one-bar or failed read clears the symbol's list entry. Other ranges never touch the 1D entry.
  // useOwnedRead only publishes this key's own result, so a late answer from an earlier symbol/range/API cannot report.
  const settled = chart.phase === "ready" ? chart.value : chart.phase === "error" ? "error" : null
  useEffect(() => {
    if (range !== "1D" || settled === null) return
    const data = settled !== "error" && settled.status === "AVAILABLE" ? settled.data : null
    onSeries(name, data && data.bars.length >= 2 ? data : null)
  }, [range, name, settled, onSeries])
  return chart.phase === "ready" ? <MarketChart response={chart.value} quote={quote} /> : <div className="min-h-64"><Status status={chart.phase} /></div>
}
