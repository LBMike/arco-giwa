import { formatUnits, type PublicClient } from "viem"
import {
  SAVINGS_DEPOSIT_SELECTOR,
  SAVINGS_SEED_HOLDER,
  SAVINGS_WITHDRAW_SELECTOR,
  savingsVaultReadAbi,
} from "../arcousd/abi.js"
import type { DeployedArcoGold } from "./registry.js"

// One read of ArcoGOLD (SArcoUSDNamed: the sArcoUSD vault contract under another name), serialized for JSON. Only the
// vault: ArcoGOLD has no distributor in v1, so there is nothing vesting to report and the rate shown is the set display
// rate (server/src/registry/apy.ts). Ounce amounts are base18 (1e18 = one troy ounce).

const ONE = 10n ** 18n

export type GoldVaultState = {
  readonly blockNumber: string
  /** ArcoXAU (ounces) the vault counts, base18. */
  readonly totalAssets: string
  readonly totalAssetsOunces: string
  /** ArcoGOLD in circulation, base18. */
  readonly totalSupply: string
  /** Ounces per 1 ArcoGOLD, base18 (1e18 = par). */
  readonly sharePrice: string
  readonly sharePriceHuman: string
  /** 1 ArcoGOLD held by 0x…dEaD (ArcoGOLD.seed() ran: deposits were opened). */
  readonly seeded: boolean
  readonly vaultPaused: boolean
  /** fnPaused(deposit) — deposits and mints. */
  readonly depositPaused: boolean
  /** fnPaused(withdraw) — withdrawals and redemptions. */
  readonly withdrawPaused: boolean
  /** seeded and neither the vault nor deposit is paused. */
  readonly depositsOpen: boolean
  /** Neither the vault nor withdraw is paused. */
  readonly withdrawalsOpen: boolean
}

export type GoldVaultReader = (gold: DeployedArcoGold, blockNumber?: bigint) => Promise<GoldVaultState>

type Client = Pick<PublicClient, "readContract" | "getBlockNumber">

export function createGoldVaultReader(client: Client): GoldVaultReader {
  return async (gold, at) => {
    const blockNumber = at ?? (await client.getBlockNumber())
    const vault = (functionName: string, args: readonly unknown[] = []) =>
      client.readContract({ address: gold.vaultAddress, abi: savingsVaultReadAbi, functionName, args, blockNumber } as never) as Promise<unknown>
    const [totalAssets, totalSupply, sharePrice, seedShares, minShares, vaultPaused, depositPaused, withdrawPaused] = await Promise.all([
      vault("totalAssets"),
      vault("totalSupply"),
      vault("convertToAssets", [ONE]),
      vault("balanceOf", [SAVINGS_SEED_HOLDER]),
      vault("MIN_SHARES"),
      vault("paused"),
      vault("fnPaused", [SAVINGS_DEPOSIT_SELECTOR]),
      vault("fnPaused", [SAVINGS_WITHDRAW_SELECTOR]),
    ])
    return toGoldVaultState({
      blockNumber,
      totalAssets: big(totalAssets),
      totalSupply: big(totalSupply),
      sharePrice: big(sharePrice),
      seedShares: big(seedShares),
      minShares: big(minShares),
      vaultPaused: Boolean(vaultPaused),
      depositPaused: Boolean(depositPaused),
      withdrawPaused: Boolean(withdrawPaused),
    })
  }
}

export type RawGoldVault = {
  readonly blockNumber: bigint
  readonly totalAssets: bigint
  readonly totalSupply: bigint
  readonly sharePrice: bigint
  readonly seedShares: bigint
  readonly minShares: bigint
  readonly vaultPaused: boolean
  readonly depositPaused: boolean
  readonly withdrawPaused: boolean
}

export function toGoldVaultState(raw: RawGoldVault): GoldVaultState {
  const seeded = raw.minShares > 0n && raw.seedShares >= raw.minShares
  return {
    blockNumber: raw.blockNumber.toString(),
    totalAssets: raw.totalAssets.toString(),
    totalAssetsOunces: formatUnits(raw.totalAssets, 18),
    totalSupply: raw.totalSupply.toString(),
    sharePrice: raw.sharePrice.toString(),
    sharePriceHuman: formatUnits(raw.sharePrice, 18),
    seeded,
    vaultPaused: raw.vaultPaused,
    depositPaused: raw.depositPaused,
    withdrawPaused: raw.withdrawPaused,
    depositsOpen: seeded && !raw.vaultPaused && !raw.depositPaused,
    withdrawalsOpen: !raw.vaultPaused && !raw.withdrawPaused,
  }
}

function big(value: unknown): bigint {
  return typeof value === "bigint" ? value : BigInt(value as number | string)
}
