import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { SAVINGS_DEPOSIT_SELECTOR, SAVINGS_SEED_HOLDER, SAVINGS_WITHDRAW_SELECTOR } from "../arcousd/abi.js"
import { NO_PAUSES, toReserveState, type ArcoUSDChainReader } from "../arcousd/reader.js"
import { ounceUsd } from "../services/usd-rates.js"
import { ARCOGOLD_REGISTRY_DEFAULT_PATH, parseArcoGoldEnv } from "./config.js"
import { arcoGoldPlugin } from "./plugin.js"
import { deployedArcoGold, goldReserveDeployment, readArcoGoldRegistry, validateArcoGoldRegistry, type ArcoGoldRegistryFile } from "./registry.js"
import { ArcoGoldService, OUNCE_USD_SOURCE } from "./service.js"
import { createGoldVaultReader, toGoldVaultState, type GoldVaultReader } from "./vault.js"

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
const PAXG = A(0xa1)
const XAUT = A(0xa2)
const ONE = 10n ** 18n

/** What deploy-arcogold-giwa.ts writes once it has finished (packages/contracts/scripts/arcogold/arcogold-registry.ts). */
function registry(overrides: Partial<ArcoGoldRegistryFile> = {}): ArcoGoldRegistryFile {
  const contract = (n: number) => ({ proxy: A(n), implementation: A(n + 100), bytecodeHash: "0x01" as const, blockNumber: 1000 + n })
  return {
    schemaVersion: 1,
    product: "arcogold",
    chainId: 91342,
    network: "giwa-sepolia",
    deployed: true,
    deploymentBlock: 1001,
    faucet: A(0xfa),
    unit: { name: "Arco Gold Ounce", symbol: "ArcoXAU", contract: contract(1) },
    reserve: contract(2),
    lens: { address: A(3), bytecodeHash: "0x02" },
    testAssets: [
      { symbol: "tPAXG", name: "Test PAXG", decimals: 18, contract: contract(0xa1) },
      { symbol: "tXAUT", name: "Test XAUT", decimals: 6, contract: contract(0xa2) },
    ],
    reserveAssets: [
      { symbol: "tPAXG", address: PAXG, decimals: 18, instantFeeBps: 0, swapFeeBps: 0, minQueued: "10000000000000000" },
      { symbol: "tXAUT", address: XAUT, decimals: 6, instantFeeBps: 0, swapFeeBps: 0, minQueued: "10000" },
    ],
    params: { mintCap: "100000000000000000000000", mmfTargetBps: 0, bufferFloorBps: 10000, queueMinDelay: 600 },
    savings: { name: "ArcoGOLD", symbol: "ArcoGOLD", vault: contract(4), zap: { address: A(5), bytecodeHash: "0x03" }, distributor: null, seeded: true },
    ...overrides,
  }
}

const readReserve: ArcoUSDChainReader = async (deployment) =>
  toReserveState(
    deployment,
    77n,
    {
      totalBacking: 5n * ONE,
      totalLiabilities: 5n * ONE,
      navOk: true,
      mmfBps: 0n,
      mmfTargetBps: 0n,
      bufferFloorBps: 10000n,
      queueMinDelay: 600n,
      mintCap: 100_000n * ONE,
      assets: [
        { asset: PAXG, decimals: 18, depositEnabled: true, redeemEnabled: true, instantFeeBps: 0, swapFeeBps: 0, balance: 3n * ONE, queued: 0n, available: 3n * ONE, queueLength: 0n, queueHead: 0n },
        { asset: XAUT, decimals: 6, depositEnabled: true, redeemEnabled: true, instantFeeBps: 0, swapFeeBps: 0, balance: 2_000_000n, queued: 0n, available: 0n, queueLength: 0n, queueHead: 0n },
      ],
      strategies: [],
    },
    new Map([
      [PAXG.toLowerCase(), { depositCap: 2n ** 256n - 1n, minQueued: 10n ** 16n }],
      [XAUT.toLowerCase(), { depositCap: 2n ** 256n - 1n, minQueued: 10_000n }],
    ]),
    NO_PAUSES,
  )

const readVault: GoldVaultReader = async () =>
  toGoldVaultState({
    blockNumber: 77n,
    totalAssets: 5n * ONE,
    totalSupply: 4n * ONE,
    sharePrice: (125n * ONE) / 100n,
    seedShares: ONE,
    minShares: ONE,
    vaultPaused: false,
    depositPaused: false,
    withdrawPaused: false,
  })

function service(loadRegistry: () => ArcoGoldRegistryFile | null, extra: Partial<ConstructorParameters<typeof ArcoGoldService>[0]> = {}) {
  return new ArcoGoldService({ chainId: 91342, loadRegistry, readReserve, readVault, ounceUsd: async () => 2400, ...extra })
}

test("env: the registry path defaults to deployments/91342/arcogold-giwa.json; an empty value counts as unset", () => {
  assert.equal(parseArcoGoldEnv({}).registryPath, ARCOGOLD_REGISTRY_DEFAULT_PATH)
  assert.equal(ARCOGOLD_REGISTRY_DEFAULT_PATH, "deployments/91342/arcogold-giwa.json")
  assert.equal(parseArcoGoldEnv({ ARCOGOLD_REGISTRY_PATH: "  " }).registryPath, ARCOGOLD_REGISTRY_DEFAULT_PATH)
  assert.equal(parseArcoGoldEnv({ ARCOGOLD_REGISTRY_PATH: "/tmp/gold.json" }).registryPath, "/tmp/gold.json")
})

test("registry: an absent file is not deployed; an unfinished deploy is not deployed; a finished one must carry every address", () => {
  const dir = mkdtempSync(join(tmpdir(), "arcogold-"))
  assert.equal(readArcoGoldRegistry(join(dir, "missing.json")), null)
  assert.equal(deployedArcoGold(null, 91342), null)
  // The deploy script records deployed=true only after the seed; until then nothing gold is live.
  assert.equal(deployedArcoGold(registry({ deployed: false, deploymentBlock: null }), 91342), null)
  const file = join(dir, "arcogold-giwa.json")
  writeFileSync(file, JSON.stringify(registry()))
  const gold = deployedArcoGold(readArcoGoldRegistry(file), 91342)!
  assert.deepEqual([gold.unitAddress, gold.reserveAddress, gold.lensAddress, gold.vaultAddress, gold.zapAddress, gold.seeded], [A(1), A(2), A(3), A(4), A(5), true])
  assert.deepEqual(validateArcoGoldRegistry(registry({ chainId: 1 }), 91342), ["chainId must be 91342"])
  assert.match(validateArcoGoldRegistry(registry({ product: "arcousd" as "arcogold" }), 91342).join(";"), /product/)
  const pendingZap = registry()
  const broken = { ...pendingZap, savings: { ...pendingZap.savings, zap: { address: A(5), bytecodeHash: null, pending: true } } }
  assert.throws(() => deployedArcoGold(broken, 91342), /savings.zap is still pending/)
  assert.throws(() => deployedArcoGold({ ...registry(), lens: { address: null, bytecodeHash: null } }, 91342), /lens.address/)
})

test("the gold Reserve is read by the ArcoUSD reader: the unit stands for ArcoUSD, no Router, no strategies", () => {
  const deployment = goldReserveDeployment(deployedArcoGold(registry(), 91342)!)
  assert.deepEqual([deployment.arcoUSDAddress, deployment.reserveAddress, deployment.lensAddress], [A(1), A(2), A(3)])
  assert.deepEqual([deployment.routerAddress, deployment.routerProducts, deployment.strategies, deployment.savings], [null, [], [], null])
  assert.deepEqual(deployment.reserveAssets.map((asset) => [asset.symbol, asset.decimals]), [["tPAXG", 18], ["tXAUT", 6]])
})

test("absent registry: both routes answer 200 not-deployed, and nothing is read", async () => {
  let reads = 0
  const counting = service(() => null, {
    readReserve: async (...args) => (reads++, readReserve(...args)),
    readVault: async (...args) => (reads++, readVault(...args)),
    ounceUsd: async () => (reads++, 2400),
  })
  const app = Fastify()
  await app.register(arcoGoldPlugin, { service: counting })
  for (const url of ["/api/v1/arcogold/reserve", "/api/v1/arcogold/savings"]) {
    const response = await app.inject({ method: "GET", url })
    assert.equal(response.statusCode, 200, url)
    assert.equal(response.headers["cache-control"], "no-store")
    assert.equal(response.json().status, "not-deployed")
    assert.equal(response.json().contracts, null)
  }
  const savings = (await app.inject({ method: "GET", url: "/api/v1/arcogold/savings" })).json()
  assert.deepEqual([savings.savings, savings.ounceUsd, savings.sharePriceUsd, savings.apyPercent], [null, null, null, 3.1])
  assert.equal(reads, 0)
  await app.close()
})

test("a registry that cannot be read or is invalid answers unavailable, never a 500", async () => {
  const app = Fastify()
  await app.register(arcoGoldPlugin, {
    service: service(() => {
      throw new SyntaxError("Unexpected end of JSON input")
    }),
  })
  const reserve = await app.inject({ method: "GET", url: "/api/v1/arcogold/reserve" })
  assert.equal(reserve.statusCode, 200)
  assert.equal(reserve.json().status, "unavailable")
  await app.close()
  const invalid = await service(() => registry({ chainId: 1 })).savingsState()
  assert.equal(invalid.status, "unavailable")
})

test("live: per-coin instant liquidity and totals in ounces; share price, display APY and USD value", async () => {
  const gold = service(() => registry())
  const reserve = await gold.reserveState()
  assert.equal(reserve.status, "live")
  assert.deepEqual(reserve.contracts, { unit: A(1), reserve: A(2), lens: A(3) })
  assert.deepEqual(
    reserve.reserve!.assets.map((asset) => [asset.symbol, asset.decimals, asset.availableHuman]),
    [["tPAXG", 18, "3"], ["tXAUT", 6, "0"]],
  )
  assert.equal(reserve.reserve!.totalBackingOunces, "5")
  const keys = Object.keys(reserve.reserve!)
  for (const dollarField of ["totalBackingUsd", "totalLiabilitiesUsd", "routerPaused", "strategies"]) assert.ok(!keys.includes(dollarField), dollarField)
  assert.equal(reserve.reserve!.redeemInstantOnlyPaused, false)

  const savings = await gold.savingsState()
  assert.equal(savings.status, "live")
  assert.deepEqual(savings.contracts, { arcoGOLD: A(4), zap: A(5), unit: A(1), reserve: A(2) })
  assert.equal(savings.savings!.sharePriceHuman, "1.25")
  assert.deepEqual([savings.savings!.depositsOpen, savings.savings!.withdrawalsOpen, savings.savings!.seeded], [true, true, true])
  assert.equal(savings.apyPercent, 3.1)
  assert.deepEqual([savings.ounceUsd, savings.ounceUsdSource, savings.sharePriceUsd, savings.totalAssetsUsd], [2400, OUNCE_USD_SOURCE, 3000, "12000"])
})

test("the ounce source is reported as given: the Kraken fallback says so; a bad quote falls back to null with the primary source", async () => {
  const kraken = await service(() => registry(), { ounceUsd: async () => ({ usd: 2400, source: "kraken:paxg" as const }) }).savingsState()
  assert.deepEqual([kraken.ounceUsd, kraken.ounceUsdSource, kraken.sharePriceUsd], [2400, "kraken:paxg", 3000])
  const bad = await service(() => registry(), { ounceUsd: async () => ({ usd: -1, source: "kraken:paxg" as const }) }).savingsState()
  assert.deepEqual([bad.ounceUsd, bad.ounceUsdSource, bad.sharePriceUsd], [null, OUNCE_USD_SOURCE, null])
})

test("no ounce price: the vault still answers, its USD fields are null (never a made-up price)", async () => {
  for (const ounce of [async () => null, async () => Number.NaN, async () => { throw new Error("rate limited") }]) {
    const savings = await service(() => registry(), { ounceUsd: ounce }).savingsState()
    assert.equal(savings.status, "live")
    assert.equal(savings.savings!.sharePriceHuman, "1.25")
    assert.deepEqual([savings.ounceUsd, savings.sharePriceUsd, savings.totalAssetsUsd], [null, null, null])
  }
})

test("a failed chain read is unavailable with the contracts named; one sweep serves concurrent callers and the cache window", async () => {
  const down = service(() => registry(), {
    readReserve: async () => {
      throw new Error("rpc down")
    },
    readVault: async () => {
      throw new Error("rpc down")
    },
  })
  const reserve = await down.reserveState()
  assert.deepEqual([reserve.status, reserve.contracts?.reserve, reserve.reserve], ["unavailable", A(2), null])
  const savings = await down.savingsState()
  assert.deepEqual([savings.status, savings.contracts?.zap, savings.savings], ["unavailable", A(5), null])

  let reads = 0
  let now = 0
  const cached = service(() => registry(), { readVault: async (...args) => (reads++, readVault(...args)), now: () => now })
  await Promise.all([cached.savingsState(), cached.savingsState(), cached.savingsState()])
  assert.equal(reads, 1)
  now = 14_000
  await cached.savingsState()
  assert.equal(reads, 1)
  now = 16_000
  await cached.savingsState()
  assert.equal(reads, 2)
})

test("vault reader: one block for every read; seeded from the 0x…dEaD holder; the deposit and withdraw switches", async () => {
  const calls: { functionName: string; args: readonly unknown[]; blockNumber?: bigint; address: string }[] = []
  const values: Record<string, unknown> = {
    totalAssets: 2n * ONE,
    totalSupply: 2n * ONE,
    convertToAssets: ONE,
    balanceOf: ONE,
    MIN_SHARES: ONE,
    paused: false,
  }
  const client = {
    getBlockNumber: async () => 900n,
    readContract: async (call: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint; address: string }) => {
      calls.push({ functionName: call.functionName, args: call.args ?? [], blockNumber: call.blockNumber, address: call.address })
      if (call.functionName === "fnPaused") return call.args?.[0] === SAVINGS_WITHDRAW_SELECTOR
      return values[call.functionName]
    },
  }
  const state = await createGoldVaultReader(client as never)(deployedArcoGold(registry(), 91342)!)
  assert.ok(calls.every((call) => call.blockNumber === 900n && call.address === A(4)))
  assert.deepEqual(calls.find((call) => call.functionName === "balanceOf")!.args, [SAVINGS_SEED_HOLDER])
  assert.ok(calls.some((call) => call.functionName === "fnPaused" && call.args[0] === SAVINGS_DEPOSIT_SELECTOR))
  assert.deepEqual([state.seeded, state.depositsOpen, state.withdrawPaused, state.withdrawalsOpen, state.sharePriceHuman], [true, true, true, false, "1"])
  // Not seeded: deposits stay closed whatever the switches say.
  assert.equal(toGoldVaultState({ blockNumber: 1n, totalAssets: 0n, totalSupply: 0n, sharePrice: ONE, seedShares: 0n, minShares: ONE, vaultPaused: false, depositPaused: false, withdrawPaused: false }).depositsOpen, false)
})

test("usd rates: the ounce is PAX Gold's price; unknown or bad values are null", () => {
  assert.equal(ounceUsd({ USDC: 1, BTC: 1, ETH: 1, XRP: 1, XAU: 2412.5 }), 2412.5)
  for (const XAU of [Number.NaN, 0, -1]) assert.equal(ounceUsd({ USDC: 1, BTC: 1, ETH: 1, XRP: 1, XAU }), null)
  assert.equal(ounceUsd(null), null)
})
