// Get ArcoUSD: a stablecoin converts to ArcoUSD one for one, and ArcoUSD back to a stablecoin. A converter on GIWA
// takes each coin: its deposit mints ArcoUSD for the coin, its instant redemption pays the coin back for ArcoUSD. The
// app is given the converters (ArcoUsdConvertContext, savings-routes.ts); without them there is no Get ArcoUSD. Only the
// demo wallet's chain has them so far.
//
// Leaf module (type-only imports, and the leaf savings-assets.ts): the investor shell preview's demo routes load it
// before the page's fetch guard.

import { SAVINGS_ASSET_OPTIONS, savingsOptionKey, type SavingsAssetChoice, type SavingsAssetOption } from "./savings-assets"
import type { GiwaCatalogItem, HexAddress } from "./types"

/** ArcoUSD on GIWA: what a conversion gives, or takes back. */
export const ARCOUSD_OPTION: SavingsAssetOption = SAVINGS_ASSET_OPTIONS.find((option) => option.key === savingsOptionKey("ArcoUSD", "giwa"))!

/** The coins that convert to ArcoUSD and back: every Savings stablecoin but ArcoUSD itself, in their listed order. */
export const CONVERT_OPTIONS: readonly SavingsAssetOption[] = SAVINGS_ASSET_OPTIONS.filter((option) => option.key !== ARCOUSD_OPTION.key)

export type ArcoUsdConverter = Readonly<{
  /** The coin's option key ("usdt-ethereum"). */
  option: string
  /** The coin's token on GIWA. */
  token: HexAddress
  /** Mints ArcoUSD for the coin (deposit) and pays the coin back for ArcoUSD (instant redemption). */
  converter: HexAddress
}>

export type ArcoUsdConvert = Readonly<{
  /** The ArcoUSD token. 18 decimals, as the operation hook reads the token a vault mints. */
  token: HexAddress
  /** Prices every conversion at one for one. */
  priceFeed: HexAddress
  converters: readonly ArcoUsdConverter[]
}>

/** in: a stablecoin to ArcoUSD. out: ArcoUSD back to a stablecoin. */
export type ConvertDirection = "in" | "out"

export function converterFor(convert: ArcoUsdConvert, option: string): ArcoUsdConverter | null {
  return convert.converters.find((entry) => entry.option === option) ?? null
}

/** The coin a conversion starts on: USDC on GIWA, the wallet's own chain, when it has a converter; else the first that has one. */
export function defaultConvertOption(convert: ArcoUsdConvert): SavingsAssetOption {
  const home = CONVERT_OPTIONS.find((option) => option.key === savingsOptionKey("USDC", "giwa"))
  if (home !== undefined && converterFor(convert, home.key) !== null) return home
  return CONVERT_OPTIONS.find((option) => converterFor(convert, option.key) !== null) ?? CONVERT_OPTIONS[0]!
}

/**
 * The conversion as the operation hook runs it, a vault of its own: the coin is the payment asset, ArcoUSD the token it
 * mints, and the converter both its deposit and its redemption vault, priced one for one.
 */
export function convertProduct(convert: ArcoUsdConvert, option: SavingsAssetOption, converter: ArcoUsdConverter): GiwaCatalogItem {
  return {
    productId: `arcousd-convert-${option.key}`,
    symbol: ARCOUSD_OPTION.symbol,
    name: ARCOUSD_OPTION.name,
    paymentAssetSymbol: option.symbol,
    paymentAsset: { symbol: option.symbol, name: option.name, decimals: option.decimals, tokenAddress: converter.token },
    paymentAssetAddress: converter.token,
    productTokenAddress: convert.token,
    depositVaultAddress: converter.converter,
    redemptionVaultAddress: converter.converter,
    priceFeedAddress: convert.priceFeed,
    vaultConfig: null,
    pauseState: null,
  }
}

/** The token picker's rows for a conversion, with the wallet's balance of each (null: unknown). */
export type ConvertBalances = Readonly<Record<string, number | null>>

/**
 * The coins a conversion can start from (the coin side's picker lists ArcoUSD as well, last: picking it turns the
 * conversion around), each available while it has a converter, ArcoUSD while any coin has one. One ArcoUSD is a dollar,
 * as is each stablecoin.
 */
export function convertChoices(convert: ArcoUsdConvert, balances: ConvertBalances, withArcoUsd: boolean): SavingsAssetChoice[] {
  const options = withArcoUsd ? [...CONVERT_OPTIONS, ARCOUSD_OPTION] : CONVERT_OPTIONS
  return options.map((option) => {
    const available = option.key === ARCOUSD_OPTION.key ? convert.converters.length > 0 : converterFor(convert, option.key) !== null
    const balance = available ? (balances[option.key] ?? null) : null
    return { ...option, available, balance, usd: balance }
  })
}
