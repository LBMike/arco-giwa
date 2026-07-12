import assert from "node:assert/strict"
import test from "node:test"
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, type Hex } from "viem"
import { readContractAbi } from "../evm/abi.js"
import { buildDryRunGiwaRegistry } from "../registry/generate.js"
import type { GiwaDeploymentRegistry } from "../registry/types.js"
import { GiwaIndexer, type GiwaIndexerCursor, type GiwaIndexerRpc, type GiwaIndexerStore } from "./giwa-indexer.js"
import type { RawEvmLog } from "./event-decoder.js"

const wallet = "0x00000000000000000000000000000000000000aa"

function blockHash(block: bigint): `0x${string}` {
  return `0x${block.toString(16).padStart(64, "0")}`
}

function registryWithAddresses(): GiwaDeploymentRegistry {
  const registry = structuredClone(buildDryRunGiwaRegistry(new Date("2026-06-25T00:00:00.000Z"))) as any
  const addresses = Array.from({ length: 80 }, (_value, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`)
  const next = () => addresses.shift() as `0x${string}`
  registry.activationFlags = {
    deployed: true,
    dryRun: false,
    frontendEnabled: false,
    indexerEnabled: true,
    onchainAttestationRequired: true,
  }
  registry.deploymentBlock = 10
  registry.deployer = next()
  registry.proxyAdmin = { proxy: next(), implementation: next(), bytecodeHash: "0x01" }
  registry.faucet = { proxy: next(), implementation: next(), bytecodeHash: "0x02" }
  registry.assets = registry.assets.map((asset: any) => ({
    ...asset,
    contract: { proxy: next(), implementation: next(), bytecodeHash: "0x03" },
    faucet: registry.faucet.proxy,
    deploymentBlock: 10,
  }))
  registry.products = registry.products.map((product: any) => ({
    ...product,
    productToken: { proxy: next(), implementation: next(), bytecodeHash: "0x04" },
    depositVault: { proxy: next(), implementation: next(), bytecodeHash: "0x05" },
    redemptionVault: { proxy: next(), implementation: next(), bytecodeHash: "0x06" },
    priceFeed: { proxy: next(), implementation: next(), bytecodeHash: "0x07" },
    deploymentBlock: 10,
  }))
  return registry as GiwaDeploymentRegistry
}

function redeemRequestedLog(registry: GiwaDeploymentRegistry): RawEvmLog {
  const eventAbi = readContractAbi("ArcoRedemptionVault")
  const topics = encodeEventTopics({
    abi: eventAbi,
    eventName: "ProductRedeemRequested",
    args: {
      requestId: 1n,
      sender: wallet,
      recipient: wallet,
    },
  })
  const data = encodeAbiParameters(
    parseAbiParameters("uint256 sharesIn, uint256 assetsOut, uint256 productRate, uint256 paymentRate"),
    [100n, 99n, 1_000000000000000000n, 1_000000000000000000n],
  )
  return {
    address: registry.products[0].redemptionVault.proxy as `0x${string}`,
    blockNumber: 12n,
    blockHash: blockHash(12n),
    transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    logIndex: 0,
    topics: topics as readonly Hex[],
    data,
  }
}

// ── B-test scaffolding: controlled minimal registries + a decodable PriceUpdated log ──────────
const MARK: GiwaIndexerCursor = { fromBlock: 0n, lastBlock: 0n, lastBlockHash: null, lagBlocks: 0 }

function hexAddr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}`
}
function bProduct(productId: string, deploymentBlock: number, base: number) {
  return {
    productId,
    symbol: productId,
    name: productId,
    paymentAssetSymbol: "tUSDC",
    productToken: { proxy: hexAddr(base) },
    depositVault: { proxy: hexAddr(base + 1) },
    redemptionVault: { proxy: hexAddr(base + 2) },
    priceFeed: { proxy: hexAddr(base + 3) },
    deploymentBlock,
  }
}
function bRegistry(products: ReturnType<typeof bProduct>[], deploymentBlock = 40): GiwaDeploymentRegistry {
  return { chainId: 91342, deploymentBlock, faucet: { proxy: hexAddr(0xfa) }, products } as unknown as GiwaDeploymentRegistry
}
function priceUpdatedLog(
  feed: `0x${string}`,
  block: bigint,
  answer: bigint,
  updatedAt: bigint,
  txHash: `0x${string}` = `0x${"a".repeat(64)}`,
  logIndex = 0,
): RawEvmLog {
  const eventAbi = readContractAbi("ProductPriceFeed")
  const topics = encodeEventTopics({ abi: eventAbi, eventName: "PriceUpdated", args: { roundId: 1n } })
  const data = encodeAbiParameters(parseAbiParameters("int256 answer, uint256 updatedAt"), [answer, updatedAt])
  return { address: feed, blockNumber: block, blockHash: blockHash(block), transactionHash: txHash, logIndex, topics: topics as readonly Hex[], data }
}

function mockRpc(logs: RawEvmLog[], latestBlock = 20n, hashForBlock = blockHash): GiwaIndexerRpc & { ranges: [bigint, bigint][] } {
  const ranges: [bigint, bigint][] = []
  return {
    ranges,
    async getChainId() {
      return 91342
    },
    async getBlockNumber() {
      return latestBlock
    },
    async getBlock(args) {
      return { number: args.blockNumber, hash: hashForBlock(args.blockNumber), timestamp: 1_700_000_000n + args.blockNumber }
    },
    async getLogs(args) {
      ranges.push([args.fromBlock, args.toBlock])
      const addrs = (args.addresses ?? []).map((address) => address.toLowerCase())
      return logs.filter(
        (log) =>
          log.blockNumber >= args.fromBlock &&
          log.blockNumber <= args.toBlock &&
          (addrs.length === 0 || addrs.includes(log.address.toLowerCase())),
      )
    },
  }
}

function mockStore(): GiwaIndexerStore & {
  events: Map<string, unknown>
  redemptions: Map<string, Record<string, unknown>>
  cursors: Map<string, GiwaIndexerCursor>
} {
  return {
    events: new Map(),
    redemptions: new Map(),
    cursors: new Map(),
    async getCursor(_chainId, name) {
      return this.cursors.get(name) ?? null
    },
    async upsertCursor(input) {
      this.cursors.set(input.name, input)
    },
    async insertIndexedEvent(input) {
      this.events.set(`${input.chainId}:${input.txHash}:${input.logIndex}`, input)
    },
    async upsertRedemptionRequest(input) {
      this.redemptions.set(`${input.chainId}:${input.redemptionVaultAddress}:${input.requestId}`, {
        ...input,
        status: "REQUESTED",
      })
    },
    async markRedemptionFulfilled(input) {
      const key = `${input.chainId}:${input.redemptionVaultAddress}:${input.requestId}`
      this.redemptions.set(key, { ...this.redemptions.get(key), status: "FULFILLED", fulfilledTxHash: input.txHash })
    },
    async markRedemptionClaimed(input) {
      const key = `${input.chainId}:${input.redemptionVaultAddress}:${input.requestId}`
      this.redemptions.set(key, { ...this.redemptions.get(key), status: "CLAIMED", claimedTxHash: input.txHash })
    },
  }
}

test("indexer inserts events idempotently and preserves redemption locked assets-out", async () => {
  const registry = registryWithAddresses()
  const log = redeemRequestedLog(registry)
  const rpc = mockRpc([log])
  const store = mockStore()
  const indexer = new GiwaIndexer({ loadRegistry: () => registry, rpc, store, confirmations: 2, maxBlockRange: 500n })

  const first = await indexer.pollOnce()
  await indexer.backfill(10n, 18n)

  assert.equal(first.indexedEvents, 1)
  assert.equal(store.events.size, 1)
  const event = Array.from(store.events.values())[0] as { blockTimestamp?: Date }
  assert.ok(event.blockTimestamp instanceof Date) // block time captured from the (mock) chain
  assert.equal(event.blockTimestamp.getTime(), Number(1_700_000_012n) * 1000) // 1_700_000_000 + block 12
  const redemption = Array.from(store.redemptions.values())[0]
  assert.ok(redemption)
  assert.equal(redemption.lockedAssetsOut, "99")
  assert.deepEqual(rpc.ranges[0], [10n, 18n])
})

test("indexer resumes from the persisted cursor", async () => {
  const registry = registryWithAddresses()
  const rpc = mockRpc([], 25n)
  const store = mockStore()
  store.cursors.set("giwa", { fromBlock: 10n, lastBlock: 18n, lastBlockHash: blockHash(18n), lagBlocks: 2 })
  const indexer = new GiwaIndexer({ loadRegistry: () => registry, rpc, store, confirmations: 2, maxBlockRange: 500n })

  const result = await indexer.pollOnce()

  assert.equal(result.fromBlock, 19n)
  assert.equal(result.toBlock, 23n)
  assert.deepEqual(rpc.ranges[0], [19n, 23n])
})

test("indexer rewinds when the stored cursor block hash no longer matches", async () => {
  const registry = registryWithAddresses()
  const rpc = mockRpc([], 25n, (block) => (block === 18n ? blockHash(19n) : blockHash(block)))
  const store = mockStore()
  store.cursors.set("giwa", { fromBlock: 10n, lastBlock: 18n, lastBlockHash: blockHash(18n), lagBlocks: 2 })
  const indexer = new GiwaIndexer({ loadRegistry: () => registry, rpc, store, confirmations: 2, maxBlockRange: 500n, reorgDepth: 4n })

  const result = await indexer.pollOnce()

  assert.equal(result.reorgDetected, true)
  assert.equal(result.fromBlock, 14n)
  assert.deepEqual(rpc.ranges[0], [14n, 23n])
})

test("B: a vault registered after startup is gap-backfilled from its deploymentBlock (chunked) + marked", async () => {
  const productA = bProduct("acapix", 50, 0x100)
  const productX = bProduct("arcousd", 100, 0x200) // deploymentBlock 100, below the cursor
  const xLog = priceUpdatedLog(productX.priceFeed.proxy, 350n, 100_015_000n, 1000n) // in the gap [100,700]
  const registry = bRegistry([productA, productX])
  const rpc = mockRpc([xLog], 1000n)
  const store = mockStore()
  // Established indexer: cursor at 700, baseline already seeded, vault A already handled.
  store.cursors.set("giwa", { fromBlock: 40n, lastBlock: 700n, lastBlockHash: blockHash(700n), lagBlocks: 0 })
  store.cursors.set("giwa:backfill:__seeded__", MARK)
  store.cursors.set("giwa:backfill:acapix", MARK)
  const indexer = new GiwaIndexer({ loadRegistry: () => registry, rpc, store, confirmations: 2, maxBlockRange: 200n })

  await indexer.pollOnce()

  // Gap-backfill runs BEFORE the forward poll, chunked by maxBlockRange (200) over [100,700].
  assert.deepEqual(rpc.ranges.slice(0, 4), [
    [100n, 299n],
    [300n, 499n],
    [500n, 699n],
    [700n, 700n],
  ])
  assert.deepEqual(rpc.ranges[4], [701n, 900n]) // then the forward poll
  assert.equal(store.events.size, 1) // X's PriceUpdated indexed via the gap-backfill
  assert.ok(store.cursors.get("giwa:backfill:arcousd")) // marker written
})

test("B: restart does not re-backfill an already-marked vault", async () => {
  const productA = bProduct("acapix", 50, 0x100)
  const productX = bProduct("arcousd", 100, 0x200)
  const xLog = priceUpdatedLog(productX.priceFeed.proxy, 350n, 100_015_000n, 1000n)
  const registry = bRegistry([productA, productX])
  const rpc = mockRpc([xLog], 1000n)
  const store = mockStore()
  store.cursors.set("giwa", { fromBlock: 40n, lastBlock: 700n, lastBlockHash: blockHash(700n), lagBlocks: 0 })
  store.cursors.set("giwa:backfill:__seeded__", MARK)
  store.cursors.set("giwa:backfill:acapix", MARK)
  store.cursors.set("giwa:backfill:arcousd", MARK) // X already backfilled by a prior process
  const indexer = new GiwaIndexer({ loadRegistry: () => registry, rpc, store, confirmations: 2, maxBlockRange: 200n })

  await indexer.pollOnce()

  // No gap-backfill: only the forward poll ran (no range below the cursor+1).
  assert.deepEqual(rpc.ranges, [[701n, 900n]])
  assert.equal(store.events.size, 0) // X's pre-cursor log NOT re-indexed
})

test("B: first adoption seeds existing vaults WITHOUT backfilling them", async () => {
  const productA = bProduct("acapix", 50, 0x100)
  const productB = bProduct("beqty", 60, 0x200)
  const aLog = priceUpdatedLog(productA.priceFeed.proxy, 100n, 100_000_000n, 500n) // pre-cursor; must NOT be re-indexed
  const registry = bRegistry([productA, productB])
  const rpc = mockRpc([aLog], 1000n)
  const store = mockStore()
  // Established pre-B indexer: cursor exists, but NO backfill markers yet (first adoption).
  store.cursors.set("giwa", { fromBlock: 40n, lastBlock: 700n, lastBlockHash: blockHash(700n), lagBlocks: 0 })
  const indexer = new GiwaIndexer({ loadRegistry: () => registry, rpc, store, confirmations: 2, maxBlockRange: 200n })

  await indexer.pollOnce()

  assert.ok(store.cursors.get("giwa:backfill:__seeded__"))
  assert.ok(store.cursors.get("giwa:backfill:acapix"))
  assert.ok(store.cursors.get("giwa:backfill:beqty"))
  assert.deepEqual(rpc.ranges, [[701n, 900n]]) // only the forward poll — no gap-backfill
  assert.equal(store.events.size, 0) // baseline vaults NOT re-indexed from deploy
})

test("B: a vault whose deploymentBlock is ahead of the cursor is marked without a gap-backfill", async () => {
  const productA = bProduct("acapix", 50, 0x100)
  const productX = bProduct("arcousd", 800, 0x200) // deploymentBlock 800 > cursor 700
  const registry = bRegistry([productA, productX])
  const rpc = mockRpc([], 1000n)
  const store = mockStore()
  store.cursors.set("giwa", { fromBlock: 40n, lastBlock: 700n, lastBlockHash: blockHash(700n), lagBlocks: 0 })
  store.cursors.set("giwa:backfill:__seeded__", MARK)
  store.cursors.set("giwa:backfill:acapix", MARK)
  const indexer = new GiwaIndexer({ loadRegistry: () => registry, rpc, store, confirmations: 2, maxBlockRange: 200n })

  await indexer.pollOnce()

  assert.ok(store.cursors.get("giwa:backfill:arcousd")) // marked (no backfill needed)
  assert.deepEqual(rpc.ranges, [[701n, 900n]]) // forward poll only; it will cover X going forward
})

test("B: gap-backfill and the forward poll cover disjoint ranges — no double-index at the boundary", async () => {
  const productX = bProduct("arcousd", 100, 0x200)
  const feed = productX.priceFeed.proxy
  const atBoundary = priceUpdatedLog(feed, 700n, 100_010_000n, 1000n, `0x${"b".repeat(64)}`) // == cursor (gap)
  const afterBoundary = priceUpdatedLog(feed, 701n, 100_016_500n, 2000n, `0x${"c".repeat(64)}`) // == cursor+1 (forward)
  const registry = bRegistry([productX])
  const rpc = mockRpc([atBoundary, afterBoundary], 1000n)
  const store = mockStore()
  store.cursors.set("giwa", { fromBlock: 40n, lastBlock: 700n, lastBlockHash: blockHash(700n), lagBlocks: 0 })
  store.cursors.set("giwa:backfill:__seeded__", MARK) // established; X is new (no marker)
  const indexer = new GiwaIndexer({ loadRegistry: () => registry, rpc, store, confirmations: 2, maxBlockRange: 1000n })

  await indexer.pollOnce()
  assert.equal(store.events.size, 2) // boundary event via gap, after-boundary via forward — each once

  // A second poll (X now marked, cursor caught up) re-indexes nothing.
  await indexer.pollOnce()
  assert.equal(store.events.size, 2)
})
