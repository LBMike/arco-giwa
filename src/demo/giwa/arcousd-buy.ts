import { getAddress, isAddress } from "viem"
import { assetLabel } from "./asset-label"
import { vaultConfigOf } from "./catalog"
import { SAVINGS_ASSET_OPTIONS, savingsOptionKey, type SavingsAssetChoice } from "./savings-assets"
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

// The fund invest panel picks its pay asset in the Savings token picker ("Select a token"): a Router pay asset is that
// coin's row on GIWA (tUSDT → "usdt-giwa"); the coins on other chains are listed as coming soon.

/** The token picker row a pay asset is ("usdt-giwa"); null when the picker lists no such coin on GIWA. */
export function payAssetOptionKey(asset: Pick<PayAssetOption, "label">): string | null {
  const key = savingsOptionKey(asset.label, "giwa")
  return SAVINGS_ASSET_OPTIONS.some((option) => option.key === key) ? key : null
}

/** The coin's mark as the token picker shows it ("/logos/usdt.png"); null when the picker does not list the coin. */
export function payAssetLogo(asset: Pick<PayAssetOption, "label">): string | null {
  const key = payAssetOptionKey(asset)
  return SAVINGS_ASSET_OPTIONS.find((option) => option.key === key)?.logo ?? null
}

/** The pay asset a token picker row stands for; null for a row the Router does not take. */
export function payAssetForOption(payAssets: readonly PayAssetOption[], optionKey: string): PayAssetOption | null {
  return payAssets.find((asset) => payAssetOptionKey(asset) === optionKey) ?? null
}

/**
 * The token picker's rows for a Router fund buy: every coin on every chain, the ones the Router takes available with the
 * wallet's balance of them (`balanceOf`, by pay asset key; null while unknown). The pay assets are dollar coins, so the
 * dollar value is the balance.
 */
export function fundPayChoices(
  payAssets: readonly PayAssetOption[],
  balanceOf: (asset: PayAssetOption) => number | null,
): SavingsAssetChoice[] {
  return SAVINGS_ASSET_OPTIONS.map((option) => {
    const asset = payAssetForOption(payAssets, option.key)
    const balance = asset !== null ? balanceOf(asset) : null
    return { ...option, available: asset !== null, balance, usd: balance }
  })
}

function listed(names: readonly string[], last: "or" | "and"): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} ${last} ${names[names.length - 1]}`
}

/**
 * The (?) beside "Stablecoin swap fee": which coins pay it and that it is a third-party infrastructure fee, from the
 * Reserve's own fees.
 */
export function stablecoinSwapFeeTip(payAssets: readonly PayAssetOption[]): string {
  const charged = payAssets.filter((asset) => !asset.isArcoUSD && asset.swapFeeBps > 0)
  const free = payAssets.filter((asset) => asset.isArcoUSD || !(asset.swapFeeBps > 0)).map((asset) => asset.label)
  const whose = "This fee is charged by third-party stablecoin infrastructure."
  if (charged.length === 0) return "No stablecoin currently has a swap fee. A swap fee, when set, is charged by third-party stablecoin infrastructure."
  const sameFee = charged.every((asset) => asset.swapFeeBps === charged[0].swapFeeBps)
  const pays = sameFee
    ? `Paying with ${listed(charged.map((asset) => asset.label), "or")} includes a ${swapFeeText(charged[0].swapFeeBps)} swap fee.`
    : `Paying with ${listed(charged.map((asset) => `${asset.label} (${swapFeeText(asset.swapFeeBps)})`), "or")} includes a swap fee.`
  const none = free.length === 0 ? "" : ` ${listed(free, "and")} ${free.length === 1 ? "has" : "have"} no swap fee.`
  return `${pays}${none} ${whose}`
}

/** The "Stablecoin swap fee" row of the Transaction Fees breakdown: the fee of the coin paid with, and its (?). */
export function stablecoinSwapFee(payAsset: PayAssetOption, payAssets: readonly PayAssetOption[]): { bps: number; help: string } {
  return { bps: payAsset.isArcoUSD ? 0 : Math.max(0, payAsset.swapFeeBps), help: stablecoinSwapFeeTip(payAssets) }
}
