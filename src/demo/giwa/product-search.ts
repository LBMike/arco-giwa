import { productById } from "../data/products"
import type { GiwaMarketEntry } from "./api"
import { vaultConfigOf, vaultDisplayName, vaultImageFor } from "./catalog"
import { fundsProductsOf } from "./home"
import { marketApyText } from "./price-policy"
import { giwaProductPath, giwaSavingsPath, GIWA_SAVINGS_ROUTE, GIWA_STOCKS_ROUTE } from "./routes"
import { buildSavingsAccounts } from "./savings"
import { stockLogoPath } from "./stocks-market/curated"
import type { Quote, Security } from "./stocks-market/contracts"
import type { GiwaCatalogItem } from "./types"

export const SEARCH_CATEGORIES = ["All", "Savings", "Funds", "Stocks"] as const
export type SearchCategory = typeof SEARCH_CATEGORIES[number]
export type SearchProduct = {
  id: string; category: Exclude<SearchCategory, "All">; symbol: string; name: string
  image?: string; href: string; keywords: string; value: string; change?: string; negative?: boolean
}
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })
export function buildSearchProducts(catalog: GiwaCatalogItem[], market: GiwaMarketEntry[], stocks: Security[], quotes: Quote[] = []): SearchProduct[] {
  const visible = catalog.filter(product => !vaultConfigOf(product).hidden)
  const markets = new Map(market.map(entry => [entry.productId, entry]))
  const prices = new Map(quotes.map(quote => [quote.symbol, quote]))
  return [
    ...buildSavingsAccounts(visible, market).map(account => ({
      id: `savings:${account.key}`, category: "Savings" as const, symbol: account.symbol,
      name: `${account.symbol} Savings`, image: account.icon ?? undefined,
      href: account.disabled ? GIWA_SAVINGS_ROUTE : giwaSavingsPath(account.symbol, account.key),
      keywords: `${account.symbol} ${account.vault?.name ?? ""} savings 저축`,
      value: account.disabled ? "Coming soon" : `${account.apy} APY`,
    })),
    ...fundsProductsOf(visible).map(product => ({
      id: `fund:${product.productId}`, category: "Funds" as const, symbol: vaultDisplayName(product),
      name: product.name, image: vaultImageFor(product), href: giwaProductPath(product.productId),
      keywords: `${product.productId} ${product.symbol} ${product.name} ${vaultDisplayName(product)} ${vaultConfigOf(product).assetManagerName ?? ""} funds 펀드`,
      value: `${marketApyText({ apy: markets.get(product.productId)?.apy ?? productById(product.productId)?.apy ?? null, impliedApy: markets.get(product.productId)?.impliedApy ?? null })} APY`,
    })),
    ...stocks.map(stock => {
      const quote = prices.get(stock.symbol)
      const available = quote?.status === "AVAILABLE"
      const change = available && quote.changePercent != null ? Number(quote.changePercent) : null
      return {
        id: `stock:${stock.symbol}`, category: "Stocks" as const, symbol: stock.symbol, name: stock.name,
        image: stockLogoPath(stock.symbol) ?? undefined, href: `${GIWA_STOCKS_ROUTE}?symbol=${encodeURIComponent(stock.symbol)}`,
        keywords: `${stock.symbol} ${stock.name} ${stock.isin ?? ""} stocks 주식 ETF`,
        value: available && quote.price != null ? `$${number.format(Number(quote.price))}` : "—",
        change: change == null ? undefined : `${change > 0 ? "+" : ""}${number.format(change)}%`, negative: change != null && change < 0,
      }
    }),
  ]
}
export function filterSearchProducts(products: SearchProduct[], query: string, category: SearchCategory): SearchProduct[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return products.filter(product => (category === "All" || product.category === category) && words.every(word => product.keywords.toLocaleLowerCase().includes(word)))
}
