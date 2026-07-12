import { expect } from "chai"
import { ethers, network } from "hardhat"
import { BigNumber, Contract } from "ethers"
import { deployFixture, deployProxy, expectRevert, parse, ROLES } from "./helpers"

const expectBn = async (actual: Promise<BigNumber> | BigNumber, expected: BigNumber) => {
  const value = await actual
  expect(value.toString()).to.equal(expected.toString())
}

async function deployFaucetAsset(
  admin: { address: string },
  faucet: Contract,
  symbol: string,
  decimals: number,
  dripAmount: BigNumber,
  dailyCap: BigNumber,
  globalCap: BigNumber,
  cooldown: number,
  enabled = true,
) {
  const token = await deployProxy("TestAssetToken", [
    `Test ${symbol}`,
    symbol,
    decimals,
    admin.address,
  ])
  await token.grantRole(ROLES.MINTER_ROLE, faucet.address)
  await faucet.configureAsset(token.address, dripAmount, dailyCap, globalCap, cooldown, enabled)
  return { token, amount: dripAmount }
}

async function faucetDripEvents(tx: Promise<{ wait: () => Promise<{ events?: any[] }> }>) {
  const receipt = await (await tx).wait()
  return (
    receipt.events?.filter((event) => event.event === "FaucetDrip").map((event) => ({
      token: event.args?.token as string,
      wallet: event.args?.wallet as string,
      amount: event.args?.amount as BigNumber,
    })) ?? []
  )
}

describe("Arco GIWA pre-production contracts", () => {
  it("binds deposit operations to the deposit vault and redemption operations to the redemption vault", async () => {
    const { asset, product, investor, recipient, depositVault, redemptionVault } =
      await deployFixture(6)

    const payment = parse("100", 6)
    await asset.connect(investor).approve(depositVault.address, payment)
    const shares = await depositVault.quoteDeposit(payment)

    await depositVault.connect(investor).deposit(payment, shares, investor.address)
    await expectBn(product.balanceOf(investor.address), shares)

    expect((depositVault as any).quoteRedeem).to.equal(undefined)
    expect((redemptionVault as any).quoteDeposit).to.equal(undefined)

    const assetsOut = await redemptionVault.quoteRedeem(shares)
    await redemptionVault.connect(investor).redeemInstant(shares, assetsOut, recipient.address)
    await expectBn(asset.balanceOf(recipient.address), assetsOut)
  })

  it("enforces required one-payment mappings across both vaults", async () => {
    const mappings = [
      ["aCAPIX", 6, "tUSDC"],
      ["iBENJI", 6, "tUSDC"],
      ["uMINT", 6, "tUSDC"],
      ["aBTC", 8, "tBTC"],
      ["aXRP", 6, "tXRP"],
      ["aETH", 18, "tWETH"],
    ] as const

    for (const [, decimals, symbol] of mappings) {
      const { asset, depositVault, redemptionVault } = await deployFixture(decimals, symbol)
      expect(await asset.symbol()).to.equal(symbol)
      expect(await depositVault.paymentToken()).to.equal(asset.address)
      expect(await redemptionVault.paymentToken()).to.equal(asset.address)
    }
  })

  it("normalizes 6, 8, and 18 decimal assets through base18 and rounds down", async () => {
    for (const decimals of [6, 8, 18]) {
      const { depositVault, redemptionVault } = await deployFixture(decimals)
      const paymentUnit = BigNumber.from(10).pow(decimals)
      await expectBn(depositVault.quoteDeposit(paymentUnit), parse("0.5", 18))
      await expectBn(
        redemptionVault.quoteRedeem(parse("0.333333333333333333", 18)),
        paymentUnit
          .mul(BigNumber.from("666666666666666666"))
          .div(BigNumber.from("1000000000000000000")),
      )
    }
  })

  it("locks redemption quotes at request time and does not recompute at fulfill", async () => {
    const { asset, product, productFeed, investor, recipient, depositVault, redemptionVault } =
      await deployFixture(6)

    await asset.connect(investor).approve(depositVault.address, parse("100", 6))
    await depositVault.connect(investor).deposit(parse("100", 6), 0, investor.address)
    const shares = await product.balanceOf(investor.address)

    const lockedAssets = await redemptionVault.quoteRedeem(shares)
    const requestTx = await redemptionVault
      .connect(investor)
      .requestRedeem(shares, lockedAssets, recipient.address)
    const receipt = await requestTx.wait()
    const requestEvent = receipt.events?.find(
      (event: any) => event.event === "ProductRedeemRequested",
    )
    const requestId = requestEvent?.args?.requestId

    await productFeed.setRoundDataSafe(BigNumber.from("100000000"))
    await redemptionVault.fulfillRedeem(requestId)
    await redemptionVault.connect(recipient).claimRedeem(requestId)

    await expectBn(asset.balanceOf(recipient.address), lockedAssets)
  })

  it("enforces caps, allowances, stale-price protection, and function-level pause", async () => {
    const { asset, productFeed, paymentFeed, investor, depositVault } = await deployFixture(6)

    await depositVault.setLimits(parse("1", 6), parse("1000000", 18), parse("1", 18))
    await asset.connect(investor).approve(depositVault.address, parse("10", 6))
    await expectRevert(
      depositVault.connect(investor).deposit(parse("10", 6), 0, investor.address),
      "vault allowance",
    )

    await depositVault.setLimits(parse("1", 6), parse("1000000", 18), parse("1000000", 18))
    await depositVault.pauseFn(depositVault.interface.getSighash("deposit"))
    await expectRevert(
      depositVault.connect(investor).deposit(parse("1", 6), 0, investor.address),
      "fn paused",
    )
    await depositVault.unpauseFn(depositVault.interface.getSighash("deposit"))

    await network.provider.send("evm_increaseTime", [3601])
    await network.provider.send("evm_mine")
    await expectRevert(depositVault.quoteDeposit(parse("1", 6)), "stale")

    await productFeed.setHealthyDiff(7200)
    await paymentFeed.setHealthyDiff(7200)
    await depositVault.connect(investor).deposit(parse("2", 6), 0, investor.address)
  })

  it("withdrawTo transfers the exact amount to the target and emits VaultWithdrawal", async () => {
    const { asset, investor, other, depositVault } = await deployFixture(6)

    await asset.connect(investor).approve(depositVault.address, parse("100", 6))
    await depositVault.connect(investor).deposit(parse("100", 6), 0, investor.address)
    await expectBn(asset.balanceOf(depositVault.address), parse("100", 6))

    const tx = await depositVault.withdrawTo(other.address, parse("40", 6))
    const receipt = await tx.wait()
    const event = receipt.events?.find((entry: any) => entry.event === "VaultWithdrawal")
    expect(event?.args?.to).to.equal(other.address)
    await expectBn(event?.args?.amount, parse("40", 6))

    await expectBn(asset.balanceOf(other.address), parse("40", 6))
    await expectBn(asset.balanceOf(depositVault.address), parse("60", 6))
  })

  it("withdrawTo is restricted to DEPOSIT_VAULT_ADMIN_ROLE", async () => {
    const { asset, investor, other, depositVault } = await deployFixture(6)

    await asset.connect(investor).approve(depositVault.address, parse("10", 6))
    await depositVault.connect(investor).deposit(parse("10", 6), 0, investor.address)

    await expectRevert(
      depositVault.connect(investor).withdrawTo(other.address, parse("1", 6)),
      "missing role",
    )
    await expectBn(asset.balanceOf(depositVault.address), parse("10", 6))
  })

  it("withdrawTo rejects the zero address", async () => {
    const { depositVault } = await deployFixture(6)
    await expectRevert(
      depositVault.withdrawTo(ethers.constants.AddressZero, parse("1", 6)),
      "ADV: to zero",
    )
  })

  it("withdrawTo respects function pause", async () => {
    const { asset, investor, other, depositVault } = await deployFixture(6)

    await asset.connect(investor).approve(depositVault.address, parse("10", 6))
    await depositVault.connect(investor).deposit(parse("10", 6), 0, investor.address)

    await depositVault.pauseFn(depositVault.interface.getSighash("withdrawTo"))
    await expectRevert(depositVault.withdrawTo(other.address, parse("1", 6)), "fn paused")

    await depositVault.unpauseFn(depositVault.interface.getSighash("withdrawTo"))
    await depositVault.withdrawTo(other.address, parse("1", 6))
    await expectBn(asset.balanceOf(other.address), parse("1", 6))
  })

  it("allows permissionless mints and transfers when product greenlist enforcement is off", async () => {
    const { admin, investor, recipient, other } = await deployFixture(6)
    const product = await deployProxy("ProductToken", ["Arco Test", "aTEST", admin.address])

    expect(await product.greenlistEnforced()).to.equal(false)
    await product.mint(investor.address, parse("10", 18))
    await product.connect(investor).transfer(recipient.address, parse("1", 18))
    await expectBn(product.balanceOf(recipient.address), parse("1", 18))

    await product.blacklist(other.address)
    await expectRevert(product.connect(investor).transfer(other.address, 1), "blacklisted")

    await product.pause()
    await expectRevert(product.connect(investor).transfer(recipient.address, 1), "PT: paused")
  })

  it("enforces greenlist checks when product greenlist enforcement is on", async () => {
    const { admin, investor, recipient } = await deployFixture(6)
    const product = await deployProxy("ProductToken", ["Arco Test", "aTEST", admin.address])

    await expectRevert(
      product.connect(investor).setGreenlistEnforced(true),
      "missing role",
    )
    const tx = await product.setGreenlistEnforced(true)
    const receipt = await tx.wait()
    const event = receipt.events?.find(
      (item: any) => item.event === "GreenlistEnforcementUpdated",
    )
    expect(event?.args?.enforced).to.equal(true)
    expect(await product.greenlistEnforced()).to.equal(true)

    await expectRevert(product.mint(investor.address, parse("1", 18)), "not greenlisted")
    await product.greenlist(investor.address)
    await product.mint(investor.address, parse("10", 18))
    await expectRevert(
      product.connect(investor).transfer(recipient.address, parse("1", 18)),
      "not greenlisted",
    )

    await product.greenlist(recipient.address)
    await product.connect(investor).transfer(recipient.address, parse("1", 18))
    await expectBn(product.balanceOf(recipient.address), parse("1", 18))
  })

  it("keeps product token transfers permissioned and blacklist-aware when greenlist enforcement is on", async () => {
    const { asset, product, investor, recipient, other, depositVault } = await deployFixture(6)

    await product.setGreenlistEnforced(true)
    await asset.connect(investor).approve(depositVault.address, parse("10", 6))
    await depositVault.connect(investor).deposit(parse("10", 6), 0, investor.address)

    await expectRevert(
      product.connect(investor).transfer(other.address, parse("1", 18)),
      "not greenlisted",
    )
    await product.connect(investor).transfer(recipient.address, parse("1", 18))
    await product.blacklist(recipient.address)
    await expectRevert(product.connect(recipient).transfer(investor.address, 1), "blacklisted")
  })

  it("supports request deposits and independent vault pauses", async () => {
    const { asset, investor, recipient, product, depositVault, redemptionVault } =
      await deployFixture(6)

    await asset.connect(investor).approve(depositVault.address, parse("20", 6))
    const tx = await depositVault
      .connect(investor)
      .requestDeposit(parse("20", 6), 0, recipient.address)
    const receipt = await tx.wait()
    const requestId = receipt.events?.find(
      (event: any) => event.event === "ProductDepositRequested",
    )?.args?.requestId

    await redemptionVault.pause()
    await depositVault.fulfillDeposit(requestId)
    await expectBn(product.balanceOf(recipient.address), parse("10", 18))
    await expectRevert(
      redemptionVault.connect(recipient).redeemInstant(parse("1", 18), 0, recipient.address),
      "FP: paused",
    )
  })

  it("pauses redeem entry paths per selector independently and unpause restores them", async () => {
    const { asset, product, investor, recipient, depositVault, redemptionVault } =
      await deployFixture(6)

    await asset.connect(investor).approve(depositVault.address, parse("100", 6))
    await depositVault.connect(investor).deposit(parse("100", 6), 0, investor.address)
    const shares = await product.balanceOf(investor.address)

    // Pausing redeemInstant blocks only the instant path; requestRedeem stays open.
    await redemptionVault.pauseFn(redemptionVault.interface.getSighash("redeemInstant"))
    await expectRevert(
      redemptionVault.connect(investor).redeemInstant(parse("1", 18), 0, recipient.address),
      "fn paused",
    )
    await redemptionVault.connect(investor).requestRedeem(shares.div(2), 0, recipient.address)

    // Pausing requestRedeem as well blocks both entry paths ("withdrawals paused").
    await redemptionVault.pauseFn(redemptionVault.interface.getSighash("requestRedeem"))
    await expectRevert(
      redemptionVault.connect(investor).requestRedeem(parse("1", 18), 0, recipient.address),
      "fn paused",
    )

    // Unpausing both selectors restores the request path end-to-end.
    await redemptionVault.unpauseFn(redemptionVault.interface.getSighash("redeemInstant"))
    await redemptionVault.unpauseFn(redemptionVault.interface.getSighash("requestRedeem"))
    await redemptionVault.connect(investor).requestRedeem(parse("1", 18), 0, recipient.address)
  })

  it("enforces faucet cooldown and caps", async () => {
    const { admin, investor, asset } = await deployFixture(6)
    const faucet = await deployProxy("TestAssetFaucet", [admin.address])
    await asset.grantRole(ROLES.MINTER_ROLE, faucet.address)
    await faucet.configureAsset(
      asset.address,
      parse("10", 6),
      parse("20", 6),
      parse("30", 6),
      3600,
      true,
    )

    // Daily-cap buckets are keyed by block.timestamp / 1 days (UTC). Pin the clock to the
    // start of a fresh day so the three drips (~2h span) can never straddle a bucket reset —
    // independent of wall-clock time and of evm_increaseTime leaked by earlier tests.
    const latest = await ethers.provider.getBlock("latest")
    const startOfNextDay = (Math.floor(latest.timestamp / 86400) + 1) * 86400
    await network.provider.send("evm_setNextBlockTimestamp", [startOfNextDay])
    await network.provider.send("evm_mine")

    await faucet.connect(investor).drip(asset.address)
    await expectRevert(faucet.connect(investor).drip(asset.address), "cooldown")
    await network.provider.send("evm_increaseTime", [3601])
    await network.provider.send("evm_mine")
    await faucet.connect(investor).drip(asset.address)

    await network.provider.send("evm_increaseTime", [3601])
    await network.provider.send("evm_mine")
    await expectRevert(faucet.connect(investor).drip(asset.address), "daily cap")
  })

  it("drips every eligible supported asset in one transaction", async () => {
    const { admin, investor } = await deployFixture(6)
    const faucet = await deployProxy("TestAssetFaucet", [admin.address])
    const usdc = await deployFaucetAsset(
      admin,
      faucet,
      "tUSDC",
      6,
      parse("10", 6),
      parse("100", 6),
      parse("1000", 6),
      3600,
    )
    const btc = await deployFaucetAsset(
      admin,
      faucet,
      "tBTC",
      8,
      parse("1", 8),
      parse("10", 8),
      parse("100", 8),
      3600,
    )
    const weth = await deployFaucetAsset(
      admin,
      faucet,
      "tWETH",
      18,
      parse("0.5", 18),
      parse("5", 18),
      parse("50", 18),
      3600,
    )

    await faucet.configureAsset(
      usdc.token.address,
      parse("10", 6),
      parse("100", 6),
      parse("1000", 6),
      3600,
      true,
    )

    expect(await faucet.supportedAssets()).to.deep.equal([
      usdc.token.address,
      btc.token.address,
      weth.token.address,
    ])

    const events = await faucetDripEvents(faucet.connect(investor).dripAll())
    expect(events.map((event) => event.token)).to.deep.equal([
      usdc.token.address,
      btc.token.address,
      weth.token.address,
    ])
    expect(events.map((event) => event.wallet)).to.deep.equal([
      investor.address,
      investor.address,
      investor.address,
    ])
    expect(events.map((event) => event.amount.toString())).to.deep.equal([
      usdc.amount.toString(),
      btc.amount.toString(),
      weth.amount.toString(),
    ])
    await expectBn(usdc.token.balanceOf(investor.address), usdc.amount)
    await expectBn(btc.token.balanceOf(investor.address), btc.amount)
    await expectBn(weth.token.balanceOf(investor.address), weth.amount)
    expect((await faucet.lastDripAt(usdc.token.address, investor.address)).gt(0)).to.equal(true)
    expect((await faucet.lastDripAt(btc.token.address, investor.address)).gt(0)).to.equal(true)
    expect((await faucet.lastDripAt(weth.token.address, investor.address)).gt(0)).to.equal(true)
  })

  it("skips ineligible dripAll assets without blocking eligible assets", async () => {
    const { admin, investor } = await deployFixture(6)
    const faucet = await deployProxy("TestAssetFaucet", [admin.address])
    const cooldownAsset = await deployFaucetAsset(
      admin,
      faucet,
      "tCOOL",
      6,
      parse("10", 6),
      parse("100", 6),
      parse("1000", 6),
      3600,
    )
    const dailyCappedAsset = await deployFaucetAsset(
      admin,
      faucet,
      "tDAY",
      6,
      parse("5", 6),
      parse("5", 6),
      parse("1000", 6),
      0,
    )
    const globallyCappedAsset = await deployFaucetAsset(
      admin,
      faucet,
      "tGLOBAL",
      6,
      parse("1", 6),
      parse("100", 6),
      parse("1", 6),
      0,
    )
    const eligibleAsset = await deployFaucetAsset(
      admin,
      faucet,
      "tOK",
      6,
      parse("2", 6),
      parse("100", 6),
      parse("1000", 6),
      0,
    )

    await faucet.connect(investor).dripAll()
    const cooldownTimestamp = await faucet.lastDripAt(
      cooldownAsset.token.address,
      investor.address,
    )
    const secondEvents = await faucetDripEvents(faucet.connect(investor).dripAll())

    expect(secondEvents.map((event) => event.token)).to.deep.equal([eligibleAsset.token.address])
    await expectBn(cooldownAsset.token.balanceOf(investor.address), cooldownAsset.amount)
    await expectBn(dailyCappedAsset.token.balanceOf(investor.address), dailyCappedAsset.amount)
    await expectBn(globallyCappedAsset.token.balanceOf(investor.address), globallyCappedAsset.amount)
    await expectBn(eligibleAsset.token.balanceOf(investor.address), eligibleAsset.amount.mul(2))
    await expectBn(
      faucet.lastDripAt(cooldownAsset.token.address, investor.address),
      cooldownTimestamp,
    )
  })

  it("blocks dripAll when the function selector is paused", async () => {
    const { admin, investor } = await deployFixture(6)
    const faucet = await deployProxy("TestAssetFaucet", [admin.address])
    await deployFaucetAsset(
      admin,
      faucet,
      "tUSDC",
      6,
      parse("10", 6),
      parse("100", 6),
      parse("1000", 6),
      3600,
    )

    await faucet.pauseFn(faucet.interface.getSighash("dripAll"))
    await expectRevert(faucet.connect(investor).dripAll(), "fn paused")
  })
})
