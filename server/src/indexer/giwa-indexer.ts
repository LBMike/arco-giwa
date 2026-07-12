import type { IndexedEventInput, RedemptionRequestIndexInput } from "../services/types.js"
import type { GiwaDeploymentRegistry, RegistryProduct } from "../registry/types.js"
import { decodeIndexedEventLog, type RawEvmLog } from "./event-decoder.js"
import { productForVault, productIndexedAddresses, registryIndexedAddresses } from "./registry-addresses.js"

export type EvmBlock = {
  readonly number: bigint
  readonly hash: `0x${string}` | null
  readonly timestamp: bigint
}

export type GiwaIndexerRpc = {
  getChainId(): Promise<number>
  getBlockNumber(): Promise<bigint>
  getBlock(args: { blockNumber: bigint }): Promise<EvmBlock>
  getLogs(args: {
    addresses: readonly `0x${string}`[]
    fromBlock: bigint
    toBlock: bigint
  }): Promise<RawEvmLog[]>
}

export type GiwaIndexerCursor = {
  readonly fromBlock: bigint | number
  readonly lastBlock: bigint | number
  readonly lastBlockHash?: string | null
  readonly lagBlocks?: number
}

export type GiwaIndexerStore = {
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
  upsertRedemptionRequest(input: RedemptionRequestIndexInput): Promise<unknown>
  markRedemptionFulfilled(input: {
    chainId: number
    redemptionVaultAddress: string
    requestId: string
    txHash: string
  }): Promise<unknown>
  markRedemptionClaimed(input: {
    chainId: number
    redemptionVaultAddress: string
    requestId: string
    txHash: string
  }): Promise<unknown>
}

export type GiwaIndexerPollResult = {
  readonly indexedEvents: number
  readonly fromBlock: bigint
  readonly toBlock: bigint
  readonly latestBlock: bigint
  readonly lagBlocks: number
  readonly reorgDetected: boolean
}

function toBigInt(value: bigint | number): bigint {
  return typeof value === "bigint" ? value : BigInt(value)
}

function max(a: bigint, b: bigint) {
  return a > b ? a : b
}

function min(a: bigint, b: bigint) {
  return a < b ? a : b
}

function argString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "number") return String(value)
  return typeof value === "string" ? value : null
}

export class GiwaIndexer {
  // Last successfully-loaded registry — used when a live reload throws so the poller never crashes.
  private lastGoodRegistry: GiwaDeploymentRegistry
  // In-memory record of products already reconciled this process (backfill marker confirmed), so
  // steady-state polls skip the per-product marker read. Rebuilt from the store after a restart.
  private readonly seenProducts = new Set<string>()
  // Whether the one-time baseline seeding ("__seeded__" sentinel) has been checked this process.
  private seeded = false

  constructor(
    private readonly options: {
      // Registry is loaded FRESH each poll so vaults registered after startup are picked up
      // without a restart (mirrors EvmMarketService's per-request loadRegistry).
      readonly loadRegistry: () => GiwaDeploymentRegistry
      readonly rpc: GiwaIndexerRpc
      readonly store: GiwaIndexerStore
      readonly confirmations: number
      readonly maxBlockRange: bigint
      readonly cursorName?: string
      readonly reorgDepth?: bigint
    },
  ) {
    this.lastGoodRegistry = options.loadRegistry()
  }

  private cursorName(): string {
    return this.options.cursorName ?? "giwa"
  }

  // Fresh registry each poll; guarded so a transient read/parse error keeps the last-good copy
  // instead of crashing the poller.
  private currentRegistry(): GiwaDeploymentRegistry {
    try {
      const registry = this.options.loadRegistry()
      this.lastGoodRegistry = registry
      return registry
    } catch (error) {
      console.warn(
        `[giwa-indexer] registry reload failed; keeping last-good: ${error instanceof Error ? error.message : String(error)}`,
      )
      return this.lastGoodRegistry
    }
  }

  async pollOnce(): Promise<GiwaIndexerPollResult> {
    const registry = this.currentRegistry()
    const chainId = await this.options.rpc.getChainId()
    if (chainId !== registry.chainId) {
      throw new Error(`RPC chainId ${chainId} does not match registry chainId ${registry.chainId}`)
    }

    const startBlock = BigInt(registry.deploymentBlock ?? 0)
    const latestBlock = await this.options.rpc.getBlockNumber()
    const confirmedBlock = latestBlock - BigInt(this.options.confirmations)
    if (confirmedBlock < startBlock) {
      return {
        indexedEvents: 0,
        fromBlock: startBlock,
        toBlock: startBlock,
        latestBlock,
        lagBlocks: Number(latestBlock - startBlock),
        reorgDetected: false,
      }
    }

    const cursorName = this.cursorName()
    const cursor = await this.options.store.getCursor(registry.chainId, cursorName)
    const cursorLastBlock = cursor ? toBigInt(cursor.lastBlock) : null

    // Gap-backfill vaults registered after the indexed address set was last established, so
    // "register a vault → it gets indexed" without a manual backfill/restart. Runs before the
    // forward poll and is a no-op once every current vault has a backfill marker.
    await this.reconcileNewVaults(registry, registry.chainId, cursorLastBlock)

    let fromBlock = cursor ? toBigInt(cursor.lastBlock) + 1n : startBlock
    let reorgDetected = false

    if (cursor?.lastBlockHash) {
      const lastBlock = toBigInt(cursor.lastBlock)
      const canonical = await this.options.rpc.getBlock({ blockNumber: lastBlock })
      if (canonical.hash && canonical.hash.toLowerCase() !== cursor.lastBlockHash.toLowerCase()) {
        reorgDetected = true
        fromBlock = max(startBlock, lastBlock - (this.options.reorgDepth ?? 12n))
      }
    }

    if (fromBlock > confirmedBlock) {
      const lagBlocks = Number(latestBlock - toBigInt(cursor?.lastBlock ?? startBlock))
      await this.options.store.upsertCursor({
        chainId: registry.chainId,
        name: cursorName,
        fromBlock: startBlock,
        lastBlock: toBigInt(cursor?.lastBlock ?? startBlock),
        lastBlockHash: cursor?.lastBlockHash ?? null,
        confirmations: this.options.confirmations,
        lagBlocks,
      })
      return {
        indexedEvents: 0,
        fromBlock,
        toBlock: confirmedBlock,
        latestBlock,
        lagBlocks,
        reorgDetected,
      }
    }

    const toBlock = min(confirmedBlock, fromBlock + this.options.maxBlockRange - 1n)
    const addresses = registryIndexedAddresses(registry)
    const logs = addresses.length ? await this.options.rpc.getLogs({ addresses, fromBlock, toBlock }) : []
    let indexedEvents = 0
    const blockTimestamps = new Map<string, Date>()
    for (const log of logs) {
      if (await this.indexLog(registry, registry.chainId, log, blockTimestamps)) indexedEvents += 1
    }

    const lastBlock = await this.options.rpc.getBlock({ blockNumber: toBlock })
    const lagBlocks = Number(latestBlock - toBlock)
    await this.options.store.upsertCursor({
      chainId: registry.chainId,
      name: cursorName,
      fromBlock: startBlock,
      lastBlock: toBlock,
      lastBlockHash: lastBlock.hash,
      confirmations: this.options.confirmations,
      lagBlocks,
    })

    return { indexedEvents, fromBlock, toBlock, latestBlock, lagBlocks, reorgDetected }
  }

  async backfill(fromBlock: bigint, toBlock: bigint) {
    const registry = this.currentRegistry()
    const addresses = registryIndexedAddresses(registry)
    const logs = addresses.length ? await this.options.rpc.getLogs({ addresses, fromBlock, toBlock }) : []
    let indexedEvents = 0
    const blockTimestamps = new Map<string, Date>()
    for (const log of logs) {
      if (await this.indexLog(registry, registry.chainId, log, blockTimestamps)) indexedEvents += 1
    }
    return { indexedEvents, fromBlock, toBlock }
  }

  // Decode + persist one log (indexed event + any redemption-request side effect). Returns whether
  // it was a recognized/indexed event. Shared by the forward poll, the env-backfill, and the
  // per-vault gap-backfill so all three stay identical.
  private async indexLog(
    registry: GiwaDeploymentRegistry,
    chainId: number,
    log: RawEvmLog,
    blockTimestamps: Map<string, Date>,
  ): Promise<boolean> {
    const decoded = decodeIndexedEventLog(log)
    if (!decoded) return false
    await this.options.store.insertIndexedEvent({
      chainId,
      contractAddress: log.address,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      eventName: decoded.eventName,
      args: decoded.args,
      removed: log.removed ?? false,
      blockTimestamp: await this.blockTimestampFor(blockTimestamps, log.blockNumber),
    })
    await this.handleRedemptionEvent(registry, chainId, log, decoded.eventName, decoded.args)
    return true
  }

  // Backfill markers reuse the cursor table (name "<cursor>:backfill:<id>") → no migration, and a
  // restart never re-backfills. A one-time "__seeded__" sentinel records the CURRENT vault set as
  // already-handled at adoption (they are covered by the pre-existing forward poll / prior
  // backfills), so ONLY vaults registered later get gap-backfilled.
  private backfillMarkerName(productId: string): string {
    return `${this.cursorName()}:backfill:${productId}`
  }

  private async writeBackfillMarker(chainId: number, name: string, block: bigint): Promise<void> {
    await this.options.store.upsertCursor({
      chainId,
      name,
      fromBlock: block,
      lastBlock: block,
      lastBlockHash: null,
      confirmations: 0,
      lagBlocks: 0,
    })
  }

  private async reconcileNewVaults(
    registry: GiwaDeploymentRegistry,
    chainId: number,
    cursorLastBlock: bigint | null,
  ): Promise<void> {
    // One-time baseline seeding: the first time this indexer adopts the reconcile logic, record
    // every current vault as handled WITHOUT backfilling (they are already covered by the existing
    // forward poll / prior manual backfills). Avoids a massive re-index of established vaults.
    if (!this.seeded) {
      const seededName = this.backfillMarkerName("__seeded__")
      const alreadySeeded = await this.options.store.getCursor(chainId, seededName)
      this.seeded = true
      if (!alreadySeeded) {
        const seedBlock = cursorLastBlock ?? BigInt(registry.deploymentBlock ?? 0)
        for (const product of registry.products) {
          await this.writeBackfillMarker(chainId, this.backfillMarkerName(product.productId), seedBlock)
          this.seenProducts.add(product.productId)
        }
        await this.writeBackfillMarker(chainId, seededName, seedBlock)
        return // everything current is now seeded; nothing new to gap-backfill this poll
      }
    }

    for (const product of registry.products) {
      if (this.seenProducts.has(product.productId)) continue
      const markerName = this.backfillMarkerName(product.productId)
      if (await this.options.store.getCursor(chainId, markerName)) {
        this.seenProducts.add(product.productId) // handled by a prior process (restart)
        continue
      }

      const deployBlock = BigInt(product.deploymentBlock ?? registry.deploymentBlock ?? 0)
      try {
        if (cursorLastBlock == null || deployBlock > cursorLastBlock) {
          // No gap: the forward poll will reach this vault's first events. Just record it.
          await this.writeBackfillMarker(chainId, markerName, cursorLastBlock ?? deployBlock)
        } else {
          // Gap: [deployBlock, cursorLastBlock] was polled before this vault's addresses joined the
          // set → backfill it (chunked by maxBlockRange), then record the marker.
          await this.gapBackfillProduct(registry, product, chainId, deployBlock, cursorLastBlock)
          await this.writeBackfillMarker(chainId, markerName, cursorLastBlock)
        }
        this.seenProducts.add(product.productId)
      } catch (error) {
        // Leave the marker unset (and out of seenProducts) so the gap is retried next poll; never
        // crash the poller or block the other vaults.
        console.warn(
          `[giwa-indexer] gap-backfill failed for ${product.productId}; will retry: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  private async gapBackfillProduct(
    registry: GiwaDeploymentRegistry,
    product: RegistryProduct,
    chainId: number,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<void> {
    const addresses = productIndexedAddresses(product)
    if (!addresses.length) return
    const blockTimestamps = new Map<string, Date>()
    for (let lo = fromBlock; lo <= toBlock; lo += this.options.maxBlockRange) {
      const hi = min(lo + this.options.maxBlockRange - 1n, toBlock)
      const logs = await this.options.rpc.getLogs({ addresses, fromBlock: lo, toBlock: hi })
      for (const log of logs) {
        await this.indexLog(registry, chainId, log, blockTimestamps)
      }
    }
  }

  // Resolve (and cache within a batch) a block's wall-clock time from its on-chain timestamp, so
  // every indexed event can persist blockTimestamp with at most one getBlock per block.
  private async blockTimestampFor(cache: Map<string, Date>, blockNumber: bigint): Promise<Date> {
    const key = blockNumber.toString()
    const cached = cache.get(key)
    if (cached) return cached
    const block = await this.options.rpc.getBlock({ blockNumber })
    const timestamp = new Date(Number(block.timestamp) * 1000)
    cache.set(key, timestamp)
    return timestamp
  }

  private async handleRedemptionEvent(
    registry: GiwaDeploymentRegistry,
    chainId: number,
    log: RawEvmLog,
    eventName: string,
    args: Record<string, unknown>,
  ) {
    const requestId = argString(args, "requestId")
    if (!requestId) return

    if (eventName === "ProductRedeemRequested") {
      const product = productForVault(registry, log.address)
      if (!product) return
      await this.options.store.upsertRedemptionRequest({
        chainId,
        requestId,
        walletAddress: argString(args, "sender") ?? "",
        productId: product.productId,
        productTokenAddress: product.productToken.proxy ?? "",
        redemptionVaultAddress: log.address,
        sharesIn: argString(args, "sharesIn") ?? "0",
        lockedAssetsOut: argString(args, "assetsOut") ?? "0",
        requestedTxHash: log.transactionHash,
        requestedAtBlock: log.blockNumber,
        metadata: {
          recipient: argString(args, "recipient"),
          productRate: argString(args, "productRate"),
          paymentRate: argString(args, "paymentRate"),
        },
      })
    }

    if (eventName === "ProductRedeemFulfilled") {
      await this.options.store.markRedemptionFulfilled({
        chainId,
        redemptionVaultAddress: log.address,
        requestId,
        txHash: log.transactionHash,
      })
    }

    if (eventName === "ProductRedeemClaimed") {
      await this.options.store.markRedemptionClaimed({
        chainId,
        redemptionVaultAddress: log.address,
        requestId,
        txHash: log.transactionHash,
      })
    }
  }
}
