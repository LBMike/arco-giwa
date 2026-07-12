import path from "path"
import { BigNumber, Contract, ContractTransaction, Signer } from "ethers"
import { ethers, network } from "hardhat"
import { loadRegistry, registryFilePath, type ResumableRegistry } from "./deploy-registry"
import { EXPECTED_GIWA_DEPLOYER } from "./keystore-constants"

// Refresh every ProductPriceFeed on GIWA so deposits stop reverting with "PPF: stale".
// Each feed was deployed with healthyDiff = 3600 (1h) and answer = 1e8 (1.0, 8 decimals).
// On a testnet we widen healthyDiff to 365 days and re-push the price so updatedAt is fresh.
// Read-only off-chain; signs with the keystore feed admin.

const PRICE_ANSWER = BigNumber.from("100000000") // 1.0 at 8 decimals
const HEALTHY_DIFF_SECONDS = BigNumber.from(365 * 24 * 60 * 60) // 1 year (testnet)

function repoRoot() {
  return path.resolve(__dirname, "../../..")
}

function requireAddress(value: string | null | undefined, label: string): `0x${string}` {
  if (!value) throw new Error(`Missing address: ${label}`)
  return value as `0x${string}`
}

async function main() {
  if (process.env.DEPLOYER_PRIVATE_KEY) {
    throw new Error("Raw private-key use is forbidden")
  }
  if (process.env.CONFIRM_GIWA_BROADCAST !== "I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA") {
    throw new Error("Set CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA to broadcast")
  }

  const chain = await ethers.provider.getNetwork()
  if (network.name !== "giwaSepolia" || chain.chainId !== 91342) {
    throw new Error(`Expected giwaSepolia chain 91342, got ${network.name} ${chain.chainId}`)
  }

  const [deployer] = (await ethers.getSigners()) as Array<Signer & { address: string }>
  if (!deployer) throw new Error("No signer available")
  if (deployer.address.toLowerCase() !== EXPECTED_GIWA_DEPLOYER.toLowerCase()) {
    throw new Error(`Signer is ${deployer.address}; expected ${EXPECTED_GIWA_DEPLOYER}`)
  }

  const registryPath = registryFilePath(repoRoot())
  const registry: ResumableRegistry = loadRegistry(
    registryPath,
    deployer.address as `0x${string}`,
    repoRoot(),
    "cancun",
  )

  const feedAbi = [
    "function healthyDiff() view returns (uint256)",
    "function setHealthyDiff(uint256 healthyDiff_)",
    "function setRoundDataSafe(int256 answer)",
    "function minExpectedAnswer() view returns (uint256)",
    "function maxExpectedAnswer() view returns (uint256)",
  ]

  const feeData = await ethers.provider.getFeeData()
  const overrides = {
    gasLimit: BigNumber.from(300_000),
    ...(feeData.maxFeePerGas
      ? {
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? ethers.utils.parseUnits("0.001", "gwei"),
        }
      : { gasPrice: feeData.gasPrice ?? ethers.utils.parseUnits("1", "gwei") }),
  }

  for (const product of registry.products) {
    const feedAddress = requireAddress(
      product.priceFeed?.proxy ?? null,
      `registry.products.${product.symbol}.priceFeed.proxy`,
    )
    const feed = new Contract(feedAddress, feedAbi, deployer)

    const currentDiff = (await feed.healthyDiff()) as BigNumber
    if (currentDiff.lt(HEALTHY_DIFF_SECONDS)) {
      const diffTx: ContractTransaction = await feed.setHealthyDiff(HEALTHY_DIFF_SECONDS, overrides)
      console.log(`submitted setHealthyDiff ${product.symbol}: ${diffTx.hash}`)
      await diffTx.wait(1)
      console.log(`confirmed setHealthyDiff ${product.symbol} -> ${HEALTHY_DIFF_SECONDS.toString()}s`)
    } else {
      console.log(`healthyDiff already >= target for ${product.symbol}`)
    }

    const priceTx: ContractTransaction = await feed.setRoundDataSafe(PRICE_ANSWER, overrides)
    console.log(`submitted setRoundDataSafe ${product.symbol}: ${priceTx.hash}`)
    await priceTx.wait(1)
    console.log(`confirmed setRoundDataSafe ${product.symbol} -> ${PRICE_ANSWER.toString()}`)
  }

  console.log(
    JSON.stringify(
      {
        status: "price feeds refreshed",
        network: "giwaSepolia",
        chainId: 91342,
        feeds: registry.products.length,
        priceAnswer: PRICE_ANSWER.toString(),
        healthyDiffSeconds: HEALTHY_DIFF_SECONDS.toString(),
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
