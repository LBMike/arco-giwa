import { isRetiredProduct, vaultConfigOf } from "./catalog"
import { buildSavingsAccounts, type SavingsAccount } from "./savings"
import type { GiwaCatalogItem } from "./types"
import type { GiwaMarketEntry } from "./api"

// Pure helpers for the Home page summaries. They derive from the same catalog/market data as the
// Funds and Savings pages, so Home never shows a count those pages would not.

// Same predicate as the Funds page list (Investor.tsx): hidden vaults are investor declutter,
// saving vaults live on the Savings page only, and retired vaults are no longer offered.
export function fundsProductsOf(catalog: GiwaCatalogItem[]): GiwaCatalogItem[] {
  return catalog.filter(
    (product) => !vaultConfigOf(product).hidden && vaultConfigOf(product).kind !== "saving" && !isRetiredProduct(product),
  )
}

export type HomeSavingsSummary = {
  // Selectable accounts on the Savings page, in its selector order.
  accounts: SavingsAccount[]
  // Disabled "coming soon" entries the Savings page also lists.
  comingSoon: number
}

export function homeSavingsSummary(catalog: GiwaCatalogItem[], market: GiwaMarketEntry[]): HomeSavingsSummary {
  const all = buildSavingsAccounts(catalog, market)
  return {
    accounts: all.filter((account) => !account.disabled),
    comingSoon: all.filter((account) => account.disabled).length,
  }
}

export function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}
