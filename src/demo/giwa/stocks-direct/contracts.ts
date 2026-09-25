// Which contracts a direct trade is sent to. They come from the public catalog, the way Savings and Funds take their
// vaults from the public product catalog, and are checked against what this page already pins: the cash must be the
// platform tUSDC (the only cash a v3 deployment accepts), NVDA's token is the one the catalog publishes, and no two
// roles share an address. Both contracts only ever take from the wallet that calls them (msg.sender).
import type { HexAddress, StocksCatalog } from "../stocks-investor/types"
import { PLATFORM_TUSDC } from "../stocks-wallet/types"

export type DirectContracts = Readonly<{ cashToken: HexAddress; fundingVault: HexAddress; stockToken: HexAddress; redemptionEscrow: HexAddress }>

/** The catalog's direct-trade contracts, or null when this catalog cannot be traded directly (older server, other cash). */
export function directContracts(catalog: StocksCatalog | null): DirectContracts | null {
  const contracts = catalog?.contracts
  if (!catalog || !contracts || catalog.cashSymbol !== "tUSDC") return null
  if (contracts.cashToken !== PLATFORM_TUSDC) return null
  const nvda = catalog.instruments.find((item) => item.symbol === "NVDA")
  if (!nvda || (nvda.tokenAddress !== undefined && nvda.tokenAddress !== contracts.stockToken)) return null
  const all = [contracts.cashToken, contracts.fundingVault, contracts.stockToken, contracts.redemptionEscrow]
  if (new Set(all).size !== all.length || all.some((value) => !/^0x[0-9a-f]{40}$/.test(value))) return null
  return Object.freeze({ ...contracts })
}
