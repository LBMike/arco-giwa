// The coins a Savings deposit can be paid in, and a withdrawal paid out in, each on the chains it is issued on. A
// vault's contracts take one of them: its own coin (USDC on GIWA for the stablecoin account). Any other coin reaches
// the vault through a route that converts it on the way in and out, when the app has one (SavingsRoutesContext);
// without a route an option is listed as coming soon.
//
// Leaf module (type-only imports): the investor shell preview's demo wallet loads it before the page's fetch guard.

import type { GiwaCatalogItem, HexAddress } from "./types"

export type SavingsChainId = "ethereum" | "xrpl" | "giwa"

export const SAVINGS_CHAINS: readonly Readonly<{ id: SavingsChainId; name: string }>[] = [
  { id: "ethereum", name: "Ethereum" },
  { id: "xrpl", name: "XRPL" },
  { id: "giwa", name: "GIWA" },
]

export function chainName(chain: SavingsChainId): string {
  return SAVINGS_CHAINS.find((entry) => entry.id === chain)?.name ?? chain
}

export type SavingsCoin = Readonly<{ symbol: string; name: string; logo: string; decimals: number; chains: readonly SavingsChainId[] }>

/**
 * The stablecoins, each on the chains it is issued on: USDC on Ethereum and GIWA (not on XRPL), USDT only on Ethereum,
 * RLUSD on Ethereum and XRPL, ArcoUSD on GIWA.
 * The Stablecoins tab stacks them in this order (SavingsTabs.tsx).
 */
export const SAVINGS_COINS: readonly SavingsCoin[] = [
  { symbol: "USDC", name: "USD Coin", logo: "/logos/usdc.svg", decimals: 6, chains: ["ethereum", "giwa"] },
  { symbol: "USDT", name: "Tether USD", logo: "/logos/usdt.png", decimals: 6, chains: ["ethereum"] },
  { symbol: "RLUSD", name: "Ripple USD", logo: "/logos/rlusd.png", decimals: 18, chains: ["ethereum", "xrpl"] },
  // 18 decimals: ArcoUSD is also what a conversion mints (arcousd-convert.ts), read as the operation hook reads a token.
  { symbol: "ArcoUSD", name: "Arco USD", logo: "/logos/arcousd.png", decimals: 18, chains: ["giwa"] },
]

/** One coin on one chain: a row of the token picker. */
export type SavingsAssetOption = Readonly<{
  /** "usdt-ethereum" */
  key: string
  symbol: string
  name: string
  logo: string
  decimals: number
  chain: SavingsChainId
  chainName: string
}>

export const savingsOptionKey = (symbol: string, chain: SavingsChainId) => `${symbol.toLowerCase()}-${chain}`

export const SAVINGS_ASSET_OPTIONS: readonly SavingsAssetOption[] = SAVINGS_COINS.flatMap((coin) =>
  coin.chains.map((chain) => ({
    key: savingsOptionKey(coin.symbol, chain),
    symbol: coin.symbol,
    name: coin.name,
    logo: coin.logo,
    decimals: coin.decimals,
    chain,
    chainName: chainName(chain),
  })),
)

/** The option a vault's own coin is (USDC on GIWA for a vault paid in tUSDC); null for a vault that takes no stablecoin. */
export function nativeSavingsOption(paymentAssetSymbol: string): SavingsAssetOption | null {
  // The GIWA test assets carry a "t" (tUSDC is USDC), as reserveAssetLabel in savings-backing.ts reads them.
  const coin = paymentAssetSymbol.replace(/^t(?=[A-Z])/, "")
  return SAVINGS_ASSET_OPTIONS.find((option) => option.chain === "giwa" && option.symbol === coin) ?? null
}

/**
 * How a coin other than a vault's own reaches that vault: the coin's token, and the route's deposit and redemption
 * contracts on GIWA, which convert it on the way in and out. The share token, the price and the product stay the vault's.
 */
export type SavingsRoute = Readonly<{
  /** The vault's productId. */
  vault: string
  /** The option's key ("usdt-ethereum"). */
  option: string
  token: HexAddress
  depositVault: HexAddress
  redemptionVault: HexAddress
}>

export function routeFor(routes: readonly SavingsRoute[], vault: Pick<GiwaCatalogItem, "productId">, option: string): SavingsRoute | null {
  return routes.find((route) => route.vault === vault.productId && route.option === option) ?? null
}

/** The vault as paid through a route: its product, share token and price; the route's coin and contracts. */
export function productThroughRoute(vault: GiwaCatalogItem, option: SavingsAssetOption, route: SavingsRoute): GiwaCatalogItem {
  return {
    ...vault,
    paymentAssetSymbol: option.symbol,
    paymentAssetAddress: route.token,
    paymentAsset: { symbol: option.symbol, name: option.name, decimals: option.decimals, tokenAddress: route.token },
    depositVaultAddress: route.depositVault,
    redemptionVaultAddress: route.redemptionVault,
  }
}

/**
 * The coin a transfer uses: the one picked, while the vault can take it (its own coin, or one it has a route for);
 * otherwise the vault's own. Null for a vault that takes no stablecoin (it keeps its single coin).
 */
export function chosenSavingsOption(
  vault: Pick<GiwaCatalogItem, "productId" | "paymentAssetSymbol">,
  routes: readonly SavingsRoute[],
  picked: string | null,
): SavingsAssetOption | null {
  const native = nativeSavingsOption(vault.paymentAssetSymbol)
  if (native === null || picked === null || picked === native.key) return native
  const option = SAVINGS_ASSET_OPTIONS.find((entry) => entry.key === picked)
  return option !== undefined && routeFor(routes, vault, option.key) !== null ? option : native
}

/** An option as the picker shows it: whether the vault can take it here, and the wallet's balance of it (null: unknown). */
export type SavingsAssetChoice = SavingsAssetOption &
  Readonly<{
    available: boolean
    balance: number | null
    /** The balance in dollars, or null while unknown. */
    usd: number | null
  }>

export type PickerFilter = Readonly<{ chain: SavingsChainId | "all"; query: string }>

function matches(choice: SavingsAssetChoice, { chain, query }: PickerFilter): boolean {
  if (chain !== "all" && choice.chain !== chain) return false
  const words = query.trim().toLowerCase()
  if (words === "") return true
  return [choice.symbol, choice.name, choice.chainName].some((text) => text.toLowerCase().includes(words))
}

const held = (choice: SavingsAssetChoice) => choice.available && choice.balance !== null && choice.balance > 0

/**
 * The picker's two lists, narrowed to a chain and a search: the coins the wallet holds, the largest first; then the
 * rest in their listed order, the ones the vault can take ahead of those coming soon.
 */
export function pickerSections(
  choices: readonly SavingsAssetChoice[],
  filter: PickerFilter,
): Readonly<{ held: SavingsAssetChoice[]; other: SavingsAssetChoice[] }> {
  const shown = choices.filter((choice) => matches(choice, filter))
  return {
    held: shown.filter(held).sort((a, b) => (b.usd ?? b.balance ?? 0) - (a.usd ?? a.balance ?? 0)),
    other: shown.filter((choice) => !held(choice)).sort((a, b) => Number(b.available) - Number(a.available)),
  }
}

/** The chains the wallet holds a coin on, in the chains' own order (the network menu's "With balance"). */
export function chainsWithBalance(choices: readonly SavingsAssetChoice[]): SavingsChainId[] {
  return SAVINGS_CHAINS.map((chain) => chain.id).filter((id) => choices.some((choice) => choice.chain === id && held(choice)))
}

/** The coins the wallet holds, one per coin across its chains, the largest total first (the Savings card's stack). */
export function heldCoins(choices: readonly SavingsAssetChoice[]): Readonly<{ symbol: string; logo: string; usd: number }>[] {
  const totals = new Map<string, { symbol: string; logo: string; usd: number }>()
  for (const choice of choices) {
    if (!held(choice)) continue
    const entry = totals.get(choice.symbol) ?? { symbol: choice.symbol, logo: choice.logo, usd: 0 }
    entry.usd += choice.usd ?? choice.balance ?? 0
    totals.set(choice.symbol, entry)
  }
  return [...totals.values()].sort((a, b) => b.usd - a.usd)
}

/** What the wallet holds across the coins the vault can take, in dollars; null until one of them is known. */
export function heldUsd(choices: readonly SavingsAssetChoice[]): number | null {
  const known = choices.filter((choice) => choice.available && choice.usd !== null)
  return known.length === 0 ? null : known.reduce((sum, choice) => sum + (choice.usd ?? 0), 0)
}
