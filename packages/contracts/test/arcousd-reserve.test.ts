import { expect } from "chai"
import { ethers, network } from "hardhat"
import { BigNumber, Contract } from "ethers"
import { deployFixture, deployProxy, expectRevert, parse, ROLES } from "./helpers"

// ArcoUSDReserve: docs/specs/arcousd-v1.md. The MMF strategy uses a real Arco product (deployFixture:
// tUSDC payment asset, product NAV 2.0, payment feed 1.0), so allocation and recall run through the
// same deposit/redemption vaults as the live products.

const MAX = ethers.constants.MaxUint256
const SETTLER_ROLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("SETTLER_ROLE"))
const RESERVE_MANAGER_ROLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("RESERVE_MANAGER_ROLE"))
const usd6 = (value: string) => parse(value, 6)
const usd18 = (value: string) => parse(value, 18)
const str = (value: BigNumber) => value.toString()

const assetParams = (overrides: Partial<Record<string, unknown>> = {}) => ({
  depositEnabled: true,
  redeemEnabled: true,
  instantFeeBps: 0,
  depositCap: MAX,
  priceFeed: ethers.constants.AddressZero,
  maxDepegBps: 0,
  minQueued: 0,
  ...overrides,
})

let currentLens: Contract

/** A fresh Arco product paid in the reserve's tUSDC (optionally wired like the live testnet:
 *  product feed as BOTH feeds), plus its deposit and redemption vaults. */
async function usdcProduct(fixture: any, symbol: string, options: { oneToOneBug?: boolean } = {}) {
  const extra = await deployFixture(6, symbol)
  const paymentFeed = options.oneToOneBug ? extra.productFeed.address : extra.paymentFeed.address
  const dv = await deployProxy("ArcoDepositVault", [
    extra.product.address, fixture.usdc.address, extra.productFeed.address, paymentFeed,
    usd6("1"), usd18("1000000"), usd18("500000"), fixture.admin.address,
  ])
  const rv = await deployProxy("ArcoRedemptionVault", [
    extra.product.address, fixture.usdc.address, extra.productFeed.address, paymentFeed,
    usd18("1"), usd6("1000000"), fixture.admin.address,
  ])
  await extra.product.grantRole(ROLES.MINTER_ROLE, dv.address)
  await extra.product.grantRole(ROLES.BURNER_ROLE, rv.address)
  return { product: extra.product, productFeed: extra.productFeed, paymentFeed: extra.paymentFeed, dv, rv }
}

async function reserveFixture(
  options: { instantFeeBps?: number; bufferFloorBps?: number; queueMinDelay?: number } = {},
) {
  const product = await deployFixture(6)
  const { admin, investor, recipient, other, asset: usdc } = product
  const [, , , , settler, keeper, carol] = await ethers.getSigners()

  const usdt = await deployProxy("TestAssetToken", ["Test USDT", "tUSDT", 6, admin.address])
  const rlusd = await deployProxy("TestAssetToken", ["Test RLUSD", "tRLUSD", 18, admin.address])
  const arco = await deployProxy("ArcoUSD", [admin.address])
  const reserve = await deployProxy("ArcoUSDReserve", [
    arco.address,
    admin.address,
    usd18("10000000"),
    5000,
    options.bufferFloorBps ?? 3000,
    options.queueMinDelay ?? 0,
  ])
  await arco.grantRole(ROLES.MINTER_ROLE, reserve.address)
  await arco.grantRole(ROLES.BURNER_ROLE, reserve.address)
  await reserve.grantRole(SETTLER_ROLE, settler.address)
  const lensFactory = await ethers.getContractFactory("ArcoUSDReserveLens")
  const lens = await lensFactory.deploy()
  await lens.deployed()
  currentLens = lens

  const fee = options.instantFeeBps ?? 0
  await reserve.setAsset(usdc.address, assetParams({ instantFeeBps: fee }))
  await reserve.setAsset(usdt.address, assetParams({ instantFeeBps: fee }))
  await reserve.setAsset(rlusd.address, assetParams({ instantFeeBps: fee }))

  for (const user of [investor, recipient, other, settler, keeper, carol]) {
    await usdc.mint(user.address, usd6("100000"))
    await usdt.mint(user.address, usd6("100000"))
    await rlusd.mint(user.address, usd18("100000"))
    for (const token of [usdc, usdt, rlusd]) await token.connect(user).approve(reserve.address, MAX)
    await arco.connect(user).approve(reserve.address, MAX)
  }
  return { ...product, usdc, usdt, rlusd, arco, reserve, lens, settler, keeper, carol }
}

async function backingAndLiabilities(reserve: Contract) {
  const [backing, navOk] = await currentLens.totalBacking(reserve.address)
  return {
    backing: backing as BigNumber,
    navOk: navOk as boolean,
    liabilities: (await currentLens.totalLiabilities(reserve.address)) as BigNumber,
  }
}

async function queuedId(tx: Promise<any>) {
  const receipt = await (await tx).wait()
  const event = receipt.events?.find((entry: any) => entry.event === "RedeemQueued")
  return event?.args?.requestId as BigNumber | undefined
}

describe("ArcoUSDReserve deposits", () => {
  it("issues ArcoUSD 1:1 across 6- and 18-decimal stablecoins", async () => {
    const { reserve, arco, usdc, usdt, rlusd, investor } = await reserveFixture()
    await reserve.connect(investor).deposit(usdc.address, usd6("100"), investor.address)
    await reserve.connect(investor).deposit(usdt.address, usd6("50.5"), investor.address)
    await reserve.connect(investor).deposit(rlusd.address, usd18("25"), investor.address)
    expect(str(await arco.balanceOf(investor.address))).to.equal(str(usd18("175.5")))
    const { backing, liabilities } = await backingAndLiabilities(reserve)
    expect(str(backing)).to.equal(str(liabilities))
  })

  it("refuses disabled assets, zero amounts, caps, the mint cap and a depegged asset", async () => {
    const { reserve, usdc, usdt, investor, admin } = await reserveFixture()
    await expectRevert(reserve.connect(investor).deposit(usdc.address, 0, investor.address), "ZeroAmount")
    await reserve.setAsset(usdt.address, assetParams({ depositEnabled: false }))
    await expectRevert(reserve.connect(investor).deposit(usdt.address, 1, investor.address), "DepositDisabled")
    await reserve.setAsset(usdc.address, assetParams({ depositCap: usd6("150") }))
    await reserve.connect(investor).deposit(usdc.address, usd6("100"), investor.address)
    await expectRevert(reserve.connect(investor).deposit(usdc.address, usd6("51"), investor.address), "DepositCap")
    await reserve.setAsset(usdc.address, assetParams())
    await reserve.setParams(usd18("120"), 5000, 3000, 0)
    await expectRevert(reserve.connect(investor).deposit(usdc.address, usd6("21"), investor.address), "MintCap")
    await reserve.setParams(usd18("10000000"), 5000, 3000, 0)

    // Depeg guard: a USD price feed at 0.95 with a 50 bps band refuses the deposit; 1.003 passes.
    const feed = await deployProxy("ProductPriceFeed", [8, BigNumber.from("95000000"), 3600, 1, BigNumber.from("1000000000"), 0, admin.address])
    await reserve.setAsset(usdt.address, assetParams({ priceFeed: feed.address, maxDepegBps: 50 }))
    await expectRevert(reserve.connect(investor).deposit(usdt.address, usd6("1"), investor.address), "Depeg")
    await feed.setRoundDataSafe(BigNumber.from("100300000"))
    await reserve.connect(investor).deposit(usdt.address, usd6("1"), investor.address)
  })
})

describe("ArcoUSDReserve redemptions", () => {
  it("pays Instant when the free buffer covers it, charges the fee and keeps sub-unit dust with the holder", async () => {
    const { reserve, arco, usdc, investor, recipient } = await reserveFixture({ instantFeeBps: 10 })
    await reserve.connect(investor).deposit(usdc.address, usd6("1000"), investor.address)
    const before = await usdc.balanceOf(recipient.address)
    // 100.0000005 ArcoUSD → 100.000000 USDC gross; the 5e11 wei of dust is not taken.
    const amount = usd18("100").add(BigNumber.from("500000000000"))
    await reserve.connect(investor).redeem(usdc.address, amount, recipient.address, usd6("99.9"))
    expect(str((await usdc.balanceOf(recipient.address)).sub(before))).to.equal(str(usd6("99.9")))
    // Only the 100 ArcoUSD that maps to whole USDC units is taken; the dust stays in the wallet.
    expect(str(await arco.balanceOf(investor.address))).to.equal(str(usd18("900")))
    // The 0.1 USDC fee stays in the reserve as surplus.
    const { backing, liabilities } = await backingAndLiabilities(reserve)
    expect(str(backing.sub(liabilities))).to.equal(str(usd18("0.1")))
    await expectRevert(
      reserve.connect(investor).redeem(usdc.address, usd18("10"), recipient.address, usd6("10")),
      "MinOut",
    )
  })

  it("queues when the asset's buffer is short, keeps FIFO, and pushes payouts to wallets", async () => {
    const { reserve, arco, usdc, usdt, investor, recipient, other, carol, keeper } = await reserveFixture()
    // Reserve holds only USDT; investor wants USDC out.
    await reserve.connect(investor).deposit(usdt.address, usd6("100"), investor.address)
    const first = await queuedId(reserve.connect(investor).redeem(usdc.address, usd18("100"), recipient.address, 0))
    expect(str(first!)).to.equal("1")
    expect(str(await reserve.queuedAssets(usdc.address))).to.equal(str(usd6("100")))
    expect(str(await arco.balanceOf(reserve.address))).to.equal(str(usd18("100"))) // escrowed, not burned
    expect(str(await currentLens.totalLiabilities(reserve.address))).to.equal(str(usd18("100")))

    // A later 30 USDC deposit cannot be used to jump the queue.
    await reserve.connect(other).deposit(usdc.address, usd6("30"), other.address)
    expect(str(await reserve.availableLiquidity(usdc.address))).to.equal("0")
    await expectRevert(
      reserve.connect(other).redeemInstantOnly(usdc.address, usd18("20"), other.address, 0),
      "InsufficientLiquidity",
    )
    const second = await queuedId(reserve.connect(other).redeem(usdc.address, usd18("20"), other.address, 0))
    expect(str(second!)).to.equal("2")

    // 50 USDC is not enough for the head (100): nothing is paid, nothing is skipped.
    await reserve.connect(carol).deposit(usdc.address, usd6("20"), carol.address)
    await reserve.connect(keeper).processQueue(usdc.address, 10)
    expect((await reserve.getRequest(1)).status).to.equal(1)
    expect((await reserve.getRequest(2)).status).to.equal(1)

    // Enough liquidity: anyone can push both payouts, in order, straight to the wallets.
    await reserve.connect(carol).deposit(usdc.address, usd6("100"), carol.address)
    const recipientBefore = await usdc.balanceOf(recipient.address)
    const otherBefore = await usdc.balanceOf(other.address)
    await reserve.connect(keeper).processQueue(usdc.address, 10)
    expect(str((await usdc.balanceOf(recipient.address)).sub(recipientBefore))).to.equal(str(usd6("100")))
    expect(str((await usdc.balanceOf(other.address)).sub(otherBefore))).to.equal(str(usd6("20")))
    expect((await reserve.getRequest(1)).status).to.equal(2)
    expect((await reserve.getRequest(2)).status).to.equal(2)
    expect(str(await reserve.queuedAssets(usdc.address))).to.equal("0")
    expect(str(await arco.balanceOf(reserve.address))).to.equal("0") // escrow burned on payout
    expect(str(await reserve.queueHead(usdc.address))).to.equal("2")
    const { backing, liabilities } = await backingAndLiabilities(reserve)
    expect(str(backing)).to.equal(str(liabilities))
  })

  it("queues are per asset: a USDT shortfall never blocks USDC", async () => {
    const { reserve, usdc, usdt, investor, other } = await reserveFixture()
    await reserve.connect(investor).deposit(usdc.address, usd6("100"), investor.address)
    await queuedId(reserve.connect(investor).redeem(usdt.address, usd18("50"), investor.address, 0))
    expect(str(await reserve.queuedAssets(usdt.address))).to.equal(str(usd6("50")))
    const before = await usdc.balanceOf(other.address)
    await reserve.connect(investor).redeemInstantOnly(usdc.address, usd18("40"), other.address, 0)
    expect(str((await usdc.balanceOf(other.address)).sub(before))).to.equal(str(usd6("40")))
  })

  it("the owner can cancel a queued request and the queue skips it", async () => {
    const { reserve, arco, usdc, usdt, investor, other, keeper } = await reserveFixture()
    await reserve.connect(investor).deposit(usdt.address, usd6("100"), investor.address)
    const id = await queuedId(reserve.connect(investor).redeem(usdc.address, usd18("60"), investor.address, 0))
    await reserve.connect(other).deposit(usdt.address, usd6("10"), other.address)
    const next = await queuedId(reserve.connect(other).redeem(usdc.address, usd18("10"), other.address, 0))
    await expectRevert(reserve.connect(other).cancelRedeem(id!), "NotOwner")
    await reserve.connect(investor).cancelRedeem(id!)
    expect(str(await arco.balanceOf(investor.address))).to.equal(str(usd18("100")))
    expect(str(await reserve.queuedAssets(usdc.address))).to.equal(str(usd6("10")))
    await expectRevert(reserve.connect(investor).cancelRedeem(id!), "NotCancellable")
    await reserve.connect(keeper).deposit(usdc.address, usd6("10"), keeper.address)
    await reserve.connect(keeper).processQueue(usdc.address, 5)
    expect((await reserve.getRequest(id!)).status).to.equal(3) // Cancelled
    expect((await reserve.getRequest(next!)).status).to.equal(2) // Paid
  })

  it("a recipient blocked by the stablecoin is marked failed and never stalls the queue", async () => {
    const { reserve, arco, usdt, investor, recipient, other, keeper } = await reserveFixture()
    const factory = await ethers.getContractFactory("TestBlocklistStable")
    const blockUsd = await factory.deploy("Blocklist USD", "bUSD", 6)
    await blockUsd.deployed()
    await reserve.setAsset(blockUsd.address, assetParams())
    await reserve.connect(investor).deposit(usdt.address, usd6("30"), investor.address)
    const blockedId = await queuedId(reserve.connect(investor).redeem(blockUsd.address, usd18("20"), recipient.address, 0))
    const okId = await queuedId(reserve.connect(investor).redeem(blockUsd.address, usd18("10"), other.address, 0))
    await blockUsd.setBlocked(recipient.address, true)
    await blockUsd.mint(keeper.address, usd6("30"))
    await blockUsd.connect(keeper).approve(reserve.address, MAX)
    await reserve.connect(keeper).deposit(blockUsd.address, usd6("30"), keeper.address)

    await reserve.connect(keeper).processQueue(blockUsd.address, 10)
    expect((await reserve.getRequest(blockedId!)).status).to.equal(4) // PayoutFailed
    expect((await reserve.getRequest(okId!)).status).to.equal(2) // Paid
    expect(str(await blockUsd.balanceOf(other.address))).to.equal(str(usd6("10")))
    // The owner takes the escrowed ArcoUSD back.
    const before = await arco.balanceOf(investor.address)
    await reserve.connect(investor).cancelRedeem(blockedId!)
    expect(str((await arco.balanceOf(investor.address)).sub(before))).to.equal(str(usd18("20")))
  })

  it("redeemWithPermit pulls ArcoUSD with an EIP-2612 signature", async () => {
    const { reserve, arco, usdc, investor, recipient } = await reserveFixture()
    await reserve.connect(investor).deposit(usdc.address, usd6("10"), investor.address)
    await arco.connect(investor).approve(reserve.address, 0)
    const { chainId } = await ethers.provider.getNetwork()
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600
    const value = usd18("4")
    const signature = await investor._signTypedData(
      { name: "ArcoUSD", version: "1", chainId, verifyingContract: arco.address },
      {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { owner: investor.address, spender: reserve.address, value, nonce: await arco.nonces(investor.address), deadline },
    )
    const { v, r, s } = ethers.utils.splitSignature(signature)
    const before = await usdc.balanceOf(recipient.address)
    await reserve.connect(investor).redeemWithPermit(usdc.address, value, recipient.address, 0, deadline, v, r, s)
    expect(str((await usdc.balanceOf(recipient.address)).sub(before))).to.equal(str(usd6("4")))
  })
})

describe("ArcoUSDReserve settlement", () => {
  it("settleFor burns the settler's ArcoUSD, pays the asset, and only uses the free buffer", async () => {
    const { reserve, arco, usdc, usdt, investor, settler, depositVault, other } = await reserveFixture()
    await reserve.connect(settler).deposit(usdt.address, usd6("100"), settler.address) // buy with USDT
    await expectRevert(reserve.connect(other).settleFor(usdc.address, usd18("1"), other.address), "missing role")
    await expectRevert(
      reserve.connect(settler).settleFor(usdc.address, usd18("50"), depositVault.address),
      "InsufficientLiquidity",
    )
    await reserve.connect(investor).deposit(usdc.address, usd6("80"), investor.address)
    // A queued USDC request (30) ranks ahead of settlement.
    await reserve.connect(investor).redeem(usdc.address, usd18("30"), investor.address, 0) // Instant: 80 free
    await reserve.connect(investor).deposit(usdt.address, usd6("100"), investor.address)
    await queuedId(reserve.connect(investor).redeem(usdc.address, usd18("70"), investor.address, 0)) // 50 free → queued
    expect(str(await reserve.availableForSettlement(usdc.address))).to.equal("0")
    await expectRevert(
      reserve.connect(settler).settleFor(usdc.address, usd18("1"), depositVault.address),
      "InsufficientLiquidity",
    )
    await reserve.connect(other).deposit(usdc.address, usd6("100"), other.address) // free = 150 − 70 = 80
    const supplyBefore = await arco.totalSupply()
    await reserve.connect(settler).settleFor(usdc.address, usd18("50"), depositVault.address)
    expect(str(supplyBefore.sub(await arco.totalSupply()))).to.equal(str(usd18("50")))
    expect(str(await reserve.availableForSettlement(usdc.address))).to.equal(str(usd6("30")))
  })
})

describe("ArcoUSDReserve MMF strategies", () => {
  async function withStrategy(options: { bufferFloorBps?: number } = {}) {
    const fixture = await reserveFixture(options)
    const { reserve, depositVault, redemptionVault, usdc, investor } = fixture
    await reserve.addStrategy(depositVault.address, redemptionVault.address, usd18("1000000"))
    await reserve.connect(investor).deposit(usdc.address, usd6("1000"), investor.address)
    return fixture
  }

  it("addStrategy checks that both vaults are one product paid in a supported asset", async () => {
    const { reserve, depositVault, redemptionVault } = await reserveFixture()
    const btc = await deployFixture(8) // tBTC product: payment asset not supported by the reserve
    await expectRevert(reserve.addStrategy(btc.depositVault.address, btc.redemptionVault.address, 1), "UnsupportedAsset")
    const otherUsd = await deployFixture(6) // another tUSDC product with its own token and feed
    await expectRevert(reserve.addStrategy(depositVault.address, otherUsd.redemptionVault.address, 1), "StrategyMismatch")
    await reserve.addStrategy(depositVault.address, redemptionVault.address, 1)
    expect(str(await reserve.strategyCount())).to.equal("1")
  })

  it("allocate buys the product at NAV and backing still covers every ArcoUSD", async () => {
    const { reserve, product, usdc, other } = await withStrategy()
    await expectRevert(reserve.connect(other).allocate(0, usd6("400"), 0), "missing role")
    await reserve.allocate(0, usd6("400"), 0) // NAV 2.0 → 200 shares
    expect(str(await product.balanceOf(reserve.address))).to.equal(str(usd18("200")))
    const [value, ok] = await reserve.strategyValue(0)
    expect(ok).to.equal(true)
    expect(str(value)).to.equal(str(usd18("400")))
    expect(str(await reserve.bufferBalance(usdc.address))).to.equal(str(usd6("600")))
    expect(str(await currentLens.mmfAllocationBps(reserve.address))).to.equal("4000")
    const { backing, liabilities, navOk } = await backingAndLiabilities(reserve)
    expect(navOk).to.equal(true)
    expect(str(backing)).to.equal(str(liabilities))
  })

  it("allocate respects the buffer floor, the strategy cap and the free buffer", async () => {
    const { reserve, usdc, usdt, investor } = await withStrategy({ bufferFloorBps: 3000 })
    await expectRevert(reserve.allocate(0, usd6("800"), 0), "BufferFloor") // 200 / 1000 < 30%
    await reserve.setStrategy(0, true, usd18("300"))
    await expectRevert(reserve.allocate(0, usd6("400"), 0), "StrategyCap")
    await reserve.setStrategy(0, true, usd18("1000000"))
    // Queued USDC payouts are not allocatable.
    await reserve.connect(investor).deposit(usdt.address, usd6("2000"), investor.address)
    await reserve.connect(investor).redeem(usdc.address, usd18("1000"), investor.address, 0) // instant (1000 free)
    await queuedId(reserve.connect(investor).redeem(usdc.address, usd18("10"), investor.address, 0))
    await expectRevert(reserve.allocate(0, usd6("1"), 0), "InsufficientLiquidity")
    await reserve.setStrategy(0, false, usd18("1000000"))
    await expectRevert(reserve.allocate(0, usd6("1"), 0), "StrategyDisabled")
  })

  it("recallInstant and requestRecall → fulfill → claimRecall return the buffer", async () => {
    const { reserve, usdc, redemptionVault, keeper } = await withStrategy()
    await reserve.allocate(0, usd6("400"), 0)
    await reserve.recallInstant(0, usd18("50"), usd6("100"))
    expect(str(await reserve.bufferBalance(usdc.address))).to.equal(str(usd6("700")))

    const receipt = await (await reserve.requestRecall(0, usd18("50"), 0)).wait()
    const vaultRequestId = receipt.events?.find((event: any) => event.event === "RecallRequested")?.args?.vaultRequestId
    expect(str(await reserve.recallRequests(0, vaultRequestId))).to.equal(str(usd6("100")))
    expect(str(await reserve.pendingRecall(0))).to.equal(str(usd18("100")))
    let state = await backingAndLiabilities(reserve)
    expect(str(state.backing)).to.equal(str(state.liabilities)) // value moved holdings → pending

    await expectRevert(reserve.connect(keeper).claimRecall(0, vaultRequestId), "ARV: not fulfilled")
    await redemptionVault.fulfillRedeem(vaultRequestId)
    await reserve.connect(keeper).claimRecall(0, vaultRequestId) // permissionless
    expect(str(await reserve.bufferBalance(usdc.address))).to.equal(str(usd6("800")))
    expect(str(await reserve.pendingRecall(0))).to.equal("0")
    await expectRevert(reserve.connect(keeper).claimRecall(0, vaultRequestId), "UnknownRecall")
    state = await backingAndLiabilities(reserve)
    expect(str(state.backing)).to.equal(str(state.liabilities))
  })

  it("acknowledgeRecallPaid only lowers reported backing and is manager-only", async () => {
    const { reserve, other } = await withStrategy()
    await reserve.allocate(0, usd6("400"), 0)
    const receipt = await (await reserve.requestRecall(0, usd18("25"), 0)).wait()
    const vaultRequestId = receipt.events?.find((event: any) => event.event === "RecallRequested")?.args?.vaultRequestId
    await expectRevert(reserve.connect(other).acknowledgeRecallPaid(0, vaultRequestId), "missing role")
    const before = (await currentLens.totalBacking(reserve.address))[0]
    await reserve.acknowledgeRecallPaid(0, vaultRequestId)
    const after = (await currentLens.totalBacking(reserve.address))[0]
    expect(str(before.sub(after))).to.equal(str(usd18("50")))
    await expectRevert(reserve.acknowledgeRecallPaid(0, vaultRequestId), "NotPending")
  })

  it("an acknowledged recall that the vault later fulfils can still be claimed (never stranded)", async () => {
    const { reserve, usdc, redemptionVault, keeper } = await withStrategy()
    await reserve.allocate(0, usd6("400"), 0)
    const receipt = await (await reserve.requestRecall(0, usd18("25"), 0)).wait()
    const vaultRequestId = receipt.events?.find((event: any) => event.event === "RecallRequested")?.args?.vaultRequestId
    await reserve.acknowledgeRecallPaid(0, vaultRequestId)
    expect(await reserve.recallOpen(0, vaultRequestId)).to.equal(true)
    await redemptionVault.fulfillRedeem(vaultRequestId)
    const before = await reserve.bufferBalance(usdc.address)
    await reserve.connect(keeper).claimRecall(0, vaultRequestId)
    expect(str((await reserve.bufferBalance(usdc.address)).sub(before))).to.equal(str(usd6("50")))
    expect(str(await reserve.pendingRecall(0))).to.equal("0")
    expect(await reserve.recallOpen(0, vaultRequestId)).to.equal(false)
  })

  it("a stale NAV on another strategy is reported, not trusted, and blocks allocation", async () => {
    const fixture = await withStrategy()
    const { reserve, productFeed, paymentFeed } = fixture
    const { dv, rv } = await usdcProduct(fixture, "tUSDC2")
    await reserve.addStrategy(dv.address, rv.address, usd18("1000000"))
    await reserve.allocate(1, usd6("100"), 0)

    await network.provider.send("evm_increaseTime", [7200])
    await network.provider.send("evm_mine", [])
    // Strategy 0's feeds are refreshed, strategy 1's are not.
    await productFeed.setRoundDataSafe(BigNumber.from("200000000"))
    await paymentFeed.setRoundDataSafe(BigNumber.from("100000000"))
    const [value, ok] = await reserve.strategyValue(1)
    expect(ok).to.equal(false)
    expect(str(value)).to.equal("0")
    expect((await currentLens.totalBacking(reserve.address))[1]).to.equal(false)
    // Strategy 0 itself is priceable, so the revert is the Reserve's own NAV guard.
    await expectRevert(reserve.allocate(0, usd6("10"), 0), "NavUnavailable")
  })

  it("rejects a second strategy on the same product token (no double-counted shares)", async () => {
    const { reserve, depositVault, redemptionVault } = await withStrategy()
    await expectRevert(
      reserve.addStrategy(depositVault.address, redemptionVault.address, 1),
      "DuplicateStrategy",
    )
  })

  it("allocate never trusts the vault: no shares, or a mispriced quote, reverts", async () => {
    const fixture = await withStrategy()
    const { reserve, usdc } = fixture
    // A vault that keeps the USDC, mints nothing and claims 1e30 shares.
    const other = await deployFixture(6, "tUSDC3")
    const factory = await ethers.getContractFactory("TestRogueProductVault")
    const rogue = await factory.deploy(usdc.address, other.product.address, other.productFeed.address)
    await rogue.deployed()
    await reserve.addStrategy(rogue.address, rogue.address, usd18("1000000"))
    await expectRevert(reserve.allocate(1, usd6("100"), 0), "SharesNotReceived")

    // A real product wired like the live testnet (product feed used as BOTH feeds, NAV 2.0):
    // 100 USDC buys 100 shares worth 200 — the 1:1 quote bug is caught, not booked as profit.
    const { dv, rv } = await usdcProduct(fixture, "tUSDC4", { oneToOneBug: true })
    await reserve.addStrategy(dv.address, rv.address, usd18("1000000"))
    await expectRevert(reserve.allocate(2, usd6("100"), 0), "AllocationMispriced")
  })

  it("the buffer floor is measured on the allocated asset's own backing", async () => {
    const { reserve, usdt, investor } = await withStrategy({ bufferFloorBps: 3000 })
    // USDT deposits neither block nor loosen the USDC floor: USDC backing is 1000 either way.
    await reserve.connect(investor).deposit(usdt.address, usd6("2000"), investor.address)
    await reserve.allocate(0, usd6("700"), 0) // USDC free 300 / USDC backing 1000 = 30%: allowed
    await expectRevert(reserve.allocate(0, usd6("1"), 0), "BufferFloor") // 299 / 1000 < 30%
  })

  it("recalls never trust the vault: underpaid, unburned, mispriced or misdirected recalls revert", async () => {
    const fixture = await withStrategy()
    const { reserve, usdc, admin } = fixture
    const real = await usdcProduct(fixture, "tUSDC5")
    const factory = await ethers.getContractFactory("TestRogueRedemptionVault")
    const rogue = await factory.deploy(usdc.address, real.product.address, real.productFeed.address)
    await rogue.deployed()
    await real.product.grantRole(ROLES.BURNER_ROLE, rogue.address)
    await usdc.mint(rogue.address, usd6("1000"))
    await reserve.addStrategy(real.dv.address, rogue.address, usd18("1000000"))
    await reserve.allocate(1, usd6("200"), 0) // NAV 2.0 → 100 shares
    // Pays 1 USDC when at least 10 was required.
    await rogue.setInstant(usd6("1"), usd18("10"))
    await expectRevert(reserve.recallInstant(1, usd18("10"), usd6("10")), "RecallNotReceived")
    // Pays the right amount but burns no shares (the Reserve would keep them AND the cash).
    await rogue.setInstant(usd6("20"), 0)
    await expectRevert(reserve.recallInstant(1, usd18("10"), 0), "RecallMispriced")
    // Burns the shares but pays half their NAV.
    await rogue.setInstant(usd6("10"), usd18("10"))
    await expectRevert(reserve.recallInstant(1, usd18("10"), 0), "RecallMispriced")
    // Request path: nothing recorded, paid to someone else, or shares not burned.
    await rogue.setRequest(reserve.address, 0, usd18("10"))
    await expectRevert(reserve.requestRecall(1, usd18("10"), 0), "EmptyRecall")
    await rogue.setRequest(admin.address, usd6("20"), usd18("10"))
    await expectRevert(reserve.requestRecall(1, usd18("10"), 0), "RecallMispriced")
    await rogue.setRequest(reserve.address, usd6("20"), 0)
    await expectRevert(reserve.requestRecall(1, usd18("10"), 0), "RecallMispriced")
    // Honest figures pass.
    await rogue.setRequest(reserve.address, usd6("20"), usd18("10"))
    await reserve.requestRecall(1, usd18("10"), 0)
    expect(str(await reserve.pendingRecall(1))).to.equal(str(usd18("20")))
  })

  it("a reserve asset or ArcoUSD can never double as a strategy product, and vice versa", async () => {
    const fixture = await withStrategy()
    const { reserve, product, usdc } = fixture
    await expectRevert(reserve.setAsset(product.address, assetParams()), "InvalidAsset")
    const factory = await ethers.getContractFactory("TestRogueProductVault")
    const rogue = await factory.deploy(usdc.address, fixture.usdt.address, fixture.productFeed.address)
    await rogue.deployed()
    await expectRevert(reserve.addStrategy(rogue.address, rogue.address, 1), "InvalidAsset")
  })
})

describe("ArcoUSDReserve admin and pause", () => {
  it("only the admin configures; bad parameters are refused", async () => {
    const { reserve, usdc, other, arco } = await reserveFixture()
    await expectRevert(reserve.connect(other).setAsset(usdc.address, assetParams()), "missing role")
    await expectRevert(reserve.setAsset(usdc.address, assetParams({ instantFeeBps: 101 })), "InvalidParams")
    await expectRevert(reserve.setAsset(arco.address, assetParams()), "InvalidAsset")
    await expectRevert(reserve.setParams(1, 10001, 0, 0), "InvalidParams")
    await expectRevert(reserve.setParams(1, 0, 0, 8 * 24 * 3600), "InvalidParams")
    await expectRevert(reserve.connect(other).setParams(1, 0, 0, 0), "missing role")
    expect((await reserve.getAssets()).length).to.equal(3)
    expect(await reserve.hasRole(RESERVE_MANAGER_ROLE, other.address)).to.equal(false)
  })

  it("pause stops entry points but never the way back to escrowed funds", async () => {
    const { reserve, usdc, usdt, investor, admin } = await reserveFixture()
    await reserve.connect(investor).deposit(usdt.address, usd6("10"), investor.address)
    const id = await queuedId(reserve.connect(investor).redeem(usdc.address, usd18("10"), investor.address, 0))
    await reserve.connect(admin).pause()
    await expectRevert(reserve.connect(investor).deposit(usdc.address, 1, investor.address), "FP: paused")
    await expectRevert(reserve.connect(investor).redeem(usdt.address, 1, investor.address, 0), "FP: paused")
    await expectRevert(reserve.processQueue(usdc.address, 1), "FP: paused")
    await reserve.connect(investor).cancelRedeem(id!) // still open
    await reserve.connect(admin).unpause()

    const depositSelector = reserve.interface.getSighash("deposit")
    await reserve.connect(admin).pauseFn(depositSelector)
    await expectRevert(reserve.connect(investor).deposit(usdc.address, 1, investor.address), "FP: fn paused")
    await reserve.connect(investor).redeem(usdt.address, usd18("1"), investor.address, 0) // other paths run
  })
})

describe("ArcoUSDReserve queue hardening", () => {
  it("queued (fee-free) requests only pay after queueMinDelay: no same-block fee bypass", async () => {
    const { reserve, usdc, usdt, investor, other, keeper } = await reserveFixture({ instantFeeBps: 100, queueMinDelay: 600 })
    await reserve.connect(other).deposit(usdc.address, usd6("100"), other.address)
    await reserve.connect(investor).deposit(usdt.address, usd6("200"), investor.address)
    // 100 is available now (paid Instant, 1% fee); only the 100 shortfall is queued.
    const id = await queuedId(reserve.connect(investor).redeem(usdc.address, usd18("200"), investor.address, 0))
    expect(str((await reserve.getRequest(id!)).assetAmount)).to.equal(str(usd6("100")))
    // Fill the shortfall and try to settle the queue straight away.
    await reserve.connect(investor).deposit(usdc.address, usd6("100"), investor.address)
    await reserve.connect(keeper).processQueue(usdc.address, 5)
    expect((await reserve.getRequest(id!)).status).to.equal(1) // still Queued
    await network.provider.send("evm_increaseTime", [601])
    await network.provider.send("evm_mine", [])
    await reserve.connect(keeper).processQueue(usdc.address, 5)
    expect((await reserve.getRequest(id!)).status).to.equal(2) // Paid, fee-free, after waiting
  })

  it("a token-wide failure (Reserve blocked / token paused) stops the queue without failing anyone", async () => {
    const { reserve, usdt, investor, recipient, keeper } = await reserveFixture()
    const factory = await ethers.getContractFactory("TestBlocklistStable")
    const blockUsd = await factory.deploy("Blocklist USD", "bUSD", 6)
    await blockUsd.deployed()
    await reserve.setAsset(blockUsd.address, assetParams())
    await reserve.connect(investor).deposit(usdt.address, usd6("30"), investor.address)
    const id = await queuedId(reserve.connect(investor).redeem(blockUsd.address, usd18("20"), recipient.address, 0))
    await blockUsd.mint(keeper.address, usd6("30"))
    await blockUsd.connect(keeper).approve(reserve.address, MAX)
    await reserve.connect(keeper).deposit(blockUsd.address, usd6("30"), keeper.address)

    await blockUsd.setBlocked(reserve.address, true)
    await reserve.connect(keeper).processQueue(blockUsd.address, 5)
    expect((await reserve.getRequest(id!)).status).to.equal(1) // keeps its place
    expect(str(await reserve.queuedAssets(blockUsd.address))).to.equal(str(usd6("20")))
    expect(str(await reserve.queueHead(blockUsd.address))).to.equal("0")

    await blockUsd.setBlocked(reserve.address, false)
    await reserve.connect(keeper).processQueue(blockUsd.address, 5)
    expect((await reserve.getRequest(id!)).status).to.equal(2)
    expect(str(await blockUsd.balanceOf(recipient.address))).to.equal(str(usd6("20")))
  })

  it("pays tokens that return no data on every path", async () => {
    const { reserve, usdt, investor, recipient, keeper } = await reserveFixture()
    const factory = await ethers.getContractFactory("TestNoReturnStable")
    const nusd = await factory.deploy()
    await nusd.deployed()
    await reserve.setAsset(nusd.address, assetParams())
    await nusd.mint(keeper.address, usd6("100"))
    await nusd.connect(keeper).approve(reserve.address, MAX)
    await reserve.connect(keeper).deposit(nusd.address, usd6("50"), keeper.address)
    await reserve.connect(keeper).redeem(nusd.address, usd18("10"), recipient.address, 0) // Instant
    await reserve.connect(investor).deposit(usdt.address, usd6("100"), investor.address)
    const id = await queuedId(reserve.connect(investor).redeem(nusd.address, usd18("60"), recipient.address, 0))
    await reserve.connect(keeper).deposit(nusd.address, usd6("50"), keeper.address)
    await reserve.connect(keeper).processQueue(nusd.address, 5)
    expect((await reserve.getRequest(id!)).status).to.equal(2)
    expect(str(await nusd.balanceOf(recipient.address))).to.equal(str(usd6("70")))
  })

  it("an owner blacklisted on ArcoUSD after queuing is not paid; a blacklisted recipient cannot queue", async () => {
    const { reserve, arco, usdc, usdt, investor, other, keeper, admin } = await reserveFixture()
    await reserve.connect(investor).deposit(usdt.address, usd6("100"), investor.address)
    const id = await queuedId(reserve.connect(investor).redeem(usdc.address, usd18("50"), investor.address, 0))
    await arco.connect(admin).blacklist(investor.address)
    await reserve.connect(keeper).deposit(usdc.address, usd6("100"), keeper.address)
    const before = await usdc.balanceOf(investor.address)
    await reserve.connect(keeper).processQueue(usdc.address, 5)
    expect((await reserve.getRequest(id!)).status).to.equal(4) // PayoutFailed
    expect(str(await usdc.balanceOf(investor.address))).to.equal(str(before))
    // Escrow stays frozen while blacklisted.
    await expectRevert(reserve.connect(investor).cancelRedeem(id!), "MAC: blacklisted")
    await arco.connect(admin).unBlacklist(investor.address)
    await reserve.connect(investor).cancelRedeem(id!)

    await arco.connect(admin).blacklist(other.address)
    await expectRevert(
      reserve.connect(keeper).redeem(usdc.address, usd18("1"), other.address, 0),
      "Blacklisted",
    )
  })

  it("refuses dust requests into the queue (minQueued)", async () => {
    const { reserve, usdc, usdt, investor } = await reserveFixture()
    await reserve.setAsset(usdc.address, assetParams({ minQueued: usd6("10") }))
    await reserve.connect(investor).deposit(usdt.address, usd6("100"), investor.address)
    await expectRevert(
      reserve.connect(investor).redeem(usdc.address, usd18("0.000001"), investor.address, 0),
      "BelowQueueMinimum",
    )
    await queuedId(reserve.connect(investor).redeem(usdc.address, usd18("10"), investor.address, 0))
  })

  it("maxCount bounds the work and cancelled entries are stepped over", async () => {
    const { reserve, usdc, usdt, investor, other, carol, keeper } = await reserveFixture()
    for (const user of [investor, other, carol]) await reserve.connect(user).deposit(usdt.address, usd6("10"), user.address)
    const a = await queuedId(reserve.connect(investor).redeem(usdc.address, usd18("10"), investor.address, 0))
    const b = await queuedId(reserve.connect(other).redeem(usdc.address, usd18("10"), other.address, 0))
    const c = await queuedId(reserve.connect(carol).redeem(usdc.address, usd18("10"), carol.address, 0))
    await reserve.connect(other).cancelRedeem(b!)
    await reserve.connect(keeper).deposit(usdc.address, usd6("30"), keeper.address)
    await reserve.connect(keeper).processQueue(usdc.address, 1)
    expect((await reserve.getRequest(a!)).status).to.equal(2)
    expect((await reserve.getRequest(c!)).status).to.equal(1)
    await reserve.connect(keeper).processQueue(usdc.address, 2)
    expect((await reserve.getRequest(c!)).status).to.equal(2)
    expect(str(await reserve.queueHead(usdc.address))).to.equal("3")
  })

  it("queues and pays an 18-decimal asset", async () => {
    const { reserve, rlusd, usdt, investor, recipient, keeper } = await reserveFixture()
    await reserve.connect(investor).deposit(usdt.address, usd6("5"), investor.address)
    const id = await queuedId(reserve.connect(investor).redeem(rlusd.address, usd18("5"), recipient.address, 0))
    await reserve.connect(keeper).deposit(rlusd.address, usd18("5"), keeper.address)
    const before = await rlusd.balanceOf(recipient.address)
    await reserve.connect(keeper).processQueue(rlusd.address, 5)
    expect((await reserve.getRequest(id!)).status).to.equal(2)
    expect(str((await rlusd.balanceOf(recipient.address)).sub(before))).to.equal(str(usd18("5")))
  })

  it("an emergency pause of ArcoUSD burns halts queue payouts as a whole (nothing half-paid)", async () => {
    const { reserve, arco, usdc, usdt, investor, keeper, admin } = await reserveFixture()
    await reserve.connect(investor).deposit(usdt.address, usd6("10"), investor.address)
    const id = await queuedId(reserve.connect(investor).redeem(usdc.address, usd18("10"), investor.address, 0))
    await reserve.connect(keeper).deposit(usdc.address, usd6("10"), keeper.address)
    await arco.connect(admin).pauseFn(arco.interface.getSighash("burn"))
    await expectRevert(reserve.connect(keeper).processQueue(usdc.address, 5), "FP: fn paused")
    expect((await reserve.getRequest(id!)).status).to.equal(1)
  })

  it("permit: a front-run permit still lets the redemption through; an expired one without allowance fails", async () => {
    const { reserve, arco, usdc, investor, recipient, other } = await reserveFixture()
    await reserve.connect(investor).deposit(usdc.address, usd6("10"), investor.address)
    await arco.connect(investor).approve(reserve.address, 0)
    const { chainId } = await ethers.provider.getNetwork()
    const now = (await ethers.provider.getBlock("latest")).timestamp
    const sign = async (value: BigNumber, deadline: number) => {
      const signature = await investor._signTypedData(
        { name: "ArcoUSD", version: "1", chainId, verifyingContract: arco.address },
        {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        { owner: investor.address, spender: reserve.address, value, nonce: await arco.nonces(investor.address), deadline },
      )
      return ethers.utils.splitSignature(signature)
    }
    const value = usd18("3")
    const fresh = await sign(value, now + 3600)
    await arco.connect(other).permit(investor.address, reserve.address, value, now + 3600, fresh.v, fresh.r, fresh.s)
    await reserve.connect(investor).redeemWithPermit(usdc.address, value, recipient.address, 0, now + 3600, fresh.v, fresh.r, fresh.s)

    const expired = await sign(value, now - 1)
    await expectRevert(
      reserve.connect(investor).redeemWithPermit(usdc.address, value, recipient.address, 0, now - 1, expired.v, expired.r, expired.s),
      "insufficient allowance",
    )
  })

  it("invariant over a pseudo-random sequence: backing ≥ liabilities and queuedAssets = Σ open requests", async () => {
    const { reserve, arco, usdc, usdt, rlusd, investor, other, carol, keeper } = await reserveFixture({ instantFeeBps: 5 })
    const users = [investor, other, carol]
    const assets = [
      { token: usdc, unit: (x: number) => usd6(String(x)) },
      { token: usdt, unit: (x: number) => usd6(String(x)) },
      { token: rlusd, unit: (x: number) => usd18(String(x)) },
    ]
    let seed = 42
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const open: BigNumber[] = []
    for (let step = 0; step < 45; step++) {
      const user = users[rand(users.length)]
      const asset = assets[rand(assets.length)]
      const action = rand(4)
      if (action === 0) {
        await reserve.connect(user).deposit(asset.token.address, asset.unit(1 + rand(50)), user.address)
      } else if (action === 1) {
        const balance = await arco.balanceOf(user.address)
        const amount = usd18(String(1 + rand(30)))
        if (balance.gte(amount)) {
          const id = await queuedId(reserve.connect(user).redeem(asset.token.address, amount, user.address, 0))
          if (id) open.push(id)
        }
      } else if (action === 2) {
        await reserve.connect(keeper).processQueue(asset.token.address, 1 + rand(4))
      } else if (open.length > 0) {
        const id = open[rand(open.length)]
        const request = await reserve.getRequest(id)
        if (request.status === 1 && users.some((u) => u.address === request.owner)) {
          await reserve.connect(users.find((u) => u.address === request.owner)!).cancelRedeem(id)
        }
      }
      const { backing, liabilities } = await backingAndLiabilities(reserve)
      expect(backing.gte(liabilities), `step ${step}`).to.equal(true)
      for (const { token } of assets) {
        let sum = BigNumber.from(0)
        for (const id of open) {
          const request = await reserve.getRequest(id)
          if (request.status === 1 && request.asset === token.address) sum = sum.add(request.assetAmount)
        }
        expect(str(await reserve.queuedAssets(token.address)), `step ${step}`).to.equal(str(sum))
      }
    }
  })
})

describe("ArcoUSDReserve partial liquidity and probes", () => {
  it("pays what is available now and queues only the shortfall", async () => {
    const { reserve, arco, usdc, usdt, investor, recipient, other, settler, depositVault } = await reserveFixture({ instantFeeBps: 10 })
    await reserve.connect(other).deposit(usdc.address, usd6("30"), other.address)
    await reserve.connect(investor).deposit(usdt.address, usd6("100"), investor.address)
    const before = await usdc.balanceOf(recipient.address)
    const receipt = await (await reserve.connect(investor).redeem(usdc.address, usd18("100"), recipient.address, 0)).wait()
    const instant = receipt.events?.find((event: any) => event.event === "RedeemedInstant")?.args
    const queued = receipt.events?.find((event: any) => event.event === "RedeemQueued")?.args
    expect(str(instant?.assetOut)).to.equal(str(usd6("29.97"))) // 30 minus 0.1% fee
    expect(str(queued?.assetOut)).to.equal(str(usd6("70")))
    expect(str(queued?.arcoUSDIn)).to.equal(str(usd18("70")))
    expect(str((await usdc.balanceOf(recipient.address)).sub(before))).to.equal(str(usd6("29.97")))
    expect(str(await arco.balanceOf(reserve.address))).to.equal(str(usd18("70"))) // only the queued part is escrowed
    // A large request can no longer reserve liquidity that is actually free: none is left.
    expect(str(await reserve.availableForSettlement(usdc.address))).to.equal("0")
    await expectRevert(reserve.connect(settler).settleFor(usdc.address, usd18("1"), depositVault.address), "InsufficientLiquidity")
  })

  it("a blacklisted owner at the head never blocks the requests behind it", async () => {
    const { reserve, arco, usdc, usdt, investor, other, keeper, admin } = await reserveFixture()
    await reserve.connect(investor).deposit(usdt.address, usd6("100"), investor.address)
    await reserve.connect(other).deposit(usdt.address, usd6("10"), other.address)
    const head = await queuedId(reserve.connect(investor).redeem(usdc.address, usd18("100"), investor.address, 0))
    const next = await queuedId(reserve.connect(other).redeem(usdc.address, usd18("10"), other.address, 0))
    await arco.connect(admin).blacklist(investor.address)
    await reserve.connect(keeper).deposit(usdc.address, usd6("50"), keeper.address) // < head, ≥ next
    await reserve.connect(keeper).processQueue(usdc.address, 5)
    expect((await reserve.getRequest(head!)).status).to.equal(4)
    expect((await reserve.getRequest(next!)).status).to.equal(2)
  })

  it("a recipient blacklisted on ArcoUSD after queuing is not paid", async () => {
    const { reserve, arco, usdc, usdt, investor, recipient, keeper, admin } = await reserveFixture()
    await reserve.connect(investor).deposit(usdt.address, usd6("10"), investor.address)
    const id = await queuedId(reserve.connect(investor).redeem(usdc.address, usd18("10"), recipient.address, 0))
    await arco.connect(admin).blacklist(recipient.address)
    await reserve.connect(keeper).deposit(usdc.address, usd6("10"), keeper.address)
    const before = await usdc.balanceOf(recipient.address)
    await reserve.connect(keeper).processQueue(usdc.address, 5)
    expect((await reserve.getRequest(id!)).status).to.equal(4)
    expect(str(await usdc.balanceOf(recipient.address))).to.equal(str(before))
  })

  it("a paused token that returns false (no revert) stops the queue instead of failing everyone", async () => {
    const { reserve, usdt, investor, recipient, keeper } = await reserveFixture()
    const factory = await ethers.getContractFactory("TestFalseReturnStable")
    const fusd = await factory.deploy()
    await fusd.deployed()
    await reserve.setAsset(fusd.address, assetParams())
    await reserve.connect(investor).deposit(usdt.address, usd6("20"), investor.address)
    const id = await queuedId(reserve.connect(investor).redeem(fusd.address, usd18("20"), recipient.address, 0))
    await fusd.mint(keeper.address, usd6("20"))
    await fusd.connect(keeper).approve(reserve.address, MAX)
    await reserve.connect(keeper).deposit(fusd.address, usd6("20"), keeper.address)
    await fusd.setPaused(true)
    await reserve.connect(keeper).processQueue(fusd.address, 5)
    expect((await reserve.getRequest(id!)).status).to.equal(1)
    await fusd.setPaused(false)
    await reserve.connect(keeper).processQueue(fusd.address, 5)
    expect((await reserve.getRequest(id!)).status).to.equal(2)
    expect(str(await fusd.balanceOf(recipient.address))).to.equal(str(usd6("20")))
  })

  it("stops before a payout when gas runs low instead of misreading it as a recipient failure", async () => {
    const { reserve, usdc, usdt, investor, keeper } = await reserveFixture()
    await reserve.connect(investor).deposit(usdt.address, usd6("10"), investor.address)
    const id = await queuedId(reserve.connect(investor).redeem(usdc.address, usd18("10"), investor.address, 0))
    await reserve.connect(keeper).deposit(usdc.address, usd6("10"), keeper.address)
    await reserve.connect(keeper).processQueue(usdc.address, 5, { gasLimit: 160_000 })
    expect((await reserve.getRequest(id!)).status).to.equal(1)
    await reserve.connect(keeper).processQueue(usdc.address, 5)
    expect((await reserve.getRequest(id!)).status).to.equal(2)
  })

  it("covers the remaining guards: zero address, redeem disabled, unknown strategy, too many assets", async () => {
    const { reserve, usdc, investor, admin } = await reserveFixture()
    await expectRevert(reserve.connect(investor).deposit(usdc.address, 1, ethers.constants.AddressZero), "ZeroAddress")
    await reserve.connect(investor).deposit(usdc.address, usd6("1"), investor.address)
    await reserve.setAsset(usdc.address, assetParams({ redeemEnabled: false }))
    await expectRevert(reserve.connect(investor).redeem(usdc.address, usd18("1"), investor.address, 0), "RedeemDisabled")
    await expectRevert(reserve.getStrategy(99), "UnknownStrategy")
    for (let i = 0; i < 5; i++) {
      const token = await deployProxy("TestAssetToken", [`Extra ${i}`, `EX${i}`, 6, admin.address])
      await reserve.setAsset(token.address, assetParams())
    }
    const ninth = await deployProxy("TestAssetToken", ["Extra 9", "EX9", 6, admin.address])
    await expectRevert(reserve.setAsset(ninth.address, assetParams()), "TooMany")
  })

  it("the lens snapshot reports buffers, queue and strategies in one call", async () => {
    const { reserve, lens, usdc, usdt, investor, depositVault, redemptionVault } = await reserveFixture()
    await reserve.addStrategy(depositVault.address, redemptionVault.address, usd18("1000000"))
    await reserve.connect(investor).deposit(usdc.address, usd6("1000"), investor.address)
    await reserve.allocate(0, usd6("400"), 0)
    await reserve.connect(investor).deposit(usdt.address, usd6("10"), investor.address)
    await reserve.connect(investor).redeem(usdt.address, usd18("20"), investor.address, 0) // 10 now, 10 queued
    const snap = await lens.snapshot(reserve.address)
    expect(snap.navOk).to.equal(true)
    expect(str(snap.totalBacking)).to.equal(str(snap.totalLiabilities))
    expect(str(snap.mmfBps)).to.equal("4000")
    const usdtRow = snap.assets.find((row: any) => row.asset === usdt.address)
    expect(str(usdtRow.queued)).to.equal(str(usd6("10")))
    expect(str(usdtRow.available)).to.equal("0")
    expect(str(snap.strategies[0].value)).to.equal(str(usd18("400")))
    expect(str(snap.strategies[0].shares)).to.equal(str(usd18("200")))
  })
})
