import { createHash, randomUUID } from "crypto"
import type { Contract } from "ethers"
import type { HardhatRuntimeEnvironment } from "hardhat/types"

export type StocksDeployment = Awaited<ReturnType<typeof deployStocks>>

/** Isolated Hardhat only; uses unlocked RPC signers and never exports account keys. */
export async function deployStocks(hre: HardhatRuntimeEnvironment, abiDigest: string) {
  if (!/^[a-f0-9]{64}$/.test(abiDigest)) throw new Error("Backend ABI digest is required")
  if (!["hardhat", "stocksLocal"].includes(hre.network.name))
    throw new Error("Local Stocks harness only")
  const metadata = await hre.network.provider.send("hardhat_metadata")
  const network = await hre.ethers.provider.getNetwork()
  if (network.chainId !== 91342 || !metadata.instanceId || metadata.forkedNetwork) {
    throw new Error("Expected isolated, unforked chain 91342")
  }
  const [deployer, operator, faucetOperator, holder, otherHolder] = await hre.ethers.getSigners()
  if (!otherHolder) throw new Error("Local harness needs five unlocked RPC accounts")
  const nonce = await deployer.getTransactionCount("pending")
  const predicted = Array.from({ length: 5 }, (_, offset) =>
    hre.ethers.utils.getContractAddress({
      from: deployer.address,
      nonce: nonce + offset,
    }),
  )
  async function create(name: string, args: unknown[], offset: number): Promise<Contract> {
    if ((await deployer.getTransactionCount("pending")) !== nonce + offset) {
      throw new Error("Deployment nonce changed; do not reuse this partial deployment")
    }
    const factory = await hre.ethers.getContractFactory(name, deployer)
    const contract = await factory.deploy(...args)
    await contract.deployed()
    if (contract.address !== predicted[offset]) throw new Error("Unexpected deployment address")
    return contract
  }
  const cash = await create("StocksTestCash", [faucetOperator.address], 0)
  const vault = await create(
    "StocksFundingVault",
    [predicted[0], operator.address, predicted[4]],
    1,
  )
  const controller = await create("StocksMintController", [operator.address, predicted[3]], 2)
  const stock = await create("StocksToken", [predicted[2], predicted[4]], 3)
  const escrow = await create(
    "StocksRedemptionEscrow",
    [operator.address, predicted[3], predicted[1]],
    4,
  )
  const same = (actual: string, expected: string) => {
    if (actual.toLowerCase() !== expected.toLowerCase())
      throw new Error("Immutable relationship mismatch")
  }
  same(await cash.faucetOperator(), faucetOperator.address)
  same(await stock.mintController(), controller.address)
  same(await stock.redemptionEscrow(), escrow.address)
  same(await vault.cashToken(), cash.address)
  same(await vault.redemptionEscrow(), escrow.address)
  same(await vault.operator(), operator.address)
  same(await controller.stockToken(), stock.address)
  same(await controller.operator(), operator.address)
  same(await escrow.stockToken(), stock.address)
  same(await escrow.cashToken(), cash.address)
  same(await escrow.fundingVault(), vault.address)
  same(await escrow.operator(), operator.address)
  if ((await cash.decimals()) !== 6 || (await stock.decimals()) !== 9)
    throw new Error("Wrong asset scale")
  const checkpoint = await hre.ethers.provider.getBlock("latest")
  const codeHashes: Record<string, string> = {}
  for (const contract of [cash, vault, controller, stock, escrow]) {
    const code = await hre.ethers.provider.getCode(contract.address, checkpoint.number)
    if (code === "0x") throw new Error("Missing deployed code")
    codeHashes[contract.address.toLowerCase()] = hre.ethers.utils.keccak256(code)
  }
  const manifest = {
    schemaVersion: 2 as const,
    deploymentId: `stocks-local-${randomUUID()}`,
    profile: "DEMO_TESTNET" as const,
    chainId: 91342 as const,
    networkInstance: `hardhat-${createHash("sha256").update(metadata.instanceId).digest("hex")}`,
    checkpointNumber: String(checkpoint.number),
    checkpointHash: checkpoint.hash.toLowerCase(),
    abiDigest,
    finalityPolicy: "FINALIZED" as const,
    cashToken: cash.address.toLowerCase(),
    cashSymbol: "ARCO_TEST_USDC" as const,
    cashScale: 6 as const,
    stockToken: stock.address.toLowerCase(),
    quantityScale: 9 as const,
    fundingVault: vault.address.toLowerCase(),
    mintController: controller.address.toLowerCase(),
    redemptionEscrow: escrow.address.toLowerCase(),
    signerAddress: operator.address.toLowerCase(),
    codeHashes,
    restrictedTransfers: true as const,
    nonUpgradeable: true as const,
  }
  return {
    manifest,
    contracts: { cash, vault, controller, stock, escrow },
    signers: { deployer, operator, faucetOperator, holder, otherHolder },
    publicAccounts: {
      deployer: deployer.address.toLowerCase(),
      operator: operator.address.toLowerCase(),
      faucetOperator: faucetOperator.address.toLowerCase(),
      holder: holder.address.toLowerCase(),
      otherHolder: otherHolder.address.toLowerCase(),
    },
  }
}
