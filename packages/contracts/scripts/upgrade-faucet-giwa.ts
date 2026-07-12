import { execFileSync } from "child_process"
import { existsSync } from "fs"
import path from "path"
import { BigNumber, Contract, ContractReceipt, ContractTransaction, Signer } from "ethers"
import { ethers, network, upgrades } from "hardhat"
import { PAYMENT_ASSETS } from "./deploy-plan"
import { loadRegistry, registryFilePath, writeRegistry, type ResumableRegistry } from "./deploy-registry"
import { EXPECTED_GIWA_DEPLOYER } from "./keystore-constants"

const TX_TIMEOUT_MS = 180_000

function repoRoot() {
  return path.resolve(__dirname, "../../..")
}

function packageRoot() {
  return path.resolve(__dirname, "..")
}

function ensureNoRawPrivateKey() {
  if (process.env.DEPLOYER_PRIVATE_KEY) {
    throw new Error("Raw private-key deployment is forbidden")
  }
}

function ensureCancun() {
  const evmVersion = process.env.GIWA_EVM_VERSION ?? "cancun"
  if (evmVersion !== "cancun") {
    throw new Error(`GIWA faucet upgrade requires evmVersion cancun, got ${evmVersion}`)
  }
}

function ensureCleanTree() {
  if (process.env.ALLOW_DIRTY_GIWA_DEPLOY === "I_UNDERSTAND_DIRTY_TREE_RISK") return
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: repoRoot(),
    encoding: "utf8",
  }).trim()
  if (status) {
    throw new Error(
      "Refusing GIWA broadcast from a dirty git tree. Commit/revert changes, or set ALLOW_DIRTY_GIWA_DEPLOY=I_UNDERSTAND_DIRTY_TREE_RISK for a reviewed exception.",
    )
  }
}

function ensureContractTestsPass() {
  const testEnv = {
    ...process.env,
    HARDHAT_NETWORK: "hardhat",
    GIWA_REQUIRE_KEYSTORE: "",
    GIWA_KEYSTORE_PASSWORD: "",
    CONFIRM_GIWA_BROADCAST: "",
  }
  console.log("Running pre-upgrade contract tests on local hardhat network (chainId 31337).")
  execFileSync("corepack", ["yarn", "hardhat", "test", "--network", "hardhat"], {
    cwd: packageRoot(),
    env: testEnv,
    stdio: "inherit",
  })
}

async function main() {
  ensureNoRawPrivateKey()
  ensureCancun()

  const chain = await ethers.provider.getNetwork()
  if (network.name !== "giwaSepolia" || chain.chainId !== 91342) {
    throw new Error(`GIWA faucet upgrade expected giwaSepolia chain 91342, got ${network.name} ${chain.chainId}`)
  }
  if (process.env.CONFIRM_GIWA_BROADCAST !== "I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA") {
    throw new Error("Set CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA to broadcast")
  }

  const [deployer] = (await ethers.getSigners()) as Array<Signer & { address: string }>
  if (!deployer) throw new Error("No signer available")
  if (deployer.address.toLowerCase() !== EXPECTED_GIWA_DEPLOYER.toLowerCase()) {
    throw new Error(`GIWA upgrade signer is ${deployer.address}; expected ${EXPECTED_GIWA_DEPLOYER}`)
  }

  ensureCleanTree()
  ensureContractTestsPass()

  const registryPath = registryFilePath(repoRoot())
  const registry = loadRegistry(registryPath, deployer.address as `0x${string}`, repoRoot(), "cancun")
  const faucetProxy = requireAddress(registry.faucet.proxy, "registry.faucet.proxy")
  const FaucetV2 = await ethers.getContractFactory("TestAssetFaucet")

  await upgrades.validateUpgrade(faucetProxy, FaucetV2, { kind: "transparent" })
  const faucetAlreadyUpgraded = await supportsAssetEnumeration(faucetProxy, deployer)
  if (faucetAlreadyUpgraded) {
    console.log(`faucet ${faucetProxy} already exposes supportedAssets(); skipping upgradeProxy`)
  } else {
    console.log(`upgrading faucet proxy ${faucetProxy}`)
    const upgraded = await upgrades.upgradeProxy(faucetProxy, FaucetV2, {
      kind: "transparent",
      txOverrides: await txOverrides("upgrade"),
    } as Parameters<typeof upgrades.upgradeProxy>[2] & { txOverrides: Record<string, unknown> })
    await upgraded.deployed()
    const receipt = await confirmedReceipt(upgraded.deployTransaction, "faucet implementation upgrade")
    console.log(`confirmed faucet upgrade: ${upgraded.deployTransaction.hash}`)

    registry.faucet.implementation = (await upgrades.erc1967.getImplementationAddress(faucetProxy)) as `0x${string}`
    registry.faucet.bytecodeHash = await codeHash(registry.faucet.implementation)
    registry.faucet.blockNumber = receipt.blockNumber
    writeRegistry(registryPath, registry)
  }

  await backfillSupportedAssets(registry, faucetProxy, deployer)
  registry.faucet.implementation = (await upgrades.erc1967.getImplementationAddress(faucetProxy)) as `0x${string}`
  registry.faucet.bytecodeHash = await codeHash(registry.faucet.implementation)
  writeRegistry(registryPath, registry)

  console.log(
    JSON.stringify(
      {
        status: "faucet upgraded and supported asset set backfilled",
        network: network.name,
        chainId: chain.chainId,
        faucetProxy,
        implementation: registry.faucet.implementation,
        registryPath,
      },
      null,
      2,
    ),
  )
}

async function supportsAssetEnumeration(proxy: `0x${string}`, signer: Signer) {
  const faucet = new Contract(proxy, ["function supportedAssets() view returns (address[])"], signer)
  try {
    await faucet.supportedAssets()
    return true
  } catch {
    return false
  }
}

async function backfillSupportedAssets(
  registry: ResumableRegistry,
  faucetProxy: `0x${string}`,
  deployer: Signer,
) {
  const faucet = new Contract(
    faucetProxy,
    [
      "function supportedAssets() view returns (address[])",
      "function configureAsset(address token,uint256 dripAmount,uint256 dailyCap,uint256 globalCap,uint256 cooldown,bool enabled)",
    ],
    deployer,
  )
  const supported = new Set<string>(
    ((await faucet.supportedAssets()) as string[]).map((asset) => asset.toLowerCase()),
  )

  // Testnet faucet drip settings (human units → token base units via decimals).
  // cooldown 24h; daily cap = 10x drip; global cap = 1,000,000x drip (effectively unlimited).
  const DRIP_HUMAN: Record<string, string> = {
    tUSDC: "1000",
    tBTC: "0.1",
    tXRP: "1000",
    tWETH: "1",
  }
  const COOLDOWN_SECONDS = BigNumber.from(24 * 60 * 60)

  for (const assetPlan of PAYMENT_ASSETS) {
    const asset = registry.assets.find((item) => item.symbol === assetPlan.symbol)
    const token = requireAddress(asset?.contract.proxy ?? null, `registry.assets.${assetPlan.symbol}.contract.proxy`)
    if (supported.has(token.toLowerCase())) {
      console.log(`supported asset already configured: ${assetPlan.symbol} ${token}`)
      continue
    }

    const human = DRIP_HUMAN[assetPlan.symbol]
    if (!human) {
      throw new Error(`No drip amount configured for ${assetPlan.symbol}`)
    }
    const dripAmount = ethers.utils.parseUnits(human, assetPlan.decimals)
    const dailyCap = dripAmount.mul(10)
    const globalCap = dripAmount.mul(1_000_000)

    const tx: ContractTransaction = await faucet.configureAsset(
      token,
      dripAmount,
      dailyCap,
      globalCap,
      COOLDOWN_SECONDS,
      true,
      await txOverrides("configure"),
    )
    console.log(
      `submitted faucet configureAsset ${assetPlan.symbol} (drip ${human}, cooldown 24h): ${tx.hash}`,
    )
    await confirmedReceipt(tx, `faucet configureAsset ${assetPlan.symbol}`)
    console.log(`confirmed faucet configureAsset ${assetPlan.symbol}: ${tx.hash}`)
  }
}

async function txOverrides(kind: "upgrade" | "configure") {
  const feeData = await ethers.provider.getFeeData()
  // configureAsset on a fresh asset writes 2 new cold storage slots + a 5-field
  // struct + event, which exceeds 200k gas; give it ample headroom.
  const gasLimit = kind === "upgrade" ? BigNumber.from(900_000) : BigNumber.from(500_000)
  if (feeData.maxFeePerGas) {
    return {
      gasLimit,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? ethers.utils.parseUnits("0.001", "gwei"),
    }
  }
  return {
    gasLimit,
    gasPrice: feeData.gasPrice ?? ethers.utils.parseUnits("1", "gwei"),
  }
}

async function confirmedReceipt(tx: ContractTransaction | undefined, label: string): Promise<ContractReceipt> {
  if (!tx) throw new Error(`Missing transaction object for ${label}`)
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(
      () => reject(new Error(`Timed out waiting for ${label} (${tx.hash}). Inspect the explorer before resuming.`)),
      TX_TIMEOUT_MS,
    )
  })
  const receipt = await Promise.race([tx.wait(1), timeout])
  if (receipt.status !== 1) throw new Error(`${label} reverted (${tx.hash})`)
  return receipt
}

async function codeHash(address: string): Promise<`0x${string}`> {
  const code = await ethers.provider.getCode(address)
  if (!code || code === "0x") throw new Error(`No bytecode at ${address}`)
  return ethers.utils.keccak256(code) as `0x${string}`
}

function requireAddress(value: string | null, label: string): `0x${string}` {
  if (!value) throw new Error(`Missing address for ${label}`)
  return value as `0x${string}`
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
