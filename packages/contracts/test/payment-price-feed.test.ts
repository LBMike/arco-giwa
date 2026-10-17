import { expect } from "chai"
import { ethers, upgrades } from "hardhat"
import { BigNumber, Contract } from "ethers"
import { deployProxy, expectRevert, parse, ROLES } from "./helpers"

// Live GIWA vaults were initialized with the product feed as BOTH productPriceFeed and
// paymentPriceFeed (deploy-giwa.ts passed `priceFeed` twice), so every quote is 1:1 whatever
// the NAV. Repair: upgrade both vault implementations (adds setPaymentPriceFeed, no storage
// change) and point paymentPriceFeed at an immutable ConstantPriceFeed(1e18).

const NAV_102 = BigNumber.from("102000000") // 1.02 with 8 feed decimals
const ONE = parse("1", 18)

async function liveLikeVaults(paymentDecimals = 6) {
  const [admin, investor, recipient, other] = await ethers.getSigners()
  const product = await deployProxy("ProductToken", ["Arco CAPIX", "aCAPIX", admin.address])
  await product.greenlist(admin.address)
  await product.greenlist(investor.address)
  await product.greenlist(recipient.address)
  const asset = await deployProxy("TestAssetToken", ["Test tUSDC", "tUSDC", paymentDecimals, admin.address])
  const productFeed = await deployProxy("ProductPriceFeed", [
    8,
    NAV_102,
    3600,
    1,
    BigNumber.from("100000000000000"),
    0,
    admin.address,
  ])
  const unit = BigNumber.from(10).pow(paymentDecimals)

  // The live implementations, initialized exactly like deploy-giwa.ts did (feed passed twice).
  const depositVault = await deployProxy("ArcoDepositVaultLiveLayout", [
    product.address,
    asset.address,
    productFeed.address,
    productFeed.address,
    unit,
    parse("1000000", 18),
    parse("500000", 18),
    admin.address,
  ])
  const redemptionVault = await deployProxy("ArcoRedemptionVaultLiveLayout", [
    product.address,
    asset.address,
    productFeed.address,
    productFeed.address,
    parse("1", 18),
    unit.mul(1_000_000),
    admin.address,
  ])
  await product.grantRole(ROLES.MINTER_ROLE, depositVault.address)
  await product.grantRole(ROLES.BURNER_ROLE, redemptionVault.address)
  await asset.mint(investor.address, unit.mul(100_000))
  await asset.mint(redemptionVault.address, unit.mul(100_000))
  return { admin, investor, recipient, other, product, asset, productFeed, depositVault, redemptionVault, unit }
}

async function upgradeBoth(depositVault: Contract, redemptionVault: Contract) {
  const nextDeposit = await ethers.getContractFactory("ArcoDepositVault")
  const nextRedemption = await ethers.getContractFactory("ArcoRedemptionVault")
  await upgrades.validateUpgrade(depositVault.address, nextDeposit, { kind: "transparent" })
  await upgrades.validateUpgrade(redemptionVault.address, nextRedemption, { kind: "transparent" })
  const deposit = await upgrades.upgradeProxy(depositVault.address, nextDeposit, { kind: "transparent" })
  const redemption = await upgrades.upgradeProxy(redemptionVault.address, nextRedemption, { kind: "transparent" })
  return { deposit, redemption }
}

async function constantFeed(answer = ONE) {
  const factory = await ethers.getContractFactory("ConstantPriceFeed")
  const feed = await factory.deploy(answer)
  await feed.deployed()
  return feed
}

describe("payment price feed repair (setPaymentPriceFeed + ConstantPriceFeed)", () => {
  it("ConstantPriceFeed is a fixed, never-stale 1e18 answer and rejects zero", async () => {
    const feed = await constantFeed()
    expect((await feed.getDataInBase18()).toString()).to.equal(ONE.toString())
    expect(await feed.decimals()).to.equal(18)
    await ethers.provider.send("evm_increaseTime", [10 * 365 * 24 * 3600])
    await ethers.provider.send("evm_mine", [])
    expect((await feed.getDataInBase18()).toString()).to.equal(ONE.toString())
    const factory = await ethers.getContractFactory("ConstantPriceFeed")
    await expectRevert(factory.deploy(0), "CPF: answer zero")
  })

  it("reproduces the live 1:1 bug at NAV 1.02, then prices by NAV after the upgrade", async () => {
    const { investor, asset, depositVault, redemptionVault, unit, productFeed } = await liveLikeVaults(6)

    // Bug: 102 USDC buys 102 shares and 100 shares redeem for 100 USDC at NAV 1.02.
    expect((await depositVault.quoteDeposit(unit.mul(102))).toString()).to.equal(parse("102", 18).toString())
    expect((await redemptionVault.quoteRedeem(parse("100", 18))).toString()).to.equal(unit.mul(100).toString())

    const { deposit, redemption } = await upgradeBoth(depositVault, redemptionVault)
    // Upgrade alone changes no state: still the product feed in both slots.
    expect(await deposit.paymentPriceFeed()).to.equal(productFeed.address)
    expect(await deposit.productToken()).to.equal(await depositVault.productToken())

    const feed = await constantFeed()
    for (const vault of [deposit, redemption]) {
      const receipt = await (await vault.setPaymentPriceFeed(feed.address)).wait()
      const event = receipt.events?.find((entry: any) => entry.event === "PaymentPriceFeedSet")
      expect(event?.args?.previousFeed).to.equal(productFeed.address)
      expect(event?.args?.newFeed).to.equal(feed.address)
      expect(await vault.paymentPriceFeed()).to.equal(feed.address)
      expect(await vault.productPriceFeed()).to.equal(productFeed.address)
    }

    // Fixed: 102 USDC -> 100 shares; 100 shares -> 102 USDC.
    expect((await deposit.quoteDeposit(unit.mul(102))).toString()).to.equal(parse("100", 18).toString())
    expect((await redemption.quoteRedeem(parse("100", 18))).toString()).to.equal(unit.mul(102).toString())

    // End to end through the real entry points.
    await asset.connect(investor).approve(deposit.address, unit.mul(102))
    await deposit.connect(investor).deposit(unit.mul(102), parse("100", 18), investor.address)
    const before = await asset.balanceOf(investor.address)
    await redemption.connect(investor).redeemInstant(parse("100", 18), unit.mul(102), investor.address)
    expect((await asset.balanceOf(investor.address)).sub(before).toString()).to.equal(unit.mul(102).toString())
  })

  it("open requests keep the rate locked before the repair", async () => {
    const { investor, recipient, asset, depositVault, redemptionVault, unit } = await liveLikeVaults(6)
    await asset.connect(investor).approve(depositVault.address, unit.mul(200))
    await depositVault.connect(investor).deposit(unit.mul(100), 0, investor.address) // 100 shares (bug rate)
    const depositRequest = await (await depositVault.connect(investor).requestDeposit(unit.mul(50), 0, investor.address)).wait()
    const depositRequestId = depositRequest.events?.find((event: any) => event.event === "ProductDepositRequested")?.args?.requestId
    const redeemRequest = await (await redemptionVault.connect(investor).requestRedeem(parse("10", 18), 0, recipient.address)).wait()
    const redeemRequestId = redeemRequest.events?.find((event: any) => event.event === "ProductRedeemRequested")?.args?.requestId

    const { deposit, redemption } = await upgradeBoth(depositVault, redemptionVault)
    const feed = await constantFeed()
    await deposit.setPaymentPriceFeed(feed.address)
    await redemption.setPaymentPriceFeed(feed.address)

    // Locked at request time: 50 shares for 50 USDC, 10 USDC for 10 shares.
    expect((await deposit.depositRequests(depositRequestId)).sharesOut.toString()).to.equal(parse("50", 18).toString())
    expect((await redemption.redemptionRequests(redeemRequestId)).assetsOut.toString()).to.equal(unit.mul(10).toString())
    await redemption.fulfillRedeem(redeemRequestId)
    const before = await asset.balanceOf(recipient.address)
    await redemption.connect(recipient).claimRedeem(redeemRequestId)
    expect((await asset.balanceOf(recipient.address)).sub(before).toString()).to.equal(unit.mul(10).toString())
  })

  it("only DEFAULT_ADMIN_ROLE may set it; zero, the product feed, and dead feeds are refused", async () => {
    const { other, productFeed, depositVault, redemptionVault } = await liveLikeVaults(18)
    const { deposit, redemption } = await upgradeBoth(depositVault, redemptionVault)
    const feed = await constantFeed()
    for (const vault of [deposit, redemption]) {
      await expectRevert(vault.connect(other).setPaymentPriceFeed(feed.address), "missing role")
      await expectRevert(vault.setPaymentPriceFeed(ethers.constants.AddressZero), "payment feed zero")
      await expectRevert(vault.setPaymentPriceFeed(productFeed.address), "same as product feed")
      // A non-feed address (an EOA) cannot be wired in: the answer probe reverts.
      await expectRevert(vault.setPaymentPriceFeed(other.address))
    }
  })

  it("18-decimal payment asset prices by NAV after the repair", async () => {
    const { depositVault, redemptionVault } = await liveLikeVaults(18)
    const { deposit, redemption } = await upgradeBoth(depositVault, redemptionVault)
    const feed = await constantFeed()
    await deposit.setPaymentPriceFeed(feed.address)
    await redemption.setPaymentPriceFeed(feed.address)
    expect((await deposit.quoteDeposit(parse("1.02", 18))).toString()).to.equal(parse("1", 18).toString())
    expect((await redemption.quoteRedeem(parse("1", 18))).toString()).to.equal(parse("1.02", 18).toString())
  })
})
