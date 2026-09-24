import type { Envelope, Quote } from "./contracts"
import { time } from "./display"

export function MarketFreshness({ response }: { response: Envelope<Quote[]> }) {
  if (response.provider !== "ALPACA") return null
  const latest = response.data?.reduce<string | null>((value, quote) => quote.sourceTimestamp && (!value || quote.sourceTimestamp > value) ? quote.sourceTimestamp : value, null) ?? null
  return <p className="text-xs text-[var(--color-arco-text-soft)]" title="가격과 거래량은 IEX 거래소 기준입니다. 종목별 마지막 거래 시각은 서로 다를 수 있습니다. Volume (USD)는 가격 × 주식 수 추정치입니다.">
    Alpaca · {response.marketFeed} · 30초마다 확인 · 최근 거래: {time(latest)}
  </p>
}
