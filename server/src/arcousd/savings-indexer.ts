import { decodeEventLog } from "viem"
import type { RawEvmLog } from "../indexer/event-decoder.js"
import type { GiwaIndexerCursor, GiwaIndexerRpc } from "../indexer/giwa-indexer.js"
import type { PrismaArcoService } from "../services/prisma-arco-service.js"
import type { IndexedEventInput, JsonObject } from "../services/types.js"
import { distributorEventsAbi, savingsVaultEventsAbi, savingsZapEventsAbi } from "./abi.js"
import { deployedArcoUSD, type ArcoUSDRegistryFile, type DeployedSavings } from "./registry.js"
import { safeErrorText } from "./safe-error.js"
import type { SavingsChainReader, SavingsState } from "./savings.js"

// Savings indexer (docs/specs/arcousd-v1.md §5, phase 4). Beside the ArcoUSD indexer, with its OWN
// cursor ("arcousd-savings") that starts at the Savings contracts' deploy block: Savings can be
// deployed after the rest, and the ArcoUSD cursor may already be past that block by the time the
// registry lists them.
//   • every sArcoUSD, ArcoUSDSavingsDistributor and ArcoSavingsZap event → EvmIndexedEvent (audit
//     trail; no walletAddress, like the Reserve's) — except sArcoUSD Transfer and Approval: every
//     deposit and withdrawal already has its Deposit / Withdraw;
//   • every snapshotIntervalMs, one savings read → ArcoUSDSavingsSnapshot (share price history).
// Inert (no RPC calls) until all three Savings contracts are in the registry.

export type SavingsSnapshotInput = {
  readonly chainId: number
  readonly vaultAddress: string
  readonly blockNumber: bigint
  readonly takenAt: Date
  readonly state: SavingsState
}

export type SavingsIndexerStore = {
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
  /** Idempotent per (chainId, vaultAddress, blockNumber). */
  insertSavingsSnapshot(input: SavingsSnapshotInput): Promise<unknown>
}

export type SavingsIndexerPollResult =
  | { readonly mode: "inert"; readonly reason: string }
  | {
      readonly mode: "poll"
      readonly indexedEvents: number
      readonly fromBlock: bigint
      readonly toBlock: bigint
      readonly latestBlock: bigint
      readonly lagBlocks: number
      readonly reorgDetected: boolean
      readonly snapshot: "taken" | "not-due" | "failed"
    }

export const SAVINGS_CURSOR = "arcousd-savings"
const SNAPSHOT_RETRY_MS = 60_000
/** Decoded but not stored (see the header). */
const SKIPPED_VAULT_EVENTS = new Set(["Transfer", "Approval"])

type Decoded = { eventName: string; args: JsonObject }

function toJson(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString()
  if (Array.isArray(value)) return value.map(toJson)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, toJson(nested)]))
  }
  if (typeof value === "string" && value.startsWith("0x")) return value.toLowerCase()
  return value
}

function decodeWith(abi: readonly unknown[], log: RawEvmLog): Decoded | null {
  try {
    const decoded = decodeEventLog({
      abi: abi as typeof savingsVaultEventsAbi,
      data: log.data,
      topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
    })
    return { eventName: decoded.eventName, args: toJson(decoded.args ?? {}) as JsonObject }
  } catch {
    return null // not an event we know (e.g. from a future upgrade): skip it
  }
}

export function decodeSavingsLog(log: RawEvmLog, savings: DeployedSavings): Decoded | null {
  const address = log.address.toLowerCase()
  if (address === savings.vaultAddress.toLowerCase()) {
    const decoded = decodeWith(savingsVaultEventsAbi, log)
    return decoded && !SKIPPED_VAULT_EVENTS.has(decoded.eventName) ? decoded : null
  }
  if (address === savings.distributorAddress.toLowerCase()) return decodeWith(distributorEventsAbi, log)
  if (address === savings.zapAddress.toLowerCase()) return decodeWith(savingsZapEventsAbi, log)
  return null
}

function toBigInt(value: bigint | number): bigint {
  return typeof value === "bigint" ? value : BigInt(value)
}

export class ArcoUSDSavingsIndexer {
  private lastGoodRegistry: ArcoUSDRegistryFile | null = null
  private nextSnapshotAt = 0

  constructor(
    private readonly options: {
      /** Re-read each poll so the Savings deploy is picked up without a restart. */
      readonly loadRegistry: () => ArcoUSDRegistryFile | null
      readonly rpc: GiwaIndexerRpc
      readonly store: SavingsIndexerStore
      readonly readState: SavingsChainReader
      readonly confirmations: number
      readonly maxBlockRange: bigint
      readonly snapshotIntervalMs: number
      readonly reorgDepth?: bigint
      readonly now?: () => number
    },
  ) {}

  private now() {
    return (this.options.now ?? Date.now)()
  }

  // Same rule as the ArcoUSD indexer: a read/parse failure keeps the last good copy; a file that
  // reads fine but fails validation throws so it is loud in the logs.
  private registry(): ArcoUSDRegistryFile | null {
    try {
      this.lastGoodRegistry = this.options.loadRegistry()
    } catch (error) {
      console.warn(
        `[arcousd-savings-indexer] registry reload failed; keeping last-good: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return this.lastGoodRegistry
  }

  async pollOnce(): Promise<SavingsIndexerPollResult> {
    const registry = this.registry()
    if (!registry?.deployed) return { mode: "inert", reason: "ArcoUSD registry missing or not deployed" }
    const chainId = await this.options.rpc.getChainId()
    if (chainId !== registry.chainId) {
      throw new Error(`RPC chainId ${chainId} does not match ArcoUSD registry chainId ${registry.chainId}`)
    }
    const savings = deployedArcoUSD(registry, chainId)!.savings
    if (!savings) return { mode: "inert", reason: "Savings contracts not in the ArcoUSD registry yet" }

    const startBlock = BigInt(savings.startBlock)
    const latestBlock = await this.options.rpc.getBlockNumber()
    const confirmedBlock = latestBlock - BigInt(this.options.confirmations)
    const snapshot = await this.maybeSnapshot(chainId, savings)
    const idle = (fromBlock: bigint, toBlock: bigint, lagBlocks: number, reorgDetected: boolean) => ({
      mode: "poll" as const,
      indexedEvents: 0,
      fromBlock,
      toBlock,
      latestBlock,
      lagBlocks,
      reorgDetected,
      snapshot,
    })
    if (confirmedBlock < startBlock) return idle(startBlock, startBlock, 0, false)

    const cursor = await this.options.store.getCursor(chainId, SAVINGS_CURSOR)
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
    if (fromBlock > confirmedBlock) return idle(fromBlock, confirmedBlock, Number(latestBlock - (fromBlock - 1n)), reorgDetected)

    const span = fromBlock + this.options.maxBlockRange - 1n
    const toBlock = span < confirmedBlock ? span : confirmedBlock
    const addresses = [savings.vaultAddress, savings.distributorAddress, savings.zapAddress].map(
      (address) => address.toLowerCase() as `0x${string}`,
    )
    const logs = await this.options.rpc.getLogs({ addresses, fromBlock, toBlock })
    const timestamps = new Map<bigint, Date>()
    let indexedEvents = 0
    for (const log of logs) {
      const decoded = decodeSavingsLog(log, savings)
      if (!decoded) continue
      await this.options.store.insertIndexedEvent({
        chainId,
        contractAddress: log.address.toLowerCase(),
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        eventName: decoded.eventName,
        args: decoded.args,
        removed: log.removed ?? false,
        blockTimestamp: await this.blockTime(timestamps, log.blockNumber),
      })
      indexedEvents++
    }

    const last = await this.options.rpc.getBlock({ blockNumber: toBlock })
    const lagBlocks = Number(latestBlock - toBlock)
    await this.options.store.upsertCursor({
      chainId,
      name: SAVINGS_CURSOR,
      fromBlock: startBlock,
      lastBlock: toBlock,
      lastBlockHash: last.hash,
      confirmations: this.options.confirmations,
      lagBlocks,
    })
    return { mode: "poll", indexedEvents, fromBlock, toBlock, latestBlock, lagBlocks, reorgDetected, snapshot }
  }

  // Snapshot failures never block event indexing; they retry after SNAPSHOT_RETRY_MS.
  private async maybeSnapshot(chainId: number, savings: DeployedSavings): Promise<"taken" | "not-due" | "failed"> {
    const now = this.now()
    if (now < this.nextSnapshotAt) return "not-due"
    try {
      const state = await this.options.readState(savings)
      const blockNumber = BigInt(state.blockNumber)
      const block = await this.options.rpc.getBlock({ blockNumber })
      await this.options.store.insertSavingsSnapshot({
        chainId,
        vaultAddress: savings.vaultAddress.toLowerCase(),
        blockNumber,
        takenAt: new Date(Number(block.timestamp) * 1000),
        state,
      })
      this.nextSnapshotAt = now + this.options.snapshotIntervalMs
      return "taken"
    } catch (error) {
      console.warn(`[arcousd-savings-indexer] snapshot failed: ${safeErrorText(error)}`) // never the RPC URL
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

// ─────────────────────────────── Prisma ───────────────────────────────

export type PrismaSavingsIndexerDelegates = {
  arcoUSDSavingsSnapshot: { upsert(args: unknown): Promise<unknown> }
}

/** Cursor + generic events through the core indexer's service; the snapshot table here. */
export class PrismaSavingsIndexerStore implements SavingsIndexerStore {
  constructor(
    private readonly prisma: PrismaSavingsIndexerDelegates,
    private readonly arco: Pick<PrismaArcoService, "getIndexerCursor" | "upsertIndexerCursor" | "insertIndexedEvent">,
  ) {}

  getCursor(chainId: number, name: string) {
    return this.arco.getIndexerCursor(chainId, name) as ReturnType<SavingsIndexerStore["getCursor"]>
  }

  upsertCursor(input: Parameters<SavingsIndexerStore["upsertCursor"]>[0]) {
    return this.arco.upsertIndexerCursor(input)
  }

  insertIndexedEvent(input: IndexedEventInput) {
    return this.arco.insertIndexedEvent(input)
  }

  insertSavingsSnapshot(input: SavingsSnapshotInput) {
    const vaultAddress = input.vaultAddress.toLowerCase()
    return this.prisma.arcoUSDSavingsSnapshot.upsert({
      where: { chainId_vaultAddress_blockNumber: { chainId: input.chainId, vaultAddress, blockNumber: input.blockNumber } },
      create: {
        chainId: input.chainId,
        vaultAddress,
        blockNumber: input.blockNumber,
        takenAt: input.takenAt,
        totalAssets: input.state.totalAssets,
        totalSupply: input.state.totalSupply,
        sharePrice: input.state.sharePrice,
        aprBps: input.state.currentAprBps,
        data: input.state,
      },
      update: {},
    })
  }
}
