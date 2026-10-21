import { formatUnits, maxUint256, type PublicClient } from "viem"
import {
  ARCOUSD_BURN_SELECTOR,
  ARCOUSD_MINT_SELECTOR,
  DEPOSIT_SELECTOR,
  lensAbi,
  PROCESS_QUEUE_SELECTOR,
  REDEEM_INSTANT_ONLY_SELECTOR,
  REDEEM_SELECTOR,
  reserveAssetConfigAbi,
  reservePauseAbi,
  ROUTER_BUY_SELECTOR,
  SETTLE_FOR_SELECTOR,
} from "./abi.js"
import type { DeployedArcoUSD } from "./registry.js"

// One read of the Reserve through the Lens, serialized for JSON (base units as decimal
// strings, plus human amounts for the screens).

export type AssetState = {
  readonly symbol: string
  readonly address: string
  readonly decimals: number
  readonly depositEnabled: boolean
  readonly redeemEnabled: boolean
  /** Instant redemptions only (bps). */
  readonly instantFeeBps: number
  /** Swap fee on deposits and all redemptions (bps); 0 for the base asset. */
  readonly swapFeeBps: number
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
  /** Smallest payout (asset units) a Standard request may have; below it redeem reverts BelowQueueMinimum. */
  readonly minQueued: string
  readonly minQueuedHuman: string
  /** deposit reverts DepositCap when the Reserve's balance of this asset would exceed it (asset units).
   *  max uint256 means no cap: then the human amount and the room are null. */
  readonly depositCap: string
  readonly depositCapHuman: string | null
  /** depositCap − balance, floored at 0: the room under the cap only (deposit can still revert on the
   *  mint cap, a disabled deposit or the peg check); null with no cap. */
  readonly depositRoom: string | null
  readonly depositRoomHuman: string | null
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
  /** Reserve.fnPaused(processQueue) — Standard-queue payouts stop (requests keep their place). */
  readonly queuePaused: boolean
  /** ArcoUSD.paused() — halts mint and burn (not transfers). */
  readonly arcoUSDPaused: boolean
  /** ArcoUSD.fnPaused(burn) — settleFor and queue payouts burn ArcoUSD. */
  readonly arcoUSDBurnPaused: boolean
  /** Reserve.fnPaused(deposit) — a stablecoin-paid Router buy deposits first. */
  readonly depositPaused: boolean
  /** ArcoUSD.fnPaused(mint) — that deposit mints ArcoUSD. */
  readonly arcoUSDMintPaused: boolean
  /** ArcoRouter.paused() or fnPaused(buy); false while no Router is deployed. */
  readonly routerPaused: boolean
  /** Reserve.fnPaused(redeem) — every redemption, Instant and Standard (cancelRedeem still works).
   *  Like depositPaused, only the switch: a redemption also stops while reservePaused. */
  readonly redeemPaused: boolean
  /** Reserve.fnPaused(redeemInstantOnly) — Instant-only redemptions (the app's withdrawals and conversions back to a
   *  coin, the Savings Zap). They also stop while redeemPaused or reservePaused. */
  readonly redeemInstantOnlyPaused: boolean
  readonly assets: readonly AssetState[]
  readonly strategies: readonly StrategyState[]
}

/** Reads at `blockNumber` when given (e.g. the indexer's last block, to compare like with like), else the latest. */
export type ArcoUSDChainReader = (deployment: DeployedArcoUSD, blockNumber?: bigint) => Promise<ReserveState>

export function createArcoUSDChainReader(client: Pick<PublicClient, "readContract" | "getBlockNumber">): ArcoUSDChainReader {
  return async (deployment, at) => {
    const blockNumber = at ?? (await client.getBlockNumber())
    const pausedAt = (address: `0x${string}`) =>
      client.readContract({ address, abi: reservePauseAbi, functionName: "paused", blockNumber })
    const fnPausedAt = (address: `0x${string}`, selector: `0x${string}`) =>
      client.readContract({ address, abi: reservePauseAbi, functionName: "fnPaused", args: [selector], blockNumber })
    const router = deployment.routerAddress
    const [snap, reservePaused, settlementPaused, queuePaused, arcoUSDPaused, arcoUSDBurnPaused, depositPaused, arcoUSDMintPaused, routerPaused, routerBuyPaused, redeemPaused, redeemInstantOnlyPaused] = await Promise.all([
      client.readContract({
        address: deployment.lensAddress,
        abi: lensAbi,
        functionName: "snapshot",
        args: [deployment.reserveAddress],
        blockNumber,
      }),
      pausedAt(deployment.reserveAddress),
      fnPausedAt(deployment.reserveAddress, SETTLE_FOR_SELECTOR),
      fnPausedAt(deployment.reserveAddress, PROCESS_QUEUE_SELECTOR),
      pausedAt(deployment.arcoUSDAddress),
      fnPausedAt(deployment.arcoUSDAddress, ARCOUSD_BURN_SELECTOR),
      fnPausedAt(deployment.reserveAddress, DEPOSIT_SELECTOR),
      fnPausedAt(deployment.arcoUSDAddress, ARCOUSD_MINT_SELECTOR),
      router ? pausedAt(router) : false,
      router ? fnPausedAt(router, ROUTER_BUY_SELECTOR) : false,
      fnPausedAt(deployment.reserveAddress, REDEEM_SELECTOR),
      fnPausedAt(deployment.reserveAddress, REDEEM_INSTANT_ONLY_SELECTOR),
    ])
    // The Lens leaves out the per-asset limits: one getAssetConfig per asset, at the same block.
    const configs = new Map<string, AssetLimits>()
    await Promise.all(
      snap.assets.map(async (asset) => {
        const config = await client.readContract({
          address: deployment.reserveAddress,
          abi: reserveAssetConfigAbi,
          functionName: "getAssetConfig",
          args: [asset.asset as `0x${string}`],
          blockNumber,
        })
        configs.set(asset.asset.toLowerCase(), { depositCap: config.depositCap, minQueued: config.minQueued })
      }),
    )
    return toReserveState(deployment, blockNumber, snap, configs, {
      reservePaused: Boolean(reservePaused),
      settlementPaused: Boolean(settlementPaused),
      queuePaused: Boolean(queuePaused),
      arcoUSDPaused: Boolean(arcoUSDPaused),
      arcoUSDBurnPaused: Boolean(arcoUSDBurnPaused),
      depositPaused: Boolean(depositPaused),
      arcoUSDMintPaused: Boolean(arcoUSDMintPaused),
      routerPaused: Boolean(routerPaused) || Boolean(routerBuyPaused),
      redeemPaused: Boolean(redeemPaused),
      redeemInstantOnlyPaused: Boolean(redeemInstantOnlyPaused),
    })
  }
}

/** Reserve.getAssetConfig's limits, keyed by lowercase asset address. */
export type AssetLimits = { readonly depositCap: bigint; readonly minQueued: bigint }

export type PauseFlags = Pick<
  ReserveState,
  "reservePaused" | "settlementPaused" | "queuePaused" | "arcoUSDPaused" | "arcoUSDBurnPaused" | "depositPaused" | "arcoUSDMintPaused" | "routerPaused" | "redeemPaused" | "redeemInstantOnlyPaused"
>

export const NO_PAUSES: PauseFlags = {
  reservePaused: false,
  settlementPaused: false,
  queuePaused: false,
  arcoUSDPaused: false,
  arcoUSDBurnPaused: false,
  depositPaused: false,
  arcoUSDMintPaused: false,
  routerPaused: false,
  redeemPaused: false,
  redeemInstantOnlyPaused: false,
}

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
    instantFeeBps: number
    swapFeeBps: number
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
  limits: ReadonlyMap<string, AssetLimits>,
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
      instantFeeBps: Number(asset.instantFeeBps),
      swapFeeBps: Number(asset.swapFeeBps),
      balance: asset.balance.toString(),
      queued: asset.queued.toString(),
      available: asset.available.toString(),
      balanceHuman: formatUnits(asset.balance, Number(asset.decimals)),
      queuedHuman: formatUnits(asset.queued, Number(asset.decimals)),
      availableHuman: formatUnits(asset.available, Number(asset.decimals)),
      queueLength: Number(asset.queueLength),
      queueHead: Number(asset.queueHead),
      queueBacklog: Number(asset.queueLength - asset.queueHead),
      ...limitsOf(asset, limits.get(asset.asset.toLowerCase())),
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

/** minQueued and the deposit cap with what is left under it (null with no cap). The reader always has
 *  the limits; without them (a caller passing none) the cap reads 0, so no deposit room is claimed. */
function limitsOf(
  asset: { decimals: number; balance: bigint },
  limits: AssetLimits | undefined,
): Pick<AssetState, "minQueued" | "minQueuedHuman" | "depositCap" | "depositCapHuman" | "depositRoom" | "depositRoomHuman"> {
  const decimals = Number(asset.decimals)
  const minQueued = limits?.minQueued ?? 0n
  const cap = limits?.depositCap ?? 0n
  const capped = cap !== maxUint256
  const room = capped ? (cap > asset.balance ? cap - asset.balance : 0n) : null
  return {
    minQueued: minQueued.toString(),
    minQueuedHuman: formatUnits(minQueued, decimals),
    depositCap: cap.toString(),
    depositCapHuman: capped ? formatUnits(cap, decimals) : null,
    depositRoom: room === null ? null : room.toString(),
    depositRoomHuman: room === null ? null : formatUnits(room, decimals),
  }
}
