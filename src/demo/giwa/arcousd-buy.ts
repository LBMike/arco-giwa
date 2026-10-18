import { getAddress, isAddress } from "viem"
import { assetLabel } from "./asset-label"
import { vaultConfigOf } from "./catalog"
import type { GiwaArcoUSDReserve, GiwaCatalogItem, HexAddress } from "./types"

// Fund buys through the ArcoRouter (docs/specs/arcousd-v1.md §3.12): pay with any Reserve
// stablecoin or ArcoUSD; the Router turns it into the fund's payment token from the Reserve
// buffer. Pure helpers only (no React, no wallet), so the panel, the hook and tests share them.
//
// A product buys through the Router only when ALL hold: it is a fund (not a Savings vault), the
// ArcoUSD API reports a Router, and the product is one the Router may buy. Anything else keeps
// the existing direct vault deposit, unchanged.

/** Product owner's fixed copy (English) for a closed buy gate. */
export const RESERVE_REFILL_NOTICE = "Purchases are temporarily paused while the reserve refills."

const BPS = 10_000n

export type PayAssetOption = {
  /** Lowercase address: stable key for the selector. */
  readonly key: string
  readonly symbol: string
  /** What the screen shows (tUSDC → USDC, tUSDT → USDT, tRLUSD → RLUSD). */
  readonly label: string
  readonly address: HexAddress
  readonly decimals: number
  /** Reserve deposit swap fee; 0 for the base asset and for ArcoUSD itself. */
  readonly swapFeeBps: number
  readonly isArcoUSD: boolean
}

export type FundBuyRoute =
  | { readonly kind: "direct" }
  | {
      readonly kind: "router"
      readonly router: HexAddress
      readonly payAssets: readonly PayAssetOption[]
      /** The buy gate is closed: every buy of this fund is blocked (RESERVE_REFILL_NOTICE). */
      readonly gateClosed: boolean
    }

const DIRECT: FundBuyRoute = { kind: "direct" }

export function payAssetLabel(symbol: string): string {
  if (symbol === "tUSDT") return "USDT"
  if (symbol === "tRLUSD") return "RLUSD"
  return assetLabel(symbol)
}

export function isFundProduct(product: Pick<GiwaCatalogItem, "productId" | "vaultConfig">): boolean {
  return vaultConfigOf(product).kind !== "saving"
}

function checksum(value: string | null | undefined): HexAddress | null {
  return typeof value === "string" && isAddress(value) ? (getAddress(value) as HexAddress) : null
}

/**
 * How `product` is bought now. The pay assets are the Reserve's deposit-enabled assets (the
 * fund's own payment asset first) and ArcoUSD last. A fund that routes but whose reserve read
 * failed has no pay assets and a closed gate: it cannot be bought until the read recovers.
 */
export function fundBuyRoute(
  product: Pick<GiwaCatalogItem, "productId" | "vaultConfig" | "paymentAssetAddress">,
  reserve: GiwaArcoUSDReserve | null | undefined,
): FundBuyRoute {
  if (!reserve || !isFundProduct(product)) return DIRECT
  const router = checksum(reserve.contracts?.router)
  if (!router || !reserve.contracts?.routerProducts.includes(product.productId)) return DIRECT
  const own = product.paymentAssetAddress?.toLowerCase() ?? null
  const stablecoins: PayAssetOption[] = []
  for (const asset of reserve.reserve?.assets ?? []) {
    const address = checksum(asset.address)
    if (!address || !asset.depositEnabled) continue
    stablecoins.push({
      key: address.toLowerCase(),
      symbol: asset.symbol,
      label: payAssetLabel(asset.symbol),
      address,
      decimals: asset.decimals,
      swapFeeBps: asset.swapFeeBps,
      isArcoUSD: false,
    })
  }
  stablecoins.sort((a, b) => Number(b.key === own) - Number(a.key === own)) // stable: keeps Reserve order otherwise
  const arcoUSD = checksum(reserve.contracts?.arcoUSD)
  const payAssets =
    stablecoins.length && arcoUSD
      ? [...stablecoins, { key: arcoUSD.toLowerCase(), symbol: "ArcoUSD", label: "ArcoUSD", address: arcoUSD, decimals: 18, swapFeeBps: 0, isArcoUSD: true }]
      : stablecoins
  return { kind: "router", router, payAssets, gateClosed: reserve.gate.status !== "open" || payAssets.length === 0 }
}

/** The selected pay asset, falling back to the first option (the fund's own payment asset). */
export function selectedPayAsset(route: FundBuyRoute, key: string | null): PayAssetOption | null {
  if (route.kind !== "router") return null
  return route.payAssets.find((asset) => asset.key === key) ?? route.payAssets[0] ?? null
}

export type RouterBuyQuote = {
  /** ArcoUSD the Router receives after the deposit swap fee (base18). */
  readonly arcoUSDIn: bigint
  /** Swap fee in the pay asset's own units (0 for the base asset and ArcoUSD). */
  readonly feeInPayAsset: bigint
  /** The fund's payment token settled into the vault (its units, rounded down). */
  readonly paymentAmount: bigint
}

/**
 * Mirrors ArcoRouter.quoteBuy / ArcoUSDReserve.deposit: gross = pay × 10^(18−dec); fee is taken
 * in base18 (floor); the payment token gets floor((gross − fee) / 10^(18−paymentDec)).
 */
export function routerBuyQuote(payAmount: bigint, payAsset: Pick<PayAssetOption, "decimals" | "swapFeeBps" | "isArcoUSD">, paymentDecimals: number): RouterBuyQuote {
  if (payAmount <= 0n) return { arcoUSDIn: 0n, feeInPayAsset: 0n, paymentAmount: 0n }
  const scale = 10n ** BigInt(18 - payAsset.decimals)
  const gross = payAmount * scale
  const fee = payAsset.isArcoUSD ? 0n : (gross * BigInt(payAsset.swapFeeBps)) / BPS
  const arcoUSDIn = gross - fee
  return {
    arcoUSDIn,
    feeInPayAsset: fee / scale,
    paymentAmount: arcoUSDIn / 10n ** BigInt(18 - paymentDecimals),
  }
}

/** "0.1%" for 10 bps; "No fee" for 0. */
export function swapFeeText(bps: number): string {
  if (!(bps > 0)) return "No fee"
  const percent = bps / 100
  return `${Number(percent.toFixed(2))}%`
}

/** Pay amount after the swap fee, as a number for the price quote ("You receive"). */
export function amountAfterSwapFee(amount: number, swapFeeBps: number): number {
  if (!Number.isFinite(amount)) return Number.NaN
  return amount * (1 - Math.max(0, swapFeeBps) / 10_000)
}
