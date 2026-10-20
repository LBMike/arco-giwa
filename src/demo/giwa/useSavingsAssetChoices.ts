// The token picker's rows for one Savings vault: every coin option, whether the vault can take it (its own coin, or a
// coin it has a route for), and the connected wallet's balance of it. Balances share the operation hook's query keys
// (useGiwaProductOperation's payment balance), so a transfer refreshes the picker and the Savings card with them.

import { useQueries } from "@tanstack/react-query"
import { readTokenBalance } from "./contracts"
import { nativeSavingsOption, routeFor, SAVINGS_ASSET_OPTIONS, type SavingsAssetChoice, type SavingsRoute } from "./savings-assets"
import type { GiwaCatalogItem, HexAddress } from "./types"

/** Null for a vault that takes no stablecoin (it keeps its single coin and no picker). */
export function useSavingsAssetChoices(
  vault: GiwaCatalogItem,
  routes: readonly SavingsRoute[],
  account: HexAddress | null,
  usdPerCoin: number | null,
): SavingsAssetChoice[] | null {
  const native = nativeSavingsOption(vault.paymentAssetSymbol)
  const sources =
    native === null
      ? []
      : SAVINGS_ASSET_OPTIONS.map((option) => {
          const own = option.key === native.key
          const token = own ? vault.paymentAssetAddress : (routeFor(routes, vault, option.key)?.token ?? null)
          const decimals = own ? (vault.paymentAsset?.decimals ?? option.decimals) : option.decimals
          return { option, token, decimals }
        })
  const balances = useQueries({
    queries: sources.map(({ token, decimals }) => ({
      queryKey: ["giwa", "payment-balance-one", account, token],
      queryFn: () => readTokenBalance(token!, account!, decimals),
      enabled: Boolean(account && token),
    })),
  })
  if (native === null) return null
  return sources.map(({ option, token }, index) => {
    const raw = balances[index]?.data
    const parsed = raw != null ? Number(raw) : null
    const balance = parsed !== null && Number.isFinite(parsed) ? parsed : null
    return {
      ...option,
      available: token !== null,
      balance: token !== null ? balance : null,
      usd: token !== null && balance !== null && usdPerCoin !== null ? balance * usdPerCoin : null,
    }
  })
}
