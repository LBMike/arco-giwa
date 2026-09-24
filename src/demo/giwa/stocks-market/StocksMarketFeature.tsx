import { DemoDetails, useDemoPresentation } from "../demo-presentation"
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { ArrowLeft } from "lucide-react"
import type { MarketClient } from "./client"
import type { Catalog, Chart, Envelope, Quote, Security } from "./contracts"
import { curatedStock } from "./curated"
import { FEED_LABELS, marketSourceLabel } from "./display"
import { FOCUS, knownWithoutCatalog, NotFoundDetail, scrollBehavior, SecurityDetail, UnavailableDetail } from "./MarketDetail"
import { useStocksSelection, type StocksSelection } from "./selection"
import { DEFAULT_TABLE_VIEW, MarketQuoteStatus, MarketStatus as Status, StocksMarketTable, useOrderCapabilities, type Capabilities, type OrdersCatalogClient, type TableView } from "./StocksMarketTable"
import { useMarketRows } from "./useMarketRows"
import { useMarketQuotes } from "./useMarketQuotes"
import { useOwnedRead } from "./useOwnedRead"
import { StocksPageEnvironment } from "./environment"

export type StocksAsideView = {
  selection: StocksSelection
  quote?: Quote | null
  /**
   * The open symbol is not a verified market-data security: the ready market catalog does not list it, or no ready catalog
   * has been checked and it is neither NVDA nor one of the curated 40. The page then claims no market-data support for it.
   */
  unverified: boolean
}
export type StocksMarketFeatureProps = {
  client: MarketClient | null
  ordersClient?: OrdersCatalogClient | null
  /**
   * The page's right column (order panel, sign-in, notices). It is rendered at one tree position in list and detail mode, so
   * nothing in it remounts when the page switches; return keyed siblings in the order each mode needs.
   */
  aside?: (view: StocksAsideView) => ReactNode
}
/**
 * /stocks: the list (40-row table) or one security's detail, chosen by the page selection (?symbol=). The market reads, the 1D
 * series the list's sparklines use and the table's filter/search/sort live above both views, so a detail visit keeps them.
 */
export function StocksMarketFeature({ client, ordersClient = null, aside }: StocksMarketFeatureProps) {
  const demo = useDemoPresentation()
  const selection = useStocksSelection()
  // What the ready market catalog said about the open symbol (reported by its owner); null until a ready catalog was checked.
  const [checked, setChecked] = useState<Checked | null>(null)
  const back = useRef<HTMLButtonElement>(null)
  const symbol = selection.symbol
  const detail = symbol !== null
  const verified = symbol !== null && (symbol === "NVDA" || (checked?.symbol === symbol ? checked.listed : knownWithoutCatalog(symbol)))
  // Below lg the NVDA order panel mounts a fixed Buy/Sell dock with its summary card, whose heading carries the frozen id
  // giwa-stocks-detail-title. The padding keeps the page end (and the chart slider) clear of the dock only while it is there:
  // not on the Orders/Portfolio tabs, nor before the order catalog loads. At lg the same id is the inline panel's: no padding.
  const layout = detail ? `grid grid-cols-1 gap-6 ${demo ? "lg:grid-cols-[minmax(0,1fr)_360px]" : "lg:grid-cols-[minmax(0,1fr)_minmax(0,488px)]"} lg:items-start${symbol === "NVDA" ? " max-lg:has-[#giwa-stocks-detail-title]:pb-28" : ""}` : "flex flex-col gap-6"
  return <>
    {detail ? <button ref={back} type="button" onClick={selection.closeDetail} className={`inline-flex h-9 w-fit scroll-mt-[92px] items-center gap-2 rounded-lg text-sm font-medium text-[var(--color-arco-chip-ink)] hover:text-[var(--color-arco-ink)] ${FOCUS}`}><ArrowLeft aria-hidden="true" className="size-4 shrink-0" /><span>Stocks &amp; ETFs</span><span className="sr-only"> 목록으로</span></button> : null}
    <div className={layout}>
      <div className="min-w-0">{client ? <MarketOwner key={client.baseUrl} client={client} ordersClient={ordersClient} selection={selection} anchor={back} onChecked={setChecked} /> : <NoClient selection={selection} anchor={back} />}</div>
      {aside ? <div className={`flex min-w-0 flex-col gap-6 ${demo && detail ? "lg:sticky lg:top-[104px]" : ""}`}>{aside({ selection, quote: checked?.symbol === symbol ? checked.quote : null, unverified: detail && !verified })}</div> : null}
    </div>
  </>
}

type Checked = { symbol: string; listed: boolean; quote: Quote | null }
type ReportChecked = (update: (current: Checked | null) => Checked | null) => void
function NoClient({ selection, anchor }: { selection: StocksSelection; anchor: RefObject<HTMLElement> }) {
  if (selection.symbol === null) return <section aria-label="Stocks market" className="w-full rounded-2xl bg-[var(--color-arco-surface)] p-6"><h1 className="text-2xl">Stocks</h1><p role="status" className="mt-3">시장정보 API 연결 준비 중</p></section>
  return <UnavailableDetail symbol={selection.symbol} status={<p role="status" className="text-sm text-[var(--color-arco-text-soft)]">시장정보 API 연결 준비 중</p>} capabilities={{ phase: "error" }} selection={selection} anchor={anchor} settled />
}

function MarketOwner({ client, ordersClient, selection, anchor, onChecked }: { client: MarketClient; ordersClient: OrdersCatalogClient | null; selection: StocksSelection; anchor: RefObject<HTMLElement>; onChecked: ReportChecked }) {
  const load = useCallback((signal: AbortSignal) => client.catalog(signal), [client])
  const catalog = useOwnedRead(client.baseUrl, load)
  // One public order-catalog read per API, whatever the market data does (it may be unavailable while ordering works).
  const capabilities = useOrderCapabilities(ordersClient)
  const data = catalog.phase === "ready" ? catalog.value.data : null
  if (catalog.phase === "ready" && data) return <MarketCatalog key={JSON.stringify(data.securities.map(item => item.symbol))} client={client} response={catalog.value as Envelope<Catalog> & { data: Catalog }} capabilities={capabilities} selection={selection} anchor={anchor} onChecked={onChecked} />
  const status = catalog.phase === "ready" ? catalog.value.status : catalog.phase
  if (selection.symbol === null) return <ListFrame selection={selection} settled={status !== "loading"}><Status status={status} /></ListFrame>
  return <UnavailableDetail symbol={selection.symbol} status={<Status status={status} />} capabilities={capabilities} selection={selection} anchor={anchor} settled={status !== "loading"} />
}

/** The list's own frame. Returning from a detail focuses the opened row, or this heading when the table cannot be shown. */
function ListFrame({ selection, settled, table, children }: { selection: StocksSelection; settled: boolean; table?: RefObject<HTMLElement>; children: ReactNode }) {
  const demo = useDemoPresentation()
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const request = selection.focus
    if (selection.symbol !== null || !settled || request.target !== "row" || !request.symbol || !selection.claimFocus(request.tick)) return
    const region = table?.current ?? null
    const row = region?.querySelector<HTMLElement>(`button[data-symbol="${request.symbol}"]`) ?? null
    // The list filter may hide the row that was open: the table region takes focus instead.
    const target = row ?? region?.querySelector<HTMLElement>('[role="region"]') ?? heading.current
    ;(row ?? region ?? heading.current)?.scrollIntoView?.({ behavior: scrollBehavior(), block: row ? "center" : "start" })
    target?.focus({ preventScroll: true })
  }, [selection, settled, table])
  return <section aria-label="Stocks market" className="w-full min-w-0 rounded-2xl bg-[var(--color-arco-surface)] p-4 sm:p-6">
    <header className="mb-6"><p className="text-xs text-[var(--color-arco-text-soft)]">{demo ? "MARKETS" : "MARKETS · DISPLAY ONLY"}</p><h1 ref={heading} tabIndex={-1} className={`mt-1 w-fit rounded-sm text-3xl font-medium ${FOCUS}`}>Stocks</h1><p className="mt-2 text-sm text-[var(--color-arco-text-soft)]">{demo ? "Explore stocks & ETFs" : "기초 미국 주식·ETF 시장정보. 모의 주문의 체결가는 아래 주문 섹션에서 별도로 확인하세요."}</p></header>
    {children}
  </section>
}

function MarketCatalog({ client, response, capabilities, selection, anchor, onChecked }: { client: MarketClient; response: Envelope<Catalog> & { data: Catalog }; capabilities: Capabilities; selection: StocksSelection; anchor: RefObject<HTMLElement>; onChecked: ReportChecked }) {
  const { liveNvda } = useContext(StocksPageEnvironment)
  const catalog = response.data
  const names = useMemo(() => catalog.securities.map(item => item.symbol), [catalog])
  const { quotes, live, connection } = useMarketQuotes(client, names, liveNvda === true)
  const bySymbol = new Map(quotes.phase === "ready" ? (quotes.value.data ?? []).map(item => [item.symbol, item]) : [])
  const [detailSeries, setSeries] = useState<Readonly<Record<string, Chart | null>>>({})
  const series = Object.fromEntries(Object.entries(detailSeries).filter((entry): entry is [string, Chart] => entry[1] !== null))
  // A finished 1D read either stores its series or clears the symbol's entry, so a later failed/stale read never leaves an old chart.
  const report = useCallback((symbol: string, chart: Chart | null) => setSeries(current => {
    if (chart) return current[symbol] === chart ? current : { ...current, [symbol]: chart }
    return { ...current, [symbol]: null }
  }), [])
  const overview = useMarketRows(client, names, true, report)
  const [view, setView] = useState<TableView>(DEFAULT_TABLE_VIEW)
  const table = useRef<HTMLDivElement>(null)
  const symbol = selection.symbol
  const listed = symbol === null ? null : catalog.securities.find(item => item.symbol === symbol) ?? null
  // This ready catalog's answer for the open symbol, so the page can tell a listed security from an unknown one.
  const isListed = listed !== null
  const selectedQuote = symbol === null ? null : bySymbol.get(symbol) ?? null
  useEffect(() => {
    if (symbol === null) return
    const answer: Checked = { symbol, listed: isListed, quote: selectedQuote }
    onChecked(() => answer)
    return () => onChecked(current => current === answer ? null : current)
  }, [symbol, isListed, selectedQuote, onChecked])
  if (symbol === null) return <ListFrame selection={selection} settled table={table}>
    <div className="mb-4">{quotes.phase === "ready" && <DemoDetails><p className="text-xs text-[var(--color-arco-text-soft)]">{marketSourceLabel(quotes.value)} · {FEED_LABELS[quotes.value.feedDelay]}</p></DemoDetails>}<MarketQuoteStatus quotes={quotes} marketSession={live?.marketSession} /></div>
    <div ref={table} className="min-w-0 scroll-mt-24"><StocksMarketTable variant="full" catalog={catalog} quotes={quotes} capabilities={capabilities} series={series} profiles={overview.profiles} view={view} onViewChange={setView} onSelect={name => selection.openDetail(name, "row")} /></div>
  </ListFrame>
  // NVDA is the tradable symbol, so its detail opens even when the market catalog does not list it.
  const security: Security | null = listed ?? (symbol === "NVDA" ? { symbol, name: curatedStock(symbol)?.name ?? symbol } : null)
  if (!security) return <NotFoundDetail symbol={symbol} selection={selection} anchor={anchor} />
  return <SecurityDetail key={JSON.stringify([client.baseUrl, symbol])} client={client} security={security} quote={bySymbol.get(symbol) ?? null} quotes={quotes} capabilities={capabilities} day={series[symbol] ?? null} onSeries={report} selection={selection} anchor={anchor} marketSession={symbol === "NVDA" && connection === "streaming" ? live?.marketSession ?? null : null} liveConnection={symbol === "NVDA" ? connection : "off"} />
}
