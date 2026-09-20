import { DemoDetails, useDemoPresentation } from "../demo-presentation"
// The /stocks security detail (left column): header, price/period/chart card, About and Statistics. Every value comes from the
// server market contract (catalog, quotes, profile, chart) or the curated display metadata; nothing from the Figma capture.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import type { MarketClient } from "./client"
import type { Chart, Envelope, Profile, Quote, Range, Security } from "./contracts"
import { RANGES } from "./contracts"
import { curatedStock, type CuratedStock } from "./curated"
import { barRange, changeParts, compactDollars, dollars, exact, FEED_LABELS, marketSourceLabel, priceLabel, time } from "./display"
import { MarketChart, type ChartSelection } from "./MarketChart"
import type { StocksSelection } from "./selection"
import { StockLogo } from "./StockLogo"
import { MarketStatus as Status, StatusBadge, Triangle, type Capabilities } from "./StocksMarketTable"
import { useOwnedRead, type ReadState } from "./useOwnedRead"

export const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
export const CARD = "min-w-0 rounded-3xl border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-4 sm:p-6"
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect
export const scrollBehavior = (): ScrollBehavior => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"

/**
 * Entering from a row or a first-load deep link: once this view is final (`settled`), scroll the top of the detail (the back
 * control) into view and focus the heading. "investor" and Back/Forward entries carry no request, so focus stays put.
 */
function useDetailFocus(selection: StocksSelection, heading: RefObject<HTMLElement>, anchor: RefObject<HTMLElement>, settled: boolean) {
  useEffect(() => {
    const request = selection.focus
    const target = heading.current
    if (!settled || !target || request.target !== "heading" || request.symbol !== selection.symbol || !selection.claimFocus(request.tick)) return
    ;(anchor.current ?? target).scrollIntoView?.({ behavior: scrollBehavior(), block: "start" })
    target.focus({ preventScroll: true })
  }, [selection, settled, heading, anchor])
}

/** `capabilities: null` leaves the order-capability badge out (a symbol nothing has verified gets no market-data claim). */
export function DetailHeader({ symbol, name, logoUrl, capabilities, headingRef, headingId }: { symbol: string; name: string; logoUrl: string | null; capabilities: Capabilities | null; headingRef?: RefObject<HTMLHeadingElement>; headingId: string }) {
  return <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
    <div className="flex min-w-0 items-center gap-4">
      <StockLogo symbol={symbol} size={40} apiLogoUrl={logoUrl} />
      <h1 id={headingId} ref={headingRef} tabIndex={-1} className={`min-w-0 break-words rounded-sm text-2xl font-medium leading-[1.05] tracking-[-0.02em] text-[var(--color-arco-ink)] sm:text-[28px] ${FOCUS}`}>{name === symbol ? symbol : <>{name} <span className="text-[var(--color-arco-chip-ink)]">{symbol}</span></>}</h1>
    </div>
    {capabilities ? <StatusBadge symbol={symbol} capabilities={capabilities} /> : null}
  </header>
}

/** "▲ $5.01 (2.81%)": unsigned magnitudes from the provider's change against the previous close; direction by triangle, colour and sr text. */
export function QuoteChange({ quote }: { quote: Quote | null }) {
  const amount = changeParts(quote?.change ?? null), percent = changeParts(quote?.changePercent ?? null)
  const lead = amount ?? percent
  if (!lead) return <span className="text-[var(--color-arco-text-soft)]">—</span>
  const text = amount && percent ? `$${amount.magnitude} (${percent.magnitude}%)` : amount ? `$${amount.magnitude}` : `${percent!.magnitude}%`
  if (lead.direction === "flat") return <span className="text-[var(--color-arco-text-soft)]">{text}</span>
  const up = lead.direction === "up"
  return <span className={`inline-flex items-center gap-1 ${up ? "text-[var(--color-arco-up-text)]" : "text-[var(--color-arco-down)]"}`}><Triangle up={up} /><span className="sr-only">{up ? "상승 " : "하락 "}</span>{text}</span>
}

export function PeriodTabs({ range, onRange }: { range: Range; onRange: (range: Range) => void }) {
  return <div role="group" aria-label="차트 기간" className="inline-flex max-w-full flex-wrap gap-1 rounded bg-[var(--color-arco-chip)] p-0.5">
    {RANGES.map(value => <button type="button" key={value} aria-pressed={range === value} onClick={() => onRange(value)} className={`h-7 min-w-9 rounded px-2 text-sm font-medium ${FOCUS} ${range === value ? "bg-[var(--color-arco-surface)] text-[var(--color-arco-ink)] shadow-[var(--shadow-control)] ring-1 ring-inset ring-[var(--color-arco-ink)]" : "text-[var(--color-arco-chip-ink)] hover:text-[var(--color-arco-ink)]"}`}>{value}</button>)}
  </div>
}

type Quotes = ReadState<Envelope<Quote[]>>
/** Price header (once per symbol; it stays while a range loads), period buttons outside anything keyed by range, then the chart. */
export function PriceCard({ quote, quotes, selection, range, onRange, children }: { quote: Quote | null; quotes: Quotes; selection: ChartSelection | null; range: Range; onRange: (range: Range) => void; children: ReactNode }) {
  const demo = useDemoPresentation()
  const bar = selection?.bar ?? null
  const feed = selection?.feedDelay ?? (quotes.phase === "ready" ? quotes.value.feedDelay : "UNKNOWN")
  return <section aria-label="시세와 차트" className={`${CARD} space-y-5`}>
    <div className="space-y-2" aria-live="polite" aria-atomic="true">
      <p className="text-sm text-[var(--color-arco-chip-ink)]">{demo ? "Price · USD" : selection ? `${selection.interval} 구간 종가 · 시각은 봉 시작` : "기초 주식 시세 · USD"}</p>
      <p title={dollars(bar?.close ?? quote?.price ?? null)} className="break-all text-[40px] font-medium leading-[1.05] tracking-[-0.03em] tabular-nums text-[var(--color-arco-ink)] sm:text-5xl">{priceLabel(bar?.close ?? quote?.price ?? null)}</p>
      {/* Hidden (not removed) while a bar is picked: the change is against the previous close, not the picked bar. */}
      <p className={`flex flex-wrap items-center gap-x-1.5 text-sm ${selection ? "invisible" : ""}`}><QuoteChange quote={quote} /><span className="text-[var(--color-arco-chip-ink)]">전일 종가 대비</span></p>
      <p className="text-xs text-[var(--color-arco-text-soft)]">{time(bar?.timestamp ?? quote?.sourceTimestamp ?? null)}<DemoDetails> · {FEED_LABELS[feed]}</DemoDetails></p>
    </div>
    {/* This symbol's own quote status (STALE included), or the envelope's when the response has no row for it. Not the envelope's
        when a row exists: one stale symbol marks the whole envelope STALE. Shown whatever state the chart below is in. */}
    {quotes.phase !== "ready" ? <Status status={quotes.phase} /> : (quote?.status ?? quotes.value.status) !== "AVAILABLE" ? <Status status={quote?.status ?? quotes.value.status} /> : null}
    <PeriodTabs range={range} onRange={onRange} />
    {children}
  </section>
}

type StatRow = { label: string; value: ReactNode; title?: string; wrap?: boolean }
function StatList({ rows }: { rows: StatRow[] }) {
  if (!rows.length) return null
  return <dl className="min-w-0 border-t border-[var(--color-arco-border)]">{rows.map(row => <div key={row.label} className="flex min-h-10 items-center justify-between gap-4 border-b border-[var(--color-arco-border)] py-2 last:border-b-0">
    <dt className="shrink-0 text-sm text-[var(--color-arco-chip-ink)]">{row.label}</dt>
    <dd title={row.title} className={`min-w-0 text-right text-sm text-[var(--color-arco-ink)] ${row.wrap ? "flex flex-wrap justify-end gap-1" : "truncate"}`}>{row.value}</dd>
  </div>)}</dl>
}
const KIND = { STOCK: "주식", ETF: "ETF" } as const
function categories(curated: CuratedStock | null, securityType: string | null): string[] {
  const parts = [curated ? KIND[curated.kind] : null, curated?.detail === "LEVERAGED_OR_INVERSE" ? "레버리지·인버스" : curated?.detail === "ADS" ? "ADS" : null, securityType]
  // The provider's type can repeat the curated kind (ETF · ETF): each label once.
  return [...new Set(parts.filter((item): item is string => Boolean(item)))]
}
function host(url: string): string { try { return new URL(url).host } catch { return url } }

function Description({ text }: { text: string }) {
  const id = useId()
  const body = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  // A static render cannot measure; long text starts with the control and layout corrects it.
  const [overflows, setOverflows] = useState(() => text.length > 160)
  useIsomorphicLayoutEffect(() => {
    const element = body.current
    if (!element || expanded) return
    const measure = () => { if (element.clientHeight > 0) setOverflows(element.scrollHeight > element.clientHeight + 1) }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text, expanded])
  return <div>
    <p ref={body} id={id} className={`text-sm leading-[1.32] text-[var(--color-arco-text)] ${expanded ? "" : "line-clamp-2"}`}>{text}</p>
    {(overflows || expanded) && <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)} className={`mt-1 rounded-sm text-sm font-medium text-[var(--color-arco-ink)] underline underline-offset-2 ${FOCUS}`}>{expanded ? "Show Less" : "Show More"}</button>}
  </div>
}

/** About: description (2 lines, expandable) and the facts the contract carries. A row without a value is left out. */
export function AboutCard({ security, profile }: { security: Security; profile: ReadState<Envelope<Profile>> }) {
  const demo = useDemoPresentation()
  const id = useId()
  const data = profile.phase === "ready" ? profile.value.data : null
  const curated = curatedStock(security.symbol)
  const name = data?.name ?? security.name
  const kinds = categories(curated, data?.securityType ?? null)
  const exchange = data?.exchange ?? security.exchange ?? null
  const isin = security.isin ?? curated?.isin ?? null
  const candidates: (StatRow | null)[] = [
    { label: "Underlying Asset Name", value: name, title: name },
    { label: "Underlying Asset Ticker", value: security.symbol },
    kinds.length ? { label: "Category", value: kinds.map(kind => <span key={kind} className="inline-flex h-5 items-center rounded-full bg-[var(--color-arco-chip)] px-1.5 text-xs font-medium text-[var(--color-arco-chip-ink)]">{kind}</span>), title: kinds.join(" · "), wrap: true } : null,
    exchange ? { label: "Exchange", value: exchange } : null,
    data?.industry ? { label: "Industry", value: data.industry, title: data.industry } : null,
    data?.website ? { label: "Website", value: <a href={data.website} target="_blank" rel="noopener noreferrer" className={`rounded-sm underline-offset-2 hover:underline ${FOCUS}`}>{host(data.website)}<span className="sr-only"> (새 창)</span></a>, title: data.website } : null,
    isin ? { label: "ISIN", value: isin } : null,
  ]
  const rows = candidates.filter((row): row is StatRow => row !== null)
  const half = Math.ceil(rows.length / 2)
  return <section aria-labelledby={id} className={CARD}>
    <h2 id={id} className="text-2xl font-medium leading-[1.05] tracking-[-0.01em] text-[var(--color-arco-ink)]">About</h2>
    {/* "No provider description" only for a profile that loaded; loading, failed and unavailable reads say so in the status below. */}
    <DemoDetails>{data && (data.description ? <div className="mt-3"><Description key={data.description} text={data.description} /></div> : <p className="mt-3 text-sm text-[var(--color-arco-text-soft)]">공급자 설명 없음</p>)}</DemoDetails>
    <div className="mt-3 grid grid-cols-1 md:grid-cols-2 md:gap-x-6 lg:grid-cols-1 2xl:grid-cols-2"><StatList rows={rows.slice(0, half)} /><StatList rows={rows.slice(half)} /></div>
    {demo && (profile.phase !== "ready" || profile.value.status !== "AVAILABLE") ? <Status status={profile.phase === "ready" ? profile.value.status : profile.phase} /> : null}
    <DemoDetails><section aria-label="기업정보 상태" className="mt-4 space-y-1 text-xs text-[var(--color-arco-text-soft)]">
      <p role="status">{profile.phase === "loading" ? "기업정보 불러오는 중…" : profile.phase === "error" ? "기업정보를 불러올 수 없습니다" : profile.value.status === "STALE" ? "기업정보 · 마지막 확인 정보 · 오래된 데이터" : profile.value.status === "UNCONFIGURED" ? "기업정보 연결 준비 중" : profile.value.status === "UNAVAILABLE" ? "기업정보를 불러올 수 없습니다" : "기업정보 · 공급자 참조 데이터"}</p>
      {profile.phase === "ready" && data && <p>기업정보 최근 수집: {time(profile.value.fetchedAt)} · 공급자 기준일: {data.sourceDate ?? "미확인"}. 시세 관측 시각과 별개입니다.</p>}
    </section></DemoDetails>
  </section>
}

function StatGroup({ title, qualifier, rows, note }: { title: string; qualifier?: string; rows: StatRow[]; note?: string }) {
  return <div className="min-w-0">
    <h3 className="flex min-h-10 flex-wrap items-baseline gap-x-1.5 border-b border-[var(--color-arco-border)] py-2.5 text-base font-medium text-[var(--color-arco-ink)]">{title}{qualifier && <span className="text-sm text-[var(--color-arco-chip-ink)]">{qualifier}</span>}</h3>
    <StatList rows={rows} />
    <DemoDetails>{note && <p className="mt-1 text-xs text-[var(--color-arco-text-soft)]">{note}</p>}</DemoDetails>
  </div>
}
const price = (value: string | null): Pick<StatRow, "value" | "title"> => ({ value: priceLabel(value), title: value === null ? undefined : dollars(value) })
/**
 * Statistics: open/high/low of the rolling 24 hours come only from a loaded AVAILABLE 1D chart (the same series the list's
 * sparkline uses); the quote supplies previous close and session volume, the profile the market cap. Missing values are "—".
 */
export function StatisticsCard({ symbol, quote, quotes, profile, day }: { symbol: string; quote: Quote | null; quotes: Quotes; profile: ReadState<Envelope<Profile>>; day: Chart | null }) {
  const id = useId()
  const span = day ? barRange(day) : null
  const marketCap = profile.phase === "ready" ? profile.value.data?.marketCap ?? null : null
  const feed = FEED_LABELS[quotes.phase === "ready" ? quotes.value.feedDelay : "UNKNOWN"]
  return <section aria-labelledby={id} className={CARD}>
    <h2 id={id} className="text-2xl font-medium leading-[1.05] tracking-[-0.01em] text-[var(--color-arco-ink)]">Statistics</h2>
    <div className="mt-3 grid grid-cols-1 gap-y-4 md:grid-cols-2 md:gap-x-6 lg:grid-cols-1 2xl:grid-cols-2">
      <StatGroup title="Underlying Asset Price" qualifier="24H" rows={[{ label: "Open", ...price(span?.open ?? null) }, { label: "High", ...price(span?.high ?? null) }, { label: "Low", ...price(span?.low ?? null) }]} note={span ? `최근 24시간(rolling) · 반환된 1D ${day!.interval} 봉의 첫 시가·최고가·최저가${day!.history === "TRUNCATED" ? " · 일부 구간만 반환된 기준" : ""}` : "현재 1D 차트 관측값(봉 2개 이상)이 있을 때만 표시합니다."} />
      <StatGroup title="Underlying Asset Statistics" rows={[{ label: "Total Market Cap", value: compactDollars(marketCap), title: marketCap === null ? undefined : dollars(marketCap) }, { label: "세션 거래량", title: quotes.phase === "ready" && quotes.value.provider === "ALPACA" ? marketSourceLabel(quotes.value) : undefined, value: quote?.sessionVolume == null ? "—" : `${exact(quote.sessionVolume)} 주` }, { label: "전일 종가", ...price(quote?.previousClose ?? null) }]} />
    </div>
    <DemoDetails><div className="mt-4 space-y-1 text-xs text-[var(--color-arco-text-soft)]">
      <p>Massive · {feed} · 시세 관측: {time(quote?.sourceTimestamp ?? null)}. 주식 시세·기업 시가총액은 ARCO 토큰 가격·유동성·보유량이 아닙니다.</p>
      {symbol === "NVDA" && <p>NVDA 모의 주문은 주문 패널에서 진행합니다. 표시 시세는 체결에 사용하지 않습니다.</p>}
    </div></DemoDetails>
  </section>
}

export type SecurityDetailViewProps = {
  security: Security
  profile: ReadState<Envelope<Profile>>
  quote: Quote | null
  quotes: Quotes
  capabilities: Capabilities
  /** This symbol's current 1D series (AVAILABLE, 2+ bars), if the detail has loaded one. */
  day: Chart | null
  range: Range
  onRange: (range: Range) => void
  selection: ChartSelection | null
  chart: ReactNode
  headingRef?: RefObject<HTMLHeadingElement>
}
export function SecurityDetailView({ security, profile, quote, quotes, capabilities, day, range, onRange, selection, chart, headingRef }: SecurityDetailViewProps) {
  const headingId = useId()
  const data = profile.phase === "ready" ? profile.value.data : null
  return <article aria-labelledby={headingId} className="min-w-0 space-y-4">
    <DetailHeader symbol={security.symbol} name={data?.name ?? security.name} logoUrl={data?.logoUrl ?? null} capabilities={capabilities} headingRef={headingRef} headingId={headingId} />
    <PriceCard quote={quote} quotes={quotes} selection={selection} range={range} onRange={onRange}>{chart}</PriceCard>
    <AboutCard security={security} profile={profile} />
    <StatisticsCard symbol={security.symbol} quote={quote} quotes={quotes} profile={profile} day={day} />
  </article>
}

export function SecurityDetail({ client, security, quote, quotes, capabilities, day, onSeries, selection, anchor }: { client: MarketClient; security: Security; quote: Quote | null; quotes: Quotes; capabilities: Capabilities; day: Chart | null; onSeries: (symbol: string, chart: Chart | null) => void; selection: StocksSelection; anchor: RefObject<HTMLElement> }) {
  const [range, setRange] = useState<Range>("1D")
  const [picked, setPicked] = useState<ChartSelection | null>(null)
  const load = useCallback((signal: AbortSignal) => client.profile(security.symbol, signal), [client, security.symbol])
  const profile = useOwnedRead(security.symbol, load)
  const heading = useRef<HTMLHeadingElement>(null)
  useDetailFocus(selection, heading, anchor, true)
  return <SecurityDetailView security={security} profile={profile} quote={quote} quotes={quotes} capabilities={capabilities} day={day} range={range} onRange={value => { setPicked(null); setRange(value) }} selection={picked} headingRef={heading}
    chart={<ChartRead key={JSON.stringify([client.baseUrl, security.symbol, range])} client={client} name={security.symbol} range={range} onSeries={onSeries} onSelection={setPicked} />} />
}

function ChartRead({ client, name, range, onSeries, onSelection }: { client: MarketClient; name: string; range: Range; onSeries: (symbol: string, chart: Chart | null) => void; onSelection: (selection: ChartSelection | null) => void }) {
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
  return chart.phase === "ready" ? <MarketChart response={chart.value} onSelection={onSelection} /> : <div className="flex min-h-[220px] items-center sm:min-h-[300px]"><Status status={chart.phase} /></div>
}

/** Without a ready market catalog only NVDA (the tradable symbol) and the curated 40 count as known market-data securities. */
export function knownWithoutCatalog(symbol: string): boolean { return symbol === "NVDA" || curatedStock(symbol) !== null }

/**
 * The market catalog is loading, failed or has no data: the header still names the symbol; the order panel is unaffected.
 * A symbol that is neither NVDA nor curated is unverified here: no order-capability badge and a neutral line, never a claim
 * that it is a supported market-data security.
 */
export function UnavailableDetail({ symbol, status, capabilities, selection, anchor, settled }: { symbol: string; status: ReactNode; capabilities: Capabilities; selection: StocksSelection; anchor: RefObject<HTMLElement>; settled: boolean }) {
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const known = knownWithoutCatalog(symbol)
  useDetailFocus(selection, heading, anchor, settled)
  return <article aria-labelledby={headingId} className="min-w-0 space-y-4">
    <DetailHeader symbol={symbol} name={curatedStock(symbol)?.name ?? symbol} logoUrl={null} capabilities={known ? capabilities : null} headingRef={heading} headingId={headingId} />
    <section aria-label="시세와 차트" className={`${CARD} space-y-2`}>{status}{known ? null : <p className="text-sm text-[var(--color-arco-text-soft)]">{symbol}은 아직 시장정보 목록에서 확인되지 않은 종목입니다.</p>}</section>
  </article>
}

/** A syntactically valid symbol the server catalog does not list (and not NVDA): nothing is requested for it. */
export function NotFoundDetail({ symbol, selection, anchor }: { symbol: string; selection: StocksSelection; anchor: RefObject<HTMLElement> }) {
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  useDetailFocus(selection, heading, anchor, true)
  return <article aria-labelledby={headingId} className={CARD}>
    <h1 id={headingId} ref={heading} tabIndex={-1} className={`rounded-sm text-2xl font-medium text-[var(--color-arco-ink)] ${FOCUS}`}>종목을 찾을 수 없습니다</h1>
    <p className="mt-2 text-sm text-[var(--color-arco-text-soft)]">{symbol}은 서버 시장정보 목록에 없는 종목입니다. 목록에서 종목을 선택하세요.</p>
    <button type="button" onClick={selection.closeDetail} className={`mt-4 inline-flex h-9 items-center rounded-lg border border-[var(--color-arco-border)] px-3 text-sm font-medium text-[var(--color-arco-ink)] ${FOCUS}`}>목록으로</button>
  </article>
}
