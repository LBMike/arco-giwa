// The gold Savings account on the live ArcoGOLD contracts (server/src/arcogold, docs/operations/arcogold-launch.md),
// built from the public API's reads (/api/v1/arcogold/reserve and /savings). ArcoGOLD is a second instance of the
// sArcoUSD stack in troy ounces, so the account runs on the same screens and the same calls as the sArcoUSD account
// (arcousd-live.ts): Zap.deposit and an Instant-only Zap.redeem, priced by a `zap` transport.
//
// - The account is made here, from the gold deployment: no row in the core catalog or the Vault Config is needed (the
//   core registry has no `arcogold` product, so the Vault Config could not point a coin at one). On the Savings page it
//   takes the place of any gold coin the Vault Config lists (a coming-soon PAXG / XAUT), so it never shows twice.
// - Its own coin is PAXG on GIWA (tPAXG); XAUT (tXAUT) reaches it as a route through the same Zap.
// - Amounts are ounces: 1 tPAXG = 1 tXAUT = 1 ArcoXAU = 1 troy ounce (testnet). Dollars come from the server's ounce
//   price; while it has none the account shows its ounces and no dollar figure.
//
// Pure: no React, no wallet, so the provider, the pages and tests share it.

import { getAddress, isAddress, parseUnits } from "viem"
import { instantPayable, zapTransport } from "./arcousd-live"
import { goldSavingsOption, type SavingsAssetChoice, type SavingsAssetOption, type SavingsRoute } from "./savings-assets"
import type { SavingsAccount } from "./savings"
import { savingsAssetCategory } from "./savings-category"
import type { GiwaMarketEntry } from "./api"
import type { GiwaArcoGoldReserve, GiwaArcoGoldSavings, GiwaCatalogItem, GiwaPauseState, HexAddress } from "./types"

/** The gold account's productId (the id its logo, display APY and APY band are kept under). */
export const GOLD_SAVINGS_PRODUCT_ID = "arcogold"
/** The account's own coin: deposits default to it, the others are routes. */
const OWN_COIN = "PAXG"

/** A gold Reserve coin, as the picker lists it. */
export type ArcoGoldLiveCoin = Readonly<{
  option: SavingsAssetOption
  token: HexAddress
  /** The contract's symbol (tPAXG). */
  symbol: string
  decimals: number
  depositEnabled: boolean
  redeemEnabled: boolean
  swapFeeBps: number
  instantFeeBps: number
  /** The gold Reserve's free buffer in this coin, in the coin (ounces). */
  available: number
}>

export type ArcoGoldLive = Readonly<{
  arcoGOLD: HexAddress
  zap: HexAddress
  coins: readonly ArcoGoldLiveCoin[]
  /** Ounces per ArcoGOLD. */
  sharePrice: number
  /** USD per troy ounce (one coin), null while the server has no price. */
  ounceUsd: number | null
  /** The set display rate, in percent. */
  apyPercent: number | null
  /** The Reserve leg's deposits stop (its pause or deposit switch, the ounce unit paused or not minting). */
  depositPaused: boolean
  /** The Reserve leg's Instant withdrawals stop. */
  redeemPaused: boolean
  depositsOpen: boolean
  withdrawalsOpen: boolean
}>

function checksum(value: string | null | undefined): HexAddress | null {
  return typeof value === "string" && isAddress(value) ? (getAddress(value) as HexAddress) : null
}

function finiteNumber(value: string): number | null {
  const parsed = Number(value)
  return value.trim() !== "" && Number.isFinite(parsed) ? parsed : null
}

/**
 * The live gold account's contracts and state, or null: not deployed, not read yet, a read that failed, a vault not yet
 * seeded, or reads that disagree about the Reserve. A Reserve coin the picker has no gold row for, or whose decimals
 * differ from that row's, is left out (its amounts would be read in the wrong unit).
 */
export function arcoGoldLive(reserve: GiwaArcoGoldReserve | null | undefined, savings: GiwaArcoGoldSavings | null | undefined): ArcoGoldLive | null {
  if (!reserve || reserve.status !== "live" || !reserve.contracts || !reserve.reserve) return null
  if (!savings || savings.status !== "live" || !savings.contracts || !savings.savings || !savings.savings.seeded) return null
  const arcoGOLD = checksum(savings.contracts.arcoGOLD)
  const zap = checksum(savings.contracts.zap)
  const reserveAddress = checksum(reserve.contracts.reserve)
  const sharePrice = finiteNumber(savings.savings.sharePriceHuman)
  if (!arcoGOLD || !zap || !reserveAddress || sharePrice === null || !(sharePrice > 0)) return null
  // The two reads must describe the same Reserve.
  if (checksum(savings.contracts.reserve) !== reserveAddress) return null
  const state = reserve.reserve
  const coins: ArcoGoldLiveCoin[] = []
  for (const asset of state.assets) {
    const option = goldSavingsOption(asset.symbol)
    const token = checksum(asset.address)
    const available = finiteNumber(asset.availableHuman)
    if (option === null || token === null || available === null || option.decimals !== asset.decimals) continue
    coins.push({
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
  if (coins.length === 0) return null
  const ounceUsd = typeof savings.ounceUsd === "number" && Number.isFinite(savings.ounceUsd) && savings.ounceUsd > 0 ? savings.ounceUsd : null
  return {
    arcoGOLD,
    zap,
    coins,
    sharePrice,
    ounceUsd,
    apyPercent: typeof savings.apyPercent === "number" && Number.isFinite(savings.apyPercent) ? savings.apyPercent : null,
    depositPaused: state.reservePaused || state.depositPaused || state.arcoUSDPaused || state.arcoUSDMintPaused,
    redeemPaused: state.reservePaused || state.redeemPaused || state.redeemInstantOnlyPaused || state.arcoUSDPaused || state.arcoUSDBurnPaused,
    depositsOpen: savings.savings.depositsOpen,
    withdrawalsOpen: savings.savings.withdrawalsOpen,
  }
}

/** Through the Zap in a gold coin: closed when ArcoGOLD is, or when the Reserve leg or the coin is. */
function coinPause(live: ArcoGoldLive, coin: ArcoGoldLiveCoin): Pick<GiwaPauseState, "depositPaused" | "withdrawPaused"> {
  return {
    depositPaused: !live.depositsOpen || live.depositPaused || !coin.depositEnabled,
    withdrawPaused: !live.withdrawalsOpen || live.redeemPaused || !coin.redeemEnabled,
  }
}

function ownCoin(live: ArcoGoldLive): ArcoGoldLiveCoin {
  return live.coins.find((coin) => coin.option.symbol === OWN_COIN) ?? live.coins[0]!
}

/** The gold account as a vault the Savings screens run: ArcoGOLD through the Zap, paid in its own coin (PAXG). */
export function goldSavingsVault(live: ArcoGoldLive): GiwaCatalogItem {
  const own = ownCoin(live)
  return {
    productId: GOLD_SAVINGS_PRODUCT_ID,
    symbol: "ArcoGOLD",
    name: "ArcoGOLD",
    paymentAssetSymbol: own.symbol,
    paymentAsset: { symbol: own.symbol, name: own.option.name, decimals: own.decimals, tokenAddress: own.token },
    paymentAssetAddress: own.token,
    productTokenAddress: live.arcoGOLD,
    depositVaultAddress: live.zap,
    redemptionVaultAddress: live.zap,
    priceFeedAddress: null,
    vaultConfig: null,
    pauseState: coinPause(live, own),
    arcoUSD: zapTransport(live.sharePrice, own),
  }
}

/** The gold account's other coins on GIWA (XAUT), each a route through the same Zap. */
export function goldSavingsRoutes(live: ArcoGoldLive): SavingsRoute[] {
  const own = ownCoin(live)
  return live.coins
    .filter((coin) => coin !== own && (coin.depositEnabled || coin.redeemEnabled))
    .map((coin) => ({
      vault: GOLD_SAVINGS_PRODUCT_ID,
      option: coin.option.key,
      token: coin.token,
      depositVault: live.zap,
      redemptionVault: live.zap,
      arcoUSD: zapTransport(live.sharePrice, coin),
      instantLiquidity: instantPayable(coin),
      pauseState: coinPause(live, coin),
    }))
}

/** What a withdrawal in the account's own coin can pay at once, in the coin. */
export function goldOwnLiquidity(live: ArcoGoldLive): number {
  return instantPayable(ownCoin(live))
}

/** The gold account as the market read describes a vault: ounces per share, an ounce's dollars, the display rate. */
export function goldSavingsMarket(live: ArcoGoldLive): GiwaMarketEntry {
  return {
    productId: GOLD_SAVINGS_PRODUCT_ID,
    navBase: live.sharePrice,
    baseUsd: live.ounceUsd,
    navUsd: live.ounceUsd !== null ? live.sharePrice * live.ounceUsd : null,
    apy: live.apyPercent,
    impliedApy: null,
  }
}

/**
 * The Savings tabs' accounts with the live gold account: one account per gold coin (PAXG, XAUT), all opening the one
 * ArcoGOLD vault, in the place of the first gold coin the Vault Config lists (a coming-soon card) or after the others;
 * every gold coin the Vault Config lists is replaced, so none shows twice. Without the live account the list is as built.
 */
export function withGoldAccounts(accounts: readonly SavingsAccount[], vault: GiwaCatalogItem | null, live: ArcoGoldLive | null, apy: string): SavingsAccount[] {
  if (vault === null || live === null) return [...accounts]
  const listed = accounts.filter((account) => savingsAssetCategory(account.symbol) === "gold")
  const gold: SavingsAccount[] = live.coins.map((coin) => {
    const configured = listed.find((account) => goldSavingsOption(account.symbol)?.key === coin.option.key)
    return {
      key: `real:${GOLD_SAVINGS_PRODUCT_ID}:${coin.option.symbol}`,
      symbol: coin.option.symbol,
      icon: coin.option.logo,
      apy,
      disabled: false,
      vault,
      vaultId: GOLD_SAVINGS_PRODUCT_ID,
      sortOrder: configured?.sortOrder ?? null,
    }
  })
  const at = accounts.findIndex((account) => savingsAssetCategory(account.symbol) === "gold")
  const rest = accounts.filter((account) => savingsAssetCategory(account.symbol) !== "gold")
  if (at < 0) return [...rest, ...gold]
  const before = accounts.slice(0, at).filter((account) => savingsAssetCategory(account.symbol) !== "gold").length
  return [...rest.slice(0, before), ...gold, ...rest.slice(before)]
}

const ONE_SHARE = 10n ** 18n
/** The picker's note on a gold coin the Zap would not pay at once (its free buffer is short, or its way out is paused). */
export const NOT_INSTANT_LABEL = "Not available now"

/** An amount of ArcoGOLD in base units; 0 for anything that is not one (empty, "--", a half-typed "1."). */
function sharesOrZero(value: string): bigint {
  try {
    return value.trim() === "" ? 0n : parseUnits(value.trim(), 18)
  } catch {
    return 0n
  }
}

/**
 * What the withdraw screen asks Zap.quoteRedeem about, in ArcoGOLD base units: the amount entered, else the whole
 * balance, else one ArcoGOLD (so a coin with no free buffer at all reads as not instant before anything is typed).
 */
export function goldQuoteShares(amount: string, balance: string): bigint {
  const entered = sharesOrZero(amount)
  if (entered > 0n) return entered
  const held = sharesOrZero(balance)
  return held > 0n ? held : ONE_SHARE
}

/**
 * The picker's coins with every coin quoteRedeem says is not instant greyed out (`available: false`). A coin with no
 * answer yet stays as it is; null (anywhere but the gold withdraw screen) leaves the list unchanged.
 */
export function withInstantCoins(
  choices: readonly SavingsAssetChoice[] | null,
  instant: ReadonlyMap<string, boolean> | null,
): SavingsAssetChoice[] | null {
  if (choices === null) return null
  if (instant === null) return [...choices]
  return choices.map((choice) => (instant.get(choice.key) === false ? { ...choice, available: false, unavailableLabel: NOT_INSTANT_LABEL } : choice))
}
