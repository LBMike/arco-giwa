import { expect } from "chai"
import { ethers } from "hardhat"
import { BigNumber, Contract } from "ethers"
import { deployFixture, deployProxy, expectRevert, parse, ROLES } from "./helpers"

// ArcoRouter: docs/specs/arcousd-v1.md §3.12. A real Reserve (tUSDC base, tUSDT/tRLUSD with a 10 bps
// swap fee) and a real Arco product paid in tUSDC (NAV 2.0), so every buy runs through the same
// Reserve.deposit → settleFor → ArcoDepositVault path as on GIWA.

const MAX = ethers.constants.MaxUint256
const SETTLER_ROLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("SETTLER_ROLE"))
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

async function routerFixture(options: { bufferUsdc?: string } = {}) {
  const fixture = await deployFixture(6)
  const { admin, investor, recipient, other, asset: usdc, product, depositVault } = fixture
  const usdt = await deployProxy("TestAssetToken", ["Test USDT", "tUSDT", 6, admin.address])
  const rlusd = await deployProxy("TestAssetToken", ["Test RLUSD", "tRLUSD", 18, admin.address])
  const arco = await deployProxy("ArcoUSD", [admin.address])
  const reserve = await deployProxy("ArcoUSDReserve", [arco.address, admin.address, usd18("10000000"), 5000, 3000, 0])
  await arco.grantRole(ROLES.MINTER_ROLE, reserve.address)
  await arco.grantRole(ROLES.BURNER_ROLE, reserve.address)
  await reserve.setAsset(usdc.address, assetParams())
  await reserve.setAsset(usdt.address, assetParams({ swapFeeBps: 10 }))
  await reserve.setAsset(rlusd.address, assetParams({ swapFeeBps: 10 }))

  const router = await deployProxy("ArcoRouter", [reserve.address, admin.address])
  await reserve.grantRole(SETTLER_ROLE, router.address)
  await router.setVault(depositVault.address, true)

  for (const user of [investor, recipient, other]) {
    await usdc.mint(user.address, usd6("100000"))
    await usdt.mint(user.address, usd6("100000"))
    await rlusd.mint(user.address, usd18("100000"))
    for (const token of [usdc, usdt, rlusd, arco]) {
      await token.connect(user).approve(router.address, MAX)
      await token.connect(user).approve(reserve.address, MAX)
    }
  }
  // USDC buffer the Reserve pays product buys from.
  const buffer = options.bufferUsdc ?? "10000"
  if (buffer !== "0") await reserve.connect(other).deposit(usdc.address, usd6(buffer), other.address)
  return { ...fixture, usdc, usdt, rlusd, arco, reserve, router }
}

async function routerHoldsNothing(router: Contract, tokens: Contract[]) {
  for (const token of tokens) expect(str(await token.balanceOf(router.address)), await token.symbol()).to.equal("0")
}

describe("ArcoRouter buys", () => {
  it("buys with USDT: the swap fee is taken, the Reserve's USDC pays the vault, shares go to the recipient", async () => {
    const { router, reserve, arco, usdc, usdt, rlusd, product, depositVault, investor, recipient } = await routerFixture()
    const supplyBefore = await arco.totalSupply()
    const reserveUsdcBefore = await usdc.balanceOf(reserve.address)
    const [arcoIn, paymentAmount, quoted] = await router.quoteBuy(usdt.address, usd6("1000"), depositVault.address)
    expect(str(arcoIn)).to.equal(str(usd18("999")))
    expect(str(paymentAmount)).to.equal(str(usd6("999")))

    const receipt = await (
      await router.connect(investor).buy(usdt.address, usd6("1000"), depositVault.address, quoted, recipient.address, false)
    ).wait()
    expect(str(await product.balanceOf(recipient.address))).to.equal(str(quoted))
    expect(str(quoted)).to.equal(str(usd18("499.5"))) // 999 USDC at NAV 2.0
    expect(str(await usdt.balanceOf(reserve.address))).to.equal(str(usd6("1000")))
    expect(str(reserveUsdcBefore.sub(await usdc.balanceOf(reserve.address)))).to.equal(str(usd6("999")))
    expect(str(await arco.totalSupply())).to.equal(str(supplyBefore)) // minted and burned in the same buy
    const bought = receipt.events.find((entry: any) => entry.event === "Bought")
    expect(bought.args.payer).to.equal(investor.address)
    expect(bought.args.recipient).to.equal(recipient.address)
    expect(str(bought.args.result)).to.equal(str(quoted))
    await routerHoldsNothing(router, [usdc, usdt, rlusd, arco, product])
  })

  it("USDC and ArcoUSD pay without a fee; an 18-dec stablecoin's sub-unit dust goes back to the payer; quotes match", async () => {
    const { router, reserve, arco, usdc, usdt, rlusd, product, depositVault, investor } = await routerFixture()
    const sharesOf = async () => product.balanceOf(investor.address)

    let before = await sharesOf()
    const [, usdcPayment, usdcQuote] = await router.quoteBuy(usdc.address, usd6("100"), depositVault.address)
    expect(str(usdcPayment)).to.equal(str(usd6("100")))
    await router.connect(investor).buy(usdc.address, usd6("100"), depositVault.address, 0, investor.address, false)
    expect(str((await sharesOf()).sub(before))).to.equal(str(usdcQuote))

    await reserve.connect(investor).deposit(usdc.address, usd6("50"), investor.address)
    before = await sharesOf()
    const [arcoIn, , arcoQuote] = await router.quoteBuy(arco.address, usd18("50"), depositVault.address)
    expect(str(arcoIn)).to.equal(str(usd18("50")))
    await router.connect(investor).buy(arco.address, usd18("50"), depositVault.address, 0, investor.address, false)
    expect(str((await sharesOf()).sub(before))).to.equal(str(arcoQuote))

    // 100.0000005 RLUSD → 99.9000004995 ArcoUSD after 10 bps → 99.900000 USDC; 4.995e11 wei back.
    const pay = usd18("100").add(BigNumber.from("500000000000"))
    const [rlArcoIn, rlPayment, rlQuote] = await router.quoteBuy(rlusd.address, pay, depositVault.address)
    expect(str(rlPayment)).to.equal(str(usd6("99.9")))
    const arcoBefore = await arco.balanceOf(investor.address)
    before = await sharesOf()
    await router.connect(investor).buy(rlusd.address, pay, depositVault.address, rlQuote, investor.address, false)
    expect(str((await sharesOf()).sub(before))).to.equal(str(rlQuote))
    expect(str((await arco.balanceOf(investor.address)).sub(arcoBefore))).to.equal(str(rlArcoIn.sub(usd18("99.9"))))
    await routerHoldsNothing(router, [usdc, usdt, rlusd, arco, product])
  })

  it("request mode files a vault deposit request for the recipient (fulfilled by the vault admin)", async () => {
    const { router, product, depositVault, usdc, investor, recipient, admin } = await routerFixture()
    const receipt = await (
      await router.connect(investor).buy(usdc.address, usd6("200"), depositVault.address, 0, recipient.address, true)
    ).wait()
    const requestId = receipt.events.find((entry: any) => entry.event === "Bought").args.result
    const request = await depositVault.depositRequests(requestId)
    expect(request.recipient).to.equal(recipient.address)
    expect(request.sender).to.equal(router.address)
    expect(str(await product.balanceOf(recipient.address))).to.equal("0")
    await depositVault.connect(admin).fulfillDeposit(requestId)
    expect(str(await product.balanceOf(recipient.address))).to.equal(str(usd18("100")))
  })

  it("a short USDC buffer reverts the whole buy (the gate's on-chain half) and leaves the payer whole", async () => {
    const { router, usdt, depositVault, investor } = await routerFixture({ bufferUsdc: "0" })
    const before = await usdt.balanceOf(investor.address)
    await expectRevert(
      router.connect(investor).buy(usdt.address, usd6("100"), depositVault.address, 0, investor.address, false),
      "InsufficientLiquidity",
    )
    expect(str(await usdt.balanceOf(investor.address))).to.equal(str(before))
  })
})

describe("ArcoRouter guards", () => {
  it("buys only into allowed vaults paid in a base Reserve asset; only the admin allows", async () => {
    const { router, reserve, usdc, usdt, depositVault, investor, other, admin, product, productFeed, paymentFeed } = await routerFixture()
    await expectRevert(router.connect(other).setVault(depositVault.address, false), "missing role")
    const foreign = await deployFixture(18, "tWETH") // a vault paid in a non-Reserve asset
    await expectRevert(router.setVault(foreign.depositVault.address, true), "NotReserveAsset")

    // A vault paid in a fee-bearing stablecoin would let a buyer take tUSDT out of the Reserve
    // through the fee-free settleFor: refused when allowing, and re-checked on every buy.
    const usdtVault = await deployProxy("ArcoDepositVault", [
      product.address, usdt.address, productFeed.address, paymentFeed.address,
      usd6("1"), usd18("1000000"), usd18("500000"), admin.address,
    ])
    await expectRevert(router.setVault(usdtVault.address, true), "NotBaseAsset")
    await reserve.setAsset(usdc.address, assetParams({ swapFeeBps: 5 }))
    await expectRevert(
      router.connect(investor).buy(usdc.address, usd6("10"), depositVault.address, 0, investor.address, false),
      "NotBaseAsset",
    )
    await reserve.setAsset(usdc.address, assetParams())
    await expectRevert(
      router.connect(investor).buy(usdc.address, usd6("10"), foreign.depositVault.address, 0, investor.address, false),
      "VaultNotAllowed",
    )
    await router.setVault(depositVault.address, false)
    await expectRevert(
      router.connect(investor).buy(usdc.address, usd6("10"), depositVault.address, 0, investor.address, false),
      "VaultNotAllowed",
    )
  })

  it("pause, minimum shares, zero amounts and recipients, and a missing settler role all stop the buy", async () => {
    const { router, reserve, usdc, rlusd, depositVault, investor, admin } = await routerFixture()
    const buy = (overrides: { amount?: BigNumber; minShares?: BigNumber; recipient?: string; asset?: string } = {}) =>
      router
        .connect(investor)
        .buy(overrides.asset ?? usdc.address, overrides.amount ?? usd6("10"), depositVault.address, overrides.minShares ?? 0, overrides.recipient ?? investor.address, false)
    await expectRevert(buy({ minShares: usd18("5.01") }), "ADV: min shares")
    await expectRevert(buy({ amount: BigNumber.from(0) }), "ZeroAmount")
    await expectRevert(buy({ recipient: ethers.constants.AddressZero }), "ZeroAddress")
    await expectRevert(buy({ recipient: router.address }), "InvalidRecipient")
    // Less than one USDC unit after conversion: nothing to settle.
    await expectRevert(buy({ asset: rlusd.address, amount: BigNumber.from("1000") }), "ZeroAmount")
    const buySelector = router.interface.getSighash("buy")
    await router.connect(admin).pauseFn(buySelector)
    await expectRevert(buy(), "FP: fn paused")
    await router.connect(admin).unpauseFn(buySelector)
    await reserve.revokeRole(SETTLER_ROLE, router.address)
    await expectRevert(buy(), "missing role")
  })

  it("a greenlisted product mints only to a greenlisted recipient; the Router itself needs no greenlisting", async () => {
    const { router, usdc, product, depositVault, investor, other } = await routerFixture()
    await product.setGreenlistEnforced(true)
    expect(await product.isGreenlisted(router.address)).to.equal(false)
    await expectRevert(
      router.connect(investor).buy(usdc.address, usd6("10"), depositVault.address, 0, other.address, false),
      "MAC: not greenlisted",
    )
    await router.connect(investor).buy(usdc.address, usd6("10"), depositVault.address, 0, investor.address, false)
    expect(str(await product.balanceOf(investor.address))).to.equal(str(usd18("5")))
    // A request for a recipient the token would refuse could never be fulfilled: refused up front.
    const before = await usdc.balanceOf(investor.address)
    await expectRevert(
      router.connect(investor).buy(usdc.address, usd6("10"), depositVault.address, 0, other.address, true),
      "NotGreenlisted",
    )
    expect(str(await usdc.balanceOf(investor.address))).to.equal(str(before))
  })

  it("a V1 product token (no greenlistEnforced, always enforcing) is checked as enforcing in request mode", async () => {
    const { router, usdc, investor, other, admin, productFeed, paymentFeed } = await routerFixture()
    const v1 = await deployProxy("ProductTokenV1Layout", ["Arco V1", "aV1", admin.address])
    await v1.greenlist(investor.address)
    const vault = await deployProxy("ArcoDepositVault", [
      v1.address, usdc.address, productFeed.address, paymentFeed.address,
      usd6("1"), usd18("1000000"), usd18("500000"), admin.address,
    ])
    await v1.grantRole(ROLES.MINTER_ROLE, vault.address)
    await router.setVault(vault.address, true)
    await expectRevert(
      router.connect(investor).buy(usdc.address, usd6("10"), vault.address, 0, other.address, true),
      "NotGreenlisted",
    )
    await router.connect(investor).buy(usdc.address, usd6("10"), vault.address, 0, investor.address, true)
  })

  it("the admin can rescue tokens sent to the Router by mistake; nobody else can", async () => {
    const { router, usdc, investor, other } = await routerFixture()
    await usdc.connect(investor).transfer(router.address, usd6("5"))
    await expectRevert(router.connect(other).rescue(usdc.address, other.address, usd6("5")), "missing role")
    await expectRevert(router.rescue(usdc.address, ethers.constants.AddressZero, usd6("5")), "ZeroAddress")
    const before = await usdc.balanceOf(investor.address)
    await router.rescue(usdc.address, investor.address, usd6("5"))
    expect(str((await usdc.balanceOf(investor.address)).sub(before))).to.equal(str(usd6("5")))
  })
})
