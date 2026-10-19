import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  toEventSignature,
  toFunctionSelector,
  toFunctionSignature,
  type AbiEvent,
  type AbiFunction,
  type Hex,
} from "viem"
import type { RawEvmLog } from "../indexer/event-decoder.js"
import type { GiwaIndexerCursor, GiwaIndexerRpc } from "../indexer/giwa-indexer.js"
import type { IndexedEventInput } from "../services/types.js"
import {
  distributorAbi,
  distributorEventsAbi,
  SAVINGS_DEPOSIT_SELECTOR,
  SAVINGS_REWARDS_SELECTOR,
  SAVINGS_SEED_HOLDER,
  SAVINGS_WITHDRAW_SELECTOR,
  savingsVaultEventsAbi,
  savingsVaultReadAbi,
  savingsZapEventsAbi,
} from "./abi.js"
import type { EventRecord } from "./admin.js"
import { deployedArcoUSD, deployedSavings, validateArcoUSDRegistry, type ArcoUSDRegistryFile } from "./registry.js"
import {
  annualizedBps,
  ArcoUSDSavingsService,
  createSavingsChainReader,
  dailyCompoundedBps,
  MAX_RATE_BPS,
  PREVIEW_UNREADABLE,
  toSavingsState,
  type RawPreview,
  type RawSavings,
  type SavingsSnapshotRecord,
  type SavingsState,
} from "./savings.js"
import { ArcoUSDSavingsAdmin, createDistributeSimulator } from "./savings-admin.js"
import { ArcoUSDSavingsIndexer, PrismaSavingsIndexerStore, SAVINGS_CURSOR, type SavingsIndexerStore, type SavingsSnapshotInput } from "./savings-indexer.js"

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
const ONE = 10n ** 18n
const VAULT = A(0x51)
const DISTRIBUTOR = A(0x52)
const ZAP = A(0x53)
const USDC = A(0xc1)
const ALICE = A(0xa1)
const DEAD = SAVINGS_SEED_HOLDER.toLowerCase()

function registry(savings?: Partial<NonNullable<ArcoUSDRegistryFile["savings"]>> | null): ArcoUSDRegistryFile {
  return {
    schemaVersion: 1,
    chainId: 91342,
    network: "giwa-sepolia",
    deployed: true,
    deploymentBlock: 100,
    arcoUSD: { proxy: A(1), implementation: A(2), bytecodeHash: null },
    reserve: { proxy: A(3), implementation: A(4), bytecodeHash: null },
    lens: { address: A(5), bytecodeHash: null },
    testAssets: [],
    reserveAssets: [{ symbol: "tUSDC", address: USDC, decimals: 6, minQueued: "1", instantFeeBps: 0, swapFeeBps: 0 }],
    strategies: [],
    params: { mintCap: "1", mmfTargetBps: 5000, bufferFloorBps: 3000, queueMinDelay: 600 },
    ...(savings === null
      ? {}
      : {
          savings: {
            vault: { proxy: VAULT, implementation: A(0x50), bytecodeHash: null, blockNumber: 150 },
            distributor: { address: DISTRIBUTOR, bytecodeHash: null, blockNumber: 151 },
            zap: { address: ZAP, bytecodeHash: null, blockNumber: 152 },
            seeded: true,
            ...savings,
          },
        }),
  }
}

// ─────────────────────────────── ABIs ───────────────────────────────

test("savings ABIs match the compiled sArcoUSD, distributor and Zap artifacts (no drift)", () => {
  const artifact = (name: string) =>
    JSON.parse(readFileSync(join(process.cwd(), `packages/contracts/artifacts/contracts/arcousd/${name}.sol/${name}.json`), "utf8"))
      .abi as (AbiEvent | AbiFunction)[]
  const events = (name: string) =>
    artifact(name)
      .filter((item): item is AbiEvent => item.type === "event")
      .map((event) => toEventSignature(event))
      .sort()
  const inline = (abi: readonly unknown[]) => (abi as AbiEvent[]).map((event) => toEventSignature(event)).sort()
  assert.deepEqual(inline(savingsVaultEventsAbi), events("SArcoUSD"))
  assert.deepEqual(inline(distributorEventsAbi), events("ArcoUSDSavingsDistributor"))
  assert.deepEqual(inline(savingsZapEventsAbi), events("ArcoSavingsZap"))
  // Decoded arg names drive the admin view (Deposit.owner, Distributed.surplus…).
  const named = (list: readonly AbiEvent[]) =>
    JSON.stringify([...list].sort((a, b) => a.name.localeCompare(b.name)).map((event) => [event.name, event.inputs.map((input) => [input.name, input.indexed ?? false])]))
  for (const [abi, name] of [
    [savingsVaultEventsAbi, "SArcoUSD"],
    [distributorEventsAbi, "ArcoUSDSavingsDistributor"],
    [savingsZapEventsAbi, "ArcoSavingsZap"],
  ] as const) {
    assert.equal(named(abi as readonly AbiEvent[]), named(artifact(name).filter((item): item is AbiEvent => item.type === "event")), name)
  }

  // Every function read or sent exists with the same outputs.
  const outputs = (fn: AbiFunction) => JSON.stringify(fn.outputs.map((output) => output.type))
  for (const [abi, name] of [
    [savingsVaultReadAbi, "SArcoUSD"],
    [distributorAbi, "ArcoUSDSavingsDistributor"],
  ] as const) {
    const compiled = artifact(name).filter((item): item is AbiFunction => item.type === "function")
    for (const item of abi as readonly (AbiFunction | { type: string })[]) {
      if (item.type !== "function") continue
      const fn = item as AbiFunction
      const match = compiled.find((candidate) => toFunctionSignature(candidate) === toFunctionSignature(fn))
      assert.ok(match, `${name} has no ${toFunctionSignature(fn)}`)
      assert.equal(outputs(fn), outputs(match), `${name}.${fn.name} outputs differ`)
    }
  }
  const selectors = artifact("SArcoUSD")
    .filter((item): item is AbiFunction => item.type === "function")
    .map((fn) => toFunctionSelector(toFunctionSignature(fn)))
  for (const selector of [SAVINGS_DEPOSIT_SELECTOR, SAVINGS_WITHDRAW_SELECTOR, SAVINGS_REWARDS_SELECTOR]) assert.ok(selectors.includes(selector))
  const errors = artifact("ArcoUSDSavingsDistributor").filter((item) => (item as { type: string }).type === "error").map((item) => item.name)
  for (const item of distributorAbi) if (item.type === "error") assert.ok(errors.includes(item.name), `no error ${item.name}`)
})

// ─────────────────────────────── registry ───────────────────────────────

test("Savings is live only once all three contracts are recorded and none is pending", () => {
  assert.equal(deployedSavings(registry(null)), null)
  assert.equal(deployedSavings(registry({ zap: { address: null, bytecodeHash: null } })), null)
  assert.equal(deployedSavings(registry({ distributor: { address: DISTRIBUTOR, bytecodeHash: null, pending: true } })), null)
  assert.deepEqual(deployedSavings(registry()), { vaultAddress: VAULT, distributorAddress: DISTRIBUTOR, zapAddress: ZAP, reserveAddress: A(3), arcoUSDAddress: A(1), startBlock: 150, seeded: true })
  // Without deploy blocks the indexer starts at the ArcoUSD deployment block.
  const noBlocks = registry({
    vault: { proxy: VAULT, implementation: null, bytecodeHash: null },
    distributor: { address: DISTRIBUTOR, bytecodeHash: null },
    zap: { address: ZAP, bytecodeHash: null },
    seeded: false,
  })
  assert.deepEqual(deployedSavings(noBlocks), { vaultAddress: VAULT, distributorAddress: DISTRIBUTOR, zapAddress: ZAP, reserveAddress: A(3), arcoUSDAddress: A(1), startBlock: 100, seeded: false })
  assert.equal(deployedArcoUSD(registry(null), 91342)!.savings, null)
  assert.equal(deployedArcoUSD(registry(), 91342)!.savings!.zapAddress, ZAP)
  assert.match(validateArcoUSDRegistry(registry({ zap: { address: "0xnope" as never, bytecodeHash: null } }), 91342).join(";"), /savings\.zap\.address/)
})

// ─────────────────────────────── state ───────────────────────────────

const RAW: RawSavings = {
  blockNumber: 500n,
  totalAssets: 10_000n * ONE,
  totalSupply: 9_900n * ONE,
  sharePrice: (ONE * 10_000n) / 9_900n,
  unvested: 5n * ONE,
  vestingAmount: 6n * ONE,
  vestingStart: 1_760_000_000n,
  vestingPeriod: 86_400n,
  rewardRate: (6n * ONE) / 86_400n,
  seedShares: ONE,
  minShares: ONE,
  vaultPaused: false,
  depositPaused: false,
  withdrawPaused: false,
  rewardsPaused: false,
  distributorPaused: false,
  minInterval: 86_400n,
  maxAprBps: 2000n,
  reserveMarginBps: 50n,
  lastDistribution: 1_760_000_000n,
  reservePaused: false,
  arcoUSDMintPaused: false,
}
const PREVIEW: RawPreview = [2n * ONE, 3n * ONE, 5n * ONE, 100n * ONE, 1_760_086_400n, true]

test("toSavingsState: APR of what is vesting, the seed, and open/closed paths", () => {
  const state = toSavingsState(RAW, PREVIEW)
  assert.equal(state.totalAssetsUsd, "10000")
  // 6/day on 10,000 = 0.06%/day ≈ 21.9% APR (2190 bps); daily compounding ≈ 24.47%.
  assert.equal(state.currentAprBps, 2189)
  assert.equal(state.currentApyBps, dailyCompoundedBps(2189))
  assert.ok(state.currentApyBps > state.currentAprBps)
  assert.deepEqual([state.seeded, state.depositsOpen, state.withdrawalsOpen], [true, true, true])
  assert.equal(state.vestingEndsAt, new Date((1_760_000_000 + 86_400) * 1000).toISOString())
  assert.equal(state.distributor.nextDistributionAt, new Date((1_760_000_000 + 86_400) * 1000).toISOString())
  assert.deepEqual(state.distributor.preview, { amount: (2n * ONE).toString(), amountUsd: "2", surplus: (3n * ONE).toString(), rateCap: (5n * ONE).toString(), mintHeadroom: (100n * ONE).toString(), navOk: true })

  // vestingAmount stays set after a window ends: nothing unvested means no current window.
  const closed = toSavingsState({ ...RAW, seedShares: 0n, withdrawPaused: true, totalAssets: 0n, unvested: 0n }, null)
  assert.deepEqual([closed.seeded, closed.depositsOpen, closed.withdrawalsOpen, closed.currentAprBps, closed.vestingEndsAt], [false, false, false, 0, null])
  assert.deepEqual([closed.distributor.preview, closed.distributor.previewError], [null, PREVIEW_UNREADABLE])

  // An almost empty vault (just the seed) with a top-up: rates are capped, never Infinity / over INT4.
  const tiny = toSavingsState({ ...RAW, totalAssets: ONE, rewardRate: (1_000n * ONE) / 86_400n }, PREVIEW)
  assert.deepEqual([tiny.currentAprBps, tiny.currentApyBps], [MAX_RATE_BPS, MAX_RATE_BPS])
  assert.ok(JSON.parse(JSON.stringify(tiny)).currentApyBps === MAX_RATE_BPS)
  const flags = toSavingsState({ ...RAW, reservePaused: true, arcoUSDMintPaused: true }, PREVIEW).distributor
  assert.deepEqual([flags.reservePaused, flags.arcoUSDMintPaused], [true, true])
})

test("annualizedBps and dailyCompoundedBps", () => {
  assert.equal(annualizedBps(ONE, ONE + ONE / 1000n, 3600), null) // under a day
  // +0.05% in a day ≈ 20% a year compounded.
  const apy = annualizedBps(ONE, ONE + ONE / 2000n, 86_400)!
  assert.ok(apy > 2000 && apy < 2050, String(apy))
  assert.equal(annualizedBps(0n, ONE, 86_400), null)
  assert.equal(dailyCompoundedBps(0), 0)
  assert.equal(dailyCompoundedBps(1000), 1052)
})

function fakeClient(overrides: Record<string, unknown> = {}, failPreview = false) {
  const values: Record<string, unknown> = {
    totalAssets: RAW.totalAssets,
    totalSupply: RAW.totalSupply,
    convertToAssets: RAW.sharePrice,
    unvestedAmount: RAW.unvested,
    vestingAmount: RAW.vestingAmount,
    vestingStart: RAW.vestingStart,
    vestingPeriod: RAW.vestingPeriod,
    rewardRate: RAW.rewardRate,
    balanceOf: RAW.seedShares,
    MIN_SHARES: RAW.minShares,
    paused: false,
    fnPaused: false,
    minInterval: RAW.minInterval,
    maxAprBps: RAW.maxAprBps,
    reserveMarginBps: RAW.reserveMarginBps,
    lastDistribution: RAW.lastDistribution,
    preview: PREVIEW,
    ...overrides,
  }
  const calls: { functionName: string; blockNumber?: bigint; address: string; args?: unknown }[] = []
  return {
    calls,
    client: {
      getBlockNumber: async () => 777n,
      readContract: async (input: { functionName: string; blockNumber?: bigint; address: string; args?: readonly unknown[] }) => {
        calls.push(input)
        if (input.functionName === "preview" && failPreview) throw new Error("Lens down at https://rpc.example.invalid/key/SECRET")
        if (input.functionName === "fnPaused") {
          if (input.address === A(1)) return overrides.arcoUSDMintPaused ?? false // ArcoUSD fnPaused(mint)
          return input.args?.[0] === SAVINGS_WITHDRAW_SELECTOR ? overrides.withdrawPaused ?? false : false
        }
        if (input.functionName === "paused" && input.address === A(3)) return overrides.reservePaused ?? false
        return values[input.functionName]
      },
    },
  }
}

test("the chain reader reads the vault and distributor at one block; a failed preview does not hide the vault", async () => {
  const savings = deployedSavings(registry())!
  const { client, calls } = fakeClient({ withdrawPaused: true, reservePaused: true, arcoUSDMintPaused: true })
  const state = await createSavingsChainReader(client as never)(savings)
  assert.deepEqual([state.distributor.reservePaused, state.distributor.arcoUSDMintPaused], [true, true])
  assert.equal(state.blockNumber, "777")
  assert.ok(calls.every((call) => call.blockNumber === 777n))
  assert.equal(calls.find((call) => call.functionName === "balanceOf")!.args && (calls.find((call) => call.functionName === "balanceOf")!.args as string[])[0], SAVINGS_SEED_HOLDER)
  assert.deepEqual([state.withdrawPaused, state.withdrawalsOpen, state.depositsOpen], [true, false, true])
  assert.equal(calls.find((call) => call.functionName === "preview")!.address, DISTRIBUTOR)

  const failing = fakeClient({}, true)
  const partial = await createSavingsChainReader(failing.client as never)(savings, 900n)
  assert.equal(partial.blockNumber, "900")
  assert.equal(partial.distributor.preview, null)
  assert.equal(partial.distributor.previewError, PREVIEW_UNREADABLE) // public route: a fixed code, the detail goes to the log
})

// ─────────────────────────────── service ───────────────────────────────

test("savings service: not-deployed, live (cached 15s), unavailable on a read failure", async () => {
  let file: ArcoUSDRegistryFile | null = null
  let now = 1_000_000
  let reads = 0
  let fail = false
  const service = new ArcoUSDSavingsService({
    chainId: 91342,
    loadRegistry: () => file,
    read: async () => {
      reads++
      if (fail) throw new Error("rpc down")
      return toSavingsState(RAW, PREVIEW)
    },
    now: () => now,
  })
  assert.deepEqual([(await service.state()).status, (await service.state()).savings], ["not-deployed", null])
  now += 20_000
  file = registry(null) // ArcoUSD deployed, Savings not yet
  assert.equal((await service.state()).status, "not-deployed")
  now += 20_000
  file = registry()
  const live = await service.state()
  assert.deepEqual([live.status, live.contracts!.sArcoUSD, live.contracts!.zap, live.savings!.totalAssetsUsd], ["live", VAULT, ZAP, "10000"])
  await service.state()
  assert.equal(reads, 1) // cached
  now += 20_000
  fail = true
  const down = await service.state()
  assert.deepEqual([down.status, down.savings, down.contracts!.distributor], ["unavailable", null, DISTRIBUTOR])
  now += 20_000
  file = { ...registry(), chainId: 1 } // invalid for this chain
  assert.equal((await service.state()).status, "unavailable")
})

test("savings history: newest-first rows → chronological points, realized APY, sampling", async () => {
  const day = 24 * 60 * 60 * 1000
  const start = Date.parse("2026-10-01T00:00:00Z")
  const rows: SavingsSnapshotRecord[] = []
  for (let index = 0; index <= 10; index++) {
    rows.push({ takenAt: new Date(start + index * day), blockNumber: BigInt(1000 + index), totalAssets: (1000n * ONE).toString(), sharePrice: (ONE + (ONE / 2000n) * BigInt(index)).toString(), aprBps: 1800 })
  }
  let query: { vaultAddress: string; since: Date; limit: number } | null = null
  const service = new ArcoUSDSavingsService({
    chainId: 91342,
    loadRegistry: () => registry(),
    history: {
      snapshots: async (input) => {
        query = input
        return [...rows].reverse()
      },
    },
    now: () => start + 10 * day,
  })
  const history = await service.history("30")
  assert.equal(history.status, "live")
  assert.equal(query!.vaultAddress, VAULT)
  assert.equal(history.points.length, 11)
  assert.equal(history.points[0].takenAt, new Date(start).toISOString())
  assert.equal(history.points[10].sharePrice, "1.005")
  assert.ok(history.realizedApyBps! > 1900 && history.realizedApyBps! < 2050, String(history.realizedApyBps))
  assert.equal((await service.history("0")).days, 30)
  assert.equal((await service.history("400")).days, 30) // 1..90, like the console
  assert.equal((await service.history("90")).days, 90)
  let reads = 0
  const cached = new ArcoUSDSavingsService({ chainId: 91342, loadRegistry: () => registry(), history: { snapshots: async () => (reads++, [...rows].reverse()) }, now: () => start })
  await cached.history("30")
  await cached.history("30")
  await cached.history("7")
  assert.equal(reads, 2) // one read per window per minute
  // A failed read is kept for 5 s only.
  let clock = start
  let failing = true
  let tries = 0
  const flaky = new ArcoUSDSavingsService({
    chainId: 91342,
    loadRegistry: () => registry(),
    history: {
      snapshots: async () => {
        tries++
        if (failing) throw new Error("db blip")
        return [...rows].reverse()
      },
    },
    now: () => clock,
  })
  assert.equal((await flaky.history("30")).status, "unavailable")
  failing = false
  clock += 2_000
  assert.equal((await flaky.history("30")).status, "unavailable")
  clock += 4_000
  assert.equal((await flaky.history("30")).status, "live")
  assert.equal(tries, 2)

  const many = Array.from({ length: 1000 }, (_, index) => ({ ...rows[0], takenAt: new Date(start + index * 60_000), blockNumber: BigInt(index) }))
  const sampled = await new ArcoUSDSavingsService({ chainId: 91342, loadRegistry: () => registry(), history: { snapshots: async () => [...many].reverse() } }).history()
  assert.deepEqual([sampled.total, sampled.sampled, sampled.points.length <= 360], [1000, true, true])
  assert.equal(sampled.points[sampled.points.length - 1].blockNumber, "999") // the newest always stays

  const none = await new ArcoUSDSavingsService({ chainId: 91342, loadRegistry: () => registry(null), history: { snapshots: async () => rows } }).history()
  assert.deepEqual([none.status, none.points, none.realizedApyBps], ["not-deployed", [], null])
  const broken = await new ArcoUSDSavingsService({ chainId: 91342, loadRegistry: () => registry(), history: { snapshots: async () => { throw new Error("db down") } } }).history()
  assert.equal(broken.status, "unavailable")
})

// ─────────────────────────────── indexer ───────────────────────────────

function log(abi: readonly unknown[], address: string, eventName: string, args: Record<string, unknown>, blockNumber: bigint, logIndex: number): RawEvmLog {
  const event = (abi as AbiEvent[]).find((item) => item.name === eventName) as AbiEvent
  const topics = encodeEventTopics({ abi: [event], eventName, args } as never) as Hex[]
  const data = encodeAbiParameters(
    event.inputs.filter((input) => !input.indexed),
    event.inputs.filter((input) => !input.indexed).map((input) => args[input.name!]),
  )
  return {
    address: address as `0x${string}`,
    blockNumber,
    blockHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    transactionHash: `0x${(blockNumber * 1000n + BigInt(logIndex)).toString(16).padStart(64, "0")}`,
    logIndex,
    data,
    topics,
  }
}

class FakeRpc implements GiwaIndexerRpc {
  latest = 300n
  logs: RawEvmLog[] = []
  requested: { addresses: readonly string[]; fromBlock: bigint; toBlock: bigint }[] = []
  calls = 0
  async getChainId() {
    this.calls++
    return 91342
  }
  async getBlockNumber() {
    this.calls++
    return this.latest
  }
  async getBlock({ blockNumber }: { blockNumber: bigint }) {
    this.calls++
    return { number: blockNumber, hash: `0x${blockNumber.toString(16)}`.padEnd(66, "0") as `0x${string}`, timestamp: 1_760_000_000n + blockNumber }
  }
  async getLogs(args: { addresses: readonly `0x${string}`[]; fromBlock: bigint; toBlock: bigint }) {
    this.calls++
    this.requested.push(args)
    const wanted = new Set(args.addresses.map((address) => address.toLowerCase()))
    return this.logs.filter((entry) => wanted.has(entry.address.toLowerCase()) && entry.blockNumber >= args.fromBlock && entry.blockNumber <= args.toBlock)
  }
}

class FakeStore implements SavingsIndexerStore {
  cursors = new Map<string, GiwaIndexerCursor>()
  events: IndexedEventInput[] = []
  snapshots: SavingsSnapshotInput[] = []
  async getCursor(chainId: number, name: string) {
    return this.cursors.get(`${chainId}:${name}`) ?? null
  }
  async upsertCursor(input: { chainId: number; name: string; fromBlock: bigint; lastBlock: bigint; lastBlockHash: string | null }) {
    this.cursors.set(`${input.chainId}:${input.name}`, input)
  }
  async insertIndexedEvent(input: IndexedEventInput) {
    this.events.push(input)
  }
  async insertSavingsSnapshot(input: SavingsSnapshotInput) {
    this.snapshots.push(input)
  }
}

function indexer(file: () => ArcoUSDRegistryFile | null, rpc: FakeRpc, store: FakeStore, now = () => 0) {
  return new ArcoUSDSavingsIndexer({
    loadRegistry: file,
    rpc,
    store,
    readState: async () => ({ ...toSavingsState(RAW, PREVIEW), blockNumber: "290" }) as SavingsState,
    confirmations: 5,
    maxBlockRange: 1000n,
    snapshotIntervalMs: 300_000,
    now,
  })
}

test("savings indexer: inert until Savings is listed, then its own cursor from the Savings deploy block", async () => {
  const rpc = new FakeRpc()
  const store = new FakeStore()
  let file: ArcoUSDRegistryFile | null = registry(null)
  const poller = indexer(() => file, rpc, store)
  assert.equal((await poller.pollOnce()).mode, "inert")
  assert.equal(rpc.requested.length, 0)

  file = registry()
  rpc.logs = [
    log(savingsVaultEventsAbi, VAULT, "Transfer", { from: A(0), to: DEAD, value: ONE }, 160n, 0),
    log(savingsVaultEventsAbi, VAULT, "Deposit", { sender: A(9), owner: DEAD, assets: ONE, shares: ONE }, 160n, 1),
    log(savingsVaultEventsAbi, VAULT, "Seeded", { caller: A(9), holder: DEAD, assets: ONE }, 160n, 2),
    log(savingsZapEventsAbi, ZAP, "ZapDeposit", { caller: ALICE, receiver: ALICE, asset: USDC, amount: 500_000_000n, arcoUSDIn: 500n * ONE, shares: 500n * ONE }, 170n, 0),
    log(distributorEventsAbi, DISTRIBUTOR, "Distributed", { caller: A(8), amount: 2n * ONE, backing: 1n, liabilities: 1n, surplus: 3n * ONE, rateCap: 5n * ONE }, 180n, 0),
    log(savingsVaultEventsAbi, A(0x99), "Deposit", { sender: ALICE, owner: ALICE, assets: ONE, shares: ONE }, 175n, 0), // not ours
  ]
  const result = await poller.pollOnce()
  assert.equal(result.mode, "poll")
  if (result.mode !== "poll") return
  assert.deepEqual([result.fromBlock, result.toBlock, result.indexedEvents, result.snapshot], [150n, 295n, 4, "taken"])
  assert.deepEqual(rpc.requested[0].addresses, [VAULT, DISTRIBUTOR, ZAP])
  assert.deepEqual(store.events.map((event) => event.eventName), ["Deposit", "Seeded", "ZapDeposit", "Distributed"]) // no Transfer
  // Only the saver's own action reaches a feed: not the seed, not the distribution.
  assert.deepEqual(
    store.events.map((event) => (event.args as Record<string, unknown>).walletAddress ?? null),
    [null, null, ALICE.toLowerCase(), null],
  )
  assert.equal(store.cursors.get(`91342:${SAVINGS_CURSOR}`)!.lastBlock, 295n)
  assert.deepEqual([store.snapshots[0].vaultAddress, store.snapshots[0].blockNumber], [VAULT, 290n])

  // Next poll continues after the cursor; the snapshot is not due yet.
  rpc.latest = 320n
  const next = await poller.pollOnce()
  assert.ok(next.mode === "poll" && next.fromBlock === 296n && next.snapshot === "not-due")
})

test("savings activity: a Zap action is one row (ZapDeposit → receiver, ZapRedeem → caller); direct vault calls are the owner's", async () => {
  const rpc = new FakeRpc()
  const store = new FakeStore()
  const BOB = A(0xb0b)
  rpc.logs = [
    // Alice saves through the Zap for Bob: the vault step (sender = Zap) is nobody's, ZapDeposit is Bob's.
    log(savingsVaultEventsAbi, VAULT, "Deposit", { sender: ZAP, owner: BOB, assets: ONE, shares: ONE }, 200n, 0),
    log(savingsZapEventsAbi, ZAP, "ZapDeposit", { caller: ALICE, receiver: BOB, asset: USDC, amount: 1_000_000n, arcoUSDIn: ONE, shares: ONE }, 200n, 1),
    // Bob leaves through the Zap: the vault's Withdraw (sender = Zap) is nobody's, ZapRedeem is the caller's.
    log(savingsVaultEventsAbi, VAULT, "Withdraw", { sender: ZAP, receiver: ZAP, owner: BOB, assets: ONE, shares: ONE }, 210n, 0),
    log(savingsZapEventsAbi, ZAP, "ZapRedeem", { caller: BOB, receiver: ALICE, asset: USDC, shares: ONE, arcoUSDOut: ONE, assetOut: 1_000_000n }, 210n, 1),
    // Straight to the vault: the owner's, whoever sent it.
    log(savingsVaultEventsAbi, VAULT, "Deposit", { sender: ALICE, owner: BOB, assets: ONE, shares: ONE }, 220n, 0),
    log(savingsVaultEventsAbi, VAULT, "Withdraw", { sender: BOB, receiver: ALICE, owner: BOB, assets: ONE, shares: ONE }, 230n, 0),
    log(savingsVaultEventsAbi, VAULT, "RewardsAdded", { caller: DISTRIBUTOR, amount: ONE, vestingAmount: ONE, vestingPeriod: 86_400n }, 240n, 0),
  ]
  await indexer(() => registry(), rpc, store).pollOnce()
  assert.deepEqual(
    store.events.map((event) => [event.eventName, (event.args as Record<string, unknown>).walletAddress ?? null]),
    [
      ["Deposit", null],
      ["ZapDeposit", BOB.toLowerCase()],
      ["Withdraw", null],
      ["ZapRedeem", BOB.toLowerCase()],
      ["Deposit", BOB.toLowerCase()],
      ["Withdraw", BOB.toLowerCase()],
      ["RewardsAdded", null],
    ],
  )

  // The Prisma store rewrites args when an event is indexed again (re-indexing backfills the rules).
  const upserts: Record<string, any>[] = []
  const prismaStore = new PrismaSavingsIndexerStore(
    { evmIndexedEvent: { upsert: async (args: unknown) => void upserts.push(args as Record<string, any>) }, arcoUSDSavingsSnapshot: { upsert: async () => undefined } },
    {} as never,
  )
  await prismaStore.insertIndexedEvent(store.events[1])
  assert.deepEqual(upserts[0].update, { args: store.events[1].args })
  assert.equal(upserts[0].where.chainId_txHash_logIndex.logIndex, 1)
})

test("savings indexer: a reorged cursor block rewinds, and a chain mismatch throws", async () => {
  const rpc = new FakeRpc()
  const store = new FakeStore()
  store.cursors.set(`91342:${SAVINGS_CURSOR}`, { chainId: 91342, name: SAVINGS_CURSOR, fromBlock: 150n, lastBlock: 280n, lastBlockHash: "0xdifferent" } as GiwaIndexerCursor)
  const result = await indexer(() => registry(), rpc, store).pollOnce()
  assert.ok(result.mode === "poll" && result.reorgDetected && result.fromBlock === 268n)
  const wrong = { ...registry(), chainId: 1 }
  await assert.rejects(indexer(() => wrong, rpc, store).pollOnce(), /does not match/)
})

// ─────────────────────────────── admin ───────────────────────────────

test("savings admin view: flows without the seed, distributions, top-ups and Zap assets", async () => {
  const now = Date.parse("2026-10-20T12:00:00Z")
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000)
  let n = 0
  const event = (contractAddress: string, eventName: string, args: Record<string, unknown>, hoursAgo: number, txHash?: string): EventRecord => ({
    contractAddress,
    blockNumber: BigInt(1000 - n),
    txHash: txHash ?? `0x${(++n).toString(16).padStart(64, "0")}`,
    logIndex: 0,
    eventName,
    args,
    blockTimestamp: at(hoursAgo),
  })
  // Newest first, as the store returns them.
  const events: EventRecord[] = [
    event(VAULT, "Withdraw", { sender: ZAP, receiver: ZAP, owner: ALICE, assets: (100n * ONE).toString(), shares: "1" }, 1),
    event(ZAP, "ZapRedeem", { caller: ALICE, receiver: ALICE, asset: USDC, shares: "1", arcoUSDOut: "1", assetOut: "99800000" }, 1),
    event(VAULT, "RewardsAdded", { caller: DISTRIBUTOR, amount: (2n * ONE).toString(), vestingAmount: "1", vestingPeriod: "86400" }, 2),
    event(DISTRIBUTOR, "Distributed", { caller: A(8), amount: (2n * ONE).toString(), backing: (10n * ONE).toString(), liabilities: (9n * ONE).toString(), surplus: (3n * ONE).toString(), rateCap: (5n * ONE).toString() }, 2),
    event(VAULT, "RewardsAdded", { caller: A(0x77), amount: (1n * ONE).toString(), vestingAmount: "1", vestingPeriod: "86400" }, 30),
    event(VAULT, "Deposit", { sender: ZAP, owner: ALICE, assets: (500n * ONE).toString(), shares: "1" }, 30),
    event(ZAP, "ZapDeposit", { caller: ALICE, receiver: ALICE, asset: USDC, amount: "500000000", arcoUSDIn: "1", shares: "1" }, 30),
    // A deposit to 0x…dEaD that is NOT the seed counts like any other.
    event(VAULT, "Deposit", { sender: ALICE, owner: DEAD, assets: (2n * ONE).toString(), shares: "1" }, 40),
    event(VAULT, "Seeded", { caller: A(9), holder: DEAD, assets: ONE.toString() }, 48, `0x${"5e".repeat(32)}`),
    event(VAULT, "Deposit", { sender: A(9), owner: DEAD, assets: ONE.toString(), shares: ONE.toString() }, 48, `0x${"5e".repeat(32)}`),
  ]
  let asked: { contracts: readonly string[]; since: Date } | null = null
  const admin = new ArcoUSDSavingsAdmin({
    chainId: 91342,
    loadRegistry: () => registry(),
    store: {
      events: async (query) => {
        asked = query
        return events
      },
    },
    now: () => now,
  })
  const view = await admin.view("3")
  assert.equal(view.status, "live")
  assert.deepEqual(asked!.contracts, [VAULT, DISTRIBUTOR, ZAP])
  assert.equal(asked!.since.getTime(), now - 3 * 24 * 3_600_000)
  assert.deepEqual(view.totals, { depositsUsd: "502", deposits: 2, withdrawalsUsd: "100", withdrawals: 1, distributedUsd: "2", distributions: 1, toppedUpUsd: "1" })
  assert.deepEqual(view.distributions.map((row) => [row.amountUsd, row.surplusUsd, row.rateCapUsd]), [["2", "3", "5"]])
  assert.deepEqual(view.rewards.map((row) => [row.amountUsd, row.fromDistributor]), [["2", true], ["1", false]])
  assert.deepEqual(view.activity.map((row) => [row.kind, row.amountUsd, row.viaZap]), [["withdraw", "100", true], ["deposit", "500", true], ["deposit", "2", false], ["seed", "1", false]])
  assert.deepEqual(view.zapAssets, [{ asset: USDC, symbol: "tUSDC", deposits: 1, depositAmount: "500", redemptions: 1, redeemAmount: "99.8" }])
  assert.equal(view.daily.length, 4) // 3 days back to UTC midnight, through today
  assert.equal(view.daily.reduce((sum, day) => sum + Number(day.depositsUsd), 0), 502)

  assert.equal((await new ArcoUSDSavingsAdmin({ chainId: 91342, loadRegistry: () => registry(null), store: { events: async () => [] } }).view()).status, "not-deployed")
  const broken = await new ArcoUSDSavingsAdmin({ chainId: 91342, loadRegistry: () => registry(), store: { events: async () => { throw new Error("db down") } } }).view()
  assert.deepEqual([broken.status, broken.error], ["unavailable", "Event read failed: db down"])
})

test("distribute() builder: dry run, a revert reason, and the not-deployed / invalid answers", async () => {
  const ok = await new ArcoUSDSavingsAdmin({
    chainId: 91342,
    loadRegistry: () => registry(),
    store: { events: async () => [] },
    simulateDistribute: async ({ distributor }) => {
      assert.equal(distributor.toLowerCase(), DISTRIBUTOR)
      return { amount: 5n * ONE / 2n, blockNumber: 12n }
    },
  }).distributeTransaction()
  assert.ok(ok.ok)
  if (!ok.ok) return
  assert.deepEqual(ok.preview, { amountUsd: "2.5", blockNumber: "12" })
  assert.deepEqual([ok.transaction.to.toLowerCase(), ok.transaction.value, ok.transaction.simulation.status], [DISTRIBUTOR, "0x0", "simulated"])

  // A real viem simulation error (the node answers eth_call with the encoded custom error).
  const revertingClient = (data: `0x${string}`) =>
    createPublicClient({
      transport: custom({
        async request({ method }: { method: string }) {
          if (method === "eth_blockNumber") return "0x10"
          if (method === "eth_call") throw Object.assign(new Error("execution reverted"), { code: 3, data })
          throw new Error(`unsupported ${method}`)
        },
      }),
    })
  const admin = (data: `0x${string}`) =>
    new ArcoUSDSavingsAdmin({ chainId: 91342, loadRegistry: () => registry(), store: { events: async () => [] }, simulateDistribute: createDistributeSimulator(revertingClient(data)) })
  const tooSoon = await admin(encodeErrorResult({ abi: distributorAbi, errorName: "TooSoon" })).distributeTransaction()
  assert.ok(tooSoon.ok && "error" in tooSoon.preview)
  assert.match(tooSoon.ok && "error" in tooSoon.preview ? tooSoon.preview.error : "", /TooSoon: the interval since the last distribution has not passed/)
  assert.ok(tooSoon.ok && tooSoon.transaction.simulation.status === "failed")
  const nothing = await admin(encodeErrorResult({ abi: distributorAbi, errorName: "NothingToDistribute" })).distributeTransaction()
  assert.match(nothing.ok && "error" in nothing.preview ? nothing.preview.error : "", /NothingToDistribute: nothing to distribute/)
  const paused = await admin(encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string", name: "message" }] }], errorName: "Error", args: ["Pausable: paused"] })).distributeTransaction()
  assert.match(paused.ok && "error" in paused.preview ? paused.preview.error : "", /Pausable: paused/)

  const none = await new ArcoUSDSavingsAdmin({ chainId: 91342, loadRegistry: () => registry(null), store: { events: async () => [] } }).distributeTransaction()
  assert.deepEqual(none, { ok: false, status: 409, error: "Savings is not deployed" })
  const invalid = await new ArcoUSDSavingsAdmin({ chainId: 91342, loadRegistry: () => ({ ...registry(), chainId: 7 }), store: { events: async () => [] } }).distributeTransaction()
  assert.ok(!invalid.ok && invalid.status === 503)
})
