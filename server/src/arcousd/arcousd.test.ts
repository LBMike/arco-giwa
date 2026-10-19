import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { toEventSignature, toFunctionSelector, toFunctionSignature, type AbiEvent, type AbiFunction } from "viem"
import { reserveRecallAbi } from "./recall.js"
import {
  ARCOUSD_BURN_SELECTOR,
  ARCOUSD_MINT_SELECTOR,
  DEPOSIT_SELECTOR,
  lensAbi,
  reserveEventsAbi,
  PROCESS_QUEUE_SELECTOR,
  ROUTER_BUY_SELECTOR,
  routerEventsAbi,
  SETTLE_FOR_SELECTOR,
} from "./abi.js"
import { parseArcoUSDEnv } from "./config.js"
import { arcoUSDPlugin } from "./plugin.js"
import { createArcoUSDChainReader, NO_PAUSES, toReserveState, type ReserveState } from "./reader.js"
import { deployedArcoUSD, readArcoUSDRegistry, validateArcoUSDRegistry, type ArcoUSDRegistryFile } from "./registry.js"
import { ArcoUSDService } from "./service.js"

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
const USDC = A(0xc1)
const USDT = A(0xc2)

function registry(overrides: Partial<ArcoUSDRegistryFile> = {}): ArcoUSDRegistryFile {
  return {
    schemaVersion: 1,
    chainId: 91342,
    network: "giwa-sepolia",
    deployed: true,
    deploymentBlock: 100,
    arcoUSD: { proxy: A(1), implementation: A(2), bytecodeHash: "0x01" },
    reserve: { proxy: A(3), implementation: A(4), bytecodeHash: "0x02" },
    lens: { address: A(5), bytecodeHash: "0x03" },
    testAssets: [],
    reserveAssets: [
      { symbol: "tUSDC", address: USDC, decimals: 6, minQueued: "1000000", instantFeeBps: 0, swapFeeBps: 0 },
      { symbol: "tUSDT", address: USDT, decimals: 6, minQueued: "1000000", instantFeeBps: 0, swapFeeBps: 10 },
    ],
    strategies: [{ productId: "umint", strategyId: 0, maxAllocation: "1" }],
    params: { mintCap: "1", mmfTargetBps: 5000, bufferFloorBps: 3000, queueMinDelay: 600 },
    ...overrides,
  }
}

function state(usdcAvailable: bigint, extra: Partial<ReserveState> = {}): ReserveState {
  const deployment = deployedArcoUSD(registry(), 91342)!
  const base = toReserveState(
    deployment,
    123n,
    {
      totalBacking: 2_000n * 10n ** 18n,
      totalLiabilities: 1_999n * 10n ** 18n,
      navOk: true,
      mmfBps: 4000n,
      mmfTargetBps: 5000n,
      bufferFloorBps: 3000n,
      queueMinDelay: 600n,
      mintCap: 10n ** 25n,
      assets: [
        { asset: USDC, decimals: 6, depositEnabled: true, redeemEnabled: true, instantFeeBps: 0, swapFeeBps: 0, balance: usdcAvailable + 5_000_000n, queued: 5_000_000n, available: usdcAvailable, queueLength: 3n, queueHead: 1n },
        { asset: USDT, decimals: 6, depositEnabled: true, redeemEnabled: true, instantFeeBps: 20, swapFeeBps: 10, balance: 0n, queued: 0n, available: 0n, queueLength: 0n, queueHead: 0n },
      ],
      strategies: [
        { strategyId: 0n, asset: USDC, productToken: A(9), enabled: true, shares: 10n ** 18n, value: 2n * 10n ** 18n, navOk: true, pendingRecall: 0n, maxAllocation: 10n ** 24n },
      ],
    },
    NO_PAUSES,
  )
  return { ...base, ...extra }
}

const env = parseArcoUSDEnv({ ARCOUSD_BUY_GATE_MIN: "1000" })

test("config: defaults; bad values never throw, they fall back and are flagged", () => {
  const defaults = parseArcoUSDEnv({})
  assert.equal(defaults.registryPath, "deployments/91342/arcousd-giwa.json")
  assert.equal(defaults.buyGateAsset, "tUSDC")
  assert.equal(defaults.buyGateMin, "1000")
  assert.equal(defaults.snapshotIntervalMs, 300_000)
  assert.deepEqual(defaults.invalid, [])
  const bad = parseArcoUSDEnv({ ARCOUSD_BUY_GATE_MIN: "1,000", ARCOUSD_SNAPSHOT_INTERVAL_MS: "30000", ARCOUSD_BUY_GATE_ASSET: "../x" })
  assert.deepEqual([...bad.invalid].sort(), ["ARCOUSD_BUY_GATE_ASSET", "ARCOUSD_BUY_GATE_MIN", "ARCOUSD_SNAPSHOT_INTERVAL_MS"])
  assert.deepEqual([bad.buyGateMin, bad.buyGateAsset, bad.snapshotIntervalMs], ["1000", "tUSDC", 300_000])
  assert.equal(parseArcoUSDEnv({ ARCOUSD_BUY_GATE_MIN: "2500.5", ARCOUSD_SNAPSHOT_INTERVAL_MS: "60000" }).invalid.length, 0)
  // Empty placeholders behave like unset, for every key.
  const empty = parseArcoUSDEnv({ ARCOUSD_BUY_GATE_MIN: "", ARCOUSD_BUY_GATE_ASSET: " ", ARCOUSD_SNAPSHOT_INTERVAL_MS: "", ARCOUSD_REGISTRY_PATH: "" })
  assert.deepEqual(empty, defaults)
})

test("registry: missing file is null; deployed registries must carry every address", () => {
  assert.equal(readArcoUSDRegistry(join(tmpdir(), "does-not-exist-arcousd.json")), null)
  const dir = mkdtempSync(join(tmpdir(), "arcousd-"))
  const file = join(dir, "arcousd.json")
  writeFileSync(file, JSON.stringify(registry()))
  assert.equal(readArcoUSDRegistry(file)?.reserve.proxy, A(3))

  assert.deepEqual(validateArcoUSDRegistry(registry(), 91342), [])
  assert.match(validateArcoUSDRegistry(registry({ chainId: 1 }), 91342).join(), /chainId/)
  const missing = validateArcoUSDRegistry(registry({ lens: { address: null, bytecodeHash: null } }), 91342)
  assert.match(missing.join(), /lens.address/)
  const noStrategyId = validateArcoUSDRegistry(registry({ strategies: [{ productId: "umint", strategyId: null, maxAllocation: "1" }] }), 91342)
  assert.match(noStrategyId.join(), /umint/)
  // Not deployed: inert, addresses not required.
  assert.equal(deployedArcoUSD(registry({ deployed: false, lens: { address: null, bytecodeHash: null } }), 91342), null)
  assert.throws(() => deployedArcoUSD(registry({ chainId: 1 }), 91342))

  // Router: optional (files written before it), exposed with the products it can buy.
  const legacy = deployedArcoUSD(registry(), 91342)!
  assert.deepEqual([legacy.routerAddress, legacy.routerProducts], [null, []])
  const withRouter = deployedArcoUSD(
    registry({
      router: { proxy: A(6), implementation: A(7), bytecodeHash: null },
      routerVaults: [
        { productId: "umint", configured: true },
        { productId: "beqty", configured: false },
      ],
    }),
    91342,
  )!
  assert.deepEqual([withRouter.routerAddress, withRouter.routerProducts], [A(6), ["umint"]])
  assert.match(validateArcoUSDRegistry(registry({ router: { proxy: "0x12" as `0x${string}`, implementation: null, bytecodeHash: null } }), 91342).join(), /router.proxy/)
  const badFee = registry({ reserveAssets: [{ symbol: "tUSDT", address: USDT, decimals: 6, minQueued: "1", instantFeeBps: 0, swapFeeBps: 101 }] })
  assert.match(validateArcoUSDRegistry(badFee, 91342).join(), /swapFeeBps/)
})

test("reader mapping: symbols, products, human amounts, backlog and surplus", () => {
  const s = state(2_500_000_000n)
  assert.equal(s.assets[0].symbol, "tUSDC")
  assert.equal(s.assets[0].availableHuman, "2500")
  assert.equal(s.assets[0].queueBacklog, 2)
  assert.equal(s.strategies[0].productId, "umint")
  assert.equal(s.strategies[0].valueUsd, "2")
  assert.equal(s.surplus, (10n ** 18n).toString())
  assert.equal(s.totalBackingUsd, "2000")
  assert.deepEqual([s.assets[1].swapFeeBps, s.assets[1].instantFeeBps, s.assets[0].swapFeeBps], [10, 20, 0])
})

test("chain reader: one block for every read, and every pause on the buy path is read", async () => {
  const calls: { address: string; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }[] = []
  const snap = {
    totalBacking: 0n, totalLiabilities: 0n, navOk: true, mmfBps: 0n, mmfTargetBps: 5000n, bufferFloorBps: 3000n,
    queueMinDelay: 600n, mintCap: 1n, assets: [], strategies: [],
  }
  const client = {
    getBlockNumber: async () => 777n,
    readContract: async (args: { address: string; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      calls.push(args)
      if (args.functionName === "snapshot") return snap
      // Only ArcoUSD.fnPaused(burn) is set.
      return args.functionName === "fnPaused" && args.address === A(1) && args.args?.[0] === ARCOUSD_BURN_SELECTOR
    },
  }
  const read = createArcoUSDChainReader(client as never)
  const result = await read(deployedArcoUSD(registry(), 91342)!)
  assert.ok(calls.every((call) => call.blockNumber === 777n))
  const reads = [
    `${A(1)}:fnPaused:${ARCOUSD_BURN_SELECTOR}`,
    `${A(1)}:fnPaused:${ARCOUSD_MINT_SELECTOR}`,
    `${A(1)}:paused:`,
    `${A(3)}:fnPaused:${SETTLE_FOR_SELECTOR}`,
    `${A(3)}:fnPaused:${DEPOSIT_SELECTOR}`,
    `${A(3)}:fnPaused:${PROCESS_QUEUE_SELECTOR}`,
    `${A(3)}:paused:`,
    `${A(5)}:snapshot:${A(3)}`,
  ]
  const seen = () => calls.map((call) => `${call.address}:${call.functionName}:${call.args?.[0] ?? ""}`).sort()
  assert.deepEqual(seen(), [...reads].sort()) // no Router yet: nothing read from it
  assert.deepEqual(
    [result.reservePaused, result.settlementPaused, result.arcoUSDPaused, result.arcoUSDBurnPaused],
    [false, false, false, true],
  )
  assert.deepEqual([result.depositPaused, result.arcoUSDMintPaused, result.routerPaused], [false, false, false])

  // With a Router: its global pause and fnPaused(buy) are read too.
  calls.length = 0
  const routerClient = {
    getBlockNumber: async () => 778n,
    readContract: async (args: { address: string; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      calls.push(args)
      if (args.functionName === "snapshot") return snap
      return args.functionName === "fnPaused" && args.address === A(6) && args.args?.[0] === ROUTER_BUY_SELECTOR
    },
  }
  const withRouter = await createArcoUSDChainReader(routerClient as never)(
    deployedArcoUSD(registry({ router: { proxy: A(6), implementation: A(7), bytecodeHash: null } }), 91342)!,
  )
  assert.deepEqual(seen(), [...reads, `${A(6)}:fnPaused:${ROUTER_BUY_SELECTOR}`, `${A(6)}:paused:`].sort())
  assert.ok(calls.every((call) => call.blockNumber === 778n))
  assert.deepEqual([withRouter.routerPaused, withRouter.arcoUSDBurnPaused], [true, false])

  // Reserve.fnPaused(processQueue) is read too, and a given block pins every read to it (the
  // watcher compares the chain with the indexer at the indexer's own block).
  calls.length = 0
  let headAsked = false
  const pinnedClient = {
    getBlockNumber: async () => {
      headAsked = true
      return 999n
    },
    readContract: async (args: { address: string; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      calls.push(args)
      if (args.functionName === "snapshot") return snap
      return args.functionName === "fnPaused" && args.address === A(3) && args.args?.[0] === PROCESS_QUEUE_SELECTOR
    },
  }
  const pinned = await createArcoUSDChainReader(pinnedClient as never)(deployedArcoUSD(registry(), 91342)!, 555n)
  assert.equal(headAsked, false)
  assert.ok(calls.every((call) => call.blockNumber === 555n))
  assert.deepEqual([pinned.blockNumber, pinned.queuePaused, pinned.settlementPaused], ["555", true, false])
})

test("buy gate: inactive until deployed, open above the threshold, closed below, paused or unreadable", async () => {
  const notDeployed = new ArcoUSDService({ chainId: 91342, env, loadRegistry: () => null })
  const inactive = await notDeployed.reserveState()
  assert.equal(inactive.status, "not-deployed")
  assert.equal(inactive.gate.status, "inactive")

  const svc = (read: () => Promise<ReserveState>) =>
    new ArcoUSDService({ chainId: 91342, env, loadRegistry: () => registry(), read: async () => read() })
  const open = await svc(async () => state(1_000_000_000n)).gate()
  assert.equal(open.status, "open")
  assert.equal(open.available, "1000")

  const short = await svc(async () => state(999_999_999n)).gate()
  assert.deepEqual([short.status, short.reason], ["closed", "insufficient-buffer"])

  // Any of the four pauses that make settleFor revert closes the gate.
  for (const flag of ["reservePaused", "settlementPaused", "arcoUSDPaused", "arcoUSDBurnPaused"] as const) {
    const paused = await svc(async () => state(10n ** 12n, { [flag]: true })).gate()
    assert.deepEqual([paused.status, paused.reason], ["closed", "settlement-paused"], flag)
  }

  // The Router's pause and the deposit/mint a stablecoin-paid buy runs first also close it.
  for (const flag of ["routerPaused", "depositPaused", "arcoUSDMintPaused"] as const) {
    const paused = await svc(async () => state(10n ** 12n, { [flag]: true })).gate()
    assert.deepEqual([paused.status, paused.reason], ["closed", "buy-paused"], flag)
  }

  // Less than one threshold-sized buy (1,000 ArcoUSD) left under the mint cap: closed.
  const capped = (liabilities: bigint) => state(10n ** 12n, { mintCap: (10_000n * 10n ** 18n).toString(), totalLiabilities: liabilities.toString() })
  const full = await svc(async () => capped(9_000n * 10n ** 18n + 1n)).gate()
  assert.deepEqual([full.status, full.reason], ["closed", "mint-cap"])
  assert.equal((await svc(async () => capped(9_000n * 10n ** 18n)).gate()).status, "open")

  // An invalid gate setting keeps the gate closed once deployed (and is irrelevant before).
  const badEnv = parseArcoUSDEnv({ ARCOUSD_BUY_GATE_MIN: "1,000" })
  const misconfigured = new ArcoUSDService({ chainId: 91342, env: badEnv, loadRegistry: () => registry(), read: async () => state(10n ** 12n) })
  assert.deepEqual([(await misconfigured.gate()).status, (await misconfigured.gate()).reason], ["closed", "config-invalid"])
  const misconfiguredUndeployed = new ArcoUSDService({ chainId: 91342, env: badEnv, loadRegistry: () => null })
  assert.equal((await misconfiguredUndeployed.gate()).status, "inactive")
  // Only the snapshot interval is bad: the API gate is unaffected.
  const snapshotOnly = new ArcoUSDService({ chainId: 91342, env: parseArcoUSDEnv({ ARCOUSD_SNAPSHOT_INTERVAL_MS: "5" }), loadRegistry: () => registry(), read: async () => state(10n ** 12n) })
  assert.equal((await snapshotOnly.gate()).status, "open")

  const failing = await svc(async () => {
    throw new Error("rpc down")
  }).reserveState()
  assert.equal(failing.status, "unavailable")
  assert.deepEqual([failing.gate.status, failing.gate.reason], ["closed", "read-failed"])

  const invalid = new ArcoUSDService({ chainId: 91342, env, loadRegistry: () => registry({ chainId: 7 }), read: async () => state(1n) })
  assert.equal((await invalid.gate()).status, "closed")
})

test("one RPC sweep serves concurrent callers and the cache window", async () => {
  let reads = 0
  let now = 1_000
  const service = new ArcoUSDService({
    chainId: 91342,
    env,
    loadRegistry: () => registry(),
    read: async () => {
      reads++
      await new Promise((resolve) => setTimeout(resolve, 5))
      return state(10n ** 12n)
    },
    now: () => now,
    cacheMs: 15_000,
  })
  await Promise.all([service.reserveState(), service.gate(), service.reserveState()])
  assert.equal(reads, 1)
  now += 10_000
  await service.gate()
  assert.equal(reads, 1)
  now += 6_000
  await service.gate()
  assert.equal(reads, 2)
})

test("routes are public, no-store, and never 500 on a failed read", async () => {
  const app = Fastify()
  const service = new ArcoUSDService({
    chainId: 91342,
    env,
    loadRegistry: () => registry(),
    read: async () => {
      throw new Error("rpc down")
    },
  })
  await app.register(arcoUSDPlugin, { service })
  const reserve = await app.inject({ method: "GET", url: "/api/v1/arcousd/reserve" })
  assert.equal(reserve.statusCode, 200)
  assert.equal(reserve.headers["cache-control"], "no-store")
  assert.equal(reserve.json().status, "unavailable")
  assert.equal(reserve.json().contracts.reserve, A(3))
  assert.deepEqual([reserve.json().contracts.router, reserve.json().contracts.routerProducts], [null, []])
  const gate = await app.inject({ method: "GET", url: "/api/v1/arcousd/gate" })
  assert.equal(gate.statusCode, 200)
  assert.equal(gate.json().status, "closed")
  await app.close()
})

test("inline ABIs match the compiled ArcoUSD artifacts (no drift)", () => {
  const artifact = (name: string) =>
    JSON.parse(
      readFileSync(join(process.cwd(), `packages/contracts/artifacts/contracts/arcousd/${name}.sol/${name}.json`), "utf8"),
    ).abi as (AbiEvent | AbiFunction)[]
  const compiledEvents = artifact("ArcoUSDReserve")
    .filter((item): item is AbiEvent => item.type === "event")
    .map((event) => toEventSignature(event))
    .sort()
  const inlineEvents = reserveEventsAbi.map((event) => toEventSignature(event as AbiEvent)).sort()
  assert.deepEqual(inlineEvents, compiledEvents)
  const compiledRouterEvents = artifact("ArcoRouter")
    .filter((item): item is AbiEvent => item.type === "event")
    .map((event) => toEventSignature(event))
    .sort()
  assert.deepEqual(routerEventsAbi.map((event) => toEventSignature(event as AbiEvent)).sort(), compiledRouterEvents)
  // Field names drive the decoded args (Bought.payer/recipient/result…), so compare them too.
  const named = (events: readonly AbiEvent[]) =>
    JSON.stringify([...events].sort((a, b) => a.name.localeCompare(b.name)).map((event) => [event.name, event.inputs.map((input) => [input.name, input.indexed ?? false])]))
  assert.equal(
    named(routerEventsAbi as readonly AbiEvent[]),
    named(artifact("ArcoRouter").filter((item): item is AbiEvent => item.type === "event")),
  )

  const compiledSnapshot = artifact("ArcoUSDReserveLens").find(
    (item): item is AbiFunction => item.type === "function" && item.name === "snapshot",
  )!
  // Recall functions used by the redemption console must exist on the Reserve exactly as declared,
  // including struct field names/types of their outputs (getStrategy's Strategy is decoded by name).
  const outputsShape = (fn: AbiFunction) =>
    JSON.stringify(
      fn.outputs.map((output) => ({ type: output.type, components: "components" in output ? output.components : undefined })),
      ["type", "components", "name"],
    )
  const compiledReserve = artifact("ArcoUSDReserve").filter((item): item is AbiFunction => item.type === "function")
  for (const item of reserveRecallAbi) {
    if (item.type !== "function") continue
    const fn = item as AbiFunction
    const compiled = compiledReserve.find((candidate) => toFunctionSignature(candidate) === toFunctionSignature(fn))
    assert.ok(compiled, `ArcoUSDReserve has no ${toFunctionSignature(fn)}`)
    assert.equal(outputsShape(fn), outputsShape(compiled), `${fn.name} outputs differ`)
  }

  // Every function whose pause switch the reader checks exists on its contract.
  const selectorsOf = (name: string) =>
    artifact(name)
      .filter((item): item is AbiFunction => item.type === "function")
      .map((fn) => toFunctionSelector(toFunctionSignature(fn)))
  for (const [name, selectors] of [
    ["ArcoUSDReserve", [SETTLE_FOR_SELECTOR, DEPOSIT_SELECTOR, PROCESS_QUEUE_SELECTOR]],
    ["ArcoUSD", [ARCOUSD_BURN_SELECTOR, ARCOUSD_MINT_SELECTOR]],
    ["ArcoRouter", [ROUTER_BUY_SELECTOR]],
  ] as const) {
    for (const selector of selectors) assert.ok(selectorsOf(name).includes(selector), `${name} has no function ${selector}`)
  }

  const inlineSnapshot = lensAbi.find((item) => item.type === "function" && item.name === "snapshot") as AbiFunction
  // Struct field names drive decoding (object keys) and must match; the single top-level return
  // name ("snap" in Solidity) is ignored by viem, so it is left out of the comparison.
  const shape = (fn: AbiFunction) =>
    JSON.stringify(
      fn.outputs.map((output) => ({ type: output.type, components: "components" in output ? output.components : undefined })),
      ["type", "components", "name"],
    )
  assert.equal(shape(inlineSnapshot), shape(compiledSnapshot))
})
