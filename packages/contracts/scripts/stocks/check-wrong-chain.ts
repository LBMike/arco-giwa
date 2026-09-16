import assert from "assert/strict"
import hre from "hardhat"

async function main() {
  assert.notEqual((await hre.ethers.provider.getNetwork()).chainId, 91342)
  const [a, b, c] = await hre.ethers.getSigners()
  const inputs: [string, string[]][] = [
    ["StocksTestCash", [a.address]],
    ["StocksFundingVault", [a.address, b.address, c.address]],
    ["StocksMintController", [a.address, b.address]],
    ["StocksToken", [a.address, b.address]],
    ["StocksRedemptionEscrow", [a.address, b.address, c.address]],
  ]
  for (const [name, args] of inputs) {
    const factory = await hre.ethers.getContractFactory(name)
    await assert.rejects(factory.deploy(...args), (error: any) =>
      error.message.includes("STOCKS_WRONG_CHAIN"),
    )
  }
  console.log("PASS: all five Stocks contracts reject deployment on chain 31337")
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Wrong-chain check failed")
  process.exitCode = 1
})
