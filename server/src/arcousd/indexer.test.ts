import assert from "node:assert/strict"
import test from "node:test"
import { encodeAbiParameters, encodeEventTopics, type AbiEvent, type Hex } from "viem"
import type { RawEvmLog } from "../indexer/event-decoder.js"
import type { GiwaIndexerCursor, GiwaIndexerRpc } from "../indexer/giwa-indexer.js"
import type { IndexedEventInput } from "../services/types.js"
import { reserveEventsAbi, routerEventsAbi } from "./abi.js"
import {
  ArcoUSDIndexer,
  REDEEM_TRANSITION_FROM,
  type ArcoUSDIndexerStore,
  type RedeemQueuedInput,
  type RedeemStatus,
  type RedeemTransitionInput,
  type ReserveSnapshotInput,
} from "./indexer.js"
import type { ReserveState } from "./reader.js"
import type { ArcoUSDRegistryFile } from "./registry.js"
import { PrismaArcoUSDIndexerStore } from "./store.js"

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
const RESERVE = A(0xabc)
const ROUTER = A(0xdef)
const VAULT = A(0x71)
const OWNER = A(0x11)
const USDC = A(0xc1)

const registry: ArcoUSDRegistryFile = {
  schemaVersion: 1,
  chainId: 91342,
  network: "giwa-sepolia",
  deployed: true,
  deploymentBlock: 100,
  arcoUSD: { proxy: A(1), implementation: A(2), bytecodeHash: null },
  reserve: { proxy: RESERVE, implementation: A(4), bytecodeHash: null },
  lens: { address: A(5), bytecodeHash: null },
  testAssets: [],
  reserveAssets: [{ symbol: "tUSDC", address: USDC, decimals: 6, minQueued: "1000000", instantFeeBps: 0 }],
  strategies: [],
  params: { mintCap: "1", mmfTargetBps: 5000, bufferFloorBps: 3000, queueMinDelay: 600 },
}

function log(
  eventName: string,
  args: Record<string, unknown>,
  blockNumber: bigint,
  logIndex: number,
  address = RESERVE,
  abi: readonly AbiEvent[] = reserveEventsAbi as readonly AbiEvent[],
): RawEvmLog {
  const event = abi.find((item) => item.name === eventName) as AbiEvent
  const topics = encodeEventTopics({ abi: [event], eventName, args } as never) as Hex[]
  const data = encodeAbiParameters(
    event.inputs.filter((input) => !input.indexed),
    event.inputs.filter((input) => !input.indexed).map((input) => args[input.name!]),
  )
  return {
    address,
    blockNumber,
    blockHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    transactionHash: `0x${(blockNumber * 1000n + BigInt(logIndex)).toString(16).padStart(64, "0")}`,
    logIndex,
    data,
    topics,
  }
}

const queued = (requestId: bigint, block: bigint, logIndex = 0) =>
  log("RedeemQueued", { requestId, owner: OWNER, recipient: OWNER, asset: USDC, arcoUSDIn: 5n * 10n ** 18n, assetOut: 5_000_000n, requestedAt: 1_700_000_000n }, block, logIndex)
const paid = (requestId: bigint, block: bigint, logIndex = 0) =>
  log("RedeemPaid", { requestId, recipient: OWNER, asset: USDC, assetOut: 5_000_000n }, block, logIndex)
const failed = (requestId: bigint, block: bigint, logIndex = 0) =>
  log("RedeemPayoutFailed", { requestId, recipient: OWNER, asset: USDC, assetOut: 5_000_000n }, block, logIndex)
const cancelled = (requestId: bigint, block: bigint, logIndex = 0) =>
  log("RedeemCancelled", { requestId, owner: OWNER, arcoUSDReturned: 5n * 10n ** 18n }, block, logIndex)

class FakeRpc implements GiwaIndexerRpc {
  latest = 200n
  chainId = 91342
  calls = 0
  hashSalt = ""
  logs: RawEvmLog[] = []
  requested: (readonly `0x${string}`[])[] = []
  async getChainId() {
    this.calls++
    return this.chainId
  }
  async getBlockNumber() {
    this.calls++
    return this.latest
  }
  async getBlock({ blockNumber }: { blockNumber: bigint }) {
    this.calls++
    return {
      number: blockNumber,
      hash: `0x${this.hashSalt}${blockNumber.toString(16)}`.padEnd(66, "0") as `0x${string}`,
      timestamp: 1_700_000_000n + blockNumber,
    }
  }
  async getLogs(args: { addresses: readonly `0x${string}`[]; fromBlock: bigint; toBlock: bigint }) {
    this.calls++
    this.requested.push(args.addresses)
    const wanted = new Set(args.addresses.map((address) => address.toLowerCase()))
    return this.logs.filter(
      (entry) => wanted.has(entry.address.toLowerCase()) && entry.blockNumber >= args.fromBlock && entry.blockNumber <= args.toBlock,
    )
  }
}

type Row = RedeemQueuedInput & { status: RedeemStatus; txs: Partial<Record<RedeemStatus, string>> }

class FakeStore implements ArcoUSDIndexerStore {
  cursors = new Map<string, GiwaIndexerCursor>()
  events = new Map<string, IndexedEventInput>()
  requests = new Map<string, Row>()
  snapshots: ReserveSnapshotInput[] = []
  async getCursor(chainId: number, name: string) {
    return this.cursors.get(`${chainId}:${name}`) ?? null
  }
  async upsertCursor(input: { chainId: number; name: string; fromBlock: bigint; lastBlock: bigint; lastBlockHash: string | null }) {
    this.cursors.set(`${input.chainId}:${input.name}`, input)
  }
  async insertIndexedEvent(input: IndexedEventInput) {
    const key = `${input.txHash}:${input.logIndex}`
    if (!this.events.has(key)) this.events.set(key, input)
  }
  async recordRedeemQueued(input: RedeemQueuedInput) {
    if (!this.requests.has(input.requestId)) this.requests.set(input.requestId, { ...input, status: "QUEUED", txs: {} })
  }
  async transitionRedeem(input: RedeemTransitionInput) {
    const row = this.requests.get(input.requestId)
    if (!row || !REDEEM_TRANSITION_FROM[input.to].includes(row.status)) return 0
    row.status = input.to
    row.txs[input.to] = input.txHash
    return 1
  }
  async insertSnapshot(input: ReserveSnapshotInput) {
    if (!this.snapshots.some((s) => s.blockNumber === input.blockNumber)) this.snapshots.push(input)
  }
}

const reserveState = (blockNumber: bigint) => ({ blockNumber: blockNumber.toString(), totalBacking: "1", totalLiabilities: "1", navOk: true, mmfBps: 0, reservePaused: false, settlementPaused: false }) as ReserveState

function setup(overrides: { loadRegistry?: () => ArcoUSDRegistryFile | null; readState?: () => Promise<ReserveState> } = {}) {
  const rpc = new FakeRpc()
  const store = new FakeStore()
  let now = 0
  const indexer = new ArcoUSDIndexer({
    loadRegistry: overrides.loadRegistry ?? (() => registry),
    rpc,
    store,
    readState: overrides.readState ?? (async () => reserveState(rpc.latest)),
    confirmations: 2,
    maxBlockRange: 1000n,
    snapshotIntervalMs: 300_000,
    now: () => now,
  })
  return { rpc, store, indexer, advance: (ms: number) => (now += ms) }
}

test("inert without a deployed registry: no RPC traffic at all", async () => {
  const { rpc, indexer } = setup({ loadRegistry: () => null })
  assert.equal((await indexer.pollOnce()).mode, "inert")
  const undeployed = setup({ loadRegistry: () => ({ ...registry, deployed: false }) })
  assert.equal((await undeployed.indexer.pollOnce()).mode, "inert")
  assert.equal(rpc.calls + undeployed.rpc.calls, 0)
})

test("a registry on another chain fails loudly", async () => {
  const { rpc, indexer } = setup()
  rpc.chainId = 1
  await assert.rejects(indexer.pollOnce(), /chainId/)
})

test("indexes Reserve events and drives request status forward only", async () => {
  const { rpc, store, indexer } = setup()
  rpc.logs = [
    log("Deposited", { sender: OWNER, recipient: OWNER, asset: USDC, assetAmount: 10_000_000n, arcoUSDOut: 10n * 10n ** 18n, fee: 0n }, 110n, 0),
    queued(1n, 120n),
    queued(2n, 121n),
    paid(1n, 150n),
    failed(2n, 151n),
    cancelled(2n, 160n),
    queued(3n, 170n),
    cancelled(3n, 199n), // beyond the confirmed head (200 - 2): next poll
    log("Deposited", { sender: OWNER, recipient: OWNER, asset: USDC, assetAmount: 1n, arcoUSDOut: 1n, fee: 0n }, 130n, 0, A(0xdead)), // other contract
  ]
  const first = await indexer.pollOnce()
  assert.equal(first.mode, "poll")
  if (first.mode !== "poll") return
  assert.deepEqual([first.fromBlock, first.toBlock, first.indexedEvents, first.staleTransitions], [100n, 198n, 7, 0])
  assert.equal(first.snapshot, "taken")
  assert.equal(store.requests.get("1")?.status, "PAID")
  assert.equal(store.requests.get("2")?.status, "CANCELLED")
  assert.equal(store.requests.get("3")?.status, "QUEUED")
  const row = store.requests.get("1")!
  assert.equal(row.owner, OWNER.toLowerCase())
  assert.equal(row.arcoUSDAmount, (5n * 10n ** 18n).toString())
  assert.equal(row.requestedAt.toISOString(), new Date(1_700_000_000_000).toISOString())
  const deposited = [...store.events.values()].find((event) => event.eventName === "Deposited")!
  assert.equal(deposited.contractAddress, RESERVE.toLowerCase())
  assert.equal((deposited.args as Record<string, unknown>).walletAddress, undefined) // kept out of Activity
  assert.equal((deposited.args as Record<string, unknown>).arcoUSDOut, (10n * 10n ** 18n).toString())

  assert.deepEqual(rpc.requested[0], [RESERVE.toLowerCase()]) // no Router in this registry

  rpc.latest = 210n
  const second = await indexer.pollOnce()
  assert.equal(second.mode === "poll" && second.fromBlock, 199n)
  assert.equal(store.requests.get("3")?.status, "CANCELLED")
})

test("indexes Router events beside the Reserve's, each decoded with its own contract's ABI", async () => {
  const withRouter: ArcoUSDRegistryFile = {
    ...registry,
    router: { proxy: ROUTER, implementation: A(6), bytecodeHash: null },
    routerVaults: [{ productId: "umint", configured: true }],
  }
  const { rpc, store, indexer } = setup({ loadRegistry: () => withRouter })
  const routerLog = (eventName: string, args: Record<string, unknown>, block: bigint, logIndex = 0) =>
    log(eventName, args, block, logIndex, ROUTER, routerEventsAbi as readonly AbiEvent[])
  rpc.logs = [
    log("Deposited", { sender: ROUTER, recipient: ROUTER, asset: USDC, assetAmount: 1_000_000n, arcoUSDOut: 999n * 10n ** 15n, fee: 10n ** 15n }, 110n, 0),
    routerLog("VaultAllowed", { depositVault: VAULT, paymentToken: USDC, allowed: true }, 105n),
    routerLog(
      "Bought",
      { payer: OWNER, recipient: OWNER, depositVault: VAULT, payAsset: USDC, payAmount: 1_000_000n, arcoUSDSettled: 999n * 10n ** 15n, paymentAmount: 999_000n, result: 7n, request: true },
      110n,
      1,
    ),
    queued(1n, 120n),
    // A Reserve-shaped log from the Router address is not a Router event: skipped, never a transition.
    log("RedeemCancelled", { requestId: 1n, owner: OWNER, arcoUSDReturned: 1n }, 130n, 0, ROUTER),
  ]
  const result = await indexer.pollOnce()
  assert.equal(result.mode === "poll" && result.indexedEvents, 4)
  assert.deepEqual(rpc.requested[0], [RESERVE.toLowerCase(), ROUTER.toLowerCase()])
  const bought = [...store.events.values()].find((event) => event.eventName === "Bought")!
  assert.equal(bought.contractAddress, ROUTER.toLowerCase())
  const args = bought.args as Record<string, unknown>
  assert.deepEqual([args.payer, args.result, args.request, args.walletAddress], [OWNER.toLowerCase(), "7", true, undefined])
  assert.equal([...store.events.values()].find((event) => event.eventName === "Deposited")?.contractAddress, RESERVE.toLowerCase())
  assert.equal((store.events.size), 4)
  assert.equal(store.requests.get("1")?.status, "QUEUED")
})

test("a reorg replays the window without regressing any request", async () => {
  const { rpc, store, indexer } = setup()
  rpc.logs = [queued(1n, 180n), failed(1n, 185n), cancelled(1n, 190n)]
  await indexer.pollOnce()
  assert.equal(store.requests.get("1")?.status, "CANCELLED")

  rpc.hashSalt = "f" // every block hash changes: the cursor's last block no longer matches
  rpc.latest = 201n
  const replay = await indexer.pollOnce()
  assert.equal(replay.mode === "poll" && replay.reorgDetected, true)
  assert.equal(replay.mode === "poll" && replay.fromBlock, 186n) // 198 − 12
  assert.equal(replay.mode === "poll" && replay.staleTransitions, 1) // the replayed cancel is a no-op
  assert.equal(store.requests.get("1")?.status, "CANCELLED")
  assert.equal(store.events.size, 3) // replayed events are idempotent
})

test("snapshots follow the interval, and a failing read never blocks event indexing", async () => {
  let fail = true
  const { rpc, store, indexer, advance } = setup({
    readState: async () => {
      if (fail) throw new Error("lens down")
      return reserveState(190n)
    },
  })
  rpc.logs = [queued(1n, 150n)]
  const first = await indexer.pollOnce()
  assert.equal(first.mode === "poll" && first.snapshot, "failed")
  assert.equal(store.requests.get("1")?.status, "QUEUED")

  advance(30_000)
  assert.equal(((await indexer.pollOnce()) as { snapshot: string }).snapshot, "not-due") // retry waits 60s
  fail = false
  advance(30_000)
  assert.equal(((await indexer.pollOnce()) as { snapshot: string }).snapshot, "taken")
  assert.equal(store.snapshots[0].takenAt.getTime(), (1_700_000_000 + 190) * 1000) // block time, not wall time
  advance(299_000)
  assert.equal(((await indexer.pollOnce()) as { snapshot: string }).snapshot, "not-due")
  advance(1_000)
  assert.equal(((await indexer.pollOnce()) as { snapshot: string }).snapshot, "taken")
  assert.equal(store.snapshots.length, 1) // same block → idempotent
})

test("Prisma store: queued is create-only, transitions are conditional on the prior status", async () => {
  const calls: { op: string; args: Record<string, any> }[] = []
  const prisma = {
    arcoUSDRedeemRequest: {
      upsert: async (args: unknown) => void calls.push({ op: "upsert", args: args as Record<string, any> }),
      updateMany: async (args: unknown) => {
        calls.push({ op: "updateMany", args: args as Record<string, any> })
        return { count: 0 }
      },
    },
    arcoUSDReserveSnapshot: { upsert: async (args: unknown) => void calls.push({ op: "snapshot", args: args as Record<string, any> }) },
  }
  const store = new PrismaArcoUSDIndexerStore(prisma, {} as never)
  await store.recordRedeemQueued({
    chainId: 91342,
    reserveAddress: RESERVE,
    requestId: "7",
    owner: OWNER,
    recipient: OWNER,
    asset: USDC,
    arcoUSDAmount: "1",
    assetAmount: "1",
    requestedAt: new Date(0),
    queuedTxHash: "0xAB",
    queuedBlock: 1n,
  })
  assert.deepEqual(calls[0].args.update, {})
  assert.equal(calls[0].args.create.status, "QUEUED")
  assert.equal(calls[0].args.where.chainId_reserveAddress_requestId.reserveAddress, RESERVE.toLowerCase())

  assert.equal(await store.transitionRedeem({ chainId: 91342, reserveAddress: RESERVE, requestId: "7", to: "CANCELLED", txHash: "0xCD", at: new Date(1) }), 0)
  const update = calls[1].args
  assert.deepEqual(update.where.status, { in: ["QUEUED", "PAYOUT_FAILED"] })
  assert.deepEqual(update.data, { status: "CANCELLED", cancelledTxHash: "0xcd", cancelledAt: new Date(1) })
  await store.transitionRedeem({ chainId: 91342, reserveAddress: RESERVE, requestId: "7", to: "PAID", txHash: "0x1", at: new Date(2) })
  assert.deepEqual(calls[2].args.where.status, { in: ["QUEUED"] })
  assert.deepEqual(Object.keys(calls[2].args.data), ["status", "paidTxHash", "paidAt"])
})
