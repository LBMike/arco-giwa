import { expect } from "chai"
import { ethers, upgrades } from "hardhat"
import { BigNumber, Contract } from "ethers"

export const role = (name: string) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(name))

export const ROLES = {
  GREENLISTED_ROLE: role("GREENLISTED_ROLE"),
  MINTER_ROLE: role("MINTER_ROLE"),
  BURNER_ROLE: role("BURNER_ROLE"),
  PAUSER_ROLE: role("PAUSER_ROLE"),
  DEPOSIT_VAULT_ADMIN_ROLE: role("DEPOSIT_VAULT_ADMIN_ROLE"),
  REDEMPTION_VAULT_ADMIN_ROLE: role("REDEMPTION_VAULT_ADMIN_ROLE"),
  FEED_ADMIN_ROLE: role("FEED_ADMIN_ROLE"),
  FAUCET_ADMIN_ROLE: role("FAUCET_ADMIN_ROLE"),
}

export const parse = ethers.utils.parseUnits

export async function expectRevert(promise: Promise<unknown>, reason?: string) {
  try {
    await promise
  } catch (error) {
    if (reason) expect((error as Error).message).to.contain(reason)
    return
  }
  expect.fail("Expected transaction to revert")
}

export async function deployProxy(name: string, args: unknown[] = []): Promise<Contract> {
  const factory = await ethers.getContractFactory(name)
  const contract = await upgrades.deployProxy(factory, args, { initializer: "initialize" })
  await contract.deployed()
  return contract
}

export async function deployFixture(paymentDecimals = 6, paymentSymbol?: string) {
  const [admin, investor, recipient, other] = await ethers.getSigners()

  const product = await deployProxy("ProductToken", ["Arco CAPIX", "aCAPIX", admin.address])
  await product.greenlist(admin.address)
  await product.greenlist(investor.address)
  await product.greenlist(recipient.address)

  const asset = await deployProxy("TestAssetToken", [
    `Test ${paymentSymbol ?? (paymentDecimals === 8 ? "tBTC" : paymentDecimals === 18 ? "tWETH" : "tUSDC")}`,
    paymentSymbol ?? (paymentDecimals === 8 ? "tBTC" : paymentDecimals === 18 ? "tWETH" : "tUSDC"),
    paymentDecimals,
    admin.address,
  ])

  const productFeed = await deployProxy("ProductPriceFeed", [
    8,
    BigNumber.from("200000000"),
    3600,
    1,
    BigNumber.from("100000000000000"),
    0,
    admin.address,
  ])

  const paymentFeed = await deployProxy("ProductPriceFeed", [
    8,
    BigNumber.from("100000000"),
    3600,
    1,
    BigNumber.from("100000000000000"),
    0,
    admin.address,
  ])

  const minDeposit = BigNumber.from(10).pow(paymentDecimals)
  const maxSupply = parse("1000000", 18)
  const mintAllowance = parse("500000", 18)
  const redeemAllowance = BigNumber.from(10).pow(paymentDecimals).mul(1_000_000)

  const depositVault = await deployProxy("ArcoDepositVault", [
    product.address,
    asset.address,
    productFeed.address,
    paymentFeed.address,
    minDeposit,
    maxSupply,
    mintAllowance,
    admin.address,
  ])

  const redemptionVault = await deployProxy("ArcoRedemptionVault", [
    product.address,
    asset.address,
    productFeed.address,
    paymentFeed.address,
    parse("1", 18),
    redeemAllowance,
    admin.address,
  ])

  await product.grantRole(ROLES.MINTER_ROLE, depositVault.address)
  await product.grantRole(ROLES.BURNER_ROLE, redemptionVault.address)
  await asset.mint(investor.address, BigNumber.from(10).pow(paymentDecimals).mul(100_000))
  await asset.mint(redemptionVault.address, BigNumber.from(10).pow(paymentDecimals).mul(100_000))

  return {
    admin,
    investor,
    recipient,
    other,
    product,
    asset,
    productFeed,
    paymentFeed,
    depositVault,
    redemptionVault,
    paymentDecimals,
  }
}
