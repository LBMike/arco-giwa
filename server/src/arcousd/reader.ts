import { formatUnits, type PublicClient } from "viem"
import { ARCOUSD_BURN_SELECTOR, lensAbi, reservePauseAbi, SETTLE_FOR_SELECTOR } from "./abi.js"
import type { DeployedArcoUSD } from "./registry.js"

// One read of the Reserve through the Lens, serialized for JSON (base units as decimal
// strings, plus human amounts for the screens).

export type AssetState = {
  readonly symbol: string
  readonly address: string
  readonly decimals: number
  readonly depositEnabled: boolean
  readonly redeemEnabled: boolean
  readonly balance: string
  readonly queued: string
  readonly available: string
  readonly balanceHuman: string
  readonly queuedHuman: string
  readonly availableHuman: string
  readonly queueLength: number
  readonly queueHead: number
  /** Queue entries processQueue has not passed yet (may include cancelled ones). */
  readonly queueBacklog: number
}

export type StrategyState = {
  readonly strategyId: number
  readonly productId: string | null
  readonly asset: string
  readonly productToken: string
  readonly enabled: boolean
  readonly shares: string
  readonly value: string
  readonly valueUsd: string
  readonly navOk: boolean
  readonly pendingRecall: string
  readonly maxAllocation: string
}

export type ReserveState = {
  readonly blockNumber: string
  readonly totalBacking: string
  readonly totalLiabilities: string
  readonly totalBackingUsd: string
  readonly totalLiabilitiesUsd: string
  /** backing − liabilities, base18 (negative when under-backed). */
  readonly surplus: string
  readonly navOk: boolean
  readonly mmfBps: number
  readonly mmfTargetBps: number
  readonly bufferFloorBps: number
  readonly queueMinDelay: number
  readonly mintCap: string
  /** Reserve.paused() */
  readonly reservePaused: boolean
  /** Reserve.fnPaused(settleFor) */
  readonly settlementPaused: boolean
  /** ArcoUSD.paused() — halts mint and burn (not transfers). */
  readonly arcoUSDPaused: boolean
  /** ArcoUSD.fnPaused(burn) — settleFor and queue payouts burn ArcoUSD. */
  readonly arcoUSDBurnPaused: boolean
  readonly assets: readonly AssetState[]
  readonly strategies: readonly StrategyState[]
}

export type ArcoUSDChainReader = (deployment: DeployedArcoUSD) => Promise<ReserveState>

export function createArcoUSDChainReader(client: Pick<PublicClient, "readContract" | "getBlockNumber">): ArcoUSDChainReader {
  return async (deployment) => {
    const blockNumber = await client.getBlockNumber()
    const pausedAt = (address: `0x${string}`) =>
      client.readContract({ address, abi: reservePauseAbi, functionName: "paused", blockNumber })
    const fnPausedAt = (address: `0x${string}`, selector: `0x${string}`) =>
      client.readContract({ address, abi: reservePauseAbi, functionName: "fnPaused", args: [selector], blockNumber })
    const [snap, reservePaused, settlementPaused, arcoUSDPaused, arcoUSDBurnPaused] = await Promise.all([
      client.readContract({
        address: deployment.lensAddress,
        abi: lensAbi,
        functionName: "snapshot",
        args: [deployment.reserveAddress],
        blockNumber,
      }),
      pausedAt(deployment.reserveAddress),
      fnPausedAt(deployment.reserveAddress, SETTLE_FOR_SELECTOR),
      pausedAt(deployment.arcoUSDAddress),
      fnPausedAt(deployment.arcoUSDAddress, ARCOUSD_BURN_SELECTOR),
    ])
    return toReserveState(deployment, blockNumber, snap, {
      reservePaused: Boolean(reservePaused),
      settlementPaused: Boolean(settlementPaused),
      arcoUSDPaused: Boolean(arcoUSDPaused),
      arcoUSDBurnPaused: Boolean(arcoUSDBurnPaused),
    })
  }
}

export type PauseFlags = Pick<ReserveState, "reservePaused" | "settlementPaused" | "arcoUSDPaused" | "arcoUSDBurnPaused">

export const NO_PAUSES: PauseFlags = { reservePaused: false, settlementPaused: false, arcoUSDPaused: false, arcoUSDBurnPaused: false }

type LensSnapshot = {
  totalBacking: bigint
  totalLiabilities: bigint
  navOk: boolean
  mmfBps: bigint
  mmfTargetBps: bigint
  bufferFloorBps: bigint
  queueMinDelay: bigint
  mintCap: bigint
  assets: readonly {
    asset: string
    decimals: number
    depositEnabled: boolean
    redeemEnabled: boolean
    balance: bigint
    queued: bigint
    available: bigint
    queueLength: bigint
    queueHead: bigint
  }[]
  strategies: readonly {
    strategyId: bigint
    asset: string
    productToken: string
    enabled: boolean
    shares: bigint
    value: bigint
    navOk: boolean
    pendingRecall: bigint
    maxAllocation: bigint
  }[]
}

export function toReserveState(
  deployment: DeployedArcoUSD,
  blockNumber: bigint,
  snap: LensSnapshot,
  pauses: PauseFlags,
): ReserveState {
  const symbolOf = (address: string) =>
    deployment.reserveAssets.find((asset) => asset.address?.toLowerCase() === address.toLowerCase())?.symbol ?? address
  const productOf = (strategyId: number) =>
    deployment.strategies.find((strategy) => strategy.strategyId === strategyId)?.productId ?? null
  return {
    blockNumber: blockNumber.toString(),
    totalBacking: snap.totalBacking.toString(),
    totalLiabilities: snap.totalLiabilities.toString(),
    totalBackingUsd: formatUnits(snap.totalBacking, 18),
    totalLiabilitiesUsd: formatUnits(snap.totalLiabilities, 18),
    surplus: (snap.totalBacking - snap.totalLiabilities).toString(),
    navOk: snap.navOk,
    mmfBps: Number(snap.mmfBps),
    mmfTargetBps: Number(snap.mmfTargetBps),
    bufferFloorBps: Number(snap.bufferFloorBps),
    queueMinDelay: Number(snap.queueMinDelay),
    mintCap: snap.mintCap.toString(),
    ...pauses,
    assets: snap.assets.map((asset) => ({
      symbol: symbolOf(asset.asset),
      address: asset.asset.toLowerCase(),
      decimals: Number(asset.decimals),
      depositEnabled: asset.depositEnabled,
      redeemEnabled: asset.redeemEnabled,
      balance: asset.balance.toString(),
      queued: asset.queued.toString(),
      available: asset.available.toString(),
      balanceHuman: formatUnits(asset.balance, Number(asset.decimals)),
      queuedHuman: formatUnits(asset.queued, Number(asset.decimals)),
      availableHuman: formatUnits(asset.available, Number(asset.decimals)),
      queueLength: Number(asset.queueLength),
      queueHead: Number(asset.queueHead),
      queueBacklog: Number(asset.queueLength - asset.queueHead),
    })),
    strategies: snap.strategies.map((strategy) => ({
      strategyId: Number(strategy.strategyId),
      productId: productOf(Number(strategy.strategyId)),
      asset: strategy.asset.toLowerCase(),
      productToken: strategy.productToken.toLowerCase(),
      enabled: strategy.enabled,
      shares: strategy.shares.toString(),
      value: strategy.value.toString(),
      valueUsd: formatUnits(strategy.value, 18),
      navOk: strategy.navOk,
      pendingRecall: strategy.pendingRecall.toString(),
      maxAllocation: strategy.maxAllocation.toString(),
    })),
  }
}
