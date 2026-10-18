import { decodeEventLog } from "viem"
import type { RawEvmLog } from "../indexer/event-decoder.js"
import type { GiwaIndexerCursor, GiwaIndexerRpc } from "../indexer/giwa-indexer.js"
import type { IndexedEventInput, JsonObject } from "../services/types.js"
import { reserveEventsAbi } from "./abi.js"
import type { ArcoUSDChainReader, ReserveState } from "./reader.js"
import { deployedArcoUSD, type ArcoUSDRegistryFile, type DeployedArcoUSD } from "./registry.js"

// ArcoUSD indexer (docs/specs/arcousd-v1.md §5). Runs beside the core GIWA indexer with its own
// cursor ("arcousd") so neither can stall the other:
//   • every ArcoUSDReserve event → EvmIndexedEvent (audit trail; no walletAddress, so nothing
//     shows up in the portfolio Activity feed until the UI integration decides how to render it);
//   • RedeemQueued/Paid/PayoutFailed/Cancelled → ArcoUSDRedeemRequest, transitions only forward;
//   • every snapshotIntervalMs, one Lens snapshot → ArcoUSDReserveSnapshot.
// Inert (no RPC calls) while the ArcoUSD registry is missing or not deployed.

export type RedeemStatus = "QUEUED" | "PAID" | "PAYOUT_FAILED" | "CANCELLED"
export type RedeemTransition = Exclude<RedeemStatus, "QUEUED">

/** Statuses each transition may leave, mirroring ArcoUSDReserve (processQueue / _failRequest / cancelRedeem). */
export const REDEEM_TRANSITION_FROM: Readonly<Record<RedeemTransition, readonly RedeemStatus[]>> = {
  PAID: ["QUEUED"],
  PAYOUT_FAILED: ["QUEUED"],
  CANCELLED: ["QUEUED", "PAYOUT_FAILED"],
}

export type RedeemQueuedInput = {
  readonly chainId: number
  readonly reserveAddress: string
  readonly requestId: string
  readonly owner: string
  readonly recipient: string
  readonly asset: string
  readonly arcoUSDAmount: string
  readonly assetAmount: string
  readonly requestedAt: Date
  readonly queuedTxHash: string
  readonly queuedBlock: bigint
}

export type RedeemTransitionInput = {
  readonly chainId: number
  readonly reserveAddress: string
  readonly requestId: string
  readonly to: RedeemTransition
  readonly txHash: string
  readonly at: Date
}

export type ReserveSnapshotInput = {
  readonly chainId: number
  readonly reserveAddress: string
  readonly blockNumber: bigint
  readonly takenAt: Date
  readonly state: ReserveState
}

export type ArcoUSDIndexerStore = {
  getCursor(chainId: number, name: string): Promise<GiwaIndexerCursor | null>
  upsertCursor(input: {
    chainId: number
    name: string
    fromBlock: bigint
    lastBlock: bigint
    lastBlockHash: string | null
    confirmations: number
    lagBlocks: number
  }): Promise<unknown>
  insertIndexedEvent(input: IndexedEventInput): Promise<unknown>
  /** Create-only: re-indexing an existing request never touches it. */
  recordRedeemQueued(input: RedeemQueuedInput): Promise<unknown>
  /** Applies `to` only from REDEEM_TRANSITION_FROM[to]; returns rows changed (0 = stale/replayed). */
  transitionRedeem(input: RedeemTransitionInput): Promise<number>
  /** Idempotent per (chainId, reserveAddress, blockNumber). */
  insertSnapshot(input: ReserveSnapshotInput): Promise<unknown>
}

export type ArcoUSDIndexerPollResult =
  | { readonly mode: "inert"; readonly reason: string }
  | {
      readonly mode: "poll"
      readonly indexedEvents: number
      readonly staleTransitions: number
      readonly fromBlock: bigint
      readonly toBlock: bigint
      readonly latestBlock: bigint
      readonly lagBlocks: number
      readonly reorgDetected: boolean
      readonly snapshot: "taken" | "not-due" | "failed"
    }

const SNAPSHOT_RETRY_MS = 60_000

function toBigInt(value: bigint | number): bigint {
  return typeof value === "bigint" ? value : BigInt(value)
}

function toJson(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString()
  if (Array.isArray(value)) return value.map(toJson)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, toJson(nested)]))
  }
  if (typeof value === "string" && value.startsWith("0x")) return value.toLowerCase()
  return value
}

export function decodeReserveLog(log: RawEvmLog): { eventName: string; args: JsonObject } | null {
  try {
    const decoded = decodeEventLog({
      abi: reserveEventsAbi,
      data: log.data,
      topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
    })
    return { eventName: decoded.eventName, args: toJson(decoded.args ?? {}) as JsonObject }
  } catch {
    return null // not a Reserve event we know (e.g. emitted by a future upgrade): skip it
  }
}

export class ArcoUSDIndexer {
  private lastGoodRegistry: ArcoUSDRegistryFile | null = null
  private nextSnapshotAt = 0

  constructor(
    private readonly options: {
      /** Re-read each poll so a fresh deploy is picked up without a restart. */
      readonly loadRegistry: () => ArcoUSDRegistryFile | null
      readonly rpc: GiwaIndexerRpc
      readonly store: ArcoUSDIndexerStore
      readonly readState: ArcoUSDChainReader
      readonly confirmations: number
      readonly maxBlockRange: bigint
      readonly snapshotIntervalMs: number
      readonly reorgDepth?: bigint
      readonly cursorName?: string
      readonly now?: () => number
    },
  ) {}

  private cursorName() {
    return this.options.cursorName ?? "arcousd"
  }

  private now() {
    return (this.options.now ?? Date.now)()
  }

  // A read/parse failure (e.g. the file mid-rewrite) keeps the last good copy; a registry that
  // reads fine but fails validation, or points at another chain, throws so it is loud in the logs.
  private registry(): ArcoUSDRegistryFile | null {
    try {
      this.lastGoodRegistry = this.options.loadRegistry()
    } catch (error) {
      console.warn(
        `[arcousd-indexer] registry reload failed; keeping last-good: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return this.lastGoodRegistry
  }

  async pollOnce(): Promise<ArcoUSDIndexerPollResult> {
    const registry = this.registry()
    if (!registry?.deployed) return { mode: "inert", reason: "ArcoUSD registry missing or not deployed" }
    const chainId = await this.options.rpc.getChainId()
    if (chainId !== registry.chainId) {
      throw new Error(`RPC chainId ${chainId} does not match ArcoUSD registry chainId ${registry.chainId}`)
    }
    const deployment = deployedArcoUSD(registry, chainId)!

    const startBlock = BigInt(deployment.deploymentBlock)
    const reserve = deployment.reserveAddress.toLowerCase() as `0x${string}`
    const latestBlock = await this.options.rpc.getBlockNumber()
    const confirmedBlock = latestBlock - BigInt(this.options.confirmations)
    const snapshot = await this.maybeSnapshot(chainId, deployment)
    if (confirmedBlock < startBlock) {
      return {
        mode: "poll",
        indexedEvents: 0,
        staleTransitions: 0,
        fromBlock: startBlock,
        toBlock: startBlock,
        latestBlock,
        lagBlocks: 0,
        reorgDetected: false,
        snapshot,
      }
    }

    const name = this.cursorName()
    const cursor = await this.options.store.getCursor(chainId, name)
    let fromBlock = cursor ? toBigInt(cursor.lastBlock) + 1n : startBlock
    let reorgDetected = false
    if (cursor?.lastBlockHash) {
      const lastBlock = toBigInt(cursor.lastBlock)
      const canonical = await this.options.rpc.getBlock({ blockNumber: lastBlock })
      if (canonical.hash && canonical.hash.toLowerCase() !== cursor.lastBlockHash.toLowerCase()) {
        reorgDetected = true
        const rewound = lastBlock - (this.options.reorgDepth ?? 12n)
        fromBlock = rewound > startBlock ? rewound : startBlock
      }
    }

    if (fromBlock > confirmedBlock) {
      return {
        mode: "poll",
        indexedEvents: 0,
        staleTransitions: 0,
        fromBlock,
        toBlock: confirmedBlock,
        latestBlock,
        lagBlocks: Number(latestBlock - (fromBlock - 1n)),
        reorgDetected,
        snapshot,
      }
    }

    const span = fromBlock + this.options.maxBlockRange - 1n
    const toBlock = span < confirmedBlock ? span : confirmedBlock
    const logs = await this.options.rpc.getLogs({ addresses: [reserve], fromBlock, toBlock })
    const timestamps = new Map<bigint, Date>()
    let indexedEvents = 0
    let staleTransitions = 0
    for (const log of logs) {
      if (log.address.toLowerCase() !== reserve) continue
      const decoded = decodeReserveLog(log)
      if (!decoded) continue
      const at = await this.blockTime(timestamps, log.blockNumber)
      await this.options.store.insertIndexedEvent({
        chainId,
        contractAddress: reserve,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        eventName: decoded.eventName,
        args: decoded.args,
        removed: log.removed ?? false,
        blockTimestamp: at,
      })
      indexedEvents++
      if ((await this.applyRequestEvent(chainId, reserve, log, decoded, at)) === 0) staleTransitions++
    }

    const last = await this.options.rpc.getBlock({ blockNumber: toBlock })
    const lagBlocks = Number(latestBlock - toBlock)
    await this.options.store.upsertCursor({
      chainId,
      name,
      fromBlock: startBlock,
      lastBlock: toBlock,
      lastBlockHash: last.hash,
      confirmations: this.options.confirmations,
      lagBlocks,
    })
    return { mode: "poll", indexedEvents, staleTransitions, fromBlock, toBlock, latestBlock, lagBlocks, reorgDetected, snapshot }
  }

  /** Returns 0 only for a transition that did not apply (replay or out-of-order); null when not a request event. */
  private async applyRequestEvent(
    chainId: number,
    reserveAddress: string,
    log: RawEvmLog,
    decoded: { eventName: string; args: JsonObject },
    at: Date,
  ): Promise<number | null> {
    const args = decoded.args as Record<string, string>
    const requestId = args.requestId
    if (typeof requestId !== "string") return null
    if (decoded.eventName === "RedeemQueued") {
      await this.options.store.recordRedeemQueued({
        chainId,
        reserveAddress,
        requestId,
        owner: args.owner,
        recipient: args.recipient,
        asset: args.asset,
        arcoUSDAmount: args.arcoUSDIn,
        assetAmount: args.assetOut,
        requestedAt: new Date(Number(args.requestedAt) * 1000),
        queuedTxHash: log.transactionHash.toLowerCase(),
        queuedBlock: log.blockNumber,
      })
      return null
    }
    const to: RedeemTransition | null =
      decoded.eventName === "RedeemPaid"
        ? "PAID"
        : decoded.eventName === "RedeemPayoutFailed"
          ? "PAYOUT_FAILED"
          : decoded.eventName === "RedeemCancelled"
            ? "CANCELLED"
            : null
    if (!to) return null
    return this.options.store.transitionRedeem({
      chainId,
      reserveAddress,
      requestId,
      to,
      txHash: log.transactionHash.toLowerCase(),
      at,
    })
  }

  // Snapshot failures never block event indexing; they retry after SNAPSHOT_RETRY_MS.
  private async maybeSnapshot(chainId: number, deployment: DeployedArcoUSD): Promise<"taken" | "not-due" | "failed"> {
    const now = this.now()
    if (now < this.nextSnapshotAt) return "not-due"
    try {
      const state = await this.options.readState(deployment)
      const blockNumber = BigInt(state.blockNumber)
      const block = await this.options.rpc.getBlock({ blockNumber })
      await this.options.store.insertSnapshot({
        chainId,
        reserveAddress: deployment.reserveAddress.toLowerCase(),
        blockNumber,
        takenAt: new Date(Number(block.timestamp) * 1000),
        state,
      })
      this.nextSnapshotAt = now + this.options.snapshotIntervalMs
      return "taken"
    } catch (error) {
      console.warn(`[arcousd-indexer] snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
      this.nextSnapshotAt = now + Math.min(SNAPSHOT_RETRY_MS, this.options.snapshotIntervalMs)
      return "failed"
    }
  }

  private async blockTime(cache: Map<bigint, Date>, blockNumber: bigint): Promise<Date> {
    const cached = cache.get(blockNumber)
    if (cached) return cached
    const block = await this.options.rpc.getBlock({ blockNumber })
    const at = new Date(Number(block.timestamp) * 1000)
    cache.set(blockNumber, at)
    return at
  }
}
