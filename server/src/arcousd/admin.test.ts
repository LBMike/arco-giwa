import assert from "node:assert/strict"
import test from "node:test"
import { decodeFunctionData } from "viem"
import {
  ArcoUSDAdmin,
  MAX_TOP_UP_UNITS,
  parseTopUpAmount,
  PrismaArcoUSDAdminStore,
  processQueueAbi,
  reserveDepositAbi,
  topUpTokenAbi,
  STANDARD_TARGET_SECONDS,
  type ArcoUSDAdminStore,
  type DepositSimulator,
  type TopUpWalletReader,
  type EventRecord,
  type ProcessQueueSimulator,
  type RedeemRecord,
  type SnapshotRecord,
} from "./admin.js"
import type { ReserveState } from "./reader.js"
import type { ArcoUSDRegistryFile } from "./registry.js"

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
const RESERVE = A(0xabc)
const ROUTER = A(0xdef)
const ARCO = A(0x1)
const USDC = A(0xc1)
const USDT = A(0xc2)
const RLUSD = A(0xc3)
const ALICE = A(0xa1)
const HOUR = 60 * 60 * 1000
const NOW = Date.parse("2026-10-19T12:00:00.000Z")
const e18 = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n

function registry(overrides: Partial<ArcoUSDRegistryFile> = {}): ArcoUSDRegistryFile {
  return {
    schemaVersion: 1,
    chainId: 91342,
    network: "giwa-sepolia",
    deployed: true,
    deploymentBlock: 100,
    arcoUSD: { proxy: ARCO, implementation: A(2), bytecodeHash: null },
    reserve: { proxy: RESERVE, implementation: A(4), bytecodeHash: null },
    lens: { address: A(5), bytecodeHash: null },
    router: { proxy: ROUTER, implementation: A(7), bytecodeHash: null },
    routerVaults: [{ productId: "umint", configured: true }],
    testAssets: [],
    reserveAssets: [
      { symbol: "tUSDC", address: USDC, decimals: 6, minQueued: "1000000", instantFeeBps: 0, swapFeeBps: 0 },
      { symbol: "tUSDT", address: USDT, decimals: 6, minQueued: "1000000", instantFeeBps: 0, swapFeeBps: 10 },
      { symbol: "tRLUSD", address: RLUSD, decimals: 18, minQueued: "1", instantFeeBps: 0, swapFeeBps: 10 },
    ],
    strategies: [],
    params: { mintCap: "1", mmfTargetBps: 5000, bufferFloorBps: 3000, queueMinDelay: 600 },
    ...overrides,
  }
}

class FakeStore implements ArcoUSDAdminStore {
  snapshotRows: SnapshotRecord[] = []
  requests: RedeemRecord[] = []
  eventRows: EventRecord[] = []
  queries: { kind: string; query: Record<string, unknown> }[] = []
  fail = false
  async snapshots(query: { chainId: number; reserveAddress: string; since: Date; limit: number }) {
    this.queries.push({ kind: "snapshots", query })
    if (this.fail) throw new Error("db down")
    return this.snapshotRows
      .filter((row) => row.takenAt >= query.since)
      .sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime()) // newest first, like Prisma
      .slice(0, query.limit)
  }
  async redeemRequests(query: Parameters<ArcoUSDAdminStore["redeemRequests"]>[0]) {
    this.queries.push({ kind: "requests", query })
    if (this.fail) throw new Error("db down")
    const rows = this.requests
      .filter((row) => !query.statuses || query.statuses.includes(row.status as never))
      .filter((row) => !query.requestIds || query.requestIds.includes(row.requestId))
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
    return (query.order === "desc" ? rows.reverse() : rows).slice(0, query.limit)
  }
  async events(query: { chainId: number; contracts: readonly string[]; since: Date; limit: number }) {
    this.queries.push({ kind: "events", query })
    if (this.fail) throw new Error("db down")
    return this.eventRows
      .filter((row) => query.contracts.includes(row.contractAddress) && row.blockTimestamp! >= query.since)
      .reverse() // newest first, like Prisma
      .slice(0, query.limit)
  }
}

function admin(
  options: {
    registry?: ArcoUSDRegistryFile | null | (() => ArcoUSDRegistryFile | null)
    simulate?: ProcessQueueSimulator
    liveQueueMinDelay?: () => Promise<number | null>
    readTopUpWallet?: TopUpWalletReader
    simulateDeposit?: DepositSimulator
    liveReserve?: () => Promise<ReserveState | null>
  } = {},
) {
  const store = new FakeStore()
  const load = typeof options.registry === "function" ? options.registry : () => (options.registry === undefined ? registry() : options.registry)
  const service = new ArcoUSDAdmin({
    chainId: 91342,
    loadRegistry: load as () => ArcoUSDRegistryFile | null,
    store,
    simulateProcessQueue: options.simulate,
    readTopUpWallet: options.readTopUpWallet,
    simulateDeposit: options.simulateDeposit,
    liveReserve: options.liveReserve,
    liveQueueMinDelay: options.liveQueueMinDelay,
    now: () => NOW,
  })
  return { service, store }
}

const request = (requestId: string, overrides: Partial<RedeemRecord> = {}): RedeemRecord => ({
  requestId,
  owner: ALICE,
  recipient: ALICE,
  asset: USDT,
  arcoUSDAmount: e18(100).toString(), // 100 ArcoUSD escrowed
  assetAmount: "99900000", // 99.9 tUSDT after the 10 bps swap fee
  status: "QUEUED",
  requestedAt: new Date(NOW - HOUR),
  queuedTxHash: `0x${"aa".repeat(32)}`,
  ...overrides,
})

let logIndex = 0
const event = (eventName: string, args: Record<string, unknown>, at: number, contractAddress: string = RESERVE.toLowerCase()): EventRecord => ({
  contractAddress,
  blockNumber: BigInt(Math.floor(at / 1000)),
  txHash: `0x${(logIndex + 1).toString(16).padStart(64, "0")}`,
  logIndex: logIndex++,
  eventName,
  args,
  blockTimestamp: new Date(at),
})

test("every view is empty and says why when ArcoUSD is not deployed or the registry is invalid", async () => {
  for (const [value, status] of [
    [null, "not-deployed"],
    [registry({ deployed: false }), "not-deployed"],
    [registry({ chainId: 1 }), "unavailable"],
  ] as const) {
    const { service, store } = admin({ registry: value })
    const [snapshots, queue, flows] = await Promise.all([service.snapshots(), service.queue(), service.flows()])
    assert.deepEqual([snapshots.status, (queue as unknown as { status: string }).status, flows.status], [status, status, status])
    assert.deepEqual([snapshots.points, (queue as unknown as { requests: unknown[] }).requests, flows.recent], [[], [], []])
    if (status === "unavailable") assert.match(String(snapshots.error), /chainId/)
    assert.equal(store.queries.length, 0) // nothing read without a live deployment
    const tx = await service.processQueueTransaction({ asset: "tUSDC" })
    assert.deepEqual(tx.ok ? null : tx.status, status === "not-deployed" ? 409 : 503)
  }
})

test("snapshots: the window's rows in USD, sampled to at most 360 points, the latest always kept", async () => {
  const { service, store } = admin()
  for (let i = 0; i < 1000; i++) {
    store.snapshotRows.push({
      takenAt: new Date(NOW - (1000 - i) * 5 * 60 * 1000),
      blockNumber: BigInt(1000 + i),
      totalBacking: e18(1000 + i).toString(),
      totalLiabilities: e18(1000).toString(),
      navOk: true,
      mmfBps: 4000,
      paused: false,
      settlementPaused: i === 999,
    })
  }
  const result = await service.snapshots("7")
  assert.equal(result.status, "live")
  assert.equal(result.days, 7)
  assert.equal(result.total, 1000)
  assert.equal(result.sampled, true)
  assert.ok(result.points.length <= 360)
  const last = result.points[result.points.length - 1]
  assert.deepEqual([last.blockNumber, last.surplusUsd, last.settlementPaused], ["1999", "999", true])
  assert.equal(last.totalBackingUsd, "1999")
  assert.equal((store.queries[0].query.since as Date).getTime(), NOW - 7 * 24 * HOUR)
  assert.equal(store.queries[0].query.reserveAddress, RESERVE.toLowerCase())
  // Bad day counts fall back to 30 rather than failing the page.
  assert.equal((await service.snapshots("1000")).days, 30)
  assert.equal(result.truncated, false)
  store.fail = true
  const failed = await service.snapshots()
  assert.deepEqual([failed.status, failed.points.length], ["unavailable", 0])
})

test("snapshots: a window over the row limit keeps the LATEST rows and says it was truncated", async () => {
  const { service, store } = admin()
  for (let i = 0; i < 30_005; i++) {
    store.snapshotRows.push({
      takenAt: new Date(NOW - (30_005 - i) * 60 * 1000), // one a minute, newest last
      blockNumber: BigInt(i),
      totalBacking: "1",
      totalLiabilities: "1",
      navOk: true,
      mmfBps: 0,
      paused: false,
      settlementPaused: false,
    })
  }
  const result = await service.snapshots("30")
  assert.equal(result.truncated, true)
  assert.equal(result.points[result.points.length - 1].blockNumber, "30004") // the latest survives
  assert.ok(Date.parse(result.points[0].takenAt) < Date.parse(result.points[1].takenAt)) // oldest first
})

test("queue: open requests FIFO with eligibility, wait, T+2 overdue and the swap fee; per-asset head", async () => {
  const { service, store } = admin()
  store.requests = [
    request("1", { requestedAt: new Date(NOW - 50 * HOUR) }), // overdue
    request("2", { requestedAt: new Date(NOW - 5 * 60 * 1000) }), // not eligible yet (10 min delay)
    request("3", { status: "PAYOUT_FAILED", requestedAt: new Date(NOW - 3 * HOUR), failedAt: new Date(NOW - 2 * HOUR), failedTxHash: "0xf1" }),
    request("4", { asset: USDC, arcoUSDAmount: e18(5).toString(), assetAmount: "5000000", requestedAt: new Date(NOW - 2 * HOUR) }),
    request("5", { status: "PAID", requestedAt: new Date(NOW - 30 * HOUR), paidAt: new Date(NOW - 29 * HOUR), paidTxHash: "0xp5" }),
  ]
  const result = await service.queue()
  assert.ok("filter" in result)
  assert.equal(result.status, "live")
  assert.equal(result.filter, "open")
  assert.equal(result.targetSeconds, STANDARD_TARGET_SECONDS)
  assert.equal(result.queueMinDelay, 600)
  assert.deepEqual(result.requests.map((row) => row.requestId), ["1", "2", "3", "4"]) // Reserve (request id) order, PAID left out
  const [first, young, failed] = result.requests
  assert.deepEqual([first.overdue, first.feeUsd, first.assetAmountHuman, first.symbol], [true, "0.1", "99.9", "tUSDT"])
  assert.equal(first.waitSeconds, 50 * 60 * 60)
  assert.equal(young.eligibleAt, new Date(NOW - 5 * 60 * 1000 + 600_000).toISOString())
  assert.deepEqual([failed.overdue, failed.closedTxHash], [false, "0xf1"]) // failed waits for a cancel, not liquidity
  const usdt = result.assets.find((asset) => asset.symbol === "tUSDT")!
  assert.deepEqual(
    [usdt.queuedCount, usdt.queuedAmountHuman, usdt.overdueCount, usdt.failedCount, usdt.head?.requestId],
    [2, "199.8", 1, 1, "1"],
  )
  const usdc = result.assets.find((asset) => asset.symbol === "tUSDC")!
  assert.deepEqual([usdc.queuedCount, usdc.head?.assetAmountHuman], [1, "5"])
  assert.equal(result.assets.find((asset) => asset.symbol === "tRLUSD")!.head, null)

  const all = await service.queue("all")
  assert.ok("filter" in all)
  assert.deepEqual(all.requests.map((row) => row.requestId), ["5", "4", "3", "2", "1"]) // newest request first
  const paid = all.requests.find((row) => row.requestId === "5")!
  assert.deepEqual([paid.waitSeconds, paid.closedTxHash, paid.overdue], [3600, "0xp5", false])
  const onlyPaid = await service.queue("PAID")
  assert.ok("filter" in onlyPaid)
  assert.deepEqual(onlyPaid.requests.map((row) => row.requestId), ["5"])
  assert.deepEqual(await service.queue("DONE"), { status: 400, error: "status must be open, all, or one of QUEUED, PAID, PAYOUT_FAILED, CANCELLED" })
  assert.deepEqual([result.queueMinDelaySource, result.summaryTruncated], ["registry", false])
})

test("queue: same-block requests keep the Reserve's id order; the live queue delay wins over the registry", async () => {
  const sameBlock = new Date(NOW - 3 * HOUR)
  const live = admin({ liveQueueMinDelay: async () => 3600 })
  live.store.requests = [request("10", { requestedAt: sameBlock }), request("9", { requestedAt: sameBlock })]
  const result = await live.service.queue()
  assert.ok("filter" in result)
  assert.deepEqual(result.requests.map((row) => row.requestId), ["9", "10"])
  assert.equal(result.assets.find((asset) => asset.symbol === "tUSDT")?.head?.requestId, "9")
  assert.deepEqual([result.queueMinDelay, result.queueMinDelaySource], [3600, "chain"])
  assert.equal(result.requests[0].eligibleAt, new Date(sameBlock.getTime() + 3600 * 1000).toISOString())
  // An unreadable live value falls back to the registry's deploy-time delay.
  const failing = admin({ liveQueueMinDelay: async () => Promise.reject(new Error("rpc down")) })
  const fallback = await failing.service.queue()
  assert.ok("filter" in fallback)
  assert.deepEqual([fallback.queueMinDelay, fallback.queueMinDelaySource], [600, "registry"])
  // A malformed stored amount never fails the view.
  live.store.requests = [request("1", { assetAmount: "not-a-number" })]
  const odd = await live.service.queue()
  assert.ok("filter" in odd && odd.status === "live")
})

test("flows: daily and per-asset volumes in USD, fees from every source, Router buys by pay asset", async () => {
  const { service, store } = admin()
  const today = NOW - HOUR
  const yesterday = NOW - 24 * HOUR
  store.requests = [request("9", { status: "PAID" })] // 100 ArcoUSD escrowed → 99.9 tUSDT paid
  store.eventRows = [
    // 1,000 tUSDT in: 999 ArcoUSD minted + 1 ArcoUSD fee
    event("Deposited", { sender: ALICE, recipient: ALICE, asset: USDT.toLowerCase(), assetAmount: "1000000000", arcoUSDOut: e18(999).toString(), fee: e18(1).toString() }, yesterday),
    event("Deposited", { sender: ALICE, recipient: ALICE, asset: USDC.toLowerCase(), assetAmount: "500000000", arcoUSDOut: e18(500).toString(), fee: "0" }, today),
    // Instant 200 ArcoUSD → 199.8 tUSDT (fee 0.2 tUSDT, asset units)
    event("RedeemedInstant", { sender: ALICE, recipient: ALICE, asset: USDT.toLowerCase(), arcoUSDIn: e18(200).toString(), assetOut: "199800000", fee: "200000" }, today),
    event("RedeemQueued", { requestId: "9", owner: ALICE, recipient: ALICE, asset: USDT.toLowerCase(), arcoUSDIn: e18(100).toString(), assetOut: "99900000", requestedAt: "1" }, today),
    event("RedeemPaid", { requestId: "9", recipient: ALICE, asset: USDT.toLowerCase(), assetOut: "99900000" }, today),
    event("SettledFor", { settler: ROUTER.toLowerCase(), asset: USDC.toLowerCase(), arcoUSDIn: e18(300).toString(), assetOut: "300000000", to: ROUTER.toLowerCase() }, today),
    event("Bought", { payer: ALICE, recipient: ALICE, depositVault: A(0x71), payAsset: ARCO.toLowerCase(), payAmount: e18(300).toString(), arcoUSDSettled: e18(300).toString(), paymentAmount: "300000000", result: "1", request: false }, today, ROUTER.toLowerCase()),
    event("RedeemCancelled", { requestId: "8", owner: ALICE, arcoUSDReturned: e18(7).toString() }, today),
    event("RedeemPayoutFailed", { requestId: "7", recipient: ALICE, asset: A(0xee).toLowerCase(), assetOut: "5" }, today), // unknown asset units
    event("Deposited", { sender: ALICE, recipient: ALICE, asset: A(0xee).toLowerCase(), assetAmount: "1", arcoUSDOut: "1", fee: "0" }, today), // unknown asset, valued in ArcoUSD
    event("Deposited", { sender: ALICE, recipient: ALICE, asset: USDC.toLowerCase(), assetAmount: "1", arcoUSDOut: "1", fee: "0" }, NOW - 40 * 24 * HOUR), // outside
  ]
  const result = await service.flows("2")
  assert.equal(result.status, "live")
  assert.deepEqual(store.queries[0].query.contracts, [RESERVE.toLowerCase(), ROUTER.toLowerCase()])
  assert.equal(result.since, "2026-10-18T00:00:00.000Z")
  assert.deepEqual(result.daily.map((day) => day.day), ["2026-10-18", "2026-10-19"])
  const { totals } = result
  assert.equal(totals.depositsUsd, "1500.000000000000000001") // gross, incl. the 1 wei unknown-asset deposit
  assert.equal(totals.deposits, 3)
  assert.equal(totals.instantRedemptionsUsd, "200")
  assert.deepEqual([totals.queuedRedemptionsUsd, totals.queuedPaidUsd, totals.queuedPaid], ["100", "99.9", 1])
  assert.deepEqual([totals.settlementsUsd, totals.routerBuysUsd, totals.routerBuys], ["300", "300", 1])
  assert.equal(totals.feesUsd, "1.3") // 1 (deposit) + 0.2 (instant) + 0.1 (queued, kept on payout)
  assert.equal(result.daily[0].depositsUsd, "1000")
  assert.equal(result.daily[1].feesUsd, "0.3")
  const usdt = result.byAsset.find((asset) => asset.symbol === "tUSDT")!
  assert.deepEqual([usdt.depositsUsd, usdt.feesUsd, usdt.queuedPaidUsd], ["1000", "1.3", "99.9"])
  assert.deepEqual(result.routerBuysByPayAsset, [{ symbol: "ArcoUSD", count: 1, volumeUsd: "300" }])
  assert.equal(result.unknownAssetEvents, 1)
  assert.equal(result.truncated, false)
  // Newest first; cancels are listed but not summed.
  assert.equal(result.recent[0].eventName, "Deposited")
  const cancel = result.recent.find((entry) => entry.eventName === "RedeemCancelled")!
  assert.deepEqual([cancel.amountUsd, cancel.contract], ["7", "reserve"])
  assert.equal(result.recent.find((entry) => entry.eventName === "Bought")?.contract, "router")

  // Without a Router only the Reserve is read.
  const legacy = admin({ registry: registry({ router: undefined, routerVaults: undefined }) })
  await legacy.service.flows()
  assert.deepEqual(legacy.store.queries[0].query.contracts, [RESERVE.toLowerCase()])
})

test("processQueue: validated input, the encoded Reserve call, and a dry-run count (or why there is none)", async () => {
  const simulated: unknown[] = []
  const { service } = admin({
    simulate: async (input) => {
      simulated.push(input)
      return { paid: 3n, blockNumber: 777n }
    },
  })
  const result = await service.processQueueTransaction({ asset: "tUSDT", maxCount: 10 })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.transaction.to.toLowerCase(), RESERVE.toLowerCase())
  assert.equal(result.transaction.chainId, 91342)
  const decoded = decodeFunctionData({ abi: processQueueAbi, data: result.transaction.data })
  assert.deepEqual([decoded.functionName, String(decoded.args[0]).toLowerCase(), decoded.args[1]], ["processQueue", USDT.toLowerCase(), 10n])
  assert.deepEqual(result.preview, { paid: 3, blockNumber: "777" })
  assert.match(result.transaction.description, /up to 10 queued tUSDT/)
  assert.equal(result.transaction.simulation?.status, "simulated")
  assert.equal((simulated[0] as { maxCount: number }).maxCount, 10)

  // By address, and the default batch.
  const byAddress = await service.processQueueTransaction({ asset: USDC.toLowerCase() })
  assert.ok(byAddress.ok && byAddress.symbol === "tUSDC" && byAddress.maxCount === 20)

  for (const [input, message] of [
    [{ asset: "tDAI" }, /asset/],
    [{ asset: A(0x99) }, /asset/],
    [{ asset: "tUSDC", maxCount: 0 }, /maxCount/],
    [{ asset: "tUSDC", maxCount: 51 }, /maxCount/],
    [{ asset: "tUSDC", maxCount: "2.5" }, /maxCount/],
    [{ asset: "tUSDC", maxCount: true }, /maxCount/],
    [{ asset: "tUSDC", maxCount: [7] }, /maxCount/],
    [{ asset: "tUSDC", maxCount: "0x10" }, /maxCount/],
  ] as const) {
    const refused = await service.processQueueTransaction(input)
    assert.ok(!refused.ok && refused.status === 400 && message.test(refused.error), JSON.stringify(input))
  }

  // A reverting or unavailable simulation still returns the transaction, with the reason.
  const reverting = admin({ simulate: async () => Promise.reject(new Error("FP: fn paused")) })
  const paused = await reverting.service.processQueueTransaction({ asset: "tUSDC" })
  assert.ok(paused.ok && "error" in paused.preview && /FP: fn paused/.test(paused.preview.error))
  assert.ok(paused.ok && paused.transaction.simulation?.status === "failed")
  const noSim = await admin().service.processQueueTransaction({ asset: "tUSDC" })
  assert.ok(noSim.ok && "error" in noSim.preview)
})

test("buffer top-up: approve only while the allowance is short, deposit to the operator wallet, dry-run once approved", async () => {
  const OPERATOR = A(0xb0b)
  let wallet = { balance: 2_500_000_000n, allowance: 0n } // 2,500 tUSDC, nothing approved
  const reads: Parameters<TopUpWalletReader>[0][] = []
  const simulated: Parameters<DepositSimulator>[0][] = []
  const { service } = admin({
    readTopUpWallet: async (input) => (reads.push(input), { ...wallet, blockNumber: 10n }),
    simulateDeposit: async (input) => (simulated.push(input), { arcoUSDOut: 998_999_000_000_000_000_000n, blockNumber: 11n }),
  })

  const first = await service.bufferTopUpTransactions({ asset: "tUSDC", amount: "1000.5", from: OPERATOR.toLowerCase() })
  assert.ok(first.ok)
  if (!first.ok) return
  assert.deepEqual(
    [first.symbol, first.amount, first.amountHuman, first.balanceHuman, first.needsApproval, first.preview],
    ["tUSDC", "1000500000", "1000.5", "2500", true, { afterApproval: true }],
  )
  assert.equal(first.from.toLowerCase(), OPERATOR.toLowerCase())
  assert.deepEqual(reads[0], { asset: first.asset, owner: first.from, spender: reads[0].spender })
  assert.equal(reads[0].spender.toLowerCase(), RESERVE.toLowerCase())
  const [approve, deposit] = first.transactions
  const approveCall = decodeFunctionData({ abi: topUpTokenAbi, data: approve.data })
  assert.deepEqual([approve.to.toLowerCase(), approveCall.functionName, String(approveCall.args[0]).toLowerCase(), approveCall.args[1]], [
    USDC.toLowerCase(),
    "approve",
    RESERVE.toLowerCase(),
    1_000_500_000n,
  ])
  const depositCall = decodeFunctionData({ abi: reserveDepositAbi, data: deposit.data })
  assert.deepEqual(
    [deposit.to.toLowerCase(), depositCall.functionName, String(depositCall.args[0]).toLowerCase(), depositCall.args[1], String(depositCall.args[2]).toLowerCase()],
    [RESERVE.toLowerCase(), "deposit", USDC.toLowerCase(), 1_000_500_000n, OPERATOR.toLowerCase()],
  )
  assert.equal(deposit.simulation.status, "not-run")
  assert.equal(simulated.length, 0) // a deposit without the allowance would revert: dry-run after the approval
  assert.match(approve.description, /approve/)
  assert.match(deposit.description, /1000.5 tUSDC into the settlement buffer/)

  // Approved: the deposit alone, dry-run from the operator wallet at the amount.
  wallet = { balance: 2_500_000_000n, allowance: 1_000_500_000n }
  const second = await service.bufferTopUpTransactions({ asset: USDC.toLowerCase(), amount: 1000.5, from: OPERATOR })
  assert.ok(second.ok && !second.needsApproval && second.transactions.length === 1)
  if (!second.ok) return
  assert.deepEqual(second.preview, { arcoUSDOutHuman: "998.999", blockNumber: "11" })
  assert.equal(second.transactions[0].simulation.status, "simulated")
  assert.deepEqual([simulated[0].amount, simulated[0].from.toLowerCase(), simulated[0].reserve.toLowerCase()], [1_000_500_000n, OPERATOR.toLowerCase(), RESERVE.toLowerCase()])

  // An 18-decimal asset: amounts in its own units.
  const rlusd = await service.bufferTopUpTransactions({ asset: "tRLUSD", amount: "0.000000000000000001", from: OPERATOR })
  assert.ok(rlusd.ok && rlusd.amount === "1" && rlusd.decimals === 18)

  // The deposit dry-run fails: the reason is shown and the transaction is marked failed.
  const reverting = admin({
    readTopUpWallet: async () => ({ balance: 10n ** 12n, allowance: 10n ** 12n, blockNumber: 1n }),
    simulateDeposit: async () => Promise.reject(new Error("FP: fn paused")),
  })
  const paused = await reverting.service.bufferTopUpTransactions({ asset: "tUSDC", amount: "5", from: OPERATOR })
  assert.ok(paused.ok && "error" in paused.preview && /FP: fn paused/.test(paused.preview.error))
  assert.ok(paused.ok && paused.transactions[0].simulation.status === "failed")

  // Refusals: balance, amount, asset, wallet, reads, deployment.
  const short = await service.bufferTopUpTransactions({ asset: "tUSDC", amount: "2500.000001", from: OPERATOR })
  assert.ok(!short.ok && short.status === 409 && /holds 2,500 tUSDC, less than the 2500.000001 tUSDC of this top-up/.test(short.error))
  for (const amount of ["0", "-1", "1e3", "1.1234567", "", " ", "0x10", "10000000", true, null, undefined, [1]]) {
    const refused = await service.bufferTopUpTransactions({ asset: "tUSDC", amount, from: OPERATOR })
    assert.ok(!refused.ok && refused.status === 400 && /amount/.test(refused.error), JSON.stringify(amount))
  }
  for (const asset of ["tDAI", A(0x99), undefined]) {
    const refused = await service.bufferTopUpTransactions({ asset, amount: "1", from: OPERATOR })
    assert.ok(!refused.ok && refused.status === 400 && /asset/.test(refused.error))
  }
  for (const from of [null, undefined, "", "0x123"]) {
    const refused = await service.bufferTopUpTransactions({ asset: "tUSDC", amount: "1", from })
    assert.ok(!refused.ok && refused.status === 400 && /operator wallet/.test(refused.error))
  }
  const noReader = await admin().service.bufferTopUpTransactions({ asset: "tUSDC", amount: "1", from: OPERATOR })
  assert.ok(!noReader.ok && noReader.status === 503)
  const readFails = await admin({ readTopUpWallet: async () => Promise.reject(new Error("rpc down")) }).service.bufferTopUpTransactions({
    asset: "tUSDC",
    amount: "1",
    from: OPERATOR,
  })
  assert.ok(!readFails.ok && readFails.status === 503 && /rpc down/.test(readFails.error))
  const noSim = await admin({ readTopUpWallet: async () => ({ balance: 10n ** 9n, allowance: 10n ** 9n, blockNumber: 1n }) }).service.bufferTopUpTransactions({
    asset: "tUSDC",
    amount: "1",
    from: OPERATOR,
  })
  assert.ok(noSim.ok && "error" in noSim.preview && noSim.transactions[0].simulation.status === "failed")
  const notDeployed = await admin({ registry: null }).service.bufferTopUpTransactions({ asset: "tUSDC", amount: "1", from: OPERATOR })
  assert.ok(!notDeployed.ok && notDeployed.status === 409)
  const invalid = await admin({ registry: registry({ chainId: 1 }) }).service.bufferTopUpTransactions({ asset: "tUSDC", amount: "1", from: OPERATOR })
  assert.ok(!invalid.ok && invalid.status === 503)
})

test("buffer top-up: a deposit the live Reserve would refuse is refused before any approval", async () => {
  const OPERATOR = A(0xb0b)
  const live = (over: Partial<ReserveState> = {}, assetOver: Record<string, unknown> = {}) =>
    ({
      mintCap: e18(10_000).toString(),
      totalLiabilities: e18(100).toString(),
      reservePaused: false,
      depositPaused: false,
      arcoUSDPaused: false,
      arcoUSDMintPaused: false,
      assets: [{ address: USDC.toLowerCase(), depositEnabled: true, depositRoom: null, ...assetOver }],
      ...over,
    }) as unknown as ReserveState
  const build = (state: ReserveState | null | (() => Promise<ReserveState | null>), amount = "1000") =>
    admin({
      readTopUpWallet: async () => ({ balance: 10n ** 12n, allowance: 0n, blockNumber: 1n }),
      liveReserve: typeof state === "function" ? state : async () => state,
    }).service.bufferTopUpTransactions({ asset: "tUSDC", amount, from: OPERATOR })

  const ok = await build(live())
  assert.ok(ok.ok && ok.needsApproval)
  for (const [state, message] of [
    [live({ depositPaused: true }), /Deposits are paused \(Reserve deposit\)/],
    [live({ reservePaused: true, arcoUSDMintPaused: true }), /Deposits are paused \(the Reserve, ArcoUSD mint\)/],
    [live({}, { depositEnabled: false }), /Deposits of tUSDC are off/],
    [live({}, { depositRoom: "500000000" }), /Only 500 tUSDC fits under its deposit cap/],
    [live({ mintCap: e18(1_000).toString(), totalLiabilities: e18(900.5).toString() }), /Only 99.5 ArcoUSD can still be minted under the mint cap/],
  ] as const) {
    const refused = await build(state)
    assert.ok(!refused.ok && refused.status === 409 && message.test(refused.error), String(message))
  }
  // Exactly the room left is fine; an unread reserve leaves it to the dry-run after the approval.
  assert.ok((await build(live({}, { depositRoom: "1000000000" }))).ok)
  assert.ok((await build(null)).ok)
  assert.ok((await build(async () => Promise.reject(new Error("rpc down")))).ok)
})

test("parseTopUpAmount: positive, within the asset's decimals and the per-call cap", () => {
  assert.equal(parseTopUpAmount("1000", 6), 1_000_000_000n)
  assert.equal(parseTopUpAmount(" 12.5 ", 6), 12_500_000n)
  assert.equal(parseTopUpAmount(0.25, 6), 250_000n)
  assert.equal(parseTopUpAmount("0.000001", 6), 1n)
  assert.equal(parseTopUpAmount("1", 18), 10n ** 18n)
  assert.equal(parseTopUpAmount(String(MAX_TOP_UP_UNITS), 6), BigInt(MAX_TOP_UP_UNITS) * 10n ** 6n)
  for (const value of ["0", "0.0000001", String(MAX_TOP_UP_UNITS + 1), "1.", ".5", "01e2", "-5", "NaN", Number.NaN, Infinity, {}, "1,000"]) {
    assert.equal(parseTopUpAmount(value, 6), null, String(value))
  }
})

test("Prisma admin store: scoped, scalar-only snapshot reads, status/id filters, non-removed events in chain order", async () => {
  const calls: Record<string, any>[] = []
  const delegate = (name: string) => ({ findMany: async (args: unknown) => (calls.push({ name, args }), []) })
  const store = new PrismaArcoUSDAdminStore({
    arcoUSDReserveSnapshot: delegate("snapshot"),
    arcoUSDRedeemRequest: delegate("request"),
    evmIndexedEvent: delegate("event"),
  })
  const since = new Date(0)
  await store.snapshots({ chainId: 91342, reserveAddress: RESERVE, since, limit: 5 })
  await store.redeemRequests({ chainId: 91342, reserveAddress: RESERVE, statuses: ["QUEUED"], requestIds: ["7"], order: "desc", limit: 3 })
  await store.events({ chainId: 91342, contracts: [RESERVE, ROUTER], since, limit: 9 })
  const [snapshot, requests, events] = calls.map((call) => call.args)
  assert.equal(snapshot.where.reserveAddress, RESERVE.toLowerCase())
  assert.equal(snapshot.select.data, undefined) // never the full JSON
  assert.deepEqual([snapshot.orderBy, snapshot.take], [{ takenAt: "desc" }, 5]) // newest first: a limit keeps the latest
  assert.deepEqual([requests.where.status, requests.where.requestId, requests.orderBy[0]], [{ in: ["QUEUED"] }, { in: ["7"] }, { requestedAt: "desc" }])
  assert.deepEqual(events.where.contractAddress, { in: [RESERVE.toLowerCase(), ROUTER.toLowerCase()] })
  assert.deepEqual([events.where.removed, events.orderBy], [false, [{ blockNumber: "desc" }, { logIndex: "desc" }]])
})
