import { expect } from "chai"
import { artifacts, ethers, upgrades } from "hardhat"
import path from "path"
import { deployProxy, expectRevert, parse, ROLES } from "./helpers"
import {
  arcoGoldParamsPath,
  loadArcoGoldParams,
  paramsDrift,
  registryFromParams,
  type ArcoGoldRegistry,
} from "../scripts/arcogold/arcogold-registry"
import {
  GOLD_SEED_HOLDER,
  planArcoGoldDeployment,
  runArcoGoldDeployment,
  type GoldCoreRefs,
} from "../scripts/arcogold/deploy-steps"

// Runs the SAME executor the GIWA script uses (scripts/arcogold/deploy-steps.ts) with the REAL
// params file (deploy-params/arcogold.json) against a local faucet, and checks the on-chain
// result, idempotence and resume-after-lost-progress. Nothing here touches deployments/91342.

const params = () => loadArcoGoldParams(arcoGoldParamsPath(path.resolve(__dirname, "..")))
const fresh = () => registryFromParams(params(), 31337, "hardhat", "test")
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

async function localCore(): Promise<GoldCoreRefs> {
  const [admin] = await ethers.getSigners()
  const faucet = await deployProxy("TestAssetFaucet", [admin.address])
  return { admin: admin.address as `0x${string}`, faucet: faucet.address as `0x${string}` }
}

async function deploy(core: GoldCoreRefs, registry?: ArcoGoldRegistry) {
  const [admin] = await ethers.getSigners()
  const saves: ArcoGoldRegistry[] = []
  const result = await runArcoGoldDeployment({
    signer: admin,
    registry: registry ?? fresh(),
    core,
    save: (next) => saves.push(clone(next)),
  })
  return { result, saves }
}

const addresses = (r: ArcoGoldRegistry) => [
  r.unit.contract.proxy,
  r.reserve.proxy,
  r.lens.address,
  r.pegFeed.address,
  r.savings.vault.proxy,
  r.savings.zap.address,
  ...r.testAssets.map((asset) => asset.contract.proxy),
]

describe("ArcoGOLD deploy params and plan", () => {
  it("the params file holds the approved design", () => {
    const p = params()
    expect(p.unit).to.deep.equal({ name: "Arco Gold Ounce", symbol: "ArcoXAU" })
    expect([p.savings.name, p.savings.symbol]).to.deep.equal(["ArcoGOLD", "ArcoGOLD"])
    expect(p.testAssets.map((a) => [a.symbol, a.decimals])).to.deep.equal([
      ["tPAXG", 18],
      ["tXAUT", 6],
    ])
    expect(p.reserveAssets.every((a) => a.swapFeeBps === 0 && a.instantFeeBps === 0)).to.equal(true)
    expect(p.pegFeed.answerBase18).to.equal(parse("1", 18).toString())
    expect(p.reserve.mmfTargetBps).to.equal(0)
  })

  it("plans every step for a fresh registry", () => {
    expect(planArcoGoldDeployment(fresh()).map((step) => step.key)).to.deep.equal([
      "deploy:tPAXG",
      "deploy:tXAUT",
      "deploy:unit",
      "deploy:reserve",
      "deploy:lens",
      "deploy:pegFeed",
      "grant:MINTER_ROLE",
      "grant:BURNER_ROLE",
      "asset:tPAXG",
      "asset:tXAUT",
      "faucet:tPAXG",
      "faucet:tXAUT",
      "deploy:vault",
      "deploy:zap",
      "seed:vault",
      "finalize",
    ])
  })

  it("refuses bad inputs before any transaction", () => {
    const bad = (mutate: (r: ArcoGoldRegistry) => void, message: RegExp) => {
      const registry = fresh()
      mutate(registry)
      expect(() => planArcoGoldDeployment(registry)).to.throw(message)
    }
    bad((r) => (r.unit.symbol = "ArcoUSD"), /must not reuse the ArcoUSD names/)
    bad((r) => (r.reserveAssets[0].swapFeeBps = 10), /seedAsset must have no swap fee/)
    bad((r) => (r.reserveAssets[1].decimals = 18), /tXAUT decimals 6 != reserve asset 18/)
    bad((r) => (r.reserveAssets[0].symbol = "tUSDC"), /not one of the gold test assets/)
    bad(
      (r) => ((r.savings as any).distributor = "0x0000000000000000000000000000000000000001"),
      /distributor must stay null/,
    )
    bad((r) => (r.params.mintCap = "0"), /params.mintCap/)
    bad((r) => (r.testAssets[0].faucet.drip = "-1"), /faucet.drip/)
  })

  it("reports params drift against a registry in progress", () => {
    const registry = fresh()
    expect(paramsDrift(registry, params())).to.deep.equal([])
    registry.params.mintCap = "1"
    registry.unit.symbol = "XAU"
    expect(paramsDrift(registry, params())).to.deep.equal(["unit", "params"])
  })
})

describe("ArcoGOLD deploy executor", () => {
  it("deploys and wires everything, and the result is usable end to end", async () => {
    const core = await localCore()
    const [admin, , user] = await ethers.getSigners()
    const { result, saves } = await deploy(core)
    expect(result.deployed).to.equal(true)
    expect(result.deploymentBlock).to.be.a("number")
    expect(result.faucet).to.equal(core.faucet)
    expect(saves.length).to.be.greaterThan(10)
    expect(planArcoGoldDeployment(result)).to.deep.equal([])

    const unit = await ethers.getContractAt("ArcoUSDNamed", result.unit.contract.proxy!)
    const reserve = await ethers.getContractAt("ArcoUSDReserve", result.reserve.proxy!)
    const vault = await ethers.getContractAt("SArcoUSDNamed", result.savings.vault.proxy!)
    const zap = await ethers.getContractAt("ArcoSavingsZap", result.savings.zap.address!)
    const lens = await ethers.getContractAt("ArcoUSDReserveLens", result.lens.address!)
    const feed = await ethers.getContractAt("ConstantPriceFeed", result.pegFeed.address!)
    const faucet = await ethers.getContractAt("TestAssetFaucet", core.faucet)
    const [paxgRec, xautRec] = result.testAssets
    const paxg = await ethers.getContractAt("TestAssetToken", paxgRec.contract.proxy!)
    const xaut = await ethers.getContractAt("TestAssetToken", xautRec.contract.proxy!)

    expect([await unit.name(), await unit.symbol()]).to.deep.equal(["Arco Gold Ounce", "ArcoXAU"])
    expect([await vault.name(), await vault.symbol()]).to.deep.equal(["ArcoGOLD", "ArcoGOLD"])
    expect([
      await paxg.symbol(),
      await paxg.decimals(),
      await xaut.symbol(),
      await xaut.decimals(),
    ]).to.deep.equal(["tPAXG", 18, "tXAUT", 6])
    expect(await reserve.arcoUSD()).to.equal(unit.address)
    expect(await vault.asset()).to.equal(unit.address)
    expect(await zap.reserve()).to.equal(reserve.address)
    expect(await zap.vault()).to.equal(vault.address)
    expect(await unit.hasRole(ROLES.MINTER_ROLE, reserve.address)).to.equal(true)
    expect(await unit.hasRole(ROLES.BURNER_ROLE, reserve.address)).to.equal(true)
    expect(await unit.hasRole(ROLES.MINTER_ROLE, admin.address)).to.equal(false)
    expect(String(await reserve.mintCap())).to.equal(params().reserve.mintCap)
    expect(
      [
        await reserve.mmfTargetBps(),
        await reserve.bufferFloorBps(),
        await reserve.strategyCount(),
      ].map(String),
    ).to.deep.equal(["0", "10000", "0"])
    expect(String(await feed.answerBase18())).to.equal(parse("1", 18).toString())
    for (const token of [paxg, xaut]) {
      const config = await reserve.getAssetConfig(token.address)
      expect([
        config.supported,
        config.depositEnabled,
        config.redeemEnabled,
        config.instantFeeBps,
        config.swapFeeBps,
        config.priceFeed,
        config.maxDepegBps,
      ]).to.deep.equal([true, true, true, 0, 0, feed.address, 100])
      expect(await token.hasRole(ROLES.MINTER_ROLE, faucet.address)).to.equal(true)
    }
    expect(String((await reserve.getAssetConfig(xaut.address)).minQueued)).to.equal("10000")
    const drip = await faucet.assetConfigs(xaut.address)
    expect([
      drip.enabled,
      String(drip.dripAmount),
      String(drip.dailyCap),
      String(drip.cooldown),
    ]).to.deep.equal([true, "1000000", "1000000000", "86400"])
    // Seeded: 1 ArcoGOLD for 0x…dEaD from 1 tPAXG, deposits open.
    expect(String(await vault.balanceOf(GOLD_SEED_HOLDER))).to.equal(parse("1", 18).toString())
    expect(String(await vault.totalSupply())).to.equal(parse("1", 18).toString())
    expect(String(await paxg.balanceOf(reserve.address))).to.equal(parse("1", 18).toString())
    expect(await vault.fnPaused(vault.interface.getSighash("deposit"))).to.equal(false)
    // The implementations behind the proxies are the compiled variants.
    const unitImpl = await upgrades.erc1967.getImplementationAddress(unit.address)
    expect(await ethers.provider.getCode(unitImpl)).to.equal(
      (await artifacts.readArtifact("ArcoUSDNamed")).deployedBytecode,
    )
    const vaultImpl = await upgrades.erc1967.getImplementationAddress(vault.address)
    expect(await ethers.provider.getCode(vaultImpl)).to.equal(
      (await artifacts.readArtifact("SArcoUSDNamed")).deployedBytecode,
    )
    const reserveImpl = await upgrades.erc1967.getImplementationAddress(reserve.address)
    expect(await ethers.provider.getCode(reserveImpl)).to.equal(
      (await artifacts.readArtifact("ArcoUSDReserve")).deployedBytecode,
    )
    expect(result.unit.contract.implementation).to.equal(unitImpl)

    // A user drips both coins from the faucet, saves both through the Zap, and takes one back.
    await faucet.connect(user).drip(paxg.address)
    await faucet.connect(user).drip(xaut.address)
    await paxg.connect(user).approve(zap.address, parse("1", 18))
    await xaut.connect(user).approve(zap.address, parse("1", 6))
    await zap.connect(user).deposit(paxg.address, parse("1", 18), 0, user.address)
    await zap.connect(user).deposit(xaut.address, parse("1", 6), 0, user.address)
    expect(String(await vault.balanceOf(user.address))).to.equal(parse("2", 18).toString())
    await vault.connect(user).approve(zap.address, parse("1", 18))
    await zap.connect(user).redeem(parse("1", 18), xaut.address, parse("1", 6), user.address)
    expect(String(await xaut.balanceOf(user.address))).to.equal(parse("1", 6).toString())
    const snap = await lens.snapshot(reserve.address)
    expect(String(snap.totalBacking)).to.equal(String(snap.totalLiabilities))
  })

  it("is idempotent, and resumes from lost progress by reading the chain", async () => {
    const core = await localCore()
    const { result } = await deploy(core)
    const before = addresses(result)

    const again = await deploy(core, clone(result))
    expect(addresses(again.result)).to.deep.equal(before)

    // Forget grants, asset configs, faucet configs and the seed: the chain is re-read, nothing is
    // redeployed, nothing reverts (setAsset/configureAsset are re-sent with the same values).
    const lost = clone(result)
    lost.roleGrants = []
    lost.deployed = false
    lost.reserveAssets.forEach((asset) => (asset.configured = false))
    lost.testAssets.forEach((asset) => (asset.faucetConfigured = false))
    lost.savings.seeded = false
    const resumed = await deploy(core, lost)
    expect(addresses(resumed.result)).to.deep.equal(before)
    expect(resumed.result.roleGrants.map((grant) => grant.status)).to.deep.equal([
      "already-present",
      "already-present",
    ])
    const vault = await ethers.getContractAt("SArcoUSDNamed", result.savings.vault.proxy!)
    expect(String(await vault.balanceOf(GOLD_SEED_HOLDER))).to.equal(parse("1", 18).toString()) // seeded once
  })

  it("resumes a pending deploy by its receipt instead of deploying again", async () => {
    const core = await localCore()
    const { saves } = await deploy(core)
    // The first save after the unit's deploy tx was sent records it as pending.
    const pending = saves.find((save) => save.unit.contract.pending)!
    expect(pending.unit.contract.proxy).to.match(/^0x/)
    const { result } = await deploy(core, clone(pending))
    expect(result.unit.contract.proxy).to.equal(pending.unit.contract.proxy)
    expect(result.unit.contract.pending).to.equal(undefined)
    // Same for the plain peg feed (its record also carries the feed params).
    const feedPending = saves.find((save) => save.pegFeed.pending)!
    const { result: feedResult } = await deploy(core, clone(feedPending))
    expect(feedResult.pegFeed.address).to.equal(feedPending.pegFeed.address)
    expect(feedResult.pegFeed.pending).to.equal(undefined)
    expect([feedResult.pegFeed.answerBase18, feedResult.pegFeed.maxDepegBps]).to.deep.equal([
      parse("1", 18).toString(),
      100,
    ])
  })

  it("stops when a named proxy does not carry the expected names", async () => {
    const core = await localCore()
    const { result } = await deploy(core)
    const wrong = clone(result)
    wrong.unit.name = "Something Else"
    await expectRevert(
      deploy(core, wrong).then((r) => r.result),
      'expected "Something Else"/"ArcoXAU"',
    )
  })
})
