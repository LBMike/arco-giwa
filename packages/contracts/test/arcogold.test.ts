import { expect } from "chai"
import hre, { ethers, network, upgrades } from "hardhat"
import { BigNumber, Contract } from "ethers"
import { deployProxy, expectRevert, parse, role, ROLES } from "./helpers"

// ArcoGOLD: a second instance of the sArcoUSD stack denominated in troy ounces
// (docs/operations/arcogold-deploy.md). ArcoUSDNamed / SArcoUSDNamed are ArcoUSD / SArcoUSD with
// deploy-time names; the Reserve, Zap, Lens and ConstantPriceFeed are the unchanged contracts.
// tPAXG (18 dec) and tXAUT (6 dec) both count as exactly 1 ounce = 1 ArcoXAU.

const MAX = ethers.constants.MaxUint256
const DAY = 24 * 60 * 60
const DEAD = "0x000000000000000000000000000000000000dEaD"
const REWARDER_ROLE = role("REWARDER_ROLE")
const DEFAULT_ADMIN_ROLE = ethers.constants.HashZero
const UNIT = { name: "Arco Gold Ounce", symbol: "ArcoXAU" }
const GOLD = { name: "ArcoGOLD", symbol: "ArcoGOLD" }
const oz18 = (value: string) => parse(value, 18) // tPAXG, ArcoXAU, ArcoGOLD
const oz6 = (value: string) => parse(value, 6) // tXAUT
const str = (value: BigNumber) => value.toString()
const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
}

async function deployNamed(contractName: string, args: unknown[]): Promise<Contract> {
  const contract = await upgrades.deployProxy(await ethers.getContractFactory(contractName), args, {
    initializer: "initializeNamed",
    kind: "transparent",
  })
  await contract.deployed()
  return contract
}

async function advance(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds])
  await network.provider.send("evm_mine", [])
}

const assetParams = (feed: string, overrides: Partial<Record<string, unknown>> = {}) => ({
  depositEnabled: true,
  redeemEnabled: true,
  instantFeeBps: 0,
  swapFeeBps: 0,
  depositCap: MAX,
  priceFeed: feed,
  maxDepegBps: 100,
  minQueued: 0,
  ...overrides,
})

/** The gold stack as the deploy script wires it; seeded (1 ArcoGOLD for 0x…dEaD) unless `seed: false`. */
async function goldFixture(options: { seed?: boolean } = {}) {
  const [admin, alice, bob, mallory] = await ethers.getSigners()
  const paxg = await deployProxy("TestAssetToken", ["Test PAXG", "tPAXG", 18, admin.address])
  const xaut = await deployProxy("TestAssetToken", ["Test XAUT", "tXAUT", 6, admin.address])
  const unit = await deployNamed("ArcoUSDNamed", [UNIT.name, UNIT.symbol, admin.address])
  const reserve = await deployProxy("ArcoUSDReserve", [
    unit.address,
    admin.address,
    oz18("100000"),
    0,
    10_000,
    0,
  ])
  await unit.grantRole(ROLES.MINTER_ROLE, reserve.address)
  await unit.grantRole(ROLES.BURNER_ROLE, reserve.address)
  const feed = await (await ethers.getContractFactory("ConstantPriceFeed")).deploy(oz18("1"))
  await feed.deployed()
  await reserve.setAsset(paxg.address, assetParams(feed.address))
  await reserve.setAsset(xaut.address, assetParams(feed.address))
  const lens = await (await ethers.getContractFactory("ArcoUSDReserveLens")).deploy()
  await lens.deployed()
  const vault = await deployNamed("SArcoUSDNamed", [
    GOLD.name,
    GOLD.symbol,
    unit.address,
    admin.address,
    DAY,
  ])
  const zap = await (
    await ethers.getContractFactory("ArcoSavingsZap")
  ).deploy(reserve.address, vault.address)
  await zap.deployed()

  for (const user of [admin, alice, bob, mallory]) {
    await paxg.mint(user.address, oz18("1000"))
    await xaut.mint(user.address, oz6("1000"))
    for (const token of [paxg, xaut]) {
      await token.connect(user).approve(reserve.address, MAX)
      await token.connect(user).approve(zap.address, MAX)
    }
    for (const spender of [reserve, vault, zap])
      await unit.connect(user).approve(spender.address, MAX)
    await vault.connect(user).approve(zap.address, MAX)
  }
  const seedVault = async () => {
    await reserve.deposit(paxg.address, oz18("1"), admin.address)
    await vault.seed()
  }
  if (options.seed !== false) await seedVault()
  return {
    admin,
    alice,
    bob,
    mallory,
    paxg,
    xaut,
    unit,
    reserve,
    feed,
    lens,
    vault,
    zap,
    seedVault,
  }
}

async function signPermit(
  signer: any,
  token: Contract,
  domainName: string,
  spender: string,
  value: BigNumber,
) {
  const { chainId } = await ethers.provider.getNetwork()
  const nonce = await token.nonces(signer.address)
  const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600
  const signature = await signer._signTypedData(
    { name: domainName, version: "1", chainId, verifyingContract: token.address },
    PERMIT_TYPES,
    { owner: signer.address, spender, value, nonce, deadline },
  )
  return { deadline, ...ethers.utils.splitSignature(signature) }
}

/** Storage layout from the compiler output (the OZ upgrades plugin turns storageLayout on). */
async function storageLayout(fqn: string) {
  const buildInfo = await hre.artifacts.getBuildInfo(fqn)
  if (!buildInfo) throw new Error(`no build info for ${fqn}`)
  const [source, name] = fqn.split(":")
  const layout = (buildInfo.output.contracts[source][name] as any).storageLayout
  const types = layout.types ?? {}
  // Compare slot, offset, label and the type's label/size (type ids embed AST ids, which differ).
  return layout.storage.map((item: any) => ({
    slot: item.slot,
    offset: item.offset,
    label: item.label,
    type: types[item.type]?.label ?? item.type,
    bytes: types[item.type]?.numberOfBytes,
  }))
}

describe("ArcoGOLD contracts: name-parameterised variants", () => {
  it("ArcoUSDNamed and SArcoUSDNamed have exactly the storage layout of ArcoUSD and SArcoUSD", async () => {
    const unitBase = await storageLayout("contracts/arcousd/ArcoUSD.sol:ArcoUSD")
    const unitNamed = await storageLayout("contracts/arcousd/ArcoUSDNamed.sol:ArcoUSDNamed")
    expect(unitBase.length).to.be.greaterThan(10)
    expect(unitNamed).to.deep.equal(unitBase)
    const vaultBase = await storageLayout("contracts/arcousd/SArcoUSD.sol:SArcoUSD")
    const vaultNamed = await storageLayout("contracts/arcousd/SArcoUSDNamed.sol:SArcoUSDNamed")
    expect(vaultBase.length).to.be.greaterThan(10)
    expect(vaultNamed).to.deep.equal(vaultBase)
  })

  it("the OZ plugin accepts the variants as upgrades of the originals (no layout change)", async () => {
    const [admin] = await ethers.getSigners()
    const arco = await deployProxy("ArcoUSD", [admin.address])
    await upgrades.validateUpgrade(arco.address, await ethers.getContractFactory("ArcoUSDNamed"), {
      kind: "transparent",
    })
    const vault = await deployProxy("SArcoUSD", [arco.address, admin.address, DAY])
    await upgrades.validateUpgrade(
      vault.address,
      await ethers.getContractFactory("SArcoUSDNamed"),
      { kind: "transparent" },
    )
  })

  it("the unit is an 18-decimal 'Arco Gold Ounce' (ArcoXAU) with ArcoUSD's role set", async () => {
    const { admin, unit } = await goldFixture({ seed: false })
    const reference = await deployProxy("ArcoUSD", [admin.address])
    expect([await unit.name(), await unit.symbol(), await unit.decimals()]).to.deep.equal([
      UNIT.name,
      UNIT.symbol,
      18,
    ])
    const roleNames = [
      "DEFAULT_ADMIN",
      "GREENLIST_OPERATOR_ROLE",
      "BLACKLIST_OPERATOR_ROLE",
      "MINTER_ROLE",
      "BURNER_ROLE",
      "PAUSER_ROLE",
      "DEPOSIT_VAULT_ADMIN_ROLE",
      "REDEMPTION_VAULT_ADMIN_ROLE",
      "FEED_ADMIN_ROLE",
      "FAUCET_ADMIN_ROLE",
    ]
    for (const name of roleNames) {
      const hash = name === "DEFAULT_ADMIN" ? DEFAULT_ADMIN_ROLE : role(name)
      expect(await unit.hasRole(hash, admin.address), name).to.equal(
        await reference.hasRole(hash, admin.address),
      )
    }
    expect(await unit.hasRole(ROLES.MINTER_ROLE, admin.address)).to.equal(false)
    await expectRevert(unit.mint(admin.address, 1), "missing role")
  })

  it("ArcoGOLD is an 18-decimal ERC-4626 'ArcoGOLD' over ArcoXAU with sArcoUSD's roles, closed until seeded", async () => {
    const { admin, alice, unit, vault, reserve, paxg, seedVault } = await goldFixture({
      seed: false,
    })
    expect([await vault.name(), await vault.symbol(), await vault.decimals()]).to.deep.equal([
      GOLD.name,
      GOLD.symbol,
      18,
    ])
    expect(await vault.asset()).to.equal(unit.address)
    expect(str(await vault.vestingPeriod())).to.equal(String(DAY))
    for (const hash of [DEFAULT_ADMIN_ROLE, ROLES.PAUSER_ROLE, REWARDER_ROLE])
      expect(await vault.hasRole(hash, admin.address)).to.equal(true)
    expect(await vault.fnPaused(vault.interface.getSighash("deposit"))).to.equal(true)
    expect(str(await vault.cumulativeAssetSeconds())).to.equal("0")
    await reserve.connect(alice).deposit(paxg.address, oz18("5"), alice.address)
    await expectRevert(vault.connect(alice).deposit(oz18("1"), alice.address), "FP: fn paused")
    await seedVault()
    expect(str(await vault.balanceOf(DEAD))).to.equal(str(oz18("1")))
    expect(await vault.fnPaused(vault.interface.getSighash("deposit"))).to.equal(false)
    await vault.connect(alice).deposit(oz18("1"), alice.address)
    await advance(100)
    // Integrates 2 ounces since the deposit, like sArcoUSD (the seed is the first checkpoint).
    expect((await vault.cumulativeAssetSeconds()).gte(oz18("2").mul(100))).to.equal(true)
  })

  it("the inherited initialize can never run after initializeNamed; implementations are locked; names cannot be empty", async () => {
    const { admin, unit, vault } = await goldFixture({ seed: false })
    await expectRevert(unit.initialize(admin.address), "already initialized")
    await expectRevert(unit.initializeNamed("X", "X", admin.address), "already initialized")
    await expectRevert(vault.initialize(unit.address, admin.address, DAY), "already initialized")
    await expectRevert(
      vault.initializeNamed("X", "X", unit.address, admin.address, DAY),
      "already initialized",
    )
    const impl = await (await ethers.getContractFactory("ArcoUSDNamed")).deploy()
    await expectRevert(
      impl.initializeNamed(UNIT.name, UNIT.symbol, admin.address),
      "already initialized",
    )
    await expectRevert(deployNamed("ArcoUSDNamed", ["", "ArcoXAU", admin.address]), "EmptyName")
    await expectRevert(
      deployNamed("SArcoUSDNamed", ["ArcoGOLD", "", unit.address, admin.address, DAY]),
      "EmptyName",
    )
    await expectRevert(
      deployNamed("SArcoUSDNamed", [
        "ArcoGOLD",
        "ArcoGOLD",
        ethers.constants.AddressZero,
        admin.address,
        DAY,
      ]),
      "ZeroAddress",
    )
  })

  it("EIP-2612 permit domains carry the new names (and the ArcoUSD names do not work)", async () => {
    const { alice, bob, unit, vault, reserve, paxg, zap } = await goldFixture()
    await reserve.connect(alice).deposit(paxg.address, oz18("3"), alice.address)
    // Unit: domain "Arco Gold Ounce".
    const wrong = await signPermit(alice, unit, "ArcoUSD", bob.address, oz18("1"))
    await expectRevert(
      unit
        .connect(bob)
        .permit(alice.address, bob.address, oz18("1"), wrong.deadline, wrong.v, wrong.r, wrong.s),
      "invalid signature",
    )
    const right = await signPermit(alice, unit, UNIT.name, bob.address, oz18("1"))
    await unit
      .connect(bob)
      .permit(alice.address, bob.address, oz18("1"), right.deadline, right.v, right.r, right.s)
    expect(str(await unit.allowance(alice.address, bob.address))).to.equal(str(oz18("1")))
    // ArcoGOLD: domain "ArcoGOLD", used by the Zap's redeemWithPermit.
    await zap.connect(alice).deposit(paxg.address, oz18("2"), 0, alice.address)
    await vault.connect(alice).approve(zap.address, 0)
    const bad = await signPermit(alice, vault, "sArcoUSD", zap.address, oz18("1"))
    await expectRevert(
      vault.permit(alice.address, zap.address, oz18("1"), bad.deadline, bad.v, bad.r, bad.s),
      "invalid signature",
    )
    const good = await signPermit(alice, vault, GOLD.name, zap.address, oz18("1"))
    const before = await paxg.balanceOf(bob.address)
    await zap
      .connect(alice)
      .redeemWithPermit(
        oz18("1"),
        paxg.address,
        0,
        bob.address,
        good.deadline,
        good.v,
        good.r,
        good.s,
      )
    expect(str((await paxg.balanceOf(bob.address)).sub(before))).to.equal(str(oz18("1")))
  })
})

describe("ArcoGOLD through the Zap: 1 ounce = 1 unit, 18 and 6 decimals", () => {
  it("deposits tPAXG (18 dec) and tXAUT (6 dec) into ArcoGOLD at 1 ounce = 1 share", async () => {
    const { alice, bob, paxg, xaut, unit, vault, zap, reserve, lens } = await goldFixture()
    const q1 = await zap.quoteDeposit(paxg.address, oz18("1.5"))
    expect([str(q1.arcoUSDIn), str(q1.shares)]).to.deep.equal([str(oz18("1.5")), str(oz18("1.5"))])
    await zap.connect(alice).deposit(paxg.address, oz18("1.5"), q1.shares, alice.address)
    expect(str(await vault.balanceOf(alice.address))).to.equal(str(oz18("1.5")))

    const q2 = await zap.quoteDeposit(xaut.address, oz6("2.25"))
    expect([str(q2.arcoUSDIn), str(q2.shares)]).to.deep.equal([
      str(oz18("2.25")),
      str(oz18("2.25")),
    ])
    await zap.connect(bob).deposit(xaut.address, oz6("2.25"), q2.shares, bob.address)
    expect(str(await vault.balanceOf(bob.address))).to.equal(str(oz18("2.25")))
    // The smallest tXAUT unit (0.000001 oz) is 1e12 ArcoXAU.
    await zap.connect(bob).deposit(xaut.address, 1, 0, bob.address)
    expect(str(await vault.balanceOf(bob.address))).to.equal(
      str(oz18("2.25").add(BigNumber.from(10).pow(12))),
    )

    // 1 + 1.5 tPAXG and 2.250001 tXAUT back 4.750001 ArcoXAU, all inside ArcoGOLD.
    expect(str(await vault.totalAssets())).to.equal(str(oz18("4.750001")))
    const snap = await lens.snapshot(reserve.address)
    expect(str(snap.totalBacking)).to.equal(str(snap.totalLiabilities))
    expect(str(snap.totalLiabilities)).to.equal(str(await unit.totalSupply()))
    expect(snap.assets.map((asset: any) => [asset.decimals, str(asset.balance)])).to.deep.equal([
      [18, str(oz18("2.5"))],
      [6, "2250001"],
    ])
    for (const token of [paxg, xaut, unit, vault])
      expect(str(await token.balanceOf(zap.address))).to.equal("0")
  })

  it("redeems into either coin (Instant), rounding tXAUT down and returning the sub-unit dust in ArcoXAU", async () => {
    const { admin, alice, bob, paxg, xaut, unit, vault, zap, reserve } = await goldFixture()
    await zap.connect(alice).deposit(paxg.address, oz18("10"), 0, alice.address)
    await zap.connect(bob).deposit(xaut.address, oz6("10"), 0, bob.address)
    // A reward makes the share price non-round (the app shows a set APY; this only exercises the maths).
    await reserve.deposit(paxg.address, oz18("0.7"), admin.address)
    await vault.addRewards(oz18("0.7"))
    await advance(DAY)

    const shares = oz18("3")
    const toXaut = await zap.quoteRedeem(shares, xaut.address)
    expect(toXaut.instant).to.equal(true)
    expect(str(toXaut.assetOut)).to.equal(str(toXaut.arcoUSDOut.div(BigNumber.from(10).pow(12))))
    const xautBefore = await xaut.balanceOf(alice.address)
    const unitBefore = await unit.balanceOf(alice.address)
    await zap.connect(alice).redeem(shares, xaut.address, toXaut.assetOut, alice.address)
    expect(str((await xaut.balanceOf(alice.address)).sub(xautBefore))).to.equal(
      str(toXaut.assetOut),
    )
    const dust = (await unit.balanceOf(alice.address)).sub(unitBefore)
    expect(str(dust)).to.equal(str(toXaut.arcoUSDOut.mod(BigNumber.from(10).pow(12))))

    const toPaxg = await zap.quoteRedeem(shares, paxg.address)
    expect(str(toPaxg.assetOut)).to.equal(str(toPaxg.arcoUSDOut)) // 18 decimals: exact
    const paxgBefore = await paxg.balanceOf(bob.address)
    await zap.connect(bob).redeem(shares, paxg.address, toPaxg.assetOut, bob.address)
    expect(str((await paxg.balanceOf(bob.address)).sub(paxgBefore))).to.equal(str(toPaxg.assetOut))
    for (const token of [paxg, xaut, unit, vault])
      expect(str(await token.balanceOf(zap.address))).to.equal("0")
    // Every ounce paid out was burned: backing ≥ liabilities.
    const backing18 = (await paxg.balanceOf(reserve.address)).add(
      (await xaut.balanceOf(reserve.address)).mul(BigNumber.from(10).pow(12)),
    )
    expect(backing18.gte(await unit.totalSupply())).to.equal(true)
  })

  it("a coin whose buffer is short reverts cleanly (InsufficientLiquidity), nothing moves, the other coin still works", async () => {
    const { alice, bob, paxg, xaut, vault, zap } = await goldFixture()
    await zap.connect(alice).deposit(paxg.address, oz18("5"), 0, alice.address)
    await zap.connect(bob).deposit(xaut.address, oz6("1"), 0, bob.address) // only 1 tXAUT in the Reserve
    expect((await zap.quoteRedeem(oz18("2"), xaut.address)).instant).to.equal(false)
    const sharesBefore = await vault.balanceOf(alice.address)
    const xautBefore = await xaut.balanceOf(alice.address)
    await expectRevert(
      zap.connect(alice).redeem(oz18("2"), xaut.address, 0, alice.address),
      "InsufficientLiquidity",
    )
    expect(str(await vault.balanceOf(alice.address))).to.equal(str(sharesBefore))
    expect(str(await xaut.balanceOf(alice.address))).to.equal(str(xautBefore))
    // Up to the buffer it works, and the tPAXG side is unaffected.
    await zap.connect(alice).redeem(oz18("1"), xaut.address, oz6("1"), alice.address)
    expect((await zap.quoteRedeem(oz18("0.000001"), xaut.address)).instant).to.equal(false)
    await zap.connect(alice).redeem(oz18("2"), paxg.address, oz18("2"), alice.address)
  })

  it("minAssetOut and receiver guards hold", async () => {
    const { alice, paxg, xaut, zap } = await goldFixture()
    await expectRevert(
      zap.connect(alice).deposit(xaut.address, oz6("1"), oz18("1.01"), alice.address),
      "MinOut",
    )
    await zap.connect(alice).deposit(xaut.address, oz6("1"), oz18("1"), alice.address)
    await expectRevert(
      zap.connect(alice).redeem(oz18("1"), paxg.address, oz18("1.01"), alice.address),
      "MinOut",
    )
    await expectRevert(
      zap.connect(alice).redeem(oz18("1"), paxg.address, 0, zap.address),
      "InvalidRecipient",
    )
  })

  it("the Reserve depeg check works in ounces: a feed off 1.0 by more than maxDepegBps blocks deposits", async () => {
    const { alice, paxg, reserve, zap } = await goldFixture()
    const off = await (await ethers.getContractFactory("ConstantPriceFeed")).deploy(oz18("0.98")) // 2% off
    await off.deployed()
    await reserve.setAsset(paxg.address, assetParams(off.address, { maxDepegBps: 100 }))
    await expectRevert(
      zap.connect(alice).deposit(paxg.address, oz18("1"), 0, alice.address),
      "Depeg",
    )
    await reserve.setAsset(paxg.address, assetParams(off.address, { maxDepegBps: 300 }))
    await zap.connect(alice).deposit(paxg.address, oz18("1"), 0, alice.address)
  })
})

describe("ArcoGOLD pauses (as in the ArcoUSD suite)", () => {
  it("vault: deposits, withdrawals and rewards pause separately; global pause; share transfers keep working", async () => {
    const { admin, alice, bob, paxg, reserve, vault, zap } = await goldFixture()
    await zap.connect(alice).deposit(paxg.address, oz18("5"), 0, alice.address)
    const depositSel = vault.interface.getSighash("deposit")
    const withdrawSel = vault.interface.getSighash("withdraw")
    const rewardsSel = vault.interface.getSighash("addRewards")
    await expectRevert(vault.connect(alice).pauseFn(depositSel), "missing role")

    await vault.pauseFn(depositSel)
    await expectRevert(
      zap.connect(alice).deposit(paxg.address, oz18("1"), 0, alice.address),
      "FP: fn paused",
    )
    await expectRevert(vault.connect(alice).mint(oz18("1"), alice.address), "FP: fn paused")
    expect(str(await vault.maxDeposit(alice.address))).to.equal("0")
    expect((await zap.quoteRedeem(oz18("1"), paxg.address)).instant).to.equal(true) // exits stay open
    await zap.connect(alice).redeem(oz18("1"), paxg.address, 0, alice.address)
    await vault.unpauseFn(depositSel)

    await vault.pauseFn(withdrawSel)
    expect((await zap.quoteRedeem(oz18("1"), paxg.address)).instant).to.equal(false)
    await expectRevert(
      zap.connect(alice).redeem(oz18("1"), paxg.address, 0, alice.address),
      "FP: fn paused",
    )
    expect(str(await vault.maxRedeem(alice.address))).to.equal("0")
    await vault.unpauseFn(withdrawSel)

    await reserve.deposit(paxg.address, oz18("1"), admin.address)
    await vault.pauseFn(rewardsSel)
    await expectRevert(vault.addRewards(oz18("1")), "FP: fn paused")
    await vault.unpauseFn(rewardsSel)

    await vault.pause()
    await expectRevert(
      zap.connect(alice).deposit(paxg.address, oz18("1"), 0, alice.address),
      "FP: paused",
    )
    await expectRevert(
      zap.connect(alice).redeem(oz18("1"), paxg.address, 0, alice.address),
      "FP: paused",
    )
    await vault.connect(alice).transfer(bob.address, oz18("1"))
    expect(str(await vault.balanceOf(bob.address))).to.equal(str(oz18("1")))
    await vault.unpause()
  })

  it("Reserve and unit pauses close the Zap paths; unit transfers keep working", async () => {
    const { alice, bob, paxg, xaut, reserve, unit, zap } = await goldFixture()
    await zap.connect(alice).deposit(paxg.address, oz18("5"), 0, alice.address)
    await reserve.connect(alice).deposit(xaut.address, oz6("1"), alice.address)

    await reserve.pauseFn(reserve.interface.getSighash("deposit"))
    await expectRevert(
      zap.connect(alice).deposit(xaut.address, oz6("1"), 0, alice.address),
      "FP: fn paused",
    )
    await reserve.unpauseFn(reserve.interface.getSighash("deposit"))

    await reserve.pauseFn(reserve.interface.getSighash("redeemInstantOnly"))
    expect((await zap.quoteRedeem(oz18("1"), paxg.address)).instant).to.equal(false)
    await expectRevert(
      zap.connect(alice).redeem(oz18("1"), paxg.address, 0, alice.address),
      "FP: fn paused",
    )
    await reserve.unpauseFn(reserve.interface.getSighash("redeemInstantOnly"))

    await unit.pauseFn(unit.interface.getSighash("burn")) // the Reserve burns what it pays out
    expect((await zap.quoteRedeem(oz18("1"), paxg.address)).instant).to.equal(false)
    await expectRevert(
      zap.connect(alice).redeem(oz18("1"), paxg.address, 0, alice.address),
      "FP: fn paused",
    )
    await unit.unpauseFn(unit.interface.getSighash("burn"))

    await unit.pauseFn(unit.interface.getSighash("mint"))
    await expectRevert(
      zap.connect(alice).deposit(paxg.address, oz18("1"), 0, alice.address),
      "FP: fn paused",
    )
    await unit.connect(alice).transfer(bob.address, oz18("0.5")) // transfers are never paused
    await unit.unpauseFn(unit.interface.getSighash("mint"))

    await reserve.pause()
    await expectRevert(
      zap.connect(alice).deposit(paxg.address, oz18("1"), 0, alice.address),
      "FP: paused",
    )
    await expectRevert(
      zap.connect(alice).redeem(oz18("1"), paxg.address, 0, alice.address),
      "FP: paused",
    )
    await reserve.unpause()
    await zap.connect(alice).redeem(oz18("1"), paxg.address, 0, alice.address)
  })

  it("follows the unit's blacklist (as sArcoUSD follows ArcoUSD's)", async () => {
    const { alice, mallory, paxg, unit, zap } = await goldFixture()
    await zap.connect(alice).deposit(paxg.address, oz18("2"), 0, alice.address)
    await zap.connect(mallory).deposit(paxg.address, oz18("2"), 0, mallory.address)
    await unit.blacklist(mallory.address)
    await expectRevert(
      zap.connect(alice).redeem(oz18("1"), paxg.address, 0, mallory.address),
      "Blacklisted",
    )
    await expectRevert(
      zap.connect(mallory).redeem(oz18("1"), paxg.address, 0, alice.address),
      "redeem more than max",
    )
    await expectRevert(
      zap.connect(alice).deposit(paxg.address, oz18("1"), 0, mallory.address),
      "deposit more than max",
    )
  })
})
