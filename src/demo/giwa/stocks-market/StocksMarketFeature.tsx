import { useCallback, useMemo, useState } from "react"
import type { MarketClient } from "./client"
import type { Catalog, Envelope, Quote, Range, Security } from "./contracts"
import { RANGES } from "./contracts"
import { dollars, exact, priceLabel, FEED_LABELS, time } from "./display"
import { MarketChart } from "./MarketChart"
import { useOwnedRead } from "./useOwnedRead"
const button = "rounded-lg border border-[var(--color-arco-border)] px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
function Status({ status }: { status: string }) { return <p role="status" className="text-sm text-[var(--color-arco-text-soft)]">{status === "loading" ? "시장정보 불러오는 중…" : status === "UNCONFIGURED" ? "시세 연결 준비 중" : status === "STALE" ? "마지막 확인 시세 · 오래된 데이터" : "시세를 불러올 수 없습니다"}</p> }
export function StocksMarketFeature({ client }: { client: MarketClient | null }) {
  if (!client) return <section aria-label="Stocks market" className="w-full rounded-2xl bg-[var(--color-arco-surface)] p-6"><h1 className="text-2xl">Stocks</h1><p role="status" className="mt-3">시장정보 API 연결 준비 중</p></section>
  return <MarketOwner key={client.baseUrl} client={client} />
}
function MarketOwner({ client }: { client: MarketClient }) {
  const load = useCallback((signal: AbortSignal) => client.catalog(signal), [client])
  const catalog = useOwnedRead(client.baseUrl, load)
  return <section aria-label="Stocks market" className="w-full min-w-0 rounded-2xl bg-[var(--color-arco-surface)] p-4 sm:p-6">
    <header className="mb-6"><p className="text-xs text-[var(--color-arco-text-soft)]">MARKETS · DISPLAY ONLY</p><h1 className="mt-1 text-3xl font-medium">Stocks</h1><p className="mt-2 text-sm text-[var(--color-arco-text-soft)]">기초 미국 주식·ETF 시장정보. 모의 주문의 체결가는 아래 주문 섹션에서 별도로 확인하세요.</p></header>
    {catalog.phase !== "ready" ? <Status status={catalog.phase} /> : catalog.value.data ? <MarketCatalog key={JSON.stringify(catalog.value.data.securities.map(item => item.symbol))} client={client} response={catalog.value as Envelope<Catalog> & { data: Catalog }} /> : <Status status={catalog.value.status} />}
  </section>
}
function MarketCatalog({ client, response }: { client: MarketClient; response: Envelope<Catalog> & { data: Catalog } }) {
  const catalog = response.data
  const [selected, setSelected] = useState(catalog.securities[0].symbol)
  const names = useMemo(() => catalog.securities.map(item => item.symbol), [catalog])
  const load = useCallback((signal: AbortSignal) => client.quotes(names, signal), [client, names])
  const quotes = useOwnedRead(JSON.stringify([client.baseUrl, names]), load)
  const bySymbol = new Map(quotes.phase === "ready" ? (quotes.value.data ?? []).map(item => [item.symbol, item]) : [])
  const active = catalog.securities.find(item => item.symbol === selected)!
  return <>
    <p className="mb-4 text-xs text-[var(--color-arco-text-soft)]">{catalog.provenance.verification === "PILOT" ? "NVDA 파일럿 목록 · 40종목 선정 완료를 의미하지 않습니다." : `서버 선정 목록 · ${catalog.securities.length}종목 · ${catalog.provenance.verification}`} {catalog.provenance.asOfDate ? `선정 기준일 ${catalog.provenance.asOfDate}` : "선정 기준일 미확인"}</p>
    <div className="grid min-w-0 gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
      <nav aria-label="시장정보 종목" className="flex max-h-80 min-w-0 flex-col gap-2 overflow-auto lg:max-h-[640px]">{catalog.securities.map(item => <button key={item.symbol} type="button" onClick={() => setSelected(item.symbol)} aria-pressed={selected === item.symbol} className={`${button} flex items-center justify-between gap-3 text-left ${selected === item.symbol ? "bg-[var(--color-arco-chip)] font-medium" : "bg-[var(--color-arco-surface)]"}`}><span className="min-w-0"><span className="block">{item.symbol}</span><span className="block truncate text-xs text-[var(--color-arco-text-soft)]">{item.name}</span></span><span title={dollars(bySymbol.get(item.symbol)?.price ?? null)} className="shrink-0 text-right font-mono text-xs">{priceLabel(bySymbol.get(item.symbol)?.price ?? null)}</span></button>)}</nav>
      <div className="min-w-0">
        {quotes.phase !== "ready" ? <Status status={quotes.phase} /> : <><p className="mb-2 text-xs text-[var(--color-arco-text-soft)]">Massive · {FEED_LABELS[quotes.value.feedDelay]}</p>{quotes.value.status !== "AVAILABLE" && <Status status={quotes.value.status} />}</>}
        <SecurityDetail key={JSON.stringify([client.baseUrl, active.symbol])} client={client} security={active} quote={bySymbol.get(active.symbol) ?? null} />
      </div>
    </div>
  </>
}
function SecurityDetail({ client, security, quote }: { client: MarketClient; security: Security; quote: Quote | null }) {
  const [range, setRange] = useState<Range>("1D")
  const load = useCallback((signal: AbortSignal) => client.profile(security.symbol, signal), [client, security.symbol])
  const profile = useOwnedRead(security.symbol, load)
  const data = profile.phase === "ready" ? profile.value.data : null
  const [logoFailed, setLogoFailed] = useState(false)
  return <article className="min-w-0 space-y-5">
    <header className="flex items-center gap-3 pt-3">{data?.logoUrl && !logoFailed ? <img src={data.logoUrl} alt="" referrerPolicy="no-referrer" crossOrigin="anonymous" onError={() => setLogoFailed(true)} className="size-10 rounded-lg object-contain" /> : <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-arco-chip)] text-lg">{security.symbol[0]}</span>}<div className="min-w-0"><h2 className="text-xl font-medium">{data?.name ?? security.name} <span className="text-sm text-[var(--color-arco-text-soft)]">{security.symbol}</span></h2><p className="text-xs text-[var(--color-arco-text-soft)]">{data?.exchange ?? security.exchange ?? "거래소 미확인"} · {data?.securityType ?? "유형 미확인"}</p></div></header>
    <div role="group" aria-label="차트 기간" className="flex flex-wrap gap-2">{RANGES.map(value => <button type="button" key={value} aria-pressed={range === value} className={`${button} ${range === value ? "bg-[var(--color-arco-ink)] text-[var(--color-arco-on-dark)]" : "bg-[var(--color-arco-surface)]"}`} onClick={() => setRange(value)}>{value}</button>)}</div>
    <ChartRead key={JSON.stringify([client.baseUrl, security.symbol, range])} client={client} name={security.symbol} range={range} quote={quote} />
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
function ChartRead({ client, name, range, quote }: { client: MarketClient; name: string; range: Range; quote: Quote | null }) {
  const load = useCallback((signal: AbortSignal) => client.chart(name, range, signal), [client, name, range])
  const chart = useOwnedRead(JSON.stringify([client.baseUrl, name, range]), load)
  return chart.phase === "ready" ? <MarketChart response={chart.value} quote={quote} /> : <div className="min-h-64"><Status status={chart.phase} /></div>
}
