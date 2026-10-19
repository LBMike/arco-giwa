import assert from "node:assert/strict"
import test from "node:test"
import type { RedeemRecord } from "./admin.js"
import type { RedeemStatus } from "./indexer.js"
import {
  ArcoUSDRedemptions,
  parseRedemptionsQuery,
  POSITION_ROW_LIMIT,
  PrismaRedemptionsStore,
  REDEMPTIONS_ERROR,
  WALLET_REQUEST_LIMIT,
  type QueuedRow,
  type WalletRedemptionsStore,
} from "./redemptions.js"
import type { ArcoUSDRegistryFile } from "./registry.js"

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`
const RESERVE = A(0xabc)
const USDC = A(0xc1)
const USDT = A(0xc2)
const ALICE = A(0xa1)
const BOB = A(0xb0)
const MIN = 60_000
const NOW = Date.parse("2026-10-20T12:00:00.000Z")
const e6 = (n: number) => String(Math.round(n * 1e6))
const e18 = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString()

function registry(): ArcoUSDRegistryFile {
  return {
    schemaVersion: 1,
    chainId: 91342,
    network: "giwa-sepolia",
    deployed: true,
    deploymentBlock: 100,
    arcoUSD: { proxy: A(1) as `0x${string}`, implementation: A(2) as `0x${string}`, bytecodeHash: null },
    reserve: { proxy: RESERVE as `0x${string}`, implementation: A(4) as `0x${string}`, bytecodeHash: null },
    lens: { address: A(5) as `0x${string}`, bytecodeHash: null },
    testAssets: [],
    reserveAssets: [
      { symbol: "tUSDC", address: USDC as `0x${string}`, decimals: 6, minQueued: "1000000", instantFeeBps: 0, swapFeeBps: 0 },
      { symbol: "tUSDT", address: USDT as `0x${string}`, decimals: 6, minQueued: "1000000", instantFeeBps: 0, swapFeeBps: 10 },
    ],
    strategies: [],
    params: { mintCap: "1", mmfTargetBps: 5000, bufferFloorBps: 3000, queueMinDelay: 600 },
  }
}

let nextBlock = 1n
function request(id: number, owner: string, asset: string, amount: number, requestedAgoMs: number, over: Partial<RedeemRecord> = {}): RedeemRecord & { queuedBlock: bigint } {
  return {
    requestId: String(id),
    owner: owner.toLowerCase(),
    recipient: owner.toLowerCase(),
    asset: asset.toLowerCase(),
    arcoUSDAmount: e18(amount),
    assetAmount: e6(amount),
    status: "QUEUED",
    requestedAt: new Date(NOW - requestedAgoMs),
    queuedTxHash: `0x${id.toString(16).padStart(64, "0")}`,
    queuedBlock: nextBlock++,
    ...over,
  }
}

/** The table, filtered and ordered like PrismaRedemptionsStore's queries. */
class FakeStore implements WalletRedemptionsStore {
  rows: (RedeemRecord & { queuedBlock: bigint })[] = []
  byOwnerCalls = 0
  queuedCalls: string[] = []
  failing = false
  async byOwner(query: { owner: string; statuses: readonly RedeemStatus[] | null; limit: number }) {
    this.byOwnerCalls++
    if (this.failing) throw new Error("Can't reach database server at `db.internal.example:5432`")
    return this.rows
      .filter((row) => row.owner === query.owner && (!query.statuses || query.statuses.includes(row.status as RedeemStatus)))
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime() || Number(b.queuedBlock - a.queuedBlock))
      .slice(0, query.limit)
  }
  async queued(query: { asset: string; limit: number }): Promise<readonly QueuedRow[]> {
    this.queuedCalls.push(query.asset)
    return this.rows
      .filter((row) => row.asset === query.asset && row.status === "QUEUED")
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime() || Number(a.queuedBlock - b.queuedBlock))
      .slice(0, query.limit)
  }
}

function service(
  store: FakeStore,
  over: { now?: () => number; live?: number | null | Error; registry?: () => ArcoUSDRegistryFile | null; log?: (line: string) => void } = {},
) {
  return new ArcoUSDRedemptions({
    chainId: 91342,
    loadRegistry: over.registry ?? registry,
    store,
    liveQueueMinDelay: async () => {
      if (over.live instanceof Error) throw over.live
      return over.live === undefined ? 900 : over.live
    },
    now: over.now ?? (() => NOW),
    log: over.log ?? (() => undefined),
  })
}

test("query: a checksummed or lowercase wallet, open by default; anything else is a 400 message", () => {
  assert.deepEqual(parseRedemptionsQuery(ALICE.toUpperCase().replace("0X", "0x"), undefined), { wallet: ALICE, filter: "open" })
  assert.deepEqual(parseRedemptionsQuery(ALICE, "all"), { wallet: ALICE, filter: "all" })
  assert.throws(() => parseRedemptionsQuery("0x123", "open"), /wallet must be a valid EVM address/)
  assert.throws(() => parseRedemptionsQuery(ALICE, "QUEUED"), /status must be open or all/)
})

test("open requests: amounts, payable time, T+2, cancellable, and the place in each asset's queue", async () => {
  const store = new FakeStore()
  store.rows = [
    request(1, BOB, USDC, 100, 50 * 60 * MIN), // waiting longest
    request(2, ALICE, USDC, 250, 49 * 60 * MIN), // Alice's, past T+2
    request(3, BOB, USDC, 40, 30 * MIN),
    request(4, ALICE, USDC, 10, 5 * MIN), // behind 1, 2 and 3
    request(5, BOB, USDC, 70, 4 * MIN), // behind Alice: not counted for her
    request(6, BOB, USDC, 999, 60 * MIN, { status: "PAID" }), // settled: never ahead
    request(7, ALICE, USDT, 30, 2 * MIN), // another asset's queue: first in line
    request(8, ALICE, USDC, 20, 3 * 60 * MIN, { status: "PAYOUT_FAILED", failedAt: new Date(NOW - 2 * 60 * MIN), failedTxHash: "0xf1" }),
    request(9, ALICE, USDC, 5, 6 * 60 * MIN, { status: "CANCELLED", cancelledAt: new Date(NOW - MIN), cancelledTxHash: "0xc1" }),
  ]
  const reply = await service(store).forWallet(ALICE, "open")
  assert.deepEqual([reply.status, reply.wallet, reply.filter, reply.queueMinDelay, reply.queueMinDelaySource, reply.targetSeconds, reply.truncated], [
    "live", ALICE, "open", 900, "chain", 172_800, false,
  ])
  assert.deepEqual(reply.requests.map((item) => item.requestId), ["7", "4", "8", "2"]) // newest first, open only

  const byId = new Map(reply.requests.map((item) => [item.requestId, item]))
  const late = byId.get("2")!
  assert.deepEqual(late.asset, { symbol: "tUSDC", address: USDC, decimals: 6 })
  assert.deepEqual([late.arcoUSDAmountHuman, late.assetAmount, late.assetAmountHuman, late.overdue, late.cancellable], ["250", e6(250), "250", true, true])
  assert.equal(late.payableFrom, new Date(NOW - 49 * 60 * MIN + 900_000).toISOString())
  assert.deepEqual(late.position, { ahead: 1, aheadAssetAmount: e6(100), aheadAssetAmountHuman: "100" })
  assert.deepEqual(byId.get("4")!.position, { ahead: 3, aheadAssetAmount: e6(390), aheadAssetAmountHuman: "390" })
  assert.deepEqual(byId.get("7")!.position, { ahead: 0, aheadAssetAmount: "0", aheadAssetAmountHuman: "0" })
  assert.equal(byId.get("4")!.overdue, false)

  const failed = byId.get("8")!
  assert.deepEqual([failed.status, failed.cancellable, failed.overdue, failed.position, failed.failedAt, failed.failedTxHash], [
    "PAYOUT_FAILED", true, false, null, new Date(NOW - 2 * 60 * MIN).toISOString(), "0xf1",
  ])
  // One queue read per asset, shared by every wallet for 5 seconds.
  assert.deepEqual([...store.queuedCalls].sort(), [USDC, USDT])
  const bob = await service(store).forWallet(BOB, "open")
  assert.deepEqual(bob.requests.map((item) => [item.requestId, item.position?.ahead]), [["5", 4], ["3", 2], ["1", 0]])
  const shared = service(store)
  await Promise.all([shared.forWallet(ALICE, "open"), shared.forWallet(BOB, "open"), shared.forWallet(ALICE, "open")])
  assert.equal(store.queuedCalls.length, 2 + 1 + 2) // the second service: USDC once (both wallets), USDT once
})

test("all: every status, newest first, closed ones not cancellable; cut at the limit", async () => {
  const store = new FakeStore()
  store.rows = [
    request(1, ALICE, USDC, 5, 10 * MIN, { status: "PAID", paidAt: new Date(NOW - 5 * MIN), paidTxHash: "0xp1" }),
    request(2, ALICE, USDC, 5, 8 * MIN, { status: "CANCELLED", cancelledAt: new Date(NOW - MIN), cancelledTxHash: "0xc2" }),
    request(3, ALICE, A(0x99), 5, 1 * MIN), // an asset the registry does not know
  ]
  const reply = await service(store, { live: new Error("reserve read failed") }).forWallet(ALICE, "all")
  assert.deepEqual([reply.queueMinDelay, reply.queueMinDelaySource], [600, "registry"])
  assert.deepEqual(reply.requests.map((item) => [item.requestId, item.status, item.cancellable]), [
    ["3", "QUEUED", true],
    ["2", "CANCELLED", false],
    ["1", "PAID", false],
  ])
  const paid = reply.requests[2]
  assert.deepEqual([paid.paidAt, paid.paidTxHash, paid.position, paid.overdue], [new Date(NOW - 5 * MIN).toISOString(), "0xp1", null, false])
  const unknown = reply.requests[0]
  assert.deepEqual([unknown.asset, unknown.assetAmountHuman, unknown.arcoUSDAmountHuman], [{ symbol: A(0x99), address: A(0x99), decimals: null }, null, "5"])
  assert.deepEqual(unknown.position, { ahead: 0, aheadAssetAmount: "0", aheadAssetAmountHuman: null })

  const many = new FakeStore()
  many.rows = Array.from({ length: WALLET_REQUEST_LIMIT + 5 }, (_, index) => request(1000 + index, ALICE, USDC, 1, (200 - index) * MIN, { status: "PAID" }))
  const cut = await service(many).forWallet(ALICE, "all")
  assert.deepEqual([cut.requests.length, cut.truncated, cut.requests[0].requestId], [WALLET_REQUEST_LIMIT, true, String(1000 + WALLET_REQUEST_LIMIT + 4)])
})

test("a queue too long to count, or unreadable, leaves position null rather than a wrong number", async () => {
  const store = new FakeStore()
  store.rows = [request(1, ALICE, USDC, 1, MIN)]
  store.queued = async () => Array.from({ length: POSITION_ROW_LIMIT + 1 }, (_, index) => ({ requestId: String(index), assetAmount: "1" }))
  assert.equal((await service(store).forWallet(ALICE, "open")).requests[0].position, null)

  const flaky = new FakeStore()
  flaky.rows = [request(1, ALICE, USDC, 1, MIN)]
  let fail = true
  flaky.queued = async () => {
    if (fail) throw new Error("timeout")
    return [{ requestId: "1", assetAmount: "1000000" }]
  }
  let clock = NOW
  const logged: string[] = []
  const svc = service(flaky, { now: () => clock, log: (line) => logged.push(line) })
  const first = await svc.forWallet(ALICE, "open")
  assert.deepEqual([first.status, first.requests[0].position], ["live", null]) // the list still answers
  assert.match(logged[0], /queue read failed: timeout/)
  fail = false
  clock += 6_000
  assert.deepEqual((await svc.forWallet(ALICE, "open")).requests[0].position, { ahead: 0, aheadAssetAmount: "0", aheadAssetAmountHuman: "0" }) // a failed read is not cached

  // A malformed row (only a hand edit could make one) counts nothing rather than something wrong.
  const odd = new FakeStore()
  odd.rows = [request(2, ALICE, USDC, 1, MIN)]
  odd.queued = async () => [{ requestId: "1", assetAmount: "not-a-number" }]
  assert.equal((await service(odd).forWallet(ALICE, "open")).requests[0].position, null)

  // A registry delay that is not a number cannot turn into a raw 400: the answer is unavailable.
  const broken = new FakeStore()
  broken.rows = [request(3, ALICE, USDC, 1, MIN)]
  const reply = await service(broken, { live: null, registry: () => ({ ...registry(), params: { ...registry().params!, queueMinDelay: "soon" as never } }) }).forWallet(ALICE, "open")
  assert.deepEqual([reply.status, reply.error], ["unavailable", REDEMPTIONS_ERROR.read])
})

test("not deployed, an invalid registry, a database failure (no detail on the public answer); cached 5 seconds per wallet and filter", async () => {
  const store = new FakeStore()
  const none = await service(store, { registry: () => null }).forWallet(ALICE, "open")
  assert.deepEqual([none.status, none.requests, store.byOwnerCalls], ["not-deployed", [], 0])
  const logged: string[] = []
  const invalid = await service(store, { registry: () => ({ ...registry(), reserve: { proxy: "0x12" } }) as never, log: (line) => logged.push(line) }).forWallet(ALICE, "open")
  assert.deepEqual([invalid.status, invalid.error], ["unavailable", REDEMPTIONS_ERROR.registry])
  assert.match(logged[0], /ArcoUSD registry is invalid/)

  let clock = NOW
  const cached = service(store, { now: () => clock, log: (line) => logged.push(line) })
  store.failing = true
  const down = await cached.forWallet(ALICE, "open")
  assert.deepEqual([down.status, down.error], ["unavailable", REDEMPTIONS_ERROR.read])
  assert.ok(!JSON.stringify(down).includes("db.internal")) // the database host stays in the log
  assert.match(logged[1], /redemptions read failed: .*db\.internal\.example/)
  store.failing = false
  clock += 4_000
  assert.equal((await cached.forWallet(ALICE, "open")).status, "unavailable") // still the cached answer
  assert.equal((await cached.forWallet(ALICE, "all")).status, "live") // another filter: its own entry
  clock += 1_500
  assert.equal((await cached.forWallet(ALICE, "open")).status, "live")
  assert.equal(store.byOwnerCalls, 3)

  // A scan of many wallets keeps at most 1,000 answers: the oldest go first.
  const scan = service(new FakeStore())
  for (let index = 0; index < 1_005; index++) await scan.forWallet(A(0x10000 + index), "open")
  const internals = scan as unknown as { cache: Map<string, unknown> }
  assert.equal(internals.cache.size, 1_000)
  assert.equal(internals.cache.has(`${A(0x10000)}:open`), false)
  assert.equal(internals.cache.has(`${A(0x10000 + 1_004)}:open`), true)
})

test("Prisma store: the owner's rows newest first, the asset's waiting rows oldest first, scalars only", async () => {
  const calls: Record<string, any>[] = []
  const store = new PrismaRedemptionsStore({ arcoUSDRedeemRequest: { findMany: async (args: unknown) => (calls.push(args as Record<string, any>), []) } })
  await store.byOwner({ chainId: 91342, reserveAddress: RESERVE.toUpperCase().replace("0X", "0x"), owner: ALICE, statuses: ["QUEUED", "PAYOUT_FAILED"], limit: 101 })
  assert.deepEqual(calls[0].where, { chainId: 91342, reserveAddress: RESERVE, owner: ALICE, status: { in: ["QUEUED", "PAYOUT_FAILED"] } })
  assert.deepEqual([calls[0].orderBy, calls[0].take], [[{ requestedAt: "desc" }, { queuedBlock: "desc" }], 101])
  await store.byOwner({ chainId: 91342, reserveAddress: RESERVE, owner: ALICE, statuses: null, limit: 101 })
  assert.equal("status" in calls[1].where, false)
  await store.queued({ chainId: 91342, reserveAddress: RESERVE, asset: USDC, limit: 10_001 })
  assert.deepEqual(calls[2].where, { chainId: 91342, reserveAddress: RESERVE, asset: USDC, status: "QUEUED" })
  assert.deepEqual([calls[2].orderBy, calls[2].take, calls[2].select], [[{ requestedAt: "asc" }, { queuedBlock: "asc" }], 10_001, { requestId: true, assetAmount: true }])
})
