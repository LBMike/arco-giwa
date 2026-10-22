// The app's Get ArcoUSD and sArcoUSD Savings account on the live ArcoUSD v1 contracts (docs/specs/arcousd-v1.md), built
// from the public API's reads (/api/v1/arcousd/reserve and /savings). The screens stay the ones the demo chain drives;
// only what they are handed changes:
//
// - Get ArcoUSD: one converter per Reserve stablecoin, all of them the Reserve (deposit mints ArcoUSD for the coin,
//   redeemInstantOnly pays the coin back for ArcoUSD).
// - Savings: the sArcoUSD account takes the stablecoin account's place on the Savings page (the `arcousd` vault it
//   replaces keeps its product page). Its own coin is USDC on GIWA; USDT, RLUSD and ArcoUSD on GIWA reach it as routes.
//   Every coin goes through the Savings Zap: Zap.deposit and an Instant-only Zap.redeem.
//
// Pure: no React, no wallet, so the provider, the pages and tests share it.

import { getAddress, isAddress } from "viem"
import { ARCOUSD_OPTION, type ArcoUsdConvert, type ArcoUsdConverter } from "./arcousd-convert"
import { nativeSavingsOption, savingsOptionKey, type SavingsAssetOption, type SavingsRoute } from "./savings-assets"
import type { GiwaMarketEntry, GiwaPriceHistory } from "./api"
import type { ProductOperation } from "./operation-routing"
import type {
  GiwaArcoUSDReserve,
  GiwaArcoUSDSavings,
  GiwaArcoUSDSavingsHistory,
  GiwaArcoUSDTransport,
  GiwaCatalogItem,
  GiwaPauseState,
  HexAddress,
} from "./types"

const BPS = 10_000

/** The sArcoUSD Savings account's productId (its own: queries keyed by product never mix it with the vault it replaces). */
export const LIVE_SAVINGS_PRODUCT_ID = "sarcousd"
/** The Savings vault the sArcoUSD account takes the place of on the Savings page. */
export const REPLACED_SAVINGS_PRODUCT_ID = "arcousd"

/** A Reserve stablecoin, as the picker lists it. */
export type ArcoUsdLiveAsset = Readonly<{
  option: SavingsAssetOption
  token: HexAddress
  /** The contract's symbol (tUSDC). */
  symbol: string
  decimals: number
  depositEnabled: boolean
  redeemEnabled: boolean
  /** Charged on a deposit (bps). */
  swapFeeBps: number
  /** Charged on an Instant withdrawal, on top of the swap fee (bps). */
  instantFeeBps: number
  /** The Reserve's free buffer in this coin (its balance less what the queue is owed), in the coin. */
  available: number
}>

export type ArcoUsdLiveSavings = Readonly<{
  sArcoUSD: HexAddress
  zap: HexAddress
  /** ArcoUSD per sArcoUSD. */
  sharePrice: number
  /**
   * The rate the account shows, in percent: the one being paid while a distribution vests, else the distributor's
   * yearly cap (what a distribution pays once the Reserve's surplus covers it).
   */
  apyPercent: number | null
  /** The rate being paid now, in percent (0 between distributions): what the balance grows at. */
  paidApyPercent: number | null
  depositsOpen: boolean
  withdrawalsOpen: boolean
}>

export type ArcoUsdLive = Readonly<{
  arcoUSD: HexAddress
  reserve: HexAddress
  assets: readonly ArcoUsdLiveAsset[]
  /** Deposits stop everywhere (a Reserve pause, its deposit switch, ArcoUSD paused or not minting). */
  depositPaused: boolean
  /** Withdrawals stop everywhere (a Reserve pause, its redeem or redeemInstantOnly switch, ArcoUSD paused or not burning). */
  redeemPaused: boolean
  /** Null until sArcoUSD is live and seeded. */
  savings: ArcoUsdLiveSavings | null
}>

function checksum(value: string | null | undefined): HexAddress | null {
  return typeof value === "string" && isAddress(value) ? (getAddress(value) as HexAddress) : null
}

function finiteNumber(value: string): number | null {
  const parsed = Number(value)
  return value.trim() !== "" && Number.isFinite(parsed) ? parsed : null
}

/** What a fee leaves of an amount: 1 − bps. */
function kept(bps: number): number {
  return 1 - bps / BPS
}

/**
 * The live contracts and their state, or null while the Reserve is not live. A Reserve coin the picker has no row for,
 * or whose decimals differ from that row's, is left out (its amounts would be read in the wrong unit).
 */
export function arcoUsdLive(reserve: GiwaArcoUSDReserve | null | undefined, savings: GiwaArcoUSDSavings | null | undefined): ArcoUsdLive | null {
  if (!reserve || reserve.status !== "live" || !reserve.contracts || !reserve.reserve) return null
  const arcoUSD = checksum(reserve.contracts.arcoUSD)
  const reserveAddress = checksum(reserve.contracts.reserve)
  if (!arcoUSD || !reserveAddress) return null
  const state = reserve.reserve
  const assets: ArcoUsdLiveAsset[] = []
  for (const asset of state.assets) {
    const option = nativeSavingsOption(asset.symbol)
    const token = checksum(asset.address)
    const available = finiteNumber(asset.availableHuman)
    if (option === null || token === null || available === null || option.decimals !== asset.decimals) continue
    if (option.key === ARCOUSD_OPTION.key) continue
    assets.push({
      option,
      token,
      symbol: asset.symbol,
      decimals: asset.decimals,
      depositEnabled: asset.depositEnabled,
      redeemEnabled: asset.redeemEnabled,
      swapFeeBps: asset.swapFeeBps,
      instantFeeBps: asset.instantFeeBps,
      available: Math.max(0, available),
    })
  }
  return {
    arcoUSD,
    reserve: reserveAddress,
    assets,
    depositPaused: state.reservePaused || state.depositPaused || state.arcoUSDPaused || state.arcoUSDMintPaused,
    // The app withdraws with redeemInstantOnly, which follows the redeem switch and its own.
    redeemPaused:
      state.reservePaused || state.redeemPaused === true || state.redeemInstantOnlyPaused === true || state.arcoUSDPaused || state.arcoUSDBurnPaused,
    savings: liveSavings(savings, arcoUSD),
  }
}

function liveSavings(savings: GiwaArcoUSDSavings | null | undefined, arcoUSD: HexAddress): ArcoUsdLiveSavings | null {
  if (!savings || savings.status !== "live" || !savings.contracts || !savings.savings || !savings.savings.seeded) return null
  const sArcoUSD = checksum(savings.contracts.sArcoUSD)
  const zap = checksum(savings.contracts.zap)
  const sharePrice = finiteNumber(savings.savings.sharePriceHuman)
  // The Savings read must name the same ArcoUSD as the Reserve read.
  if (!sArcoUSD || !zap || sharePrice === null || !(sharePrice > 0) || checksum(savings.contracts.arcoUSD) !== arcoUSD) return null
  const apyBps = savings.savings.currentApyBps
  const paidApyPercent = Number.isFinite(apyBps) ? apyBps / 100 : null
  return {
    sArcoUSD,
    zap,
    sharePrice,
    apyPercent: paidApyPercent !== null && paidApyPercent > 0 ? paidApyPercent : (capApyPercent(savings.savings) ?? paidApyPercent),
    paidApyPercent,
    depositsOpen: savings.savings.depositsOpen,
    withdrawalsOpen: savings.savings.withdrawalsOpen,
  }
}

/**
 * The distributor's yearly cap as an APY (compounded daily, like the paid rate), in percent; null when distributions
 * cannot run (the distributor, the Reserve, ArcoUSD minting or sArcoUSD rewards paused) or an older API leaves it out.
 */
function capApyPercent(state: NonNullable<GiwaArcoUSDSavings["savings"]>): number | null {
  const distributor = state.distributor
  if (!distributor || distributor.paused || distributor.reservePaused || distributor.arcoUSDMintPaused || state.rewardsPaused) return null
  const aprBps = distributor.maxAprBps
  if (!Number.isFinite(aprBps) || aprBps <= 0) return null
  return dailyCompoundedPercent(aprBps)
}

/** A yearly rate (bps) compounded daily, in percent: the server's dailyCompoundedBps (whole basis points) / 100. */
function dailyCompoundedPercent(aprBps: number): number {
  if (!(aprBps > 0)) return 0
  return Math.round((Math.pow(1 + aprBps / BPS / 365, 365) - 1) * BPS) / 100
}

/**
 * What a withdrawal in a coin can pay at once, in the coin: the Reserve checks its free buffer against the payout before
 * fees, so the most it pays after them is the buffer less those fees.
 */
export function instantPayable(asset: Pick<ArcoUsdLiveAsset, "available" | "swapFeeBps" | "instantFeeBps">): number {
  return asset.available * kept(asset.instantFeeBps + asset.swapFeeBps)
}

/** A stablecoin's way in and out of the Reserve, paused with the Reserve's switches and the coin's own. */
function coinPause(live: ArcoUsdLive, asset: ArcoUsdLiveAsset): Pick<GiwaPauseState, "depositPaused" | "withdrawPaused"> {
  return { depositPaused: live.depositPaused || !asset.depositEnabled, withdrawPaused: live.redeemPaused || !asset.redeemEnabled }
}

/** Through the Zap in a stablecoin: closed when Savings is, or when the Reserve leg is. */
function savingsCoinPause(live: ArcoUsdLive, savings: ArcoUsdLiveSavings, asset: ArcoUsdLiveAsset): Pick<GiwaPauseState, "depositPaused" | "withdrawPaused"> {
  const coin = coinPause(live, asset)
  return { depositPaused: !savings.depositsOpen || coin.depositPaused, withdrawPaused: !savings.withdrawalsOpen || coin.withdrawPaused }
}

/** The Reserve as a coin's converter: a deposit keeps the coin less its swap fee, a withdrawal pays less both fees. */
export function reserveTransport(asset: Pick<ArcoUsdLiveAsset, "swapFeeBps" | "instantFeeBps">): GiwaArcoUSDTransport {
  return { kind: "reserve", depositPrice: 1 / kept(asset.swapFeeBps), redeemPrice: kept(asset.instantFeeBps + asset.swapFeeBps) }
}

/** The Zap for a coin (null fees: ArcoUSD itself, which the Zap takes and pays as it is): sArcoUSD at its share price. */
export function zapTransport(sharePrice: number, fees: Pick<ArcoUsdLiveAsset, "swapFeeBps" | "instantFeeBps"> | null): GiwaArcoUSDTransport {
  const swap = fees?.swapFeeBps ?? 0
  const instant = fees?.instantFeeBps ?? 0
  return { kind: "zap", depositPrice: sharePrice / kept(swap), redeemPrice: sharePrice * kept(instant + swap) }
}

/** Get ArcoUSD on the Reserve: a converter for every coin it takes or pays; null when there is none. */
export function liveConvert(live: ArcoUsdLive): ArcoUsdConvert | null {
  const converters: ArcoUsdConverter[] = live.assets
    .filter((asset) => asset.depositEnabled || asset.redeemEnabled)
    .map((asset) => ({
      option: asset.option.key,
      token: asset.token,
      converter: live.reserve,
      arcoUSD: reserveTransport(asset),
      instantLiquidity: instantPayable(asset),
      pauseState: coinPause(live, asset),
    }))
  return converters.length > 0 ? { token: live.arcoUSD, priceFeed: null, converters } : null
}

const USDC_ON_GIWA = savingsOptionKey("USDC", "giwa")

/**
 * The sArcoUSD account in the place of `base` (the `arcousd` vault): the account's settings (tabs, accept-assets, copy)
 * stay; its coin is USDC on GIWA and its contracts the Zap and sArcoUSD. Null until Savings is live and USDC is a Reserve
 * coin.
 */
export function liveSavingsVault(base: GiwaCatalogItem, live: ArcoUsdLive): GiwaCatalogItem | null {
  const savings = live.savings
  const usdc = live.assets.find((asset) => asset.option.key === USDC_ON_GIWA)
  if (savings === null || usdc === undefined) return null
  return {
    ...base,
    productId: LIVE_SAVINGS_PRODUCT_ID,
    symbol: "sArcoUSD",
    name: "sArcoUSD",
    paymentAssetSymbol: usdc.symbol,
    paymentAsset: { symbol: usdc.symbol, name: usdc.option.name, decimals: usdc.decimals, tokenAddress: usdc.token },
    paymentAssetAddress: usdc.token,
    productToken: undefined,
    productTokenAddress: savings.sArcoUSD,
    depositVault: undefined,
    depositVaultAddress: savings.zap,
    redemptionVault: undefined,
    redemptionVaultAddress: savings.zap,
    priceFeed: undefined,
    priceFeedAddress: null,
    activationFlags: undefined,
    deploymentBlock: undefined,
    pauseState: savingsCoinPause(live, savings, usdc),
    arcoUSD: zapTransport(savings.sharePrice, usdc),
  }
}

/** The sArcoUSD account's other coins on GIWA: each Reserve stablecoin but USDC, and ArcoUSD, all through the Zap. */
export function liveSavingsRoutes(live: ArcoUsdLive): SavingsRoute[] {
  const savings = live.savings
  if (savings === null) return []
  const routes: SavingsRoute[] = live.assets
    .filter((asset) => asset.option.key !== USDC_ON_GIWA && (asset.depositEnabled || asset.redeemEnabled))
    .map((asset) => ({
      vault: LIVE_SAVINGS_PRODUCT_ID,
      option: asset.option.key,
      token: asset.token,
      depositVault: savings.zap,
      redemptionVault: savings.zap,
      arcoUSD: zapTransport(savings.sharePrice, asset),
      instantLiquidity: instantPayable(asset),
      pauseState: savingsCoinPause(live, savings, asset),
    }))
  // ArcoUSD in and out of sArcoUSD needs no Reserve buffer and no Reserve switch.
  routes.push({
    vault: LIVE_SAVINGS_PRODUCT_ID,
    option: ARCOUSD_OPTION.key,
    token: live.arcoUSD,
    depositVault: savings.zap,
    redemptionVault: savings.zap,
    arcoUSD: zapTransport(savings.sharePrice, null),
    instantLiquidity: null,
    pauseState: { depositPaused: !savings.depositsOpen, withdrawPaused: !savings.withdrawalsOpen },
  })
  return routes
}

/** What a withdrawal from the sArcoUSD account in its own coin (USDC) can pay at once, from the Reserve's free USDC. */
export function liveSavingsOwnLiquidity(live: ArcoUsdLive): number | null {
  const usdc = live.assets.find((asset) => asset.option.key === USDC_ON_GIWA)
  return usdc !== undefined ? instantPayable(usdc) : null
}

/**
 * The allowance an operation on ArcoUSD v1 needs besides a deposit's: an Instant withdrawal hands the product token
 * (ArcoUSD or sArcoUSD) back to the contract that pays it (the Reserve or the Zap), which pulls it. Null otherwise (a
 * deposit's coin allowance is the operation hook's usual one; a vault pair burns its shares itself).
 */
export function withdrawalApproval(
  product: Pick<GiwaCatalogItem, "arcoUSD" | "productTokenAddress" | "redemptionVaultAddress">,
  operation: ProductOperation,
): Readonly<{ token: HexAddress | null; spender: HexAddress | null }> | null {
  if (!product.arcoUSD || operation !== "redeemInstant") return null
  return { token: product.productTokenAddress, spender: product.redemptionVaultAddress }
}

/** The sArcoUSD account as the market read describes a vault: share price in ArcoUSD (a dollar each), the paid rate. */
export function liveSavingsMarket(savings: ArcoUsdLiveSavings): GiwaMarketEntry {
  return {
    productId: LIVE_SAVINGS_PRODUCT_ID,
    navBase: savings.sharePrice,
    baseUsd: 1,
    navUsd: savings.sharePrice,
    apy: savings.apyPercent,
    impliedApy: null,
  }
}

/**
 * The savings indexer's history as a vault's price history: the share price, and the rate being paid at each snapshot
 * (compounded daily, like the shown APY), which the APY chart plots as it is. Snapshots are minutes apart, too close to
 * read a yearly rate from the share price between them.
 */
export function liveSavingsHistory(history: GiwaArcoUSDSavingsHistory | null | undefined): GiwaPriceHistory | undefined {
  if (!history || history.status !== "live") return undefined
  const points = history.points.flatMap((point) => {
    const t = Math.floor(Date.parse(point.takenAt) / 1000)
    const price = finiteNumber(point.sharePrice)
    if (!Number.isFinite(t) || price === null || !(price > 0)) return []
    return Number.isFinite(point.aprBps) ? [{ t, navBase: price, navUsd: price, apy: dailyCompoundedPercent(point.aprBps) }] : [{ t, navBase: price, navUsd: price }]
  })
  return {
    productId: LIVE_SAVINGS_PRODUCT_ID,
    apy: history.realizedApyBps !== null ? history.realizedApyBps / 100 : null,
    points,
  }
}
