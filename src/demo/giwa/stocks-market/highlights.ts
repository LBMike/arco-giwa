import type { Catalog, Quote, Security } from "./contracts"
import { CURATED_STOCKS } from "./curated"
import { volumeDollars } from "./display"
import { scaled } from "./validate"

export type HighlightRow = { security: Security; quote: Quote | null }
export type HighlightGroups = { gainers: HighlightRow[]; trending: HighlightRow[]; newlyAdded: HighlightRow[] }

// The September 19 catalog expansion (c6c097f) added these securities together;
// NVDA was already the pilot. Within that one batch, retain the curated order.
// This is product-listing history, not exchange IPO dates or reverse market rank.
// Add future batches here newest first; never infer listing dates from quotes.
const LISTING_BATCHES: readonly (readonly string[])[] = [CURATED_STOCKS.filter(row => row.symbol !== "NVDA").map(row => row.symbol)]
const EMPTY: readonly Quote[] = []

/** Only securities in the active server catalog can appear; stale/missing quotes cannot rank. */
export function stockHighlights(catalog: Catalog | null, quotes: readonly Quote[] = EMPTY): HighlightGroups {
  const bySymbol = new Map(quotes.filter(quote => quote.status === "AVAILABLE").map(quote => [quote.symbol, quote]))
  const rows = [...new Map((catalog?.securities ?? []).map(security => [security.symbol, security])).values()]
    .map(security => ({ security, quote: bySymbol.get(security.symbol) ?? null }))
  const gainers = rows.filter(row => row.quote?.price != null && row.quote.changePercent != null && scaled(row.quote.changePercent) > 0n)
    .sort((a, b) => descending(scaled(a.quote!.changePercent!), scaled(b.quote!.changePercent!)) || tie(a, b)).slice(0, 3)
  const trending = rows.map(row => ({ row, volume: volumeDollars(row.quote?.price ?? null, row.quote?.sessionVolume ?? null) }))
    .filter((item): item is { row: HighlightRow; volume: string } => item.volume !== null && scaled(item.volume) > 0n)
    .sort((a, b) => descending(scaled(a.volume), scaled(b.volume)) || tie(a.row, b.row)).slice(0, 3).map(item => item.row)
  const active = new Map(rows.map(row => [row.security.symbol, row]))
  const newlyAdded = [...new Set(LISTING_BATCHES.flat())].flatMap(symbol => {
    const row = active.get(symbol)
    return row ? [row] : []
  }).slice(0, 3)
  return { gainers, trending, newlyAdded }
}
function descending(a: bigint, b: bigint) { return a === b ? 0 : a > b ? -1 : 1 }
function tie(a: HighlightRow, b: HighlightRow) { return (a.security.rank ?? Infinity) - (b.security.rank ?? Infinity) || a.security.symbol.localeCompare(b.security.symbol) }
