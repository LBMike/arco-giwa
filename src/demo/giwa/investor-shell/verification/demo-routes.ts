// DEMO ONLY: the routes the demo wallet (?wallet=demo) takes Savings coins through, and Get ArcoUSD's converters. Never
// imported by product code.
//
// The app can take a stablecoin Savings vault only its own coin (USDC on GIWA). For the demo, every other coin option
// (savings-assets.ts) gets a token on the demo chain, named for its coin and chain ("USDT (Ethereum)"), and a pair of
// route vaults that mint and burn the vault's own shares at the vault's price, as a real route would after converting
// the coin. The preview hands the same routes to the pages (SavingsRoutesContext), so the token picker can use them.
//
// ArcoUSD is one token, whichever vault takes it, and Get ArcoUSD mints it: each coin the stablecoin vault takes gets a
// converter (arcousd-convert.ts), handed to the pages as well (ArcoUsdConvertContext).

import { getAddress, keccak256, stringToHex, type Address } from "viem"
import { ARCOUSD_OPTION, CONVERT_OPTIONS, type ArcoUsdConvert, type ArcoUsdConverter } from "../../arcousd-convert"
import { nativeSavingsOption, SAVINGS_ASSET_OPTIONS, type SavingsRoute } from "../../savings-assets"
import type { GiwaProduct } from "../../types"
import { DEMO_FEED_SCALE, type DemoAsset, type DemoProduct } from "./demo-chain"

/** What the demo wallet starts with of each route's coin. */
const ROUTE_START = "10000"

function demoAddress(label: string): Address {
  return getAddress(`0x${keccak256(stringToHex(`arco-demo-route:${label}`)).slice(-40)}`)
}

/** ArcoUSD on the demo chain (18 decimals), and the feed that prices it one for one with each stablecoin. */
export const DEMO_ARCOUSD_TOKEN = demoAddress("ArcoUSD:token")
const DEMO_ARCOUSD_PEG = demoAddress("ArcoUSD:peg")

export type DemoSavingsRoutes = Readonly<{
  /** The routes as demo-chain products (DemoChainConfig.routes). */
  products: readonly DemoProduct[]
  /** The same routes as the pages see them. */
  routes: readonly SavingsRoute[]
}>

/** A route for every coin option other than each stablecoin Savings vault's own. */
export function demoSavingsRoutes(catalog: readonly GiwaProduct[], products: readonly DemoProduct[]): DemoSavingsRoutes {
  const routeProducts: DemoProduct[] = []
  const routes: SavingsRoute[] = []
  for (const item of catalog) {
    if (item.vaultConfig?.kind !== "saving") continue
    const native = nativeSavingsOption(item.paymentAssetSymbol)
    const vault = products.find((product) => product.productId === item.productId)
    if (native === null || vault === undefined) continue
    for (const option of SAVINGS_ASSET_OPTIONS) {
      if (option.key === native.key) continue
      const label = `${item.productId}:${option.key}`
      const token = option.key === ARCOUSD_OPTION.key ? DEMO_ARCOUSD_TOKEN : demoAddress(`${label}:token`)
      const depositVault = demoAddress(`${label}:deposit`)
      const redemptionVault = demoAddress(`${label}:redemption`)
      routeProducts.push({
        ...vault,
        depositVault,
        redemptionVault,
        payment: { address: token, symbol: `${option.symbol} (${option.chainName})`, decimals: option.decimals, faucet: null, start: ROUTE_START },
        baseUsd: 1,
      })
      routes.push({ vault: item.productId, option: option.key, token, depositVault, redemptionVault })
    }
  }
  return { products: routeProducts, routes }
}

export type DemoArcoUsdConvert = Readonly<{
  /** The converters as demo-chain products (DemoChainConfig.converters). */
  products: readonly DemoProduct[]
  /** The same converters as the pages see them. */
  convert: ArcoUsdConvert
}>

/**
 * Get ArcoUSD's converters: one per coin, on the coins the first stablecoin Savings vault takes (its own, and its routes'),
 * each minting ArcoUSD one for one. Null without such a vault.
 */
export function demoArcoUsdConvert(catalog: readonly GiwaProduct[], products: readonly DemoProduct[], savings: DemoSavingsRoutes): DemoArcoUsdConvert | null {
  for (const item of catalog) {
    if (item.vaultConfig?.kind !== "saving") continue
    const native = nativeSavingsOption(item.paymentAssetSymbol)
    const vault = products.find((product) => product.productId === item.productId)
    if (native === null || vault === undefined) continue
    const coinFor = (option: string): DemoAsset | null => {
      if (option === native.key) return vault.payment
      const route = savings.routes.find((entry) => entry.vault === item.productId && entry.option === option)
      return savings.products.find((product) => route !== undefined && product.payment.address === route.token)?.payment ?? null
    }
    const converterProducts: DemoProduct[] = []
    const converters: ArcoUsdConverter[] = []
    for (const option of CONVERT_OPTIONS) {
      const payment = coinFor(option.key)
      if (payment === null) continue
      const converter = demoAddress(`convert:${option.key}`)
      converterProducts.push({
        productId: `arcousd-convert-${option.key}`,
        symbol: `${ARCOUSD_OPTION.symbol} (${ARCOUSD_OPTION.chainName})`,
        token: DEMO_ARCOUSD_TOKEN,
        depositVault: converter,
        redemptionVault: converter,
        priceFeed: DEMO_ARCOUSD_PEG,
        payment,
        answer: DEMO_FEED_SCALE,
        baseUsd: 1,
      })
      converters.push({ option: option.key, token: payment.address, converter })
    }
    return { products: converterProducts, convert: { token: DEMO_ARCOUSD_TOKEN, priceFeed: DEMO_ARCOUSD_PEG, converters } }
  }
  return null
}
