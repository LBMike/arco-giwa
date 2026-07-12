import { vaultConfigOf } from "./catalog"
import { parseAumToNumber } from "./display-profile"
import { marketApyText } from "./price-policy"
import type { GiwaCatalogItem } from "./types"
import type { GiwaMarketEntry } from "./api"

// One entry in the Savings "accounts" selector. `disabled` marks a coming-soon dummy (RLUSD):
// displayed but non-selectable, no detail. `vault` is the mapped saving vault a REAL entry opens
// (null for a dummy). `apy` is a display string formatted by marketApyText so real (live) and dummy
// (static) read identically.
export type SavingsAccount = {
  key: string
  symbol: string
  icon: string | null
  apy: string
  disabled: boolean
  vault: GiwaCatalogItem | null
  // The OWNING saving vault's productId (where this asset is configured) — always set, incl. dummies
  // (whose `vault` is null). Used to address the asset when saving the global order.
  vaultId: string
  // Global cross-vault display order (null = unset → trails). Drives the stable sort below.
  sortOrder: number | null
}

// Aggregate the Savings-page selector list from the catalog + market. Iterate CURRENTLY saving
// vaults (kind==="saving") in (pinned → AUM desc → productId) order, then each vault's acceptAssets
// in stored (intra-vault index) order. A dummy is KEPT as a disabled card (static APY). A REAL asset
// is included only when its savingVaultId still points at a saving vault — a stale/dormant map (its
// vault was flipped to product, or a raw-API cross-map) is skipped so a product vault can never open
// on the Savings page. Its APY is read LIVE from the mapped vault. Order across vaults is the global
// selector order.
export function buildSavingsAccounts(catalog: GiwaCatalogItem[], market: GiwaMarketEntry[]): SavingsAccount[] {
  const savingVaults = catalog.filter((product) => vaultConfigOf(product).kind === "saving")
  const savingVaultIds = new Set(savingVaults.map((product) => product.productId))
  const marketById = new Map(market.map((entry) => [entry.productId, entry]))

  const ordered = [...savingVaults].sort((a, b) => {
    const ca = vaultConfigOf(a)
    const cb = vaultConfigOf(b)
    if (ca.pinned !== cb.pinned) return ca.pinned ? -1 : 1
    // AUM desc, unparseable/absent AUM sorts last.
    const aumA = parseAumToNumber(ca.aum) ?? -Infinity
    const aumB = parseAumToNumber(cb.aum) ?? -Infinity
    if (aumA !== aumB) return aumB - aumA
    return a.productId.localeCompare(b.productId)
  })

  const accounts: SavingsAccount[] = []
  for (const vault of ordered) {
    for (const asset of vaultConfigOf(vault).acceptAssets ?? []) {
      if (asset.isDummy) {
        accounts.push({
          key: `dummy:${vault.productId}:${asset.symbol}`,
          symbol: asset.symbol,
          icon: asset.icon,
          apy: marketApyText({ apy: asset.apy, impliedApy: null }),
          disabled: true,
          vault: null,
          vaultId: vault.productId,
          sortOrder: asset.sortOrder ?? null,
        })
        continue
      }
      // Real: skip a dangling/stale map (savingVaultId is not currently a saving vault). The Set
      // membership guarantees the subsequent find succeeds, so no separate absent-vault branch.
      if (asset.savingVaultId == null || !savingVaultIds.has(asset.savingVaultId)) continue
      const target = savingVaults.find((product) => product.productId === asset.savingVaultId)!
      accounts.push({
        key: `real:${asset.savingVaultId}:${asset.symbol}`,
        symbol: asset.symbol,
        icon: asset.icon,
        apy: marketApyText(marketById.get(asset.savingVaultId) ?? null),
        disabled: false,
        vault: target,
        vaultId: vault.productId,
        sortOrder: asset.sortOrder ?? null,
      })
    }
  }
  // Stable-sort the flat list by the global sortOrder: explicit orders lead ascending; unset (null)
  // trails in the derivation order above (Array.sort is stable, and equal keys — incl. both unset —
  // return 0 so their relative order is preserved). Behavior is unchanged until an order is set.
  return accounts.sort((a, b) => {
    const av = a.sortOrder ?? Infinity
    const bv = b.sortOrder ?? Infinity
    return av === bv ? 0 : av - bv
  })
}

// Default selection = the first enabled (real) account, or null when nothing is configured yet
// (no saving vaults, or only dummies) — the page renders a graceful empty state.
export function defaultSavingsSelection(accounts: SavingsAccount[]): SavingsAccount | null {
  return accounts.find((account) => !account.disabled) ?? null
}
