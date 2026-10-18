import assert from "node:assert/strict"
import test from "node:test"
import { decodeFunctionData } from "viem"
import { ArcoUSDRecalls, createRecallReader, recallStateOf, reserveRecallAbi, type RecallChainState, type RecallReader, type RecallRow } from "./recall.js"
import type { ArcoUSDRegistryFile } from "./registry.js"

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
const RESERVE = "0x00000000000000000000000000000000000000E5" as `0x${string}`
const UMINT_VAULT = A(0x51)
const IBENJI_VAULT = A(0x52)

function registry(overrides: Partial<ArcoUSDRegistryFile> = {}): ArcoUSDRegistryFile {
  return {
    schemaVersion: 1,
    chainId: 91342,
    network: "giwa-sepolia",
    deployed: true,
    deploymentBlock: 100,
    arcoUSD: { proxy: A(1), implementation: A(2), bytecodeHash: null },
    reserve: { proxy: RESERVE, implementation: A(4), bytecodeHash: null },
    lens: { address: A(5), bytecodeHash: null },
    testAssets: [],
    reserveAssets: [{ symbol: "tUSDC", address: A(0xc1), decimals: 6, minQueued: "1", instantFeeBps: 0 }],
    strategies: [
      { productId: "umint", strategyId: 0, maxAllocation: "1" },
      { productId: "ibenji", strategyId: 1, maxAllocation: "1" },
    ],
    params: { mintCap: "1", mmfTargetBps: 5000, bufferFloorBps: 3000, queueMinDelay: 600 },
    ...overrides,
  }
}

class FakeReader implements RecallReader {
  blocks = 0
  requests = 0
  vaults = new Map<number, string>([
    [0, UMINT_VAULT],
    [1, IBENJI_VAULT],
  ])
  state = new Map<string, RecallChainState>()
  failRequest = false
  async blockNumber() {
    this.blocks++
    return 500n
  }
  async request(_deployment: unknown, strategyId: number, vaultRequestId: bigint, blockNumber: bigint) {
    assert.equal(blockNumber, 500n)
    this.requests++
    if (this.failRequest) throw new Error("rpc down")
    return this.state.get(`${strategyId}:${vaultRequestId}`) ?? { pending: 0n, open: false }
  }
  async strategyVault(_deployment: unknown, strategyId: number, blockNumber: bigint) {
    assert.equal(blockNumber, 500n)
    return this.vaults.get(strategyId) ?? A(0)
  }
}

const row = (requestId: string, status: string, overrides: Partial<RecallRow> = {}): RecallRow => ({
  productId: "umint",
  requestId,
  status,
  walletAddress: RESERVE.toLowerCase(),
  redemptionVaultAddress: UMINT_VAULT,
  lockedAssetsOut: "5000000",
  createdAt: new Date(0),
  ...overrides,
})

function setup(load: () => ArcoUSDRegistryFile | null = () => registry(), reader: FakeReader | null = new FakeReader()) {
  let now = 0
  const recalls = new ArcoUSDRecalls({ chainId: 91342, loadRegistry: load, ...(reader ? { read: reader } : {}), now: () => now })
  return { recalls, reader: reader!, advance: (ms: number) => (now += ms) }
}

test("state follows the redemption status and the Reserve's own view of the recall", () => {
  const pending = { pending: 5n, open: true }
  assert.deepEqual(recallStateOf("REQUESTED", pending), { state: "requested", action: null, warning: null })
  assert.deepEqual(recallStateOf("SETTLING", null), { state: "settling", action: null, warning: null })
  // Open but no longer pending = acknowledged before payment.
  assert.match(recallStateOf("REQUESTED", { pending: 0n, open: true }).warning ?? "", /understated/)
  // Claimed by anyone before the core indexer caught up: not open, so no false alarm.
  assert.equal(recallStateOf("REQUESTED", { pending: 0n, open: false }).warning, null)
  assert.deepEqual(recallStateOf("SETTLED", pending), { state: "awaiting-acknowledgement", action: "acknowledge", warning: null })
  assert.deepEqual(recallStateOf("SETTLED", { pending: 0n, open: true }), { state: "done", action: null, warning: null })
  assert.deepEqual(recallStateOf("FULFILLED", pending), { state: "claimable", action: "claim", warning: null })
  assert.deepEqual(recallStateOf("FULFILLED", { pending: 0n, open: false }), { state: "done", action: null, warning: null })
  assert.deepEqual(recallStateOf("CLAIMED", null), { state: "done", action: null, warning: null })
  assert.deepEqual(recallStateOf("SETTLED", null), { state: "unknown", action: null, warning: null })
  // Settled by direct transfer AND fulfilled by the vault: paid twice, flagged (still claimable).
  const twice = recallStateOf("FULFILLED", pending, "0xabc")
  assert.equal(twice.action, "claim")
  assert.match(twice.warning ?? "", /Paid twice/)
  // Once claimed it is history (reconciliation's job), not a standing alarm on the card.
  assert.deepEqual(recallStateOf("CLAIMED", null, "0xabc"), { state: "done", action: null, warning: null })
})

test("a malformed strategies list never throws (the pending list and every settle depend on it)", () => {
  const broken = setup(() => registry({ strategies: [null, 7, { productId: 3 }, { productId: "umint", strategyId: "0" }] as never }))
  const [annotated] = broken.recalls.annotate([row("2", "REQUESTED")])
  assert.deepEqual([annotated.kind, annotated.strategyId], ["arcousd-recall", null])
  assert.equal(broken.recalls.strategyIdOf(row("2", "SETTLED", { walletAddress: A(0xc1) })), undefined)
  assert.equal(setup(() => "nonsense" as never).recalls.annotate([row("2", "REQUESTED")])[0].kind, "customer")
})

test("fresh reads and invalidation: never served from (or refilled by) a read that started before", async () => {
  const { recalls, reader, advance } = setup()
  let calls = 0
  let release: (() => void) | null = null
  const rows = [row("2", "SETTLED")]
  const load = async () => {
    calls++
    if (calls === 1) {
      // A slow read that started before the payout was settled: it still sees the row in flight.
      await new Promise<void>((resolve) => (release = resolve))
      return [row("2", "SETTLING")]
    }
    return rows
  }
  reader.state.set("0:2", { pending: 5_000_000n, open: true })
  const stale = recalls.snapshot(load)
  await new Promise((resolve) => setImmediate(resolve))
  reader.state.set("0:2", { pending: 0n, open: true }) // acknowledged meanwhile
  const fresh = await recalls.snapshot(load, { fresh: true })
  assert.equal(fresh.recalls[0].state, "done")
  release!()
  assert.equal((await stale).recalls[0].state, "settling")
  // The late stale read did not replace the fresh result in the cache.
  assert.equal((await recalls.snapshot(load)).recalls[0].state, "done")
  assert.equal(calls, 2)
  // invalidate(): the next plain read starts over.
  recalls.invalidate()
  await recalls.snapshot(load)
  assert.equal(calls, 3)
  advance(1)
})

test("row reads run at most 4 at a time", async () => {
  const { recalls, reader } = setup()
  let inFlight = 0
  let peak = 0
  reader.request = async () => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 2))
    inFlight--
    return { pending: 5_000_000n, open: true }
  }
  const rows = Array.from({ length: 10 }, (_value, index) => row(String(index + 1), "SETTLED"))
  const snapshot = await recalls.snapshot(async () => rows)
  assert.equal(snapshot.recalls.length, 10)
  assert.deepEqual(snapshot.recalls.map((item) => item.requestId), rows.map((item) => item.requestId)) // order kept
  assert.equal(peak, 4)
})

test("recalls are recognised by the Reserve address, even when the registry fails validation", () => {
  const rows = [row("1", "REQUESTED", { walletAddress: A(0xc1) }), row("2", "REQUESTED"), row("3", "REQUESTED", { productId: "other" })]
  const kinds = (recalls: ArcoUSDRecalls) => recalls.annotate(rows).map((item) => [item.requestId, item.kind, item.strategyId])
  assert.deepEqual(kinds(setup().recalls), [["1", "customer", undefined], ["2", "arcousd-recall", 0], ["3", "arcousd-recall", null]])
  // Invalid (a strategy without its id): still labelled, so nobody pays it as a customer.
  const invalid = setup(() => registry({ strategies: [{ productId: "umint", strategyId: null, maxAllocation: "1" }] }))
  assert.deepEqual(kinds(invalid.recalls)[1], ["2", "arcousd-recall", null])
  assert.equal(invalid.recalls.deployment(), null)
  // No file, or an unparseable one: nothing can be recognised.
  assert.deepEqual(kinds(setup(() => null).recalls).map((item) => item[1]), ["customer", "customer", "customer"])
  const unreadable = setup(() => {
    throw new SyntaxError("Unexpected token")
  })
  assert.deepEqual(kinds(unreadable.recalls).map((item) => item[1]), ["customer", "customer", "customer"])
})

test("snapshot: one block, CLAIMED rows not read, cached and single-flight, and never throws", async () => {
  const { recalls, reader, advance } = setup()
  reader.state.set("0:2", { pending: 5_000_000n, open: true })
  reader.state.set("0:3", { pending: 5_000_000n, open: true })
  let loads = 0
  const rows = [
    row("1", "REQUESTED", { walletAddress: A(0xc1) }), // customer: ignored
    row("2", "SETTLED"),
    row("3", "FULFILLED"),
    row("4", "CLAIMED"),
    row("5", "SETTLED", { productId: "ibenji", redemptionVaultAddress: UMINT_VAULT }), // wrong vault for strategy 1
  ]
  const load = async (reserve: string) => {
    assert.equal(reserve.toLowerCase(), RESERVE.toLowerCase())
    loads++
    return rows
  }
  const [snapshot, concurrent] = await Promise.all([recalls.snapshot(load), recalls.snapshot(load)])
  assert.equal(snapshot, concurrent)
  assert.equal(snapshot.status, "live")
  assert.deepEqual(
    snapshot.recalls.map((item) => [item.requestId, item.state, item.action, item.error === null]),
    [
      ["2", "awaiting-acknowledgement", "acknowledge", true],
      ["3", "claimable", "claim", true],
      ["4", "done", null, true],
      ["5", "unknown", null, false],
    ],
  )
  assert.match(snapshot.recalls[3].error ?? "", /not this request's vault/)
  assert.equal(reader.blocks, 1)
  assert.equal(reader.requests, 2) // rows 2 and 3; CLAIMED and the mismatched row are not read
  assert.equal(loads, 1)
  advance(4_000)
  await recalls.snapshot(load)
  assert.equal(loads, 1)
  advance(2_000)
  await recalls.snapshot(load)
  assert.equal(loads, 2)

  reader.failRequest = true
  advance(10_000)
  const failed = await recalls.snapshot(load)
  assert.equal(failed.status, "live")
  assert.equal(failed.recalls[0].action, null)
  assert.match(failed.recalls[0].error ?? "", /rpc down/)
})

test("snapshot status: not-deployed, or unavailable with the reason (rows still listed, no actions)", async () => {
  const rows = async () => [row("2", "SETTLED")]
  assert.deepEqual(await setup(() => null).recalls.snapshot(rows), { status: "not-deployed", recalls: [] })
  const unreadable = await setup(() => {
    throw new SyntaxError("Unexpected token")
  }).recalls.snapshot(rows)
  assert.equal(unreadable.status, "unavailable")
  const invalid = await setup(() => registry({ lens: { address: null, bytecodeHash: null } })).recalls.snapshot(async () => [
    row("2", "SETTLED"),
    row("4", "CLAIMED"),
  ])
  assert.equal(invalid.status, "unavailable")
  assert.match(invalid.status === "unavailable" ? invalid.error : "", /lens.address/)
  assert.equal(invalid.recalls.length, 2)
  assert.equal(invalid.recalls[0].action, null)
  assert.match(invalid.recalls[0].error ?? "", /registry is invalid/)
  // A claimed recall is final: no error to repeat on it.
  assert.deepEqual([invalid.recalls[1].state, invalid.recalls[1].error], ["done", null])
  const failingRows = await setup().recalls.snapshot(async () => {
    throw new Error("db down")
  })
  assert.equal(failingRows.status, "unavailable")
})

test("transaction builders: every unsafe case is refused, and the success encodes the Reserve call", async () => {
  const refused = async (promise: ReturnType<ArcoUSDRecalls["acknowledgeTransaction"]>, status: number, pattern: RegExp) => {
    const result = await promise
    assert.equal(result.ok, false, String(pattern))
    if (!result.ok) {
      assert.equal(result.status, status, result.error)
      assert.match(result.error, pattern)
    }
  }
  const { recalls, reader } = setup()
  await refused(recalls.acknowledgeTransaction(null), 404, /not found/)
  await refused(recalls.acknowledgeTransaction(row("2", "SETTLED", { walletAddress: A(0xc1) })), 409, /Not an ArcoUSD Reserve recall/)
  await refused(recalls.acknowledgeTransaction(row("2", "SETTLED", { productId: "other" })), 409, /No ArcoUSD strategy/)
  await refused(recalls.acknowledgeTransaction(row("2", "SETTLING")), 409, /settled/)
  await refused(recalls.claimTransaction(row("2", "SETTLED")), 409, /fulfilled/)
  assert.equal(reader.requests, 0) // refused before any read

  await refused(recalls.acknowledgeTransaction(row("2", "SETTLED", { redemptionVaultAddress: IBENJI_VAULT })), 409, /not this request's vault/)
  await refused(recalls.acknowledgeTransaction(row("2", "SETTLED")), 409, /no longer counts/)
  reader.state.set("0:2", { pending: 4_000_000n, open: true })
  await refused(recalls.acknowledgeTransaction(row("2", "SETTLED")), 409, /not the request's locked payout/)
  reader.state.set("0:3", { pending: 5_000_000n, open: false })
  await refused(recalls.claimTransaction(row("3", "FULFILLED")), 409, /no open recall/)

  await refused(setup(undefined, null).recalls.acknowledgeTransaction(row("2", "SETTLED")), 503, /reader unavailable/)
  await refused(setup(() => null).recalls.acknowledgeTransaction(row("2", "SETTLED")), 409, /not deployed/)
  await refused(setup(() => registry({ deployed: false })).recalls.acknowledgeTransaction(row("2", "SETTLED")), 409, /not deployed/)
  await refused(
    setup(() => registry({ lens: { address: null, bytecodeHash: null } })).recalls.acknowledgeTransaction(row("2", "SETTLED")),
    503,
    /registry is invalid/,
  )
  const failing = setup()
  failing.reader.failRequest = true
  await refused(failing.recalls.acknowledgeTransaction(row("2", "SETTLED")), 503, /rpc down/)

  reader.state.set("0:2", { pending: 5_000_000n, open: true })
  const acknowledge = await recalls.acknowledgeTransaction(row("2", "SETTLED"))
  assert.equal(acknowledge.ok, true)
  if (acknowledge.ok) {
    assert.equal(acknowledge.transaction.to, RESERVE)
    assert.equal(acknowledge.transaction.chainId, 91342)
    const call = decodeFunctionData({ abi: reserveRecallAbi, data: acknowledge.transaction.data })
    assert.equal(call.functionName, "acknowledgeRecallPaid")
    assert.deepEqual(call.args, [0n, 2n])
  }
  reader.state.set("1:7", { pending: 0n, open: true }) // acknowledged, then fulfilled: still claimable
  const claim = await recalls.claimTransaction(row("7", "FULFILLED", { productId: "ibenji", redemptionVaultAddress: IBENJI_VAULT }))
  assert.equal(claim.ok, true)
  if (claim.ok) assert.deepEqual(decodeFunctionData({ abi: reserveRecallAbi, data: claim.transaction.data }).args, [1n, 7n])
})

test("chain reader pins every read to the given block", async () => {
  const calls: { functionName: string; args: readonly unknown[]; blockNumber?: bigint }[] = []
  const reader = createRecallReader({
    getBlockNumber: async () => 55n,
    readContract: (async (args: { functionName: string; args: readonly unknown[]; blockNumber?: bigint }) => {
      calls.push(args)
      if (args.functionName === "recallRequests") return 7n
      if (args.functionName === "recallOpen") return true
      return { redemptionVault: UMINT_VAULT }
    }) as never,
  })
  const deployment = { reserveAddress: RESERVE } as never
  assert.equal(await reader.blockNumber(), 55n)
  assert.deepEqual(await reader.request(deployment, 0, 12n, 55n), { pending: 7n, open: true })
  assert.equal(await reader.strategyVault(deployment, 0, 55n), UMINT_VAULT)
  assert.deepEqual(calls.map((call) => [call.functionName, call.blockNumber]).sort(), [
    ["getStrategy", 55n],
    ["recallOpen", 55n],
    ["recallRequests", 55n],
  ])
})
