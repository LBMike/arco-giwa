import { expect } from "chai"
import { ethers } from "hardhat"
import { deployFixture, deployProxy, parse, ROLES } from "./helpers"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { defaultArcoUSDRegistry, loadArcoUSDRegistry, type ArcoUSDRegistry } from "../scripts/arcousd/arcousd-registry"
import { planArcoUSDDeployment, runArcoUSDDeployment, SAVINGS_SEED_HOLDER, type CoreRefs } from "../scripts/arcousd/deploy-steps"

// Runs the SAME executor the GIWA deploy script uses (scripts/arcousd/deploy-steps.ts) against a
// local core (tUSDC, two tUSDC products standing in for uMINT and iBENJI, the faucet) and checks
// the on-chain result, idempotence and resume-after-lost-progress.

const SETTLER_ROLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("SETTLER_ROLE"))
const REWARDER_ROLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("REWARDER_ROLE"))
const SAVINGS_STEPS = [
  "deploy:SArcoUSD", "deploy:ArcoUSDSavingsDistributor", "deploy:ArcoSavingsZap",
  "grant:distributor:MINTER_ROLE", "grant:distributor:REWARDER_ROLE", "seed:sArcoUSD",
]

async function localCore() {
  const fixture = await deployFixture(6)
  const { admin, asset: usdc } = fixture
  // Second tUSDC product (iBENJI stand-in) sharing the same payment asset.
  const second = await deployFixture(6, "tUSDC-B")
  const dv = await deployProxy("ArcoDepositVault", [
    second.product.address, usdc.address, second.productFeed.address, second.paymentFeed.address,
    parse("1", 6), parse("1000000", 18), parse("500000", 18), admin.address,
  ])
  const rv = await deployProxy("ArcoRedemptionVault", [
    second.product.address, usdc.address, second.productFeed.address, second.paymentFeed.address,
    parse("1", 18), parse("1000000", 6), admin.address,
  ])
  await second.product.grantRole(ROLES.MINTER_ROLE, dv.address)
  await second.product.grantRole(ROLES.BURNER_ROLE, rv.address)
  const faucet = await deployProxy("TestAssetFaucet", [admin.address])
  // uMINT stand-in enforces its greenlist, so the Reserve must be greenlisted to hold shares.
  await fixture.product.setGreenlistEnforced(true)
  // The deployer pays the 1 sArcoUSD seed with tUSDC through the Reserve.
  await usdc.mint(admin.address, parse("10", 6))
  const core: CoreRefs = {
    admin: admin.address as `0x${string}`,
    faucet: faucet.address as `0x${string}`,
    assets: { tUSDC: { address: usdc.address as `0x${string}`, decimals: 6 } },
    products: {
      umint: {
        depositVault: fixture.depositVault.address as `0x${string}`,
        redemptionVault: fixture.redemptionVault.address as `0x${string}`,
        productToken: fixture.product.address as `0x${string}`,
      },
      ibenji: {
        depositVault: dv.address as `0x${string}`,
        redemptionVault: rv.address as `0x${string}`,
        productToken: second.product.address as `0x${string}`,
      },
    },
  }
  return { ...fixture, usdc, core, faucet, secondProduct: second.product }
}

// The local core has no bEQTY stand-in: the Router allowlists the two local tUSDC products.
function freshRegistry(): ArcoUSDRegistry {
  const registry = defaultArcoUSDRegistry(31337, "hardhat", "test")
  registry.routerVaults = registry.routerVaults.filter((vault) => vault.productId !== "beqty")
  return registry
}

async function deploy(core: CoreRefs, registry?: ArcoUSDRegistry) {
  const [admin] = await ethers.getSigners()
  const saves: ArcoUSDRegistry[] = []
  const result = await runArcoUSDDeployment({
    signer: admin,
    registry: registry ?? freshRegistry(),
    core,
    save: (next) => saves.push(JSON.parse(JSON.stringify(next))),
  })
  return { result, saves }
}

describe("ArcoUSD deploy executor", () => {
  it("plans every step for a fresh registry", async () => {
    const { core } = await localCore()
    const keys = planArcoUSDDeployment(freshRegistry(), core).map((step) => step.key)
    expect(keys).to.include.members([
      "deploy:tUSDT", "deploy:tRLUSD", "deploy:ArcoUSD", "deploy:ArcoUSDReserve", "deploy:ArcoUSDReserveLens", "deploy:ArcoRouter",
      "grant:MINTER_ROLE", "grant:BURNER_ROLE", "grant:SETTLER_ROLE", "asset:tUSDC", "asset:tUSDT", "asset:tRLUSD",
      "strategy:umint", "strategy:ibenji", "faucet:tUSDT", "faucet:tRLUSD", "greenlist:umint", "greenlist:ibenji",
      "router:umint", "router:ibenji", ...SAVINGS_STEPS, "finalize",
    ])
  })

  it("a registry written before Savings resumes with only the Savings steps, then distributes surplus", async () => {
    const { core, usdc, investor } = await localCore()
    const { result } = await deploy(core)
    const legacy = JSON.parse(JSON.stringify(result))
    delete legacy.savings
    legacy.roleGrants = legacy.roleGrants.filter((grant: { key: string }) => !grant.key.includes("distributor"))
    const dir = mkdtempSync(path.join(tmpdir(), "arcousd-registry-"))
    const file = path.join(dir, "arcousd-giwa.json")
    writeFileSync(file, JSON.stringify(legacy))
    const loaded = loadArcoUSDRegistry(file, freshRegistry)
    expect(loaded.savings.vault.proxy).to.equal(null)
    expect(loaded.savings.params).to.deep.equal({ vestingPeriod: 86_400, minInterval: 86_400, maxAprBps: 2000, reserveMarginBps: 50 })
    expect(planArcoUSDDeployment(loaded, core).map((step) => step.key)).to.deep.equal(SAVINGS_STEPS)

    const { result: resumed } = await deploy(core, loaded)
    // Phase 1-3 contracts are untouched; only the Savings ones are new.
    expect([resumed.arcoUSD.proxy, resumed.reserve.proxy, resumed.lens.address, resumed.router.proxy]).to.deep.equal([
      legacy.arcoUSD.proxy, legacy.reserve.proxy, legacy.lens.address, legacy.router.proxy,
    ])
    expect(resumed.savings.vault.proxy).to.not.equal(result.savings.vault.proxy)

    // End to end on the resumed deployment: save through the Zap, surplus arrives, it is distributed.
    const vault = await ethers.getContractAt("SArcoUSD", resumed.savings.vault.proxy!)
    const zap = await ethers.getContractAt("ArcoSavingsZap", resumed.savings.zap.address!)
    const distributor = await ethers.getContractAt("ArcoUSDSavingsDistributor", resumed.savings.distributor.address!)
    await usdc.connect(investor).approve(zap.address, parse("1000", 6))
    await zap.connect(investor).deposit(usdc.address, parse("1000", 6), 0, investor.address)
    await usdc.mint(resumed.reserve.proxy, parse("100", 6))
    await ethers.provider.send("evm_increaseTime", [86_400])
    await ethers.provider.send("evm_mine", [])
    await distributor.distribute()
    expect((await vault.vestingAmount()).gt(0)).to.equal(true)
  })

  it("a registry written before the Router and swap fees existed loads with those steps still to do", async () => {
    const { core } = await localCore()
    const { result } = await deploy(core)
    const legacy = JSON.parse(JSON.stringify(result))
    delete legacy.router
    delete legacy.routerVaults
    legacy.roleGrants = legacy.roleGrants.filter((grant: { key: string }) => !grant.key.startsWith("Reserve:"))
    for (const asset of legacy.reserveAssets) delete asset.swapFeeBps
    legacy.reserveAssets[1].configured = false
    const dir = mkdtempSync(path.join(tmpdir(), "arcousd-registry-"))
    const file = path.join(dir, "arcousd-giwa.json")
    writeFileSync(file, JSON.stringify(legacy))
    const loaded = loadArcoUSDRegistry(file, freshRegistry)
    expect(loaded.router.proxy).to.equal(null)
    // Configured assets had no swap fee on chain; the unconfigured one takes the default.
    expect(loaded.reserveAssets.map((asset) => asset.swapFeeBps)).to.deep.equal([0, 10, 0])
    expect(planArcoUSDDeployment(loaded, core).map((step) => step.key)).to.deep.equal([
      "deploy:ArcoRouter", "grant:SETTLER_ROLE", "asset:tUSDT", "router:umint", "router:ibenji",
    ])
  })

  it("deploys and wires everything, and the result is usable end to end", async () => {
    const { core, faucet, usdc, product, investor } = await localCore()
    const { result, saves } = await deploy(core)
    expect(result.deployed).to.equal(true)
    expect(result.deploymentBlock).to.be.a("number")
    expect(saves.length).to.be.greaterThan(10) // progress is persisted step by step

    const arco = await ethers.getContractAt("ArcoUSD", result.arcoUSD.proxy!)
    const reserve = await ethers.getContractAt("ArcoUSDReserve", result.reserve.proxy!)
    const lens = await ethers.getContractAt("ArcoUSDReserveLens", result.lens.address!)
    const router = await ethers.getContractAt("ArcoRouter", result.router.proxy!)
    expect(await arco.hasRole(ROLES.MINTER_ROLE, reserve.address)).to.equal(true)
    expect(await arco.hasRole(ROLES.BURNER_ROLE, reserve.address)).to.equal(true)
    expect((await reserve.getAssets()).length).to.equal(3)
    expect(String(await reserve.queueMinDelay())).to.equal("600")
    const tusdt = result.testAssets.find((asset) => asset.symbol === "tUSDT")!
    expect(String((await reserve.getAssetConfig(tusdt.contract.proxy!)).minQueued)).to.equal("1000000")
    expect((await reserve.getAssetConfig(tusdt.contract.proxy!)).swapFeeBps).to.equal(10)
    expect((await reserve.getAssetConfig(usdc.address)).swapFeeBps).to.equal(0)
    expect(await reserve.hasRole(SETTLER_ROLE, router.address)).to.equal(true)
    expect(await router.reserve()).to.equal(reserve.address)
    expect(await router.allowedVault(core.products.umint.depositVault)).to.equal(true)
    expect(await router.allowedVault(core.products.ibenji.depositVault)).to.equal(true)
    expect(result.routerVaults.every((vault) => vault.configured)).to.equal(true)
    expect(result.strategies.map((strategy) => strategy.strategyId)).to.deep.equal([0, 1])
    expect(await product.isGreenlisted(reserve.address)).to.equal(true)
    const drip = await faucet.assetConfigs(tusdt.contract.proxy)
    expect(drip.enabled).to.equal(true)
    expect(String(drip.dripAmount)).to.equal(String(parse("1000", 6)))

    // A user drips tUSDT, swaps it into ArcoUSD, and redeems tUSDC that another user deposited.
    await faucet.connect(investor).drip(tusdt.contract.proxy)
    const tusdtToken = await ethers.getContractAt("TestAssetToken", tusdt.contract.proxy!)
    await tusdtToken.connect(investor).approve(reserve.address, parse("1000", 6))
    await reserve.connect(investor).deposit(tusdt.contract.proxy, parse("1000", 6), investor.address)
    expect(String(await arco.balanceOf(investor.address))).to.equal(String(parse("999", 18))) // 10 bps swap fee
    await usdc.connect(investor).approve(reserve.address, parse("500", 6))
    await reserve.connect(investor).deposit(usdc.address, parse("500", 6), investor.address)
    await arco.connect(investor).approve(reserve.address, parse("500", 18))
    const before = await usdc.balanceOf(investor.address)
    await reserve.connect(investor).redeem(usdc.address, parse("500", 18), investor.address, 0)
    expect(String((await usdc.balanceOf(investor.address)).sub(before))).to.equal(String(parse("500", 6)))
    // The fee stays in the Reserve as surplus (1 tUSDT over 999 ArcoUSD of liabilities).
    let snap = await lens.snapshot(reserve.address)
    expect(String(snap.totalBacking.sub(snap.totalLiabilities))).to.equal(String(parse("1", 18)))
    expect(snap.strategies.length).to.equal(2)

    // A product buy through the Router, paid in ArcoUSD, settled from the Reserve's tUSDC (which
    // the redeem above emptied, so a tUSDC deposit refills it first).
    await usdc.connect(investor).approve(reserve.address, parse("200", 6))
    await reserve.connect(investor).deposit(usdc.address, parse("200", 6), investor.address)
    await arco.connect(investor).approve(router.address, parse("100", 18))
    const shares = await product.balanceOf(investor.address)
    await router.connect(investor).buy(arco.address, parse("100", 18), core.products.umint.depositVault, 0, investor.address, false)
    expect((await product.balanceOf(investor.address)).gt(shares)).to.equal(true)
    snap = await lens.snapshot(reserve.address)
    expect(String(snap.totalBacking.sub(snap.totalLiabilities))).to.equal(String(parse("1", 18)))

    // Savings: sArcoUSD over ArcoUSD, the distributor's two roles, the seed, and the Zap.
    const vault = await ethers.getContractAt("SArcoUSD", result.savings.vault.proxy!)
    const distributor = await ethers.getContractAt("ArcoUSDSavingsDistributor", result.savings.distributor.address!)
    const zap = await ethers.getContractAt("ArcoSavingsZap", result.savings.zap.address!)
    expect(await vault.asset()).to.equal(arco.address)
    expect(String(await vault.vestingPeriod())).to.equal("86400")
    expect(await arco.hasRole(ROLES.MINTER_ROLE, distributor.address)).to.equal(true)
    expect(await vault.hasRole(REWARDER_ROLE, distributor.address)).to.equal(true)
    expect(await distributor.vault()).to.equal(vault.address)
    expect(await distributor.lens()).to.equal(lens.address)
    expect([String(await distributor.minInterval()), await distributor.maxAprBps(), await distributor.reserveMarginBps()]).to.deep.equal(["86400", 2000, 50])
    expect(String(await vault.balanceOf(SAVINGS_SEED_HOLDER))).to.equal(String(parse("1", 18)))
    expect(result.savings.seeded).to.equal(true)
    expect(result.roleGrants.map((grant) => grant.key)).to.include.members([
      `ArcoUSD:MINTER_ROLE:distributor:${distributor.address}`, `sArcoUSD:REWARDER_ROLE:distributor:${distributor.address}`,
    ])
    await usdc.connect(investor).approve(zap.address, parse("50", 6))
    await zap.connect(investor).deposit(usdc.address, parse("50", 6), 0, investor.address)
    expect(String(await vault.balanceOf(investor.address))).to.equal(String(parse("50", 18)))
  })

  it("is idempotent, and resumes from lost progress by reading the chain", async () => {
    const { core } = await localCore()
    const { result } = await deploy(core)
    const savingsAddresses = (registry: ArcoUSDRegistry) => [registry.savings.vault.proxy, registry.savings.distributor.address, registry.savings.zap.address]
    const addresses = [result.arcoUSD.proxy, result.reserve.proxy, result.lens.address, result.router.proxy, ...result.testAssets.map((a) => a.contract.proxy), ...savingsAddresses(result)]

    // Same registry again: nothing new is deployed and nothing reverts.
    const again = await deploy(core, JSON.parse(JSON.stringify(result)))
    expect([again.result.arcoUSD.proxy, again.result.reserve.proxy, again.result.lens.address, again.result.router.proxy, ...again.result.testAssets.map((a) => a.contract.proxy), ...savingsAddresses(again.result)]).to.deep.equal(addresses)

    // Lost progress after the contracts exist (grants, assets, strategies, faucet, greenlist forgotten):
    // the chain is re-read; strategies are found, not re-added (which would revert as duplicates).
    const lost = JSON.parse(JSON.stringify(result)) as ArcoUSDRegistry
    lost.roleGrants = []
    lost.reserveAssets.forEach((asset) => (asset.configured = false))
    lost.strategies.forEach((strategy) => (strategy.strategyId = null))
    lost.testAssets.forEach((asset) => (asset.faucetConfigured = false))
    lost.greenlisted = []
    lost.routerVaults.forEach((vault) => (vault.configured = false))
    lost.savings.seeded = false
    lost.deployed = false
    const vault = await ethers.getContractAt("SArcoUSD", result.savings.vault.proxy!)
    const supply = await vault.totalSupply()
    const resumed = await deploy(core, lost)
    expect(String(await vault.totalSupply())).to.equal(String(supply)) // the seed is found, not paid twice
    expect(resumed.result.savings.seeded).to.equal(true)
    expect(resumed.result.strategies.map((strategy) => strategy.strategyId)).to.deep.equal([0, 1])
    expect(resumed.result.roleGrants.map((grant) => grant.key)).to.have.members([
      "ArcoUSD:MINTER_ROLE:reserve", "ArcoUSD:BURNER_ROLE:reserve", "Reserve:SETTLER_ROLE:router",
      `ArcoUSD:MINTER_ROLE:distributor:${result.savings.distributor.address}`, `sArcoUSD:REWARDER_ROLE:distributor:${result.savings.distributor.address}`,
    ])
    expect(resumed.result.roleGrants.every((grant) => grant.status === "already-present")).to.equal(true)
    expect(resumed.result.routerVaults.every((vault) => vault.configured)).to.equal(true)
    const reserve = await ethers.getContractAt("ArcoUSDReserve", result.reserve.proxy!)
    expect(String(await reserve.strategyCount())).to.equal("2")
    expect(resumed.result.deployed).to.equal(true)
  })

  it("a confirm timeout leaves a pending record that the re-run settles without redeploying", async () => {
    const { core } = await localCore()
    const [admin] = await ethers.getSigners()
    const saves: ArcoUSDRegistry[] = []
    let message = ""
    try {
      await runArcoUSDDeployment({
        signer: admin,
        registry: freshRegistry(),
        core,
        save: (next) => saves.push(JSON.parse(JSON.stringify(next))),
        confirm: async (tx, label) => {
          if (label.startsWith("ArcoUSDReserve deploy")) throw new Error("Timed out waiting for ArcoUSDReserve")
          return tx.wait(1)
        },
      })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).to.contain("Timed out")
    const interrupted = saves[saves.length - 1]
    expect(interrupted.reserve.pending).to.equal(true)
    expect(interrupted.reserve.proxy).to.be.a("string")
    expect(interrupted.reserve.implementation).to.equal(null)

    const blockBefore = await ethers.provider.getBlockNumber()
    const { result } = await deploy(core, interrupted)
    expect(result.reserve.proxy).to.equal(interrupted.reserve.proxy) // settled by receipt, not redeployed
    expect(result.reserve.pending).to.equal(undefined)
    expect(result.reserve.implementation).to.be.a("string")
    expect(result.deployed).to.equal(true)
    const reserve = await ethers.getContractAt("ArcoUSDReserve", result.reserve.proxy!)
    expect(String(await reserve.mintCap())).to.equal(result.params.mintCap)
    // Only the Lens, Router and Savings deploys (plus grants/config calls) followed; no second Reserve proxy.
    const created: string[] = []
    for (let block = blockBefore + 1; block <= (await ethers.provider.getBlockNumber()); block++) {
      for (const hash of (await ethers.provider.getBlock(block)).transactions) {
        const receipt = await ethers.provider.getTransactionReceipt(hash)
        if (receipt.contractAddress) created.push(receipt.contractAddress)
      }
    }
    expect(created).to.include(result.lens.address)
    expect(created).to.include(result.router.proxy)
    const expected = [
      result.lens.address, result.router.proxy, result.router.implementation,
      result.savings.vault.proxy, result.savings.vault.implementation, result.savings.distributor.address, result.savings.zap.address,
    ]
    expect(created.filter((address) => !expected.includes(address as `0x${string}`))).to.deep.equal([])
  })

  it("a pending deploy the chain never saw is deployed again", async () => {
    const { core } = await localCore()
    const registry = freshRegistry()
    const ghost = "0x00000000000000000000000000000000000000ff" as `0x${string}`
    registry.testAssets[0].contract = {
      proxy: ghost,
      implementation: null,
      bytecodeHash: null,
      deployTxHash: `0x${"ab".repeat(32)}`,
      pending: true,
    }
    expect(planArcoUSDDeployment(registry, core).find((step) => step.key === "deploy:tUSDT")?.label).to.contain("resume pending")
    const { result } = await deploy(core, registry)
    expect(result.testAssets[0].contract.proxy).to.not.equal(ghost)
    expect(result.testAssets[0].contract.pending).to.equal(undefined)
    expect(result.deployed).to.equal(true)
  })

  it("adopts a pending deploy whose tx the node forgot only when the address runs the compiled contract", async () => {
    const { core } = await localCore()
    const { result } = await deploy(core)
    const unknownHash = `0x${"cd".repeat(32)}` as `0x${string}`

    // Lens and Reserve recorded as pending under a tx hash the node does not know (replaced / pruned).
    const forgotten = JSON.parse(JSON.stringify(result)) as ArcoUSDRegistry
    forgotten.lens = { address: result.lens.address, bytecodeHash: null, deployTxHash: unknownHash, pending: true }
    forgotten.reserve = { ...result.reserve, implementation: null, bytecodeHash: null, deployTxHash: unknownHash, pending: true }
    forgotten.deployed = false
    const blockBefore = await ethers.provider.getBlockNumber()
    const { result: adopted } = await deploy(core, forgotten)
    expect(adopted.lens.address).to.equal(result.lens.address)
    expect(adopted.lens.blockNumber).to.equal(result.lens.blockNumber) // true creation block
    expect(adopted.lens.pending).to.equal(undefined)
    expect(adopted.reserve.proxy).to.equal(result.reserve.proxy)
    expect(adopted.reserve.implementation).to.equal(result.reserve.implementation)
    expect(adopted.reserve.blockNumber).to.equal(result.reserve.blockNumber)
    expect(adopted.deployed).to.equal(true)
    expect(await ethers.provider.getBlockNumber()).to.equal(blockBefore) // nothing sent

    // An address holding other code is never adopted: the run stops before sending anything.
    const foreign = JSON.parse(JSON.stringify(result)) as ArcoUSDRegistry
    foreign.lens = { address: result.arcoUSD.proxy, bytecodeHash: null, deployTxHash: unknownHash, pending: true }
    const saves: unknown[] = []
    let message = ""
    try {
      const [admin] = await ethers.getSigners()
      await runArcoUSDDeployment({ signer: admin, registry: foreign, core, save: (next) => saves.push(next) })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).to.contain("does not match the compiled contract")
    expect(saves.length).to.equal(0)
    expect(await ethers.provider.getBlockNumber()).to.equal(blockBefore)
  })

  it("rejects invalid inputs before any transaction or save", async () => {
    const { core } = await localCore()
    const [admin] = await ethers.getSigners()
    const cases: Array<[string, (registry: ArcoUSDRegistry) => void]> = [
      ["mmfTargetBps", (registry) => (registry.params.mmfTargetBps = 10_001)],
      ["queueMinDelay", (registry) => (registry.params.queueMinDelay = 8 * 24 * 60 * 60)],
      ["decimals", (registry) => (registry.reserveAssets[0].decimals = 18)],
      ["depositCap", (registry) => (registry.reserveAssets[1].depositCap = "1e6")],
      ["instantFeeBps", (registry) => (registry.reserveAssets[2].instantFeeBps = 101)],
      ["swapFeeBps", (registry) => (registry.reserveAssets[1].swapFeeBps = 101)],
      ["Router vault product nope", (registry) => registry.routerVaults.push({ productId: "nope", configured: false })],
      ["listed twice", (registry) => registry.routerVaults.push({ productId: "umint", configured: false })],
      ["maxAllocation", (registry) => (registry.strategies[0].maxAllocation = "-1")],
      ["mintCap", (registry) => (registry.params.mintCap = (2n ** 256n).toString())],
      ["savings.params.vestingPeriod", (registry) => (registry.savings.params.vestingPeriod = 60)],
      ["savings.params.minInterval", (registry) => (registry.savings.params.minInterval = 31 * 24 * 60 * 60)],
      ["savings.params.maxAprBps", (registry) => (registry.savings.params.maxAprBps = 5001)],
      ["savings.params.reserveMarginBps", (registry) => (registry.savings.params.reserveMarginBps = 1001)],
      ["must not exceed savings.params.vestingPeriod", (registry) => (registry.savings.params.minInterval = 2 * 86_400)],
    ]
    for (const [label, mutate] of cases) {
      const registry = freshRegistry()
      mutate(registry)
      expect(() => planArcoUSDDeployment(registry, core), label).to.throw(label)
      const saves: unknown[] = []
      const before = await ethers.provider.getTransactionCount(admin.address)
      let message = ""
      try {
        await runArcoUSDDeployment({ signer: admin, registry, core, save: (next) => saves.push(next) })
      } catch (error) {
        message = (error as Error).message
      }
      expect(message, label).to.contain(label)
      expect(saves.length, label).to.equal(0)
      expect(await ethers.provider.getTransactionCount(admin.address), label).to.equal(before)
    }
  })

  it("refuses a strategy product the core registry does not know", async () => {
    const { core } = await localCore()
    const registry = freshRegistry()
    registry.strategies.push({ productId: "nope", maxAllocation: "1", strategyId: null })
    expect(() => planArcoUSDDeployment(registry, core)).to.throw("nope")
    const [admin] = await ethers.getSigners()
    const saves: unknown[] = []
    let message = ""
    try {
      await runArcoUSDDeployment({ signer: admin, registry, core, save: (next) => saves.push(next) })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).to.contain("nope")
    expect(saves.length).to.equal(0) // failed before deploying or recording anything
  })

  // Replacing the distributor is outside the script (no hand edits to the live registry); this pins
  // the executor's behaviour should a reviewed procedure ever record a new distributor.
  it("grants are keyed by distributor address: a newly recorded distributor gets its own roles", async () => {
    const { core } = await localCore()
    const { result } = await deploy(core)
    const old = result.savings.distributor.address!
    const cleared = JSON.parse(JSON.stringify(result)) as ArcoUSDRegistry
    cleared.savings.distributor = { address: null, bytecodeHash: null }
    expect(planArcoUSDDeployment(cleared, core).map((step) => step.key)).to.deep.equal([
      "deploy:ArcoUSDSavingsDistributor", "grant:distributor:MINTER_ROLE", "grant:distributor:REWARDER_ROLE",
    ])
    const { result: redeployed } = await deploy(core, cleared)
    const fresh = redeployed.savings.distributor.address!
    expect(fresh).to.not.equal(old)
    const arco = await ethers.getContractAt("ArcoUSD", result.arcoUSD.proxy!)
    const vault = await ethers.getContractAt("SArcoUSD", result.savings.vault.proxy!)
    expect(await arco.hasRole(ROLES.MINTER_ROLE, fresh)).to.equal(true)
    expect(await vault.hasRole(REWARDER_ROLE, fresh)).to.equal(true)
    // Revoking the old distributor is a separate, reviewed admin step (spec §3.14).
    expect(await arco.hasRole(ROLES.MINTER_ROLE, old)).to.equal(true)
  })

  it("stops at the seed with a clear message when the deployer has no tUSDC, and resumes once funded", async () => {
    const { core, usdc } = await localCore()
    const [admin] = await ethers.getSigners()
    await usdc.connect(admin).transfer((await ethers.getSigners())[5].address, await usdc.balanceOf(admin.address))
    const saves: ArcoUSDRegistry[] = []
    let message = ""
    try {
      await runArcoUSDDeployment({ signer: admin, registry: freshRegistry(), core, save: (next) => saves.push(JSON.parse(JSON.stringify(next))) })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).to.contain("Seeding sArcoUSD needs 1.0 tUSDC")
    const stopped = saves[saves.length - 1]
    expect(stopped.savings.zap.address).to.be.a("string")
    expect(stopped.savings.seeded).to.equal(false)
    expect(planArcoUSDDeployment(stopped, core).map((step) => step.key)).to.deep.equal(["seed:sArcoUSD", "finalize"])

    await usdc.mint(admin.address, parse("1", 6))
    const { result } = await deploy(core, stopped)
    expect(result.savings.seeded).to.equal(true)
    expect(result.deployed).to.equal(true)
    const vault = await ethers.getContractAt("SArcoUSD", result.savings.vault.proxy!)
    expect(String(await vault.balanceOf(SAVINGS_SEED_HOLDER))).to.equal(String(parse("1", 18)))
  })
})
