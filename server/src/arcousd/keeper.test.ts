import assert from "node:assert/strict"
import test from "node:test"
import { decodeFunctionData, encodeFunctionData, getAddress, HttpRequestError, keccak256, parseTransaction, recoverTransactionAddress, toEventSelector, type Hex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { createLocalKeystoreCustody } from "../stocks-signer/custody-local.js"
import { processQueueAbi } from "./admin.js"
import type { Heartbeat } from "./alerts.js"
import { KEEPER_DEFAULTS, parseArcoUSDKeeperEnv, type ArcoUSDKeeperEnv } from "./keeper-config.js"
import { ArcoUSDKeeper, guardedKeeperSigner, KEEPER_HEARTBEAT, keeperHeldRoles, runKeeperLoop, type KeeperReceipt, type KeeperRpc, type KeeperSigner, type KeeperTx } from "./keeper.js"
import { NO_PAUSES, type AssetState, type ReserveState } from "./reader.js"
import type { ArcoUSDRegistryFile } from "./registry.js"

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`)
const RESERVE = A(0xabc)
const USDC = A(0xc1)
const USDT = A(0xc2)
const MIN = 60_000
const NOW = Date.parse("2026-10-19T12:00:00.000Z")
const PAID = toEventSelector("RedeemPaid(uint256,address,address,uint256)")

function registry(): ArcoUSDRegistryFile {
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
    reserveAssets: [
      { symbol: "tUSDC", address: USDC, decimals: 6, minQueued: "1000000", instantFeeBps: 0, swapFeeBps: 0 },
      { symbol: "tUSDT", address: USDT, decimals: 6, minQueued: "1000000", instantFeeBps: 0, swapFeeBps: 10 },
    ],
    strategies: [],
    params: { mintCap: "1", mmfTargetBps: 5000, bufferFloorBps: 3000, queueMinDelay: 600 },
  }
}

const asset = (symbol: string, address: string, backlog: number): AssetState => ({
  symbol,
  address: address.toLowerCase(),
  decimals: 6,
  depositEnabled: true,
  redeemEnabled: true,
  instantFeeBps: 0,
  swapFeeBps: 0,
  balance: "1000000000",
  queued: "0",
  available: "0",
  balanceHuman: "1000",
  queuedHuman: "0",
  availableHuman: "0",
  queueLength: backlog,
  queueHead: 0,
  queueBacklog: backlog,
})

function state(over: Partial<ReserveState> = {}): ReserveState {
  return {
    blockNumber: "1000",
    totalBacking: "0",
    totalLiabilities: "0",
    totalBackingUsd: "0",
    totalLiabilitiesUsd: "0",
    surplus: "0",
    navOk: true,
    mmfBps: 0,
    mmfTargetBps: 5000,
    bufferFloorBps: 3000,
    queueMinDelay: 600,
    mintCap: "1",
    ...NO_PAUSES,
    assets: [asset("tUSDC", USDC, 2), asset("tUSDT", USDT, 0)],
    strategies: [],
    ...over,
  }
}

class FakeRpc implements KeeperRpc {
  balanceWei = 10n ** 17n
  latest = 5
  pending = 5
  sims = new Map<string, bigint | Error>()
  simulated: string[] = []
  sent: Hex[] = []
  known = new Set<string>()
  receipts = new Map<string, KeeperReceipt>()
  mineOnSend = true
  revert = false
  sendError: Error | null = null
  balanceError: Error | null = null
  async chainId() {
    return 91342
  }
  async balance() {
    if (this.balanceError) throw this.balanceError
    return this.balanceWei
  }
  async nonce(_address: string, tag: "latest" | "pending") {
    return tag === "latest" ? this.latest : this.pending
  }
  async simulate({ asset }: { asset: string; maxCount: number }) {
    this.simulated.push(asset)
    const value = this.sims.get(asset.toLowerCase()) ?? 0n
    if (value instanceof Error) throw value
    return value
  }
  async sendRaw(raw: Hex) {
    if (this.sendError) throw this.sendError
    this.sent.push(raw)
    this.known.add(keccak256(raw))
    this.pending++
    if (this.mineOnSend) this.mine(raw)
    return keccak256(raw)
  }
  mine(raw: Hex, paid = 2) {
    this.receipts.set(keccak256(raw), {
      status: this.revert ? "reverted" : "success",
      blockNumber: 1234n,
      logs: Array.from({ length: this.revert ? 0 : paid }, () => ({ address: RESERVE, topics: [PAID] as Hex[] })),
    })
    this.latest++
  }
  async receipt(hash: Hex) {
    return this.receipts.get(hash) ?? null
  }
  async transaction(hash: Hex) {
    return this.known.has(hash) || this.receipts.has(hash) ? { mined: this.receipts.has(hash) } : null
  }
}

class Beats {
  rows: { at: Date; ok: boolean; error?: string; data?: unknown }[] = []
  previous: Heartbeat | null = null
  async beat(_chainId: number, name: string, beat: { at: Date; ok: boolean; error?: string; data?: unknown }) {
    assert.equal(name, KEEPER_HEARTBEAT)
    this.rows.push(beat)
  }
  async heartbeat() {
    return this.previous
  }
}

/** A real local custody (fixed fees + signed-byte checks) over a throwaway key. */
function realSigner(config: ArcoUSDKeeperEnv) {
  const account = privateKeyToAccount(generatePrivateKey())
  const custody = createLocalKeystoreCustody({
    signerAddress: account.address,
    fees: { gas: config.gasLimit, maxFeePerGas: config.maxFeePerGas, maxPriorityFeePerGas: config.maxPriorityFeePerGas },
    limits: { maxGas: config.gasLimit, maxFeePerGas: config.maxFeePerGas, maxTotalFeeWei: config.gasLimit * config.maxFeePerGas },
    signTransaction: (tx) =>
      account.signTransaction({
        type: "eip1559",
        chainId: tx.chainId,
        nonce: Number(BigInt(tx.nonce)),
        to: tx.to as `0x${string}`,
        data: tx.data as Hex,
        value: 0n,
        gas: BigInt(tx.gasLimit),
        maxFeePerGas: BigInt(tx.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
      }),
  })
  return guardedKeeperSigner({ address: account.address, loadRegistry: registry, chainId: 91342, signOriginal: (request) => custody.signOriginal(request) })
}

function setup(over: { mode?: "off" | "dry-run" | "live"; state?: () => ReserveState; now?: () => number; signer?: KeeperSigner | null; address?: string } = {}) {
  const mode = over.mode ?? "live"
  const base = parseArcoUSDKeeperEnv({ ARCOUSD_KEEPER_MODE: mode, ARCOUSD_KEEPER_ADDRESS: over.address ?? A(0xee) })
  const signer = over.signer === undefined ? (mode === "live" ? realSigner(base) : null) : over.signer
  const config: ArcoUSDKeeperEnv = signer ? { ...base, address: signer.address } : base
  const rpc = new FakeRpc()
  const beats = new Beats()
  let reads = 0
  const keeper = new ArcoUSDKeeper({
    chainId: 91342,
    config,
    loadRegistry: registry,
    readState: async () => {
      reads++
      return (over.state ?? (() => state()))()
    },
    rpc,
    signer,
    store: beats,
    now: over.now ?? (() => NOW),
    sleep: async () => undefined,
    receiptWaitMs: 0,
  })
  return { keeper, rpc, beats, config, signer, reads: () => reads }
}

const lastBeat = (beats: Beats) => beats.rows[beats.rows.length - 1]

// ─────────────────────────────── settings ───────────────────────────────

test("keeper settings: off by default, an address outside off, and refusals by name", () => {
  const defaults = parseArcoUSDKeeperEnv({})
  assert.deepEqual([defaults.mode, defaults.address, defaults.invalid], ["off", null, []])
  assert.deepEqual(
    [defaults.intervalMs, defaults.batch, defaults.gasLimit, defaults.maxFeePerGas, defaults.maxPriorityFeePerGas, defaults.lowGasWei],
    [KEEPER_DEFAULTS.intervalMs, 20, 3_000_000n, 1_000_000_000n, 1_000_000n, 10n ** 16n],
  )
  assert.deepEqual(parseArcoUSDKeeperEnv({ ARCOUSD_KEEPER_MODE: "live" }).invalid, ["ARCOUSD_KEEPER_ADDRESS"])
  const set = parseArcoUSDKeeperEnv({ ARCOUSD_KEEPER_MODE: "dry-run", ARCOUSD_KEEPER_ADDRESS: "0x00000000000000000000000000000000000000ee", ARCOUSD_KEEPER_BATCH: "10" })
  assert.deepEqual([set.mode, set.address, set.batch, set.invalid], ["dry-run", A(0xee), 10, []])
  const bad = parseArcoUSDKeeperEnv({
    ARCOUSD_KEEPER_MODE: "on",
    ARCOUSD_KEEPER_ADDRESS: "0x123",
    ARCOUSD_KEEPER_BATCH: "51",
    ARCOUSD_KEEPER_GAS_LIMIT: "100",
    ARCOUSD_KEEPER_MAX_FEE_WEI: "1000",
    ARCOUSD_KEEPER_PRIORITY_FEE_WEI: "2000",
  })
  assert.deepEqual([...bad.invalid].sort(), [
    "ARCOUSD_KEEPER_ADDRESS",
    "ARCOUSD_KEEPER_BATCH",
    "ARCOUSD_KEEPER_GAS_LIMIT",
    "ARCOUSD_KEEPER_MODE",
    "ARCOUSD_KEEPER_PRIORITY_FEE_WEI",
  ])
})

// ─────────────────────────────── modes ───────────────────────────────

test("off: records that it is off and touches nothing", async () => {
  const { keeper, rpc, beats, reads } = setup({ mode: "off" })
  const tick = await keeper.tick()
  assert.deepEqual([tick.ok, tick.sent, rpc.simulated.length, reads()], [true, 0, 0, 0])
  assert.match(tick.note ?? "", /^Off/)
  assert.equal(lastBeat(beats).ok, true)
})

test("dry-run: asks the chain what would be paid, reports it, never signs", async () => {
  const { keeper, rpc, beats } = setup({ mode: "dry-run" })
  rpc.sims.set(USDC.toLowerCase(), 3n)
  const tick = await keeper.tick()
  assert.deepEqual(tick.simulations, [{ symbol: "tUSDC", paid: 3, error: null }]) // tUSDT has no backlog: not asked
  assert.equal(tick.note, "Dry run: would pay tUSDC")
  assert.deepEqual([rpc.sent.length, tick.sent, tick.lowGas, tick.canAffordTx], [0, 0, false, true])
  assert.equal((lastBeat(beats).data as { gasBalanceWei: string }).gasBalanceWei, (10n ** 17n).toString())
})

test("live: sends processQueue to the Reserve for a payable asset and follows it to its receipt", async () => {
  const { keeper, rpc, config, signer } = setup()
  rpc.sims.set(USDC.toLowerCase(), 2n)
  const tick = await keeper.tick()
  assert.deepEqual([tick.ok, tick.sent, rpc.sent.length], [true, 1, 1])
  const tx = parseTransaction(rpc.sent[0])
  assert.deepEqual([tx.chainId, tx.nonce, getAddress(tx.to!), tx.value ?? 0n, tx.gas, tx.maxFeePerGas], [91342, 5, RESERVE, 0n, config.gasLimit, config.maxFeePerGas])
  const call = decodeFunctionData({ abi: processQueueAbi, data: tx.data! })
  assert.deepEqual([call.functionName, getAddress(call.args[0] as string), call.args[1]], ["processQueue", USDC, 20n])
  assert.equal(await recoverTransactionAddress({ serializedTransaction: rpc.sent[0] as never }), signer!.address)
  assert.deepEqual(
    [tick.lastTx?.status, tick.lastTx?.paid, tick.lastTx?.symbol, tick.lastTx?.blockNumber, tick.lastTx?.hash],
    ["success", 2, "tUSDC", "1234", keccak256(rpc.sent[0])],
  )
})

test("live: nothing payable, payouts paused, or no gas means no transaction", async () => {
  const idle = setup()
  assert.equal((await idle.keeper.tick()).note, "Nothing payable now (in delay, or the Reserve is short)")
  assert.equal(idle.rpc.sent.length, 0)

  const paused = setup({ state: () => state({ queuePaused: true }) })
  paused.rpc.sims.set(USDC.toLowerCase(), 2n)
  assert.match((await paused.keeper.tick()).note ?? "", /Payouts are paused/)
  assert.deepEqual([paused.rpc.simulated.length, paused.rpc.sent.length], [0, 0])

  const broke = setup()
  broke.rpc.sims.set(USDC.toLowerCase(), 2n)
  broke.rpc.balanceWei = 10n ** 15n // below 3,000,000 gas × 1 gwei
  const tick = await broke.keeper.tick()
  assert.deepEqual([tick.ok, tick.canAffordTx, tick.lowGas, broke.rpc.sent.length], [false, false, true, 0])
  assert.match(tick.error ?? "", /top up its gas/)
})

test("live: two payable assets go out one after the other, starting from a rotating asset", async () => {
  const { keeper, rpc } = setup({ state: () => state({ assets: [asset("tUSDC", USDC, 2), asset("tUSDT", USDT, 1)] }) })
  rpc.sims.set(USDC.toLowerCase(), 2n)
  rpc.sims.set(USDT.toLowerCase(), 1n)
  const first = await keeper.tick()
  assert.equal(first.sent, 2)
  const assets = (raws: Hex[]) => raws.map((raw) => getAddress(decodeFunctionData({ abi: processQueueAbi, data: parseTransaction(raw).data! }).args[0] as string))
  assert.deepEqual(rpc.sent.map((raw) => parseTransaction(raw).nonce), [5, 6])
  assert.deepEqual(assets(rpc.sent), [USDC, USDT])
  rpc.sent = []
  await keeper.tick()
  assert.deepEqual(assets(rpc.sent), [USDT, USDC])
})

test("live: a transaction not mined yet blocks the next one until its receipt arrives", async () => {
  let now = NOW
  const { keeper, rpc } = setup({ now: () => now })
  rpc.sims.set(USDC.toLowerCase(), 2n)
  rpc.mineOnSend = false
  const sent = await keeper.tick()
  assert.deepEqual([sent.sent, sent.note, sent.lastTx?.status, sent.pending?.stuck], [1, "Sent; waiting for the receipt", "pending", false])
  now += MIN
  const waiting = await keeper.tick()
  assert.deepEqual([waiting.note, rpc.sent.length], ["Waiting for the last transaction", 1])
  now += 11 * MIN
  assert.equal((await keeper.tick()).pending?.stuck, true)
  rpc.mine(rpc.sent[0])
  rpc.mineOnSend = true
  now += MIN
  const settled = await keeper.tick()
  // The first settles, and the next payable round goes out with the next nonce.
  assert.deepEqual([rpc.sent.length, parseTransaction(rpc.sent[1]).nonce, settled.lastTx?.status, settled.lastTx?.nonce], [2, 6, "success", 6])
})

test("live: a pending transaction it did not send (restart, manual) is waited for, and reported stuck", async () => {
  let now = NOW
  const { keeper, rpc } = setup({ now: () => now })
  rpc.sims.set(USDC.toLowerCase(), 2n)
  rpc.pending = 6 // one ahead of the mined nonce
  const tick = await keeper.tick()
  assert.deepEqual([tick.pending?.hash, tick.pending?.nonce, tick.pending?.stuck, rpc.sent.length], [null, 5, false, 0])
  now += 11 * MIN
  assert.equal((await keeper.tick()).pending?.stuck, true)
})

test("live: a failed send is reported; one the node took anyway is followed; a dropped one is let go", async () => {
  const refused = setup()
  refused.rpc.sims.set(USDC.toLowerCase(), 2n)
  refused.rpc.sendError = new Error("nonce too low")
  const tick = await refused.keeper.tick()
  assert.deepEqual([tick.ok, tick.lastTx?.status], [false, "failed"])
  assert.match(tick.error ?? "", /Send failed: nonce too low/)

  // The node errors but did accept it (its pending nonce moved): keep following it.
  const accepted = setup()
  accepted.rpc.sims.set(USDC.toLowerCase(), 2n)
  accepted.rpc.mineOnSend = false
  accepted.rpc.sendRaw = async (raw: Hex) => {
    accepted.rpc.pending++
    accepted.rpc.known.add(keccak256(raw))
    throw new Error("timeout")
  }
  const followed = await accepted.keeper.tick()
  assert.deepEqual([followed.ok, followed.lastTx?.status, followed.pending?.nonce], [true, "pending", 5])

  // Not mined, nonce unused and gone from the pending view for over two minutes: dropped.
  let now = NOW
  const dropped = setup({ now: () => now })
  dropped.rpc.sims.set(USDC.toLowerCase(), 2n)
  dropped.rpc.mineOnSend = false
  await dropped.keeper.tick()
  dropped.rpc.pending = dropped.rpc.latest
  dropped.rpc.known.clear() // the node forgot it
  now += 3 * MIN
  await dropped.keeper.tick()
  assert.equal(dropped.rpc.sent.length, 2) // it went again from the same nonce
  assert.equal(parseTransaction(dropped.rpc.sent[1]).nonce, 5)
})

test("live: after a revert it holds for ten minutes, simulating only", async () => {
  let now = NOW
  const { keeper, rpc } = setup({ now: () => now })
  rpc.sims.set(USDC.toLowerCase(), 2n)
  rpc.revert = true
  const reverted = await keeper.tick()
  assert.deepEqual([reverted.ok, reverted.lastTx?.status], [false, "reverted"])
  assert.match(reverted.error ?? "", /reverted .*holding for 10 minutes/)
  now += 5 * MIN
  rpc.revert = false
  const held = await keeper.tick()
  // Holding is not healthy: it reports an error so the watcher's keeper:failing can fire.
  assert.equal(held.ok, false)
  assert.match(held.error ?? "", /^Holding after a reverted transaction/)
  assert.ok(held.holdUntil)
  assert.equal(rpc.sent.length, 1)
  now += 6 * MIN
  await keeper.tick()
  assert.equal(rpc.sent.length, 2)
})

test("restart: a transaction recorded as pending is followed up from the heartbeat", async () => {
  const { keeper, rpc, beats } = setup()
  const hash = keccak256("0x01")
  const last: KeeperTx = { hash, symbol: "tUSDC", asset: USDC, nonce: 5, sentAt: new Date(NOW - MIN).toISOString(), status: "pending", paid: null, blockNumber: null, error: null }
  beats.previous = { lastRunAt: new Date(NOW - MIN), lastOkAt: null, lastError: null, data: { lastTx: last } }
  rpc.pending = 6
  rpc.known.add(hash)
  const waiting = await keeper.tick()
  assert.deepEqual([waiting.note, waiting.pending?.hash], ["Waiting for the last transaction", hash])
  rpc.known.add(hash)
  rpc.receipts.set(hash, { status: "success", blockNumber: 9n, logs: [{ address: RESERVE, topics: [PAID] }] })
  rpc.latest = 6
  const settled = await keeper.tick()
  assert.deepEqual([settled.lastTx?.status, settled.lastTx?.paid], ["success", 1])
})

test("errors that reach the heartbeat carry no RPC URL", async () => {
  const { keeper, rpc, beats } = setup({ mode: "dry-run" })
  rpc.balanceError = new HttpRequestError({ url: "https://rpc.example.invalid/SECRETKEY42", status: 429, body: {}, details: "Too Many Requests" })
  const tick = await keeper.tick()
  assert.equal(tick.ok, false)
  assert.ok(!JSON.stringify(beats.rows).includes("SECRETKEY42"))
  assert.match(tick.error ?? "", /rpc\.example\.invalid, HTTP 429/)
})

// ─────────────────────────────── signing guard ───────────────────────────────

test("signer: only canonical processQueue(<registry asset>, 1..50) to the Reserve on 91342 with value 0", async () => {
  const signed: unknown[] = []
  const signer = guardedKeeperSigner({ address: A(0xee), loadRegistry: registry, chainId: 91342, signOriginal: async (request) => (signed.push(request), "0x02aa") })
  const call = (assetAddress: string, count: bigint) => encodeFunctionData({ abi: processQueueAbi, functionName: "processQueue", args: [assetAddress as `0x${string}`, count] })
  const ok = { chainId: 91342 as const, nonce: 1n, to: RESERVE, data: call(USDC, 20n), value: 0n as const }
  assert.equal(await signer.sign(ok), "0x02aa")
  await assert.rejects(signer.sign({ ...ok, to: A(0x99) }), /Only the ArcoUSD Reserve/)
  await assert.rejects(signer.sign({ ...ok, data: call(A(0x77), 20n) }), /Only a Reserve asset/)
  await assert.rejects(signer.sign({ ...ok, data: call(USDC, 0n) }), /Batch must be 1\.\.50/)
  await assert.rejects(signer.sign({ ...ok, data: call(USDC, 51n) }), /Batch must be 1\.\.50/)
  await assert.rejects(signer.sign({ ...ok, data: "0xa9059cbb" }), /Only processQueue/)
  await assert.rejects(signer.sign({ ...ok, data: `${call(USDC, 20n)}00` as Hex }), /canonical/)
  await assert.rejects(signer.sign({ ...ok, value: 1n as 0n }), /value 0/)
  assert.equal(signed.length, 1)

  // A live keeper needs the signer for exactly its configured address.
  const config = parseArcoUSDKeeperEnv({ ARCOUSD_KEEPER_MODE: "live", ARCOUSD_KEEPER_ADDRESS: A(0xef) })
  assert.throws(
    () => new ArcoUSDKeeper({ chainId: 91342, config, loadRegistry: registry, readState: async () => state(), rpc: new FakeRpc(), signer, store: new Beats() }),
    /needs the keeper signer/,
  )
  assert.throws(() => new ArcoUSDKeeper({ chainId: 91342, config, loadRegistry: registry, readState: async () => state(), rpc: new FakeRpc(), signer: null, store: new Beats() }))
})

test("the loop ticks until aborted, finishing the tick in progress", async () => {
  const controller = new AbortController()
  let ticks = 0
  const lines: unknown[] = []
  await runKeeperLoop({
    keeper: {
      tick: async () => {
        ticks++
        if (ticks === 2) controller.abort()
        return { mode: "dry-run", ok: true, error: null, sent: 0, note: null, lastTx: null } as never
      },
    },
    intervalMs: 1,
    signal: controller.signal,
    log: (line) => lines.push(line),
  })
  assert.deepEqual([ticks, lines.length], [2, 2])
})

// ─────────────────────────────── review follow-ups ───────────────────────────────

test("live: a revert seen on a later tick also holds, and is reported (not overwritten)", async () => {
  let now = NOW
  const { keeper, rpc, beats } = setup({ now: () => now })
  rpc.sims.set(USDC.toLowerCase(), 2n)
  rpc.mineOnSend = false
  await keeper.tick()
  rpc.revert = true
  rpc.mine(rpc.sent[0])
  now += MIN
  const late = await keeper.tick()
  assert.deepEqual([late.ok, late.lastTx?.status, rpc.sent.length], [false, "reverted", 1])
  assert.match(late.error ?? "", /reverted .*holding for 10 minutes/)
  assert.equal((lastBeat(beats).data as { lastTx: KeeperTx }).lastTx.status, "reverted")
  now += MIN
  rpc.revert = false
  const held = await keeper.tick()
  assert.deepEqual([held.ok, rpc.sent.length], [false, 1])
})

test("live: a revert hold survives a restart", async () => {
  const { keeper, rpc, beats } = setup()
  rpc.sims.set(USDC.toLowerCase(), 2n)
  beats.previous = { lastRunAt: new Date(NOW - MIN), lastOkAt: null, lastError: "x", data: { holdUntil: new Date(NOW + 5 * MIN).toISOString(), lastTx: null } }
  const tick = await keeper.tick()
  assert.deepEqual([tick.ok, rpc.sent.length], [false, 0])
  assert.match(tick.error ?? "", /^Holding/)
})

test("live: cancelled or failed entries filling the batch are stepped past when payable requests wait behind them", async () => {
  const backlog = { ...asset("tUSDC", USDC, 30), queued: "5000000" }
  const { keeper, rpc } = setup({ state: () => state({ assets: [backlog] }) })
  // Within the 20-entry batch nothing pays; a wider look (past the batch) does.
  rpc.simulate = async ({ maxCount }: { asset: string; maxCount: number }) => (maxCount > 20 ? 1n : 0n)
  const tick = await keeper.tick()
  assert.deepEqual(tick.simulations, [{ symbol: "tUSDC", paid: 0, error: null, clearing: true }])
  assert.equal(rpc.sent.length, 1)
  assert.equal(decodeFunctionData({ abi: processQueueAbi, data: parseTransaction(rpc.sent[0]).data! }).args[1], 50n)

  // Nothing Queued at all (only cancelled entries): no wider look, nothing sent.
  const empty = setup({ state: () => state({ assets: [{ ...asset("tUSDC", USDC, 30), queued: "0" }] }) })
  let looks = 0
  empty.rpc.simulate = async () => (looks++, 0n)
  await empty.keeper.tick()
  assert.deepEqual([looks, empty.rpc.sent.length], [1, 0])
})

test("live: its own transaction whose receipt lags is not called replaced; an unknown one is", async () => {
  let now = NOW
  const own = setup({ now: () => now })
  own.rpc.sims.set(USDC.toLowerCase(), 2n)
  own.rpc.mineOnSend = false
  await own.keeper.tick()
  own.rpc.latest = 6 // nonce used, but this node has no receipt yet; it does know the transaction
  now += MIN
  const lagging = await own.keeper.tick()
  assert.deepEqual([lagging.note, lagging.lastTx?.status], ["Waiting for the last transaction", "pending"])

  const other = setup({ now: () => now })
  other.rpc.sims.set(USDC.toLowerCase(), 2n)
  other.rpc.mineOnSend = false
  await other.keeper.tick()
  other.rpc.known.clear()
  other.rpc.latest = 6
  other.rpc.pending = 6
  await other.keeper.tick()
  // Settled as replaced, and the next payable round went out on the next free nonce.
  assert.deepEqual([other.rpc.sent.length, parseTransaction(other.rpc.sent[1]).nonce], [2, 6])
})

test("off keeps the last transaction; a failed first read of the heartbeat is retried", async () => {
  const last: KeeperTx = { hash: keccak256("0x02"), symbol: "tUSDC", asset: USDC, nonce: 4, sentAt: new Date(NOW - MIN).toISOString(), status: "success", paid: 2, blockNumber: "10", error: null }
  const off = setup({ mode: "off" })
  off.beats.previous = { lastRunAt: new Date(NOW - MIN), lastOkAt: null, lastError: null, data: { lastTx: last } }
  assert.equal((await off.keeper.tick()).lastTx?.hash, last.hash)

  const flaky = setup({ mode: "dry-run" })
  let reads = 0
  flaky.beats.heartbeat = async () => {
    reads++
    if (reads === 1) throw new Error("db blip")
    return { lastRunAt: new Date(NOW - MIN), lastOkAt: null, lastError: null, data: { lastTx: last } }
  }
  const blind = await flaky.keeper.tick()
  // State unreadable: nothing sent, and the stored report is left as it was (data undefined).
  assert.deepEqual([blind.ok, blind.lastTx, flaky.rpc.simulated.length, lastBeat(flaky.beats).data], [false, null, 0, undefined])
  assert.equal((await flaky.keeper.tick()).lastTx?.hash, last.hash)
})

test("a round that stops before asking the chain says so", async () => {
  const { keeper, rpc } = setup()
  rpc.pending = 6
  const tick = await keeper.tick()
  assert.deepEqual([tick.simulated, tick.simulations], [false, []])
  const dry = setup({ mode: "dry-run" })
  assert.equal((await dry.keeper.tick()).simulated, true)
})

test("the keeper wallet must hold no role on the Reserve, ArcoUSD or the Router", async () => {
  const deployment = { reserveAddress: RESERVE, arcoUSDAddress: A(1), routerAddress: A(6) } as never
  const asked: string[] = []
  const client = {
    readContract: async ({ address, args }: { address: string; args: readonly unknown[] }) => {
      asked.push(`${address}:${String(args[0])}`)
      return address === RESERVE && args[0] === `0x${"00".repeat(32)}`
    },
  }
  assert.deepEqual(await keeperHeldRoles(client as never, deployment, A(0xee)), ["Reserve:DEFAULT_ADMIN_ROLE"])
  assert.equal(asked.length, 12) // Reserve 4, ArcoUSD 6, Router 2
})

test("live: the hash is recorded before the broadcast, and a dropped transaction is re-broadcast byte for byte", async () => {
  let now = NOW
  const { keeper, rpc, beats } = setup({ now: () => now })
  rpc.sims.set(USDC.toLowerCase(), 2n)
  rpc.mineOnSend = false
  const order: string[] = []
  const send = rpc.sendRaw.bind(rpc)
  rpc.sendRaw = async (raw: Hex) => {
    order.push(`send:${(lastBeat(beats).data as { lastTx?: KeeperTx } | undefined)?.lastTx?.status ?? "none"}`)
    return send(raw)
  }
  await keeper.tick()
  assert.deepEqual(order, ["send:pending"]) // the pending hash was in the heartbeat first
  rpc.known.clear() // a node dropped it
  now += 3 * MIN
  const again = await keeper.tick()
  assert.equal(again.note, "Waiting for the last transaction")
  assert.equal(rpc.sent.length, 2)
  assert.equal(rpc.sent[1], rpc.sent[0]) // the same signed bytes, not a new call
})
