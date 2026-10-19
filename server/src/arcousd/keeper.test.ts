import assert from "node:assert/strict"
import test from "node:test"
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  HttpRequestError,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  toEventSelector,
  type Hex,
} from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { createLocalKeystoreCustody } from "../stocks-signer/custody-local.js"
import { distributorAbi, distributorEventsAbi } from "./abi.js"
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
const VAULT = A(0x5a)
const DISTRIBUTOR = A(0x5b)
const MIN = 60_000
const NOW = Date.parse("2026-10-19T12:00:00.000Z")
const PAID = toEventSelector("RedeemPaid(uint256,address,address,uint256)")

function registry(withSavings = false): ArcoUSDRegistryFile {
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
    ...(withSavings
      ? {
          savings: {
            vault: { proxy: VAULT, implementation: A(0x50), bytecodeHash: null, blockNumber: 150 },
            distributor: { address: DISTRIBUTOR, bytecodeHash: null, blockNumber: 151 },
            zap: { address: A(0x5c), bytecodeHash: null, blockNumber: 152 },
            seeded: true,
          },
        }
      : {}),
  }
}
const withSavings = () => registry(true)
const DISTRIBUTE = encodeFunctionData({ abi: distributorAbi, functionName: "distribute" })
const e18 = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n

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
  /** distributor.preview(): by default not due for another hour. */
  preview: { amount: bigint; nextAt: bigint } | Error = { amount: 0n, nextAt: BigInt((NOW + 60 * MIN) / 1000) }
  distributeSim: { ok: true; amount: bigint } | { ok: false; revert: string } | Error = { ok: true, amount: 0n }
  previews = 0
  distributeSims = 0
  /** ArcoUSD the next mined distribute() reports in its Distributed event. */
  minted = 0n
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
  async distributorPreview(distributor: string) {
    assert.equal(getAddress(distributor), DISTRIBUTOR)
    this.previews++
    if (this.preview instanceof Error) throw this.preview
    return this.preview
  }
  async simulateDistribute({ distributor }: { distributor: string }) {
    assert.equal(getAddress(distributor), DISTRIBUTOR)
    this.distributeSims++
    if (this.distributeSim instanceof Error) throw this.distributeSim
    return this.distributeSim
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
    const distribute = getAddress(parseTransaction(raw).to!) === DISTRIBUTOR
    const distributed = {
      address: DISTRIBUTOR,
      topics: encodeEventTopics({ abi: distributorEventsAbi, eventName: "Distributed", args: { caller: A(0xee) } }) as Hex[],
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
        [this.minted, e18(1000), e18(990), e18(5), e18(3)],
      ),
    }
    this.receipts.set(keccak256(raw), {
      status: this.revert ? "reverted" : "success",
      blockNumber: 1234n,
      logs: this.revert ? [] : distribute ? [distributed] : Array.from({ length: paid }, () => ({ address: RESERVE, topics: [PAID] as Hex[] })),
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
function realSigner(config: ArcoUSDKeeperEnv, loadRegistry: () => ArcoUSDRegistryFile = registry) {
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
  return guardedKeeperSigner({ address: account.address, loadRegistry, chainId: 91342, signOriginal: (request) => custody.signOriginal(request) })
}

function setup(
  over: {
    mode?: "off" | "dry-run" | "live"
    state?: () => ReserveState
    now?: () => number
    signer?: KeeperSigner | null
    address?: string
    /** Savings in the registry (the distribute step runs). */
    savings?: boolean
    env?: Record<string, string>
  } = {},
) {
  const mode = over.mode ?? "live"
  const loadRegistry = over.savings ? withSavings : registry
  const base = parseArcoUSDKeeperEnv({ ARCOUSD_KEEPER_MODE: mode, ARCOUSD_KEEPER_ADDRESS: over.address ?? A(0xee), ...over.env })
  const signer = over.signer === undefined ? (mode === "live" ? realSigner(base, loadRegistry) : null) : over.signer
  const config: ArcoUSDKeeperEnv = signer ? { ...base, address: signer.address } : base
  const rpc = new FakeRpc()
  const beats = new Beats()
  let reads = 0
  const keeper = new ArcoUSDKeeper({
    chainId: 91342,
    config,
    loadRegistry,
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
  assert.deepEqual([defaults.mode, defaults.address, defaults.distribute, defaults.invalid], ["off", null, true, []])
  assert.equal(parseArcoUSDKeeperEnv({ ARCOUSD_KEEPER_DISTRIBUTE: "off" }).distribute, false)
  assert.deepEqual(parseArcoUSDKeeperEnv({ ARCOUSD_KEEPER_DISTRIBUTE: "yes" }).invalid, ["ARCOUSD_KEEPER_DISTRIBUTE"])
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

test("the keeper wallet must hold no role on the Reserve, ArcoUSD, the Router or Savings", async () => {
  const deployment = { reserveAddress: RESERVE, arcoUSDAddress: A(1), routerAddress: A(6) }
  const asked: string[] = []
  const client = {
    readContract: async ({ address, args }: { address: string; args: readonly unknown[] }) => {
      asked.push(`${address}:${String(args[0])}`)
      return address === RESERVE && args[0] === `0x${"00".repeat(32)}`
    },
  }
  assert.deepEqual(await keeperHeldRoles(client as never, deployment as never, A(0xee)), ["Reserve:DEFAULT_ADMIN_ROLE"])
  assert.equal(asked.length, 12) // Reserve 4, ArcoUSD 6, Router 2

  // With Savings: sArcoUSD admin / pauser / rewarder and the distributor's admin / pauser too.
  asked.length = 0
  const rewarder = keccak256(new TextEncoder().encode("REWARDER_ROLE"))
  const savingsClient = {
    readContract: async ({ address, args }: { address: string; args: readonly unknown[] }) => {
      asked.push(`${address}:${String(args[0])}`)
      return (address === VAULT && args[0] === rewarder) || (address === DISTRIBUTOR && args[0] === `0x${"00".repeat(32)}`)
    },
  }
  const savingsDeployment = { ...deployment, savings: { vaultAddress: VAULT, distributorAddress: DISTRIBUTOR } } as never
  assert.deepEqual(await keeperHeldRoles(savingsClient as never, savingsDeployment, A(0xee)), ["sArcoUSD:REWARDER_ROLE", "SavingsDistributor:DEFAULT_ADMIN_ROLE"])
  assert.equal(asked.length, 17)
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

// ─────────────────────────────── Savings: distribute() ───────────────────────────────

const due = (amount: bigint) => ({ amount, nextAt: BigInt((NOW - 5 * MIN) / 1000) })

test("distribute: not deployed, switched off, not due, or under a cent — no dry run and no transaction", async () => {
  const none = setup()
  const tick = await none.keeper.tick()
  assert.deepEqual([tick.distribute?.state, none.rpc.previews], ["not-deployed", 0])

  const off = setup({ savings: true, env: { ARCOUSD_KEEPER_DISTRIBUTE: "off" } })
  off.rpc.preview = due(e18(5))
  assert.deepEqual([(await off.keeper.tick()).distribute?.state, off.rpc.previews, off.rpc.sent.length], ["off", 0, 0])

  const early = setup({ savings: true })
  const waiting = await early.keeper.tick()
  assert.deepEqual([waiting.ok, waiting.distribute?.state, waiting.distribute?.nextAt, early.rpc.distributeSims], [true, "waiting", new Date(NOW + 60 * MIN).toISOString(), 0])

  const dust = setup({ savings: true })
  dust.rpc.preview = due(10n ** 16n - 1n)
  const nothing = await dust.keeper.tick()
  assert.deepEqual([nothing.ok, nothing.distribute?.state, dust.rpc.distributeSims, dust.rpc.sent.length], [true, "nothing", 0, 0])
})

test("distribute: a dry run reports what would be minted and never signs", async () => {
  const { keeper, rpc } = setup({ mode: "dry-run", savings: true })
  rpc.preview = due(e18(12.5))
  rpc.distributeSim = { ok: true, amount: e18(12.34) }
  const tick = await keeper.tick()
  assert.deepEqual([tick.ok, tick.sent, tick.distribute?.state, tick.distribute?.amountUsd, tick.distribute?.detail], [true, 0, "ready", "12.34", "Dry run: would distribute"])
  assert.equal(rpc.sent.length, 0)
})

test("live: the queue first, then distribute() to the registry distributor at the next nonce, minted amount from the receipt", async () => {
  const { keeper, rpc, signer, beats } = setup({ savings: true })
  rpc.sims.set(USDC.toLowerCase(), 2n)
  rpc.preview = due(e18(8))
  rpc.distributeSim = { ok: true, amount: e18(8) }
  rpc.minted = e18(7.99)
  const tick = await keeper.tick()
  assert.deepEqual([tick.ok, tick.sent, rpc.sent.length, tick.note], [true, 2, 2, "Sent 1 transaction"])
  const [queue, distribute] = rpc.sent.map((raw) => parseTransaction(raw))
  assert.deepEqual([getAddress(queue.to!), queue.nonce], [RESERVE, 5])
  assert.deepEqual([getAddress(distribute.to!), distribute.data, distribute.nonce, distribute.value ?? 0n], [DISTRIBUTOR, DISTRIBUTE, 6, 0n])
  assert.equal(await recoverTransactionAddress({ serializedTransaction: rpc.sent[1] as never }), signer!.address)
  assert.deepEqual(
    [tick.lastTx?.action, tick.lastTx?.symbol, tick.lastTx?.status, tick.lastTx?.paid, tick.lastTx?.amountUsd, tick.lastTx?.asset],
    ["distribute", "sArcoUSD", "success", null, "7.99", undefined],
  )
  assert.deepEqual([tick.distribute?.state, tick.distribute?.amountUsd, tick.distribute?.detail], ["sent", "7.99", "Distributed"])
  assert.equal((lastBeat(beats).data as { distribute: { state: string } }).distribute.state, "sent")
})

test("distribute: a dry run that reverts is a reading (the watcher judges it); a chain that cannot be asked is a failure", async () => {
  const reverts = setup({ savings: true })
  reverts.rpc.preview = due(e18(3))
  reverts.rpc.distributeSim = { ok: false, revert: "Pausable: paused" }
  const paused = await reverts.keeper.tick()
  assert.deepEqual([paused.ok, paused.distribute?.state, paused.distribute?.detail, reverts.rpc.sent.length], [true, "reverts", "Pausable: paused", 0])

  const down = setup({ savings: true })
  down.rpc.preview = new HttpRequestError({ url: "https://rpc.example.invalid/SECRETKEY42", status: 503, body: {}, details: "Unavailable" })
  const failed = await down.keeper.tick()
  assert.deepEqual([failed.ok, failed.distribute?.state], [false, "error"])
  assert.match(failed.error ?? "", /^Savings: preview\(\) could not be read: .*rpc\.example\.invalid, HTTP 503/)
  assert.ok(!JSON.stringify(down.beats.rows).includes("SECRETKEY42"))

  const sim = setup({ savings: true })
  sim.rpc.preview = due(e18(3))
  sim.rpc.distributeSim = new Error("socket hang up")
  assert.match((await sim.keeper.tick()).error ?? "", /distribute\(\) could not be simulated: socket hang up/)
})

test("live: a reverted distribute() holds Savings distributions for ten minutes; the queue keeps going", async () => {
  let now = NOW
  const { keeper, rpc } = setup({ savings: true, now: () => now })
  rpc.preview = due(e18(3))
  rpc.distributeSim = { ok: true, amount: e18(3) }
  rpc.revert = true
  const reverted = await keeper.tick()
  assert.deepEqual([reverted.ok, reverted.lastTx?.action, reverted.lastTx?.status], [false, "distribute", "reverted"])
  assert.match(reverted.error ?? "", /^distribute\(\) reverted .*holding Savings distributions for 10 minutes/)
  assert.deepEqual([reverted.holdUntil, reverted.distributeHoldUntil], [null, new Date(NOW + 10 * MIN).toISOString()])

  rpc.revert = false
  now += 5 * MIN
  rpc.sims.set(USDC.toLowerCase(), 2n)
  const held = await keeper.tick()
  assert.equal(held.ok, false) // held is not healthy
  assert.match(held.error ?? "", /^Holding Savings distributions after a reverted distribute\(\)/)
  assert.deepEqual([held.sent, held.lastTx?.action, held.distribute?.state], [1, "processQueue", "ready"]) // the queue was paid
  now += 6 * MIN
  rpc.sims.clear()
  const again = await keeper.tick()
  assert.deepEqual([again.ok, again.lastTx?.action, again.distribute?.state], [true, "distribute", "sent"])
})

test("live: a distribute() not mined yet blocks the next round; after a restart it is followed from the heartbeat", async () => {
  const { keeper, rpc, beats } = setup({ savings: true })
  rpc.preview = due(e18(3))
  rpc.distributeSim = { ok: true, amount: e18(3) }
  rpc.mineOnSend = false
  const sent = await keeper.tick()
  assert.deepEqual([sent.ok, sent.sent, sent.distribute?.state, sent.pending?.nonce, sent.lastTx?.status], [true, 1, "sent", 5, "pending"])
  const waiting = await keeper.tick()
  assert.deepEqual([waiting.note, waiting.distribute, rpc.sent.length], ["Waiting for the last transaction", null, 1])

  // A new process picks it up from the heartbeat (no asset: a distribute) and settles it.
  const restarted = setup({ savings: true })
  restarted.beats.previous = { lastRunAt: new Date(NOW - MIN), lastOkAt: null, lastError: null, data: lastBeat(beats).data }
  const hash = keccak256(rpc.sent[0])
  restarted.rpc.known.add(hash)
  restarted.rpc.pending = 6
  assert.equal((await restarted.keeper.tick()).note, "Waiting for the last transaction")
  restarted.rpc.minted = e18(2.5)
  restarted.rpc.mine(rpc.sent[0])
  restarted.rpc.pending = 6
  const settled = await restarted.keeper.tick()
  assert.deepEqual([settled.lastTx?.hash, settled.lastTx?.action, settled.lastTx?.status, settled.lastTx?.amountUsd], [hash, "distribute", "success", "2.5"])
})

test("live: a distribute() whose revert shows up a round later holds only distributions; the queue is paid that round", async () => {
  let now = NOW
  const { keeper, rpc } = setup({ savings: true, now: () => now })
  rpc.preview = due(e18(3))
  rpc.distributeSim = { ok: true, amount: e18(3) }
  rpc.mineOnSend = false
  await keeper.tick()
  rpc.revert = true
  rpc.mine(rpc.sent[0])
  rpc.revert = false
  rpc.mineOnSend = true
  rpc.sims.set(USDC.toLowerCase(), 2n)
  now += MIN
  const late = await keeper.tick()
  assert.equal(late.ok, false)
  assert.match(late.error ?? "", /^distribute\(\) reverted .*holding Savings distributions for 10 minutes$/) // once, not also "Holding …"
  assert.deepEqual([late.holdUntil, late.distributeHoldUntil], [null, new Date(NOW + 11 * MIN).toISOString()])
  assert.deepEqual([late.sent, late.lastTx?.action, late.lastTx?.status, late.distribute?.state], [1, "processQueue", "success", "ready"])
  assert.equal(parseTransaction(rpc.sent[1]).nonce, 6)
})

test("live: a queue that cannot be read still leaves Savings checked; a failed queue send does not block distribute()", async () => {
  let reads = 0
  const broken = setup({
    savings: true,
    state: () => {
      reads++
      throw new Error("lens call reverted")
    },
  })
  broken.rpc.preview = due(e18(3))
  broken.rpc.distributeSim = { ok: true, amount: e18(3) }
  const tick = await broken.keeper.tick()
  assert.deepEqual([tick.ok, tick.note, tick.distribute?.state, broken.rpc.sent.length, reads], [false, "Could not check the queue", "sent", 1, 1])
  assert.match(tick.error ?? "", /^lens call reverted/)
  assert.equal(parseTransaction(broken.rpc.sent[0]).nonce, 5)

  const flaky = setup({ savings: true })
  flaky.rpc.sims.set(USDC.toLowerCase(), 2n)
  flaky.rpc.preview = due(e18(3))
  flaky.rpc.distributeSim = { ok: true, amount: e18(3) }
  const send = flaky.rpc.sendRaw.bind(flaky.rpc)
  let calls = 0
  flaky.rpc.sendRaw = async (raw: Hex) => {
    if (calls++ === 0) throw new Error("connection reset")
    return send(raw)
  }
  const after = await flaky.keeper.tick()
  assert.equal(after.ok, false)
  assert.match(after.error ?? "", /^Send failed: connection reset/)
  // The failed processQueue never reached the node, so distribute() reuses its nonce.
  assert.deepEqual([after.distribute?.state, flaky.rpc.sent.length, parseTransaction(flaky.rpc.sent[0]).nonce, getAddress(parseTransaction(flaky.rpc.sent[0]).to!)], ["sent", 1, 5, DISTRIBUTOR])
})

test("live: a distribute hold survives a restart", async () => {
  const { keeper, rpc, beats } = setup({ savings: true })
  beats.previous = { lastRunAt: new Date(NOW - MIN), lastOkAt: null, lastError: "x", data: { distributeHoldUntil: new Date(NOW + 5 * MIN).toISOString(), lastTx: null } }
  rpc.preview = due(e18(3))
  rpc.distributeSim = { ok: true, amount: e18(3) }
  const held = await keeper.tick()
  assert.deepEqual([held.ok, held.distributeHoldUntil, rpc.sent.length], [false, new Date(NOW + 5 * MIN).toISOString(), 0])
})

test("signer: distribute() only to the registry distributor, only its exact calldata", async () => {
  const signed: unknown[] = []
  const sign = (loadRegistry: () => ArcoUSDRegistryFile) =>
    guardedKeeperSigner({ address: A(0xee), loadRegistry, chainId: 91342, signOriginal: async (request) => (signed.push(request), "0x02aa") })
  const signer = sign(withSavings)
  const ok = { chainId: 91342 as const, nonce: 1n, to: DISTRIBUTOR, data: DISTRIBUTE, value: 0n as const }
  assert.equal(await signer.sign(ok), "0x02aa")
  assert.equal(await signer.sign({ ...ok, to: DISTRIBUTOR.toLowerCase() as `0x${string}` }), "0x02aa")
  await assert.rejects(signer.sign({ ...ok, data: DISTRIBUTE.toUpperCase().replace("0X", "0x") as Hex }), /Only canonical distribute\(\)/)
  await assert.rejects(signer.sign({ ...ok, data: `${DISTRIBUTE}00` as Hex }), /Only canonical distribute\(\)/)
  await assert.rejects(signer.sign({ ...ok, data: encodeFunctionData({ abi: processQueueAbi, functionName: "processQueue", args: [USDC, 20n] }) }), /Only canonical distribute\(\)/)
  await assert.rejects(signer.sign({ ...ok, to: VAULT }), /Only the ArcoUSD Reserve or the Savings distributor/)
  await assert.rejects(signer.sign({ ...ok, to: RESERVE }), /Only processQueue/) // distribute() calldata to the Reserve
  await assert.rejects(signer.sign({ ...ok, value: 1n as 0n }), /value 0/)
  // Without Savings in the registry the distributor is just another address.
  await assert.rejects(sign(registry).sign(ok), /Only the ArcoUSD Reserve/)
  assert.equal(signed.length, 2)
})
