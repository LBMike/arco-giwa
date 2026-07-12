import { execFileSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import path from "path"
import { BigNumber, Contract, ContractReceipt, ContractTransaction, Signer } from "ethers"
import { ethers, network, upgrades } from "hardhat"
import { loadRegistry, registryFilePath, writeRegistry } from "./deploy-registry"
import { EXPECTED_GIWA_DEPLOYER } from "./keystore-constants"

const TX_TIMEOUT_MS = 180_000
const REQUIRED_PRODUCT_TOKEN_COUNT = 6
const forbiddenGiwaEvmVersion = "pra" + "gue"

function repoRoot() {
  return path.resolve(__dirname, "../../..")
}

function packageRoot() {
  return path.resolve(__dirname, "..")
}

function manifestPath() {
  return path.join(packageRoot(), ".openzeppelin/unknown-91342.json")
}

function ensureNoRawPrivateKey() {
  if (process.env.DEPLOYER_PRIVATE_KEY) {
    throw new Error("Raw private-key deployment is forbidden")
  }
}

function ensureCancunAndNoPrague() {
  const evmVersion = process.env.GIWA_EVM_VERSION ?? "cancun"
  if (evmVersion === forbiddenGiwaEvmVersion) {
    throw new Error("GIWA product-token upgrade must never use prague")
  }
  if (evmVersion !== "cancun") {
    throw new Error(`GIWA product-token upgrade requires evmVersion cancun, got ${evmVersion}`)
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

function ensureLiveManifestContainsProductTokens(productTokenProxies: readonly `0x${string}`[]) {
  const filePath = manifestPath()
  if (!existsSync(filePath)) {
    throw new Error(`Missing live GIWA OpenZeppelin manifest: ${filePath}`)
  }
  const manifest = JSON.parse(readFileSync(filePath, "utf8")) as {
    proxies?: Array<{ address?: string; kind?: string }>
  }
  const manifestProxies = new Set(
    (manifest.proxies ?? []).map((proxy) => proxy.address?.toLowerCase()).filter(Boolean),
  )
  const missing = productTokenProxies.filter((proxy) => !manifestProxies.has(proxy.toLowerCase()))
  if (missing.length > 0) {
    throw new Error(
      `Live GIWA OpenZeppelin manifest is missing ProductToken proxies: ${missing.join(", ")}`,
    )
  }
  console.log(
    `Using live GIWA OpenZeppelin manifest ${filePath} with ${manifestProxies.size} transparent proxy records.`,
  )
}

async function main() {
  ensureNoRawPrivateKey()
  ensureCancunAndNoPrague()

  const chain = await ethers.provider.getNetwork()
  if (network.name !== "giwaSepolia" || chain.chainId !== 91342) {
    throw new Error(`GIWA product-token upgrade expected giwaSepolia chain 91342, got ${network.name} ${chain.chainId}`)
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
  const targets = registry.products.map((product) => ({
    productId: product.productId,
    symbol: product.symbol,
    proxy: requireAddress(product.productToken.proxy, `${product.symbol}.productToken.proxy`),
  }))
  if (targets.length !== REQUIRED_PRODUCT_TOKEN_COUNT) {
    throw new Error(`Expected ${REQUIRED_PRODUCT_TOKEN_COUNT} ProductToken proxies, got ${targets.length}`)
  }
  ensureLiveManifestContainsProductTokens(targets.map((target) => target.proxy))

  const ProductTokenV2 = await ethers.getContractFactory("ProductToken")
  for (const target of targets) {
    console.log(`validating ProductToken upgrade for ${target.symbol} at ${target.proxy}`)
    await upgrades.validateUpgrade(target.proxy, ProductTokenV2, { kind: "transparent" })

    const alreadyUpgraded = await supportsGreenlistToggle(target.proxy, deployer)
    if (alreadyUpgraded) {
      console.log(`${target.symbol} already exposes greenlistEnforced(); skipping upgradeProxy`)
    } else {
      console.log(`upgrading ${target.symbol} ProductToken proxy ${target.proxy}`)
      const upgraded = await upgrades.upgradeProxy(target.proxy, ProductTokenV2, {
        kind: "transparent",
        txOverrides: await txOverrides(),
      } as any)
      await upgraded.deployed()
      const receipt = await confirmedReceipt(upgraded.deployTransaction, `${target.symbol} ProductToken upgrade`)
      console.log(`confirmed ${target.symbol} ProductToken upgrade: ${upgraded.deployTransaction.hash}`)

      const product = registry.products.find((item) => item.productId === target.productId)
      if (!product) throw new Error(`Missing registry product ${target.productId}`)
      product.productToken.implementation = (await upgrades.erc1967.getImplementationAddress(target.proxy)) as `0x${string}`
      product.productToken.bytecodeHash = await codeHash(product.productToken.implementation)
      product.productToken.blockNumber = receipt.blockNumber
      writeRegistry(registryPath, registry)
    }
  }

  for (const product of registry.products) {
    if (!product.productToken.proxy) continue
    product.productToken.implementation = (await upgrades.erc1967.getImplementationAddress(product.productToken.proxy)) as `0x${string}`
    product.productToken.bytecodeHash = await codeHash(product.productToken.implementation)
  }
  writeRegistry(registryPath, registry)

  console.log(
    JSON.stringify(
      {
        status: "product tokens upgraded; greenlist enforcement left off by default",
        network: network.name,
        chainId: chain.chainId,
        upgradedProductTokenCount: targets.length,
        registryPath,
      },
      null,
      2,
    ),
  )
}

async function supportsGreenlistToggle(proxy: `0x${string}`, signer: Signer) {
  const token = new Contract(proxy, ["function greenlistEnforced() view returns (bool)"], signer)
  try {
    await token.greenlistEnforced()
    return true
  } catch {
    return false
  }
}

async function txOverrides() {
  const feeData = await ethers.provider.getFeeData()
  const gasLimit = BigNumber.from(900_000)
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
