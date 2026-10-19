import { ethers, upgrades } from "hardhat"

describe("upgrade storage-layout validation", () => {
  for (const name of [
    "ProductToken",
    "TestAssetToken",
    "ProductPriceFeed",
    "TestAssetFaucet",
    "ArcoDepositVault",
    "ArcoRedemptionVault",
    "ArcoUSD",
    "ArcoUSDReserve",
    "ArcoRouter",
    "SArcoUSD",
  ]) {
    it(`validates ${name} as an upgradeable implementation`, async () => {
      await upgrades.validateImplementation(await ethers.getContractFactory(name))
    })
  }

  it("validates TestAssetFaucet V1 to dripAll V2 storage extension", async () => {
    const [admin] = await ethers.getSigners()
    const v1 = await ethers.getContractFactory("TestAssetFaucetV1Layout")
    const proxy = await upgrades.deployProxy(v1, [admin.address], {
      initializer: "initialize",
      kind: "transparent",
    })
    await proxy.deployed()

    const v2 = await ethers.getContractFactory("TestAssetFaucet")
    await upgrades.validateUpgrade(proxy.address, v2, { kind: "transparent" })
  })

  it("validates ProductToken V1 to greenlist-toggle V2 storage extension", async () => {
    const [admin] = await ethers.getSigners()
    const v1 = await ethers.getContractFactory("ProductTokenV1Layout")
    const proxy = await upgrades.deployProxy(v1, ["Arco Test", "aTEST", admin.address], {
      initializer: "initialize",
      kind: "transparent",
    })
    await proxy.deployed()

    const v2 = await ethers.getContractFactory("ProductToken")
    await upgrades.validateUpgrade(proxy.address, v2, { kind: "transparent" })
  })
})
