import type { Envelope, Quote } from "./contracts"
import { time } from "./display"

export function MarketFreshness({ response }: { response: Envelope<Quote[]> }) {
  if (response.provider !== "ALPACA") return null
  const latest = response.data?.reduce<string | null>((value, quote) => quote.sourceTimestamp && (!value || quote.sourceTimestamp > value) ? quote.sourceTimestamp : value, null) ?? null
  return <p className="text-xs text-[var(--color-arco-text-soft)]" title="Prices and volume are from the IEX exchange. The last trade time can differ by symbol. Volume (USD) is estimated as price × shares.">
    Alpaca · {response.marketFeed} · checked every 30 seconds · last trade: {time(latest)}
  </p>
}
