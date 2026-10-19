import { expect } from "chai"
import { ethers, network } from "hardhat"
import { BigNumber, Contract } from "ethers"
import { deployFixture, deployProxy, expectRevert, parse, role, ROLES } from "./helpers"

// sArcoUSD, ArcoUSDSavingsDistributor and ArcoSavingsZap: docs/specs/arcousd-v1.md §3.13–3.15.
// Surplus is created the simplest way the Reserve counts it: stablecoin sent straight to the
// Reserve raises its buffer (backing) without minting ArcoUSD (liabilities).

const MAX = ethers.constants.MaxUint256
const DAY = 24 * 60 * 60
const YEAR = 365 * DAY
const REWARDER_ROLE = role("REWARDER_ROLE")
const BLACKLISTED_ROLE = role("BLACKLISTED_ROLE")
const DEAD = "0x000000000000000000000000000000000000dEaD"
const usd6 = (value: string) => parse(value, 6)
const usd18 = (value: string) => parse(value, 18)
const str = (value: BigNumber) => value.toString()

const assetParams = (overrides: Partial<Record<string, unknown>> = {}) => ({
  depositEnabled: true,
  redeemEnabled: true,
  instantFeeBps: 0,
  swapFeeBps: 0,
  depositCap: MAX,
  priceFeed: ethers.constants.AddressZero,
  maxDepegBps: 0,
  minQueued: 0,
  ...overrides,
})

async function advance(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds])
  await network.provider.send("evm_mine", [])
}

/** Deployed like the deploy script does it: seeded (1 sArcoUSD for 0x…dEaD, deposits open) unless `seed: false`. */
async function savingsFixture(options: { mintCap?: string; usdtInstantFeeBps?: number; seed?: boolean } = {}) {
  const base = await deployFixture(6)
  const { admin, investor: alice, recipient: bob, other: mallory, asset: usdc } = base
  const [, , , , carol] = await ethers.getSigners()

  const usdt = await deployProxy("TestAssetToken", ["Test USDT", "tUSDT", 6, admin.address])
  const arco = await deployProxy("ArcoUSD", [admin.address])
  const reserve = await deployProxy("ArcoUSDReserve", [arco.address, admin.address, usd18(options.mintCap ?? "10000000"), 5000, 3000, 0])
  await arco.grantRole(ROLES.MINTER_ROLE, reserve.address)
  await arco.grantRole(ROLES.BURNER_ROLE, reserve.address)
  const lens = await (await ethers.getContractFactory("ArcoUSDReserveLens")).deploy()
  await lens.deployed()
  await reserve.setAsset(usdc.address, assetParams())
  await reserve.setAsset(usdt.address, assetParams({ swapFeeBps: 10, instantFeeBps: options.usdtInstantFeeBps ?? 0 }))

  const vault = await deployProxy("SArcoUSD", [arco.address, admin.address, DAY])
  const distributor = await (await ethers.getContractFactory("ArcoUSDSavingsDistributor")).deploy(
    reserve.address, lens.address, vault.address, admin.address, DAY, 2000, 50,
  )
  await distributor.deployed()
  await arco.grantRole(ROLES.MINTER_ROLE, distributor.address)
  await vault.grantRole(REWARDER_ROLE, distributor.address)
  const zap = await (await ethers.getContractFactory("ArcoSavingsZap")).deploy(reserve.address, vault.address)
  await zap.deployed()

  for (const user of [admin, alice, bob, mallory, carol]) {
    await usdc.mint(user.address, usd6("100000"))
    await usdt.mint(user.address, usd6("100000"))
    for (const token of [usdc, usdt]) {
      await token.connect(user).approve(reserve.address, MAX)
      await token.connect(user).approve(zap.address, MAX)
    }
    for (const spender of [reserve, vault, zap]) await arco.connect(user).approve(spender.address, MAX)
  }
  /** ArcoUSD for `user`, minted 1:1 from tUSDC through the Reserve. */
  const arcoFor = async (user: any, amount: string) => reserve.connect(user).deposit(usdc.address, usd6(amount), user.address)
  /** Surplus: tUSDC sent straight to the Reserve (backing up, liabilities unchanged). */
  const donateToReserve = async (amount: string) => usdc.mint(reserve.address, usd6(amount))
  const seedVault = async () => {
    await arcoFor(admin, "1")
    await vault.seed()
  }
  if (options.seed !== false) await seedVault()
  return { ...base, alice, bob, mallory, carol, usdc, usdt, arco, reserve, lens, vault, distributor, zap, arcoFor, donateToReserve, seedVault }
}

async function balances(contract: Contract, tokens: Contract[]) {
  return Promise.all(tokens.map(async (token) => str(await token.balanceOf(contract.address))))
}

describe("sArcoUSD vault", () => {
  it("is an 18-decimal ERC-4626 over ArcoUSD; deposits and withdrawals are instant and 1:1 before yield", async () => {
    const { vault, arco, alice, bob, arcoFor } = await savingsFixture()
    expect(await vault.name()).to.equal("sArcoUSD")
    expect(await vault.symbol()).to.equal("sArcoUSD")
    expect(await vault.decimals()).to.equal(18)
    expect(await vault.asset()).to.equal(arco.address)

    await arcoFor(alice, "1000")
    await vault.connect(alice).deposit(usd18("1000"), alice.address)
    expect(str(await vault.balanceOf(alice.address))).to.equal(str(usd18("1000")))
    expect(str(await vault.totalAssets())).to.equal(str(usd18("1001"))) // + the 1 ArcoUSD seed

    // Withdraw straight to another wallet: no queue, no claim.
    await vault.connect(alice).withdraw(usd18("400"), bob.address, alice.address)
    expect(str(await arco.balanceOf(bob.address))).to.equal(str(usd18("400")))
    await vault.connect(alice).redeem(usd18("600"), alice.address, alice.address)
    expect(str(await vault.totalSupply())).to.equal(str(usd18("1"))) // only the seed is left
    expect(str(await arco.balanceOf(alice.address))).to.equal(str(usd18("600")))
  })

  it("keeps deposits closed until seed(), which mints 1:1 to 0x…dEaD once and opens them", async () => {
    const { vault, arco, admin, alice, mallory, arcoFor } = await savingsFixture({ seed: false })
    await arcoFor(alice, "10")
    await arcoFor(mallory, "100")
    await expectRevert(vault.connect(alice).deposit(usd18("10"), alice.address), "FP: fn paused")
    expect(str(await vault.maxDeposit(alice.address))).to.equal("0")
    // A donation before the seed cannot price the seed out: it is 1:1 and the gift stays with it.
    await arco.connect(mallory).transfer(vault.address, usd18("100"))
    await arcoFor(admin, "1")
    await expectRevert(vault.connect(alice).seed(), "missing role")
    await vault.seed()
    expect(str(await vault.balanceOf(DEAD))).to.equal(str(usd18("1")))
    expect(str(await vault.totalAssets())).to.equal(str(usd18("101")))
    await expectRevert(vault.seed(), "AlreadySeeded")
    await vault.connect(alice).deposit(usd18("10"), alice.address) // open now, at the fair price
    const value = await vault.previewRedeem(await vault.balanceOf(alice.address))
    expect(usd18("10").sub(value).lte(1000)).to.equal(true) // rounding only (price is 101)
  })

  it("with the seed every holder can always exit in full", async () => {
    const { vault, alice, bob, arcoFor } = await savingsFixture()
    await arcoFor(alice, "1")
    await arcoFor(bob, "1")
    await vault.connect(alice).deposit(usd18("0.5"), alice.address)
    await vault.connect(bob).deposit(usd18("0.3"), bob.address)
    expect(str(await vault.maxRedeem(alice.address))).to.equal(str(usd18("0.5")))
    await vault.connect(alice).redeem(usd18("0.5"), alice.address, alice.address)
    await vault.connect(bob).redeem(usd18("0.3"), bob.address, bob.address)
    expect(str(await vault.totalSupply())).to.equal(str(usd18("1")))
  })

  it("without a seed (deposits opened by hand) the supply floor still holds and max* reflects it", async () => {
    const { vault, alice, bob, arcoFor } = await savingsFixture({ seed: false })
    await vault.unpauseFn(vault.interface.getSighash("deposit"))
    await arcoFor(alice, "100")
    await arcoFor(bob, "100")
    await expectRevert(vault.connect(alice).deposit(usd18("0.5"), alice.address), "MinSharesViolation")
    await vault.connect(alice).deposit(usd18("10"), alice.address)
    await vault.connect(bob).deposit(usd18("0.4"), bob.address) // fine: the supply stays ≥ 1
    // Alice cannot leave Bob's 0.4 share alone below the minimum.
    expect(str(await vault.maxRedeem(alice.address))).to.equal(str(usd18("9.4")))
    expect(str(await vault.maxWithdraw(alice.address))).to.equal(str(usd18("9.4")))
    await expectRevert(vault.connect(alice).redeem(usd18("10"), alice.address, alice.address), "redeem more than max")
    await vault.connect(alice).redeem(usd18("9.4"), alice.address, alice.address)
    expect(str(await vault.totalSupply())).to.equal(str(usd18("1")))
  })

  it("defeats the first-depositor donation attack even without a seed", async () => {
    const { vault, arco, mallory, alice, arcoFor } = await savingsFixture({ seed: false })
    await vault.unpauseFn(vault.interface.getSighash("deposit"))
    await arcoFor(mallory, "10001")
    await arcoFor(alice, "500")
    // A 1-wei share position (the usual set-up) is refused outright.
    await expectRevert(vault.connect(mallory).deposit(1, mallory.address), "MinSharesViolation")
    // The smallest allowed position plus a large donation still cannot round the victim to zero.
    await vault.connect(mallory).deposit(usd18("1"), mallory.address)
    await arco.connect(mallory).transfer(vault.address, usd18("10000"))
    await vault.connect(alice).deposit(usd18("500"), alice.address)
    const aliceValue = await vault.previewRedeem(await vault.balanceOf(alice.address))
    expect(usd18("500").sub(aliceValue).lte(usd18("0.00001"))).to.equal(true)
  })

  it("releases rewards per second over the vesting period, rolling over what is still unvested", async () => {
    const { vault, admin, alice, bob, arcoFor, seedVault } = await savingsFixture({ seed: false })
    await arcoFor(admin, "1000")
    await expectRevert(vault.addRewards(usd18("10")), "NoDepositors")
    await seedVault()
    await arcoFor(alice, "999")
    await vault.connect(alice).deposit(usd18("999"), alice.address) // 1000 with the seed
    await expectRevert(vault.connect(bob).addRewards(usd18("10")), "missing role")

    await vault.addRewards(usd18("100"))
    expect(str(await vault.totalAssets())).to.equal(str(usd18("1000"))) // no jump
    expect(str(await vault.rewardRate())).to.equal(str(usd18("100").div(DAY)))
    await advance(DAY / 2)
    const half = await vault.totalAssets()
    expect(half.sub(usd18("1050")).abs().lte(usd18("100").div(DAY).mul(3))).to.equal(true)

    // A second reward re-spreads the ~50 still unvested plus the new 30 over a fresh day.
    await vault.addRewards(usd18("30"))
    const unvested = await vault.unvestedAmount()
    expect(unvested.sub(usd18("80")).abs().lte(usd18("100").div(DAY).mul(3))).to.equal(true)
    await advance(DAY)
    expect(str(await vault.totalAssets())).to.equal(str(usd18("1130")))
    expect(str(await vault.unvestedAmount())).to.equal("0")
    expect(str(await vault.rewardRate())).to.equal("0")
  })

  it("integrates assets over time for the distributor (a same-block deposit adds nothing)", async () => {
    const { vault, usdc, alice, mallory, arcoFor } = await savingsFixture()
    await usdc.mint(mallory.address, usd6("1000000"))
    await arcoFor(alice, "999")
    await vault.connect(alice).deposit(usd18("999"), alice.address) // 1000 with the seed
    const start = await vault.cumulativeAssetSeconds()
    await advance(1000)
    const later = await vault.cumulativeAssetSeconds()
    expect(str(later.sub(start))).to.equal(str(usd18("1000").mul(1000)))
    // A big deposit only counts for the seconds it actually stays.
    await arcoFor(mallory, "1000000")
    const before = await vault.cumulativeAssetSeconds()
    await vault.connect(mallory).deposit(usd18("1000000"), mallory.address)
    await vault.connect(mallory).redeem(await vault.balanceOf(mallory.address), mallory.address, mallory.address)
    const after = await vault.cumulativeAssetSeconds()
    // ≤ 3 blocks at most, one of them with the deposit in (hardhat advances 1 s per block).
    expect(after.sub(before).lte(usd18("1001000").mul(3))).to.equal(true)
  })

  it("a deposit right before a reward and a withdrawal right after captures almost nothing", async () => {
    const { vault, admin, alice, bob, arco, arcoFor } = await savingsFixture()
    await arcoFor(admin, "1000")
    await arcoFor(alice, "1000")
    await arcoFor(bob, "100000")
    await vault.connect(alice).deposit(usd18("1000"), alice.address)
    await vault.connect(bob).deposit(usd18("100000"), bob.address)
    await vault.addRewards(usd18("1000"))
    await vault.connect(bob).redeem(await vault.balanceOf(bob.address), bob.address, bob.address)
    const gain = (await arco.balanceOf(bob.address)).sub(usd18("100000"))
    expect(gain.lte(usd18("0.05"))).to.equal(true) // a second or two of vesting, not ~99% of the reward
  })

  it("setVestingPeriod keeps what vested and re-spreads the rest; bounds are enforced", async () => {
    const { vault, admin, alice, arcoFor } = await savingsFixture()
    await arcoFor(admin, "100")
    await arcoFor(alice, "99")
    await vault.connect(alice).deposit(usd18("99"), alice.address) // 100 with the seed
    await vault.addRewards(usd18("24"))
    await advance(DAY / 2)
    const before = await vault.totalAssets()
    await vault.setVestingPeriod(2 * DAY)
    expect((await vault.totalAssets()).sub(before).abs().lte(usd18("0.001"))).to.equal(true)
    expect(String(await vault.vestingPeriod())).to.equal(String(2 * DAY))
    await expectRevert(vault.setVestingPeriod(60), "InvalidParams")
    await expectRevert(vault.setVestingPeriod(31 * DAY), "InvalidParams")
    await expectRevert(vault.connect(alice).setVestingPeriod(DAY), "missing role")
    await advance(2 * DAY)
    expect(str(await vault.totalAssets())).to.equal(str(usd18("124")))
  })

  it("follows the ArcoUSD blacklist for deposits, transfers, redemptions and allowances", async () => {
    const { vault, arco, alice, bob, mallory, arcoFor } = await savingsFixture()
    await arcoFor(alice, "100")
    await arcoFor(mallory, "100")
    await vault.connect(alice).deposit(usd18("50"), alice.address)
    await vault.connect(mallory).deposit(usd18("50"), mallory.address)
    await vault.connect(mallory).approve(bob.address, MAX)
    await vault.connect(alice).approve(mallory.address, MAX)
    await arco.blacklist(mallory.address)
    expect(await arco.hasRole(BLACKLISTED_ROLE, mallory.address)).to.equal(true)

    // Mallory cannot get value out through the vault in any direction.
    await expectRevert(vault.connect(mallory).transfer(bob.address, usd18("1")), "Blacklisted")
    await expectRevert(vault.connect(bob).transferFrom(mallory.address, bob.address, usd18("1")), "Blacklisted")
    await expectRevert(vault.connect(bob).redeem(usd18("1"), bob.address, mallory.address), "redeem more than max")
    await expectRevert(vault.connect(mallory).redeem(usd18("1"), bob.address, mallory.address), "redeem more than max")
    expect(str(await vault.maxRedeem(mallory.address))).to.equal("0")
    // …nor receive shares, nor use an old allowance on someone else's shares.
    await expectRevert(vault.connect(alice).transfer(mallory.address, usd18("1")), "Blacklisted")
    await expectRevert(vault.connect(alice).deposit(usd18("1"), mallory.address), "deposit more than max")
    await expectRevert(vault.connect(mallory).transferFrom(alice.address, bob.address, usd18("1")), "Blacklisted")
    await expectRevert(vault.connect(mallory).redeem(usd18("1"), bob.address, alice.address), "Blacklisted")
    await expectRevert(vault.connect(alice).redeem(usd18("1"), mallory.address, alice.address), "Blacklisted")
    expect(str(await vault.maxDeposit(mallory.address))).to.equal("0")
    // Unrelated holders are unaffected.
    await vault.connect(alice).redeem(usd18("10"), bob.address, alice.address)
  })

  it("pauses deposits, withdrawals and rewards separately; share transfers keep working", async () => {
    const { vault, admin, alice, bob, arcoFor } = await savingsFixture()
    await arcoFor(admin, "100")
    await arcoFor(alice, "100")
    await vault.connect(alice).deposit(usd18("50"), alice.address)
    const depositSel = vault.interface.getSighash("deposit")
    const withdrawSel = vault.interface.getSighash("withdraw")
    const rewardsSel = vault.interface.getSighash("addRewards")
    await expectRevert(vault.connect(alice).pauseFn(depositSel), "missing role")

    await vault.pauseFn(depositSel)
    await expectRevert(vault.connect(alice).deposit(usd18("1"), alice.address), "FP: fn paused")
    await expectRevert(vault.connect(alice).mint(usd18("1"), alice.address), "FP: fn paused")
    expect(str(await vault.maxDeposit(alice.address))).to.equal("0")
    expect(str(await vault.maxMint(alice.address))).to.equal("0")
    await vault.connect(alice).withdraw(usd18("1"), alice.address, alice.address) // exits stay open
    await vault.unpauseFn(depositSel)

    await vault.pauseFn(withdrawSel)
    await expectRevert(vault.connect(alice).withdraw(usd18("1"), alice.address, alice.address), "FP: fn paused")
    await expectRevert(vault.connect(alice).redeem(usd18("1"), alice.address, alice.address), "FP: fn paused")
    expect(str(await vault.maxWithdraw(alice.address))).to.equal("0")
    expect(str(await vault.maxRedeem(alice.address))).to.equal("0")
    await vault.unpauseFn(withdrawSel)

    await vault.pauseFn(rewardsSel)
    await expectRevert(vault.addRewards(usd18("1")), "FP: fn paused")
    await vault.unpauseFn(rewardsSel)

    await vault.pause()
    await expectRevert(vault.connect(alice).deposit(usd18("1"), alice.address), "FP: paused")
    await expectRevert(vault.connect(alice).redeem(usd18("1"), alice.address, alice.address), "FP: paused")
    await vault.connect(alice).transfer(bob.address, usd18("1"))
    expect(str(await vault.balanceOf(bob.address))).to.equal(str(usd18("1")))
  })

  it("rescues stray tokens but never ArcoUSD", async () => {
    const { vault, arco, usdt, alice } = await savingsFixture()
    await usdt.connect(alice).transfer(vault.address, usd6("5"))
    await expectRevert(vault.connect(alice).rescue(usdt.address, alice.address, usd6("5")), "missing role")
    await expectRevert(vault.rescue(arco.address, alice.address, 1), "CannotRescueAsset")
    const before = await usdt.balanceOf(alice.address)
    await vault.rescue(usdt.address, alice.address, usd6("5"))
    expect(str((await usdt.balanceOf(alice.address)).sub(before))).to.equal(str(usd6("5")))
  })
})

describe("ArcoUSDSavingsDistributor", () => {
  /** Seeded vault + Alice's 9,999 ArcoUSD: 10,000 saved, 10,000 ArcoUSD of liabilities. */
  async function withSavers(options: { mintCap?: string } = {}) {
    const fixture = await savingsFixture(options)
    const { vault, alice, arcoFor } = fixture
    await arcoFor(alice, "9999")
    await vault.connect(alice).deposit(usd18("9999"), alice.address)
    return fixture
  }
  const oneDayCap = (assets: BigNumber) => assets.mul(2000).mul(DAY).div(10_000 * YEAR)

  it("mints only the surplus above the margin, into the vault, and the Reserve stays backed", async () => {
    const { distributor, vault, reserve, lens, arco, bob, donateToReserve } = await withSavers()
    await donateToReserve("52") // surplus 52 − margin 50 (0.5% of 10,000) = 2
    await expectRevert(distributor.distribute(), "TooSoon")
    await advance(DAY)
    const preview = await distributor.preview()
    expect(preview.navOk).to.equal(true)
    expect(str(preview.surplus)).to.equal(str(usd18("2")))
    expect(str(preview.amount)).to.equal(str(usd18("2")))

    const receipt = await (await distributor.connect(bob).distribute()).wait() // anyone may call
    const event = receipt.events?.find((entry: any) => entry.event === "Distributed")
    expect(str(event.args.amount)).to.equal(str(usd18("2")))
    expect(str(await vault.vestingAmount())).to.equal(str(usd18("2")))
    expect(str(await arco.balanceOf(distributor.address))).to.equal("0")
    const [backing] = await lens.totalBacking(reserve.address)
    const liabilities = await lens.totalLiabilities(reserve.address)
    expect(str(backing.sub(liabilities))).to.equal(str(usd18("50"))) // exactly the margin is left
    await expectRevert(distributor.distribute(), "TooSoon")
    await advance(DAY)
    await expectRevert(distributor.distribute(), "NothingToDistribute")
  })

  it("caps a distribution at the APR on the time-weighted assets, for at most one vesting period", async () => {
    const { distributor, vault, donateToReserve } = await withSavers()
    await donateToReserve("5000")
    await advance(DAY)
    const preview = await distributor.preview()
    expect(preview.rateCap.lt(preview.surplus)).to.equal(true)
    const cap = oneDayCap(await vault.totalAssets())
    expect(preview.rateCap.lte(cap)).to.equal(true)
    expect(preview.rateCap.gte(cap.mul(995).div(1000))).to.equal(true) // ~all of the day at 10,000
    await distributor.distribute()

    // After a 30-day gap only one vesting period of yield goes out; the rest waits in the Reserve.
    await advance(30 * DAY)
    const later = await distributor.preview()
    const assets = await vault.totalAssets()
    expect(later.rateCap.lte(oneDayCap(assets))).to.equal(true)
    expect(later.rateCap.gte(oneDayCap(assets).mul(999).div(1000))).to.equal(true)
    await distributor.distribute()
    await advance(DAY)
    expect((await distributor.preview()).amount.gt(0)).to.equal(true) // the backlog keeps flowing, a day at a time
  })

  it("a large deposit right before distribute does not raise the amount (no flash TVL)", async () => {
    const { distributor, vault, usdc, mallory, arcoFor, donateToReserve } = await withSavers()
    await usdc.mint(mallory.address, usd6("1000000"))
    await donateToReserve("1000000")
    await advance(DAY)
    const honest = (await distributor.preview()).amount
    await arcoFor(mallory, "1000000")
    await vault.connect(mallory).deposit(usd18("1000000"), mallory.address)
    const receipt = await (await distributor.connect(mallory).distribute()).wait()
    const minted = receipt.events?.find((entry: any) => entry.event === "Distributed").args.amount as BigNumber
    // At most a couple of seconds of the 1M counts: 1M × 0.2 × 3 s / year ≈ 0.019.
    expect(minted.sub(honest).lte(usd18("0.03"))).to.equal(true)
    expect(minted.lte(oneDayCap(usd18("10000")).mul(1001).div(1000))).to.equal(true)
  })

  it("stays under the Reserve mintCap", async () => {
    const { distributor, donateToReserve, arco, reserve } = await withSavers({ mintCap: "10003" })
    await donateToReserve("1000")
    await advance(DAY)
    const preview = await distributor.preview()
    expect(str(preview.mintHeadroom)).to.equal(str(usd18("3")))
    expect(str(preview.amount)).to.equal(str(usd18("3"))) // below the ~5.48 rate cap
    await distributor.distribute()
    expect(str(await arco.totalSupply())).to.equal(str(await reserve.mintCap()))
  })

  it("refuses with no depositors, while a strategy NAV is unreadable, while the Reserve or itself is paused", async () => {
    const fixture = await savingsFixture({ seed: false })
    const { distributor, vault, reserve, alice, arcoFor, donateToReserve, depositVault, redemptionVault, admin, productFeed, paymentFeed, seedVault } = fixture
    await donateToReserve("1000")
    await advance(DAY)
    await expectRevert(distributor.distribute(), "NoDepositors")

    await seedVault()
    await arcoFor(alice, "10000")
    await vault.connect(alice).deposit(usd18("10000"), alice.address)
    await reserve.pause()
    expect(str((await distributor.preview()).amount)).to.equal("0")
    await expectRevert(distributor.distribute(), "ReservePaused")
    await reserve.unpause()

    // An MMF position whose feed then goes stale (healthyDiff 1h in the fixture).
    await reserve.addStrategy(depositVault.address, redemptionVault.address, usd18("1000000"))
    await productFeed.setRoundDataSafe(BigNumber.from("200000000"))
    await paymentFeed.setRoundDataSafe(BigNumber.from("100000000"))
    await reserve.allocate(0, usd6("1000"), 0)
    expect((await distributor.preview()).navOk).to.equal(true)
    await advance(2 * 60 * 60)
    expect((await distributor.preview()).navOk).to.equal(false)
    expect(str((await distributor.preview()).amount)).to.equal("0")
    await expectRevert(distributor.distribute(), "NavUnavailable")

    await expectRevert(distributor.connect(alice).pause(), "missing role")
    await distributor.connect(admin).pause()
    await expectRevert(distributor.distribute(), "Pausable: paused")
  })

  it("validates params (interval within the vesting period) and the vault's asset", async () => {
    const { distributor, reserve, lens, alice, arco } = await savingsFixture()
    await expectRevert(distributor.connect(alice).setParams(DAY, 1000, 50), "missing role")
    await expectRevert(distributor.setParams(60, 1000, 50), "InvalidParams")
    await expectRevert(distributor.setParams(2 * DAY, 1000, 50), "InvalidParams") // vesting is 1 day
    await expectRevert(distributor.setParams(DAY, 5001, 50), "InvalidParams")
    await expectRevert(distributor.setParams(DAY, 1000, 1001), "InvalidParams")
    await distributor.setParams(DAY / 2, 1000, 100)
    expect(String(await distributor.minInterval())).to.equal(String(DAY / 2))
    // A vault over another asset is refused.
    const other = await deployProxy("SArcoUSD", [reserve.address, alice.address, DAY])
    const factory = await ethers.getContractFactory("ArcoUSDSavingsDistributor")
    await expectRevert(factory.deploy(reserve.address, lens.address, other.address, alice.address, DAY, 2000, 50), "InvalidParams")
    expect(await other.asset()).to.not.equal(arco.address)
  })
})

describe("ArcoSavingsZap", () => {
  it("deposits tUSDC, tUSDT (swap fee) or ArcoUSD into sArcoUSD in one call and keeps nothing", async () => {
    const { zap, vault, usdc, usdt, arco, alice, bob, arcoFor } = await savingsFixture()
    const quote = await zap.quoteDeposit(usdc.address, usd6("1000"))
    expect(str(quote.shares)).to.equal(str(usd18("1000")))
    await zap.connect(alice).deposit(usdc.address, usd6("1000"), quote.shares, alice.address)
    expect(str(await vault.balanceOf(alice.address))).to.equal(str(usd18("1000")))

    const usdtQuote = await zap.quoteDeposit(usdt.address, usd6("1000"))
    expect(str(usdtQuote.arcoUSDIn)).to.equal(str(usd18("999"))) // 10 bps
    await zap.connect(alice).deposit(usdt.address, usd6("1000"), 0, bob.address)
    expect(str(await vault.balanceOf(bob.address))).to.equal(str(usdtQuote.shares))

    await arcoFor(alice, "10")
    await zap.connect(alice).deposit(arco.address, usd18("10"), 0, alice.address)
    expect(str(await vault.balanceOf(alice.address))).to.equal(str(usd18("1010")))
    expect(await balances(zap, [usdc, usdt, arco, vault])).to.deep.equal(["0", "0", "0", "0"])
  })

  it("guards the receiver and the minimum shares", async () => {
    const { zap, usdc, alice } = await savingsFixture()
    await expectRevert(zap.connect(alice).deposit(usdc.address, usd6("10"), 0, zap.address), "InvalidRecipient")
    await expectRevert(zap.connect(alice).deposit(usdc.address, usd6("10"), 0, ethers.constants.AddressZero), "ZeroAddress")
    await expectRevert(zap.connect(alice).deposit(usdc.address, usd6("10"), usd18("11"), alice.address), "MinOut")
    await expectRevert(zap.connect(alice).deposit(usdc.address, 0, 0, alice.address), "ZeroAmount")
  })

  it("redeems to a stablecoin Instant (fees applied), returns ArcoUSD dust, and to ArcoUSD directly", async () => {
    const { zap, vault, usdc, usdt, arco, admin, alice, bob, arcoFor } = await savingsFixture({ usdtInstantFeeBps: 20 })
    await zap.connect(alice).deposit(usdc.address, usd6("1000"), 0, alice.address)
    await usdt.connect(bob).approve(zap.address, MAX)
    await zap.connect(bob).deposit(usdt.address, usd6("2000"), 0, bob.address) // tUSDT liquidity in the Reserve
    // Yield makes the share price non-round, so ArcoUSD → 6 decimals leaves dust.
    await arcoFor(admin, "7")
    await vault.addRewards(usd18("7"))
    await advance(DAY)

    await vault.connect(alice).approve(zap.address, MAX)
    const shares = usd18("100")
    const quote = await zap.quoteRedeem(shares, usdt.address)
    expect(quote.instant).to.equal(true)
    const usdtBefore = await usdt.balanceOf(alice.address)
    const arcoBefore = await arco.balanceOf(alice.address)
    await zap.connect(alice).redeem(shares, usdt.address, quote.assetOut, alice.address)
    expect(str((await usdt.balanceOf(alice.address)).sub(usdtBefore))).to.equal(str(quote.assetOut))
    const dust = (await arco.balanceOf(alice.address)).sub(arcoBefore)
    expect(dust.lt(BigNumber.from(10).pow(12))).to.equal(true)
    expect(await balances(zap, [usdc, usdt, arco, vault])).to.deep.equal(["0", "0", "0", "0"])

    const arcoQuote = await zap.quoteRedeem(usd18("10"), arco.address)
    const before = await arco.balanceOf(bob.address)
    await zap.connect(alice).redeem(usd18("10"), arco.address, arcoQuote.assetOut, bob.address)
    expect(str((await arco.balanceOf(bob.address)).sub(before))).to.equal(str(arcoQuote.assetOut))
  })

  it("quoteRedeem reports a closed path (vault withdrawals, Reserve redemptions or ArcoUSD burns paused) as not instant", async () => {
    const { zap, vault, reserve, usdc, arco, alice } = await savingsFixture()
    await zap.connect(alice).deposit(usdc.address, usd6("1000"), 0, alice.address)
    expect((await zap.quoteRedeem(usd18("10"), usdc.address)).instant).to.equal(true)
    await reserve.pauseFn(reserve.interface.getSighash("redeemInstantOnly"))
    expect((await zap.quoteRedeem(usd18("10"), usdc.address)).instant).to.equal(false)
    await reserve.unpauseFn(reserve.interface.getSighash("redeemInstantOnly"))
    await arco.pauseFn(arco.interface.getSighash("burn")) // the Reserve burns what it pays out
    expect((await zap.quoteRedeem(usd18("10"), usdc.address)).instant).to.equal(false)
    await arco.unpauseFn(arco.interface.getSighash("burn"))
    await vault.pauseFn(vault.interface.getSighash("withdraw"))
    expect((await zap.quoteRedeem(usd18("10"), usdc.address)).instant).to.equal(false)
    expect((await zap.quoteRedeem(usd18("10"), arco.address)).instant).to.equal(false)
  })

  it("never queues: a short Reserve buffer reverts the whole redemption", async () => {
    const { zap, vault, usdc, usdt, alice } = await savingsFixture()
    await zap.connect(alice).deposit(usdc.address, usd6("1000"), 0, alice.address) // no tUSDT in the Reserve
    await vault.connect(alice).approve(zap.address, MAX)
    expect((await zap.quoteRedeem(usd18("100"), usdt.address)).instant).to.equal(false)
    await expectRevert(zap.connect(alice).redeem(usd18("100"), usdt.address, 0, alice.address), "InsufficientLiquidity")
    expect(str(await vault.balanceOf(alice.address))).to.equal(str(usd18("1000")))
  })

  it("needs a share allowance, takes it by permit, and survives a front-run permit", async () => {
    const { zap, vault, usdc, alice, bob, mallory } = await savingsFixture()
    await zap.connect(alice).deposit(usdc.address, usd6("1000"), 0, alice.address)
    await expectRevert(zap.connect(alice).redeem(usd18("10"), usdc.address, 0, alice.address), "insufficient allowance")

    const sign = async (value: BigNumber) => {
      const { chainId } = await ethers.provider.getNetwork()
      const nonce = await vault.nonces(alice.address)
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600
      const signature = await alice._signTypedData(
        { name: "sArcoUSD", version: "1", chainId, verifyingContract: vault.address },
        { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
        { owner: alice.address, spender: zap.address, value, nonce, deadline },
      )
      return { deadline, ...ethers.utils.splitSignature(signature) }
    }
    let permit = await sign(usd18("10"))
    let before = await usdc.balanceOf(bob.address)
    await zap.connect(alice).redeemWithPermit(usd18("10"), usdc.address, 0, bob.address, permit.deadline, permit.v, permit.r, permit.s)
    expect(str((await usdc.balanceOf(bob.address)).sub(before))).to.equal(str(usd6("10")))

    // Someone submits Alice's permit first: the Zap call still goes through on the allowance.
    permit = await sign(usd18("20"))
    await vault.connect(mallory).permit(alice.address, zap.address, usd18("20"), permit.deadline, permit.v, permit.r, permit.s)
    before = await usdc.balanceOf(bob.address)
    await zap.connect(alice).redeemWithPermit(usd18("20"), usdc.address, 0, bob.address, permit.deadline, permit.v, permit.r, permit.s)
    expect(str((await usdc.balanceOf(bob.address)).sub(before))).to.equal(str(usd6("20")))
  })

  it("refuses a blacklisted receiver or owner", async () => {
    const { zap, vault, arco, usdc, alice, mallory } = await savingsFixture()
    await zap.connect(alice).deposit(usdc.address, usd6("100"), 0, alice.address)
    await zap.connect(mallory).deposit(usdc.address, usd6("100"), 0, mallory.address)
    await vault.connect(alice).approve(zap.address, MAX)
    await vault.connect(mallory).approve(zap.address, MAX)
    await arco.blacklist(mallory.address)
    await expectRevert(zap.connect(alice).redeem(usd18("10"), usdc.address, 0, mallory.address), "Blacklisted")
    await expectRevert(zap.connect(mallory).redeem(usd18("10"), usdc.address, 0, alice.address), "redeem more than max")
    await expectRevert(zap.connect(alice).deposit(usdc.address, usd6("10"), 0, mallory.address), "deposit more than max")
  })
})
