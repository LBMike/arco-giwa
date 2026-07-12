import { execFileSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import path from "path"
import { BigNumber, Contract, ContractReceipt, ContractTransaction, Signer } from "ethers"
import { ethers, network, upgrades } from "hardhat"
import { EXPECTED_GIWA_DEPLOYER } from "./keystore-constants"
import {
  PAYMENT_ASSETS,
  PRODUCTS,
  buildDeploySteps,
  type ExtendedProductPlan,
  deploymentPreview,
  estimatedCostWei,
  mergeActiveProducts,
  registryExtraProducts,
  remainingSteps,
  withSafetyMargin,
  type DeployStep,
  type GrantStep,
  type PaymentAssetSymbol,
  type ProxyStep,
  type RoleName,
} from "./deploy-plan"
import {
  addressForKey,
  loadRegistry,
  recordProxyDeployment,
  recordRoleGrant,
  registryFilePath,
  writeRegistry,
  type ResumableRegistry,
} from "./deploy-registry"

import { parseExtraProducts, resolvedInit, type DeployParamsInit, type DeployParamsProduct } from "./deploy-params"

const TX_TIMEOUT_MS = 180_000
// Post-deploy proxy readback resilience against transient GIWA RPC read-after-write lag.
const READBACK_MAX_ATTEMPTS = 6
const READBACK_BASE_DELAY_MS = 1_000
const READBACK_MAX_DELAY_MS = 15_000

// 2c-2: products resolved for THIS run (built-ins + optional GIWA_EXTRA_PRODUCTS file).
// Set once at the top of main(); every step builder / registry load / initializer
// lookup below consults these instead of the raw PRODUCTS constant.
let ACTIVE_PRODUCTS: readonly ExtendedProductPlan[] = PRODUCTS
const INIT_OVERRIDES = new Map<string, Required<DeployParamsInit>>()

// Reads + validates GIWA_EXTRA_PRODUCTS BEFORE any gate or network work runs, so a bad
// params file fails fast. Reserves the built-in ids/symbols AND every already-deployed
// registry extra: the params file must declare a GENUINELY NEW vault (prior extras auto-merge
// from the registry), so a collision with any existing vault is rejected with guidance.
function loadExtraProducts(registryExtras: readonly ExtendedProductPlan[]): DeployParamsProduct[] {
  const paramsPath = process.env.GIWA_EXTRA_PRODUCTS
  if (!paramsPath) return []
  const fullPath = path.resolve(packageRoot(), paramsPath)
  if (!existsSync(fullPath)) throw new Error(`GIWA_EXTRA_PRODUCTS file not found: ${fullPath}`)
  const raw = JSON.parse(readFileSync(fullPath, "utf8"))
  const reservedIds = [...PRODUCTS.map((product) => product.productId), ...registryExtras.map((extra) => extra.productId)]
  const reservedSymbols = [...PRODUCTS.map((product) => product.symbol), ...registryExtras.map((extra) => extra.symbol)]
  return parseExtraProducts(raw, reservedIds, reservedSymbols, `GIWA_EXTRA_PRODUCTS (${paramsPath})`)
}

// Raw registry read (pre-normalize). Missing file => {} so a fresh deploy has no registry extras.
function readRawRegistry(): unknown {
  const filePath = registryFilePath(repoRoot())
  if (!existsSync(filePath)) return {}
  return JSON.parse(readFileSync(filePath, "utf8"))
}

// Reads the RAW registry (before loadRegistry/normalizeRegistry — which throws on a prior
// extra) to recover previously-deployed extras, then ACTIVE_PRODUCTS = built-ins + registry
// extras + new params extras, deduped. INIT_OVERRIDES is set only for the NEW params extras;
// registry extras are already deployed and their steps are skipped by the resumable logic.
// No extras at all => byte-identical no-op (ACTIVE_PRODUCTS stays PRODUCTS).
function resolveActiveProducts() {
  const registryExtras = registryExtraProducts(readRawRegistry())
  const paramsExtras = loadExtraProducts(registryExtras)
  if (!registryExtras.length && !paramsExtras.length) return
  for (const extra of paramsExtras) INIT_OVERRIDES.set(extra.productId, resolvedInit(extra))
  ACTIVE_PRODUCTS = mergeActiveProducts(
    registryExtras,
    paramsExtras.map((extra) => ({
      productId: extra.productId,
      symbol: extra.symbol,
      name: extra.name,
      paymentAssetSymbol: extra.paymentAssetSymbol,
    })),
  )
  const idList = (items: readonly { productId: string }[]) => (items.length ? ` [${items.map((item) => item.productId).join(", ")}]` : "")
  console.log(
    `Active products: ${PRODUCTS.length} built-in` +
      ` + ${registryExtras.length} registry extra(s)${idList(registryExtras)}` +
      ` + ${paramsExtras.length} new params extra(s)${idList(paramsExtras)}`,
  )
}

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
  console.log("Running pre-broadcast contract tests on local hardhat network (chainId 31337).")
  execFileSync("corepack", ["yarn", "hardhat", "test", "--network", "hardhat"], {
    cwd: packageRoot(),
    env: testEnv,
    stdio: "inherit",
  })
}

async function main() {
  ensureNoRawPrivateKey()
  resolveActiveProducts()
  const chain = await ethers.provider.getNetwork()
  const [deployer] = await ethers.getSigners()
  if (!deployer) throw new Error("No signer available")
  const deployerAddress = deployer.address as `0x${string}`

  if (network.name === "hardhat") {
    const gasPrice = await ethers.provider.getGasPrice()
    const registry = loadRegistry(registryFilePath(repoRoot()), deployerAddress, repoRoot(), process.env.GIWA_EVM_VERSION ?? "cancun", ACTIVE_PRODUCTS)
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          network: network.name,
          chainId: chain.chainId,
          evmVersion: process.env.GIWA_EVM_VERSION ?? "cancun",
          signer: {
            address: deployer.address,
            label: "simulated hardhat account",
          },
          balancePrecheck: await balancePreview(deployer, registry, gasPrice),
          preview: deploymentPreview(deployerAddress, gasPrice, registry, ACTIVE_PRODUCTS),
        },
        null,
        2,
      ),
    )
    return
  }

  if (network.name === "giwaSepolia") {
    if (chain.chainId !== 91342) {
      throw new Error(`GIWA deploy expected chain 91342, got ${chain.chainId}`)
    }
    if (process.env.CONFIRM_GIWA_BROADCAST !== "I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA") {
      throw new Error(
        "Set CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA to broadcast",
      )
    }
    if (deployer.address.toLowerCase() !== EXPECTED_GIWA_DEPLOYER.toLowerCase()) {
      throw new Error(`GIWA deploy signer is ${deployer.address}; expected ${EXPECTED_GIWA_DEPLOYER}`)
    }
    ensureCleanTree()
    ensureContractTestsPass()
  } else {
    throw new Error(`Unsupported deploy network: ${network.name}`)
  }

  const registryPath = registryFilePath(repoRoot())
  const registry = loadRegistry(registryPath, deployerAddress, repoRoot(), process.env.GIWA_EVM_VERSION ?? "cancun", ACTIVE_PRODUCTS)
  registry.activationFlags.dryRun = false
  registry.deployer = deployerAddress

  assertNoStaleOZManifestSplit(registry)
  await assertSufficientBalance(deployer, registry)
  await executeRemainingSteps(registry, registryPath, deployer)

  registry.activationFlags.deployed = true
  registry.activationFlags.dryRun = false
  writeRegistry(registryPath, registry)

  console.log(
    JSON.stringify(
      {
        mode: "broadcast",
        network: network.name,
        chainId: chain.chainId,
        deployer: deployer.address,
        evmVersion: process.env.GIWA_EVM_VERSION ?? "cancun",
        registryPath,
        status: "deployment complete",
      },
      null,
      2,
    ),
  )
}

async function executeRemainingSteps(registry: ResumableRegistry, registryPath: string, deployer: Signer & { address: string }) {
  for (const step of remainingSteps(registry, buildDeploySteps(ACTIVE_PRODUCTS))) {
    if (step.type === "proxy") {
      await executeProxyStep(registry, registryPath, deployer, step)
    } else {
      await executeGrantStep(registry, registryPath, deployer, step)
    }
  }
}

async function executeProxyStep(
  registry: ResumableRegistry,
  registryPath: string,
  deployer: Signer & { address: string },
  step: ProxyStep,
) {
  console.log(`deploying ${step.label} (${step.contractName})`)
  const factory = await ethers.getContractFactory(step.contractName)
  const args = proxyInitializerArgs(step, registry, deployer.address as `0x${string}`)
  const contract = await upgrades.deployProxy(factory, args, {
    initializer: "initialize",
    kind: "transparent",
    txOverrides: await txOverrides("proxy"),
  } as any)
  await contract.deployed()

  const txHash = requireHash(contract.deployTransaction?.hash, `${step.key} proxy deploy`)
  const receipt = await confirmedReceipt(contract.deployTransaction, step.label)
  // GIWA's RPC can lag on read-after-write: right after the deploy tx confirms, the proxy's
  // EIP-1967 impl slot / impl bytecode may briefly read empty on a node that hasn't caught
  // up, so getImplementationAddress throws "...doesn't look like an ERC 1967 proxy with a
  // logic contract address". These are pure reads against an already-confirmed proxy, so
  // retrying with backoff simply waits for propagation. (This lag dropped the bEQTY
  // price-feed registry record on the first run.)
  const { implementation, bytecodeHash, proxyAdmin, proxyAdminHash } = await readbackWithRetry(async () => {
    const implementation = await upgrades.erc1967.getImplementationAddress(contract.address)
    const bytecodeHash = await codeHash(implementation)
    const proxyAdmin = await upgrades.erc1967.getAdminAddress(contract.address)
    const proxyAdminHash = await codeHash(proxyAdmin)
    return { implementation, bytecodeHash, proxyAdmin, proxyAdminHash }
  }, step.label)

  registry.proxyAdmin = {
    proxy: proxyAdmin as `0x${string}`,
    implementation: proxyAdmin as `0x${string}`,
    bytecodeHash: proxyAdminHash,
    logicalLabel: "ProxyAdmin",
    contractName: "ProxyAdmin",
  }
  recordProxyDeployment(registry, step, {
    proxy: contract.address as `0x${string}`,
    implementation: implementation as `0x${string}`,
    bytecodeHash,
    deployTxHash: txHash,
    blockNumber: receipt.blockNumber,
  })
  writeRegistry(registryPath, registry)
  console.log(`confirmed ${step.key}: ${txHash}`)
}

async function executeGrantStep(
  registry: ResumableRegistry,
  registryPath: string,
  deployer: Signer & { address: string },
  step: GrantStep,
) {
  const target = addressForKey(registry, step.targetKey)
  const grantee = addressForKey(registry, step.granteeKey)
  const roleHash = roleId(step.role)
  const access = new Contract(
    target,
    [
      "function hasRole(bytes32 role, address account) view returns (bool)",
      "function grantRole(bytes32 role, address account)",
    ],
    deployer,
  )

  if (await access.hasRole(roleHash, grantee)) {
    const blockNumber = await ethers.provider.getBlockNumber()
    recordRoleGrant(registry, {
      key: step.key,
      role: step.role,
      roleHash,
      target,
      targetKey: step.targetKey,
      grantee,
      granteeKey: step.granteeKey,
      txHash: null,
      blockNumber,
      status: "already-present",
    })
    writeRegistry(registryPath, registry)
    console.log(`skipped ${step.key}: role already present`)
    return
  }

  console.log(`granting ${step.role}: ${step.label}`)
  const tx: ContractTransaction = await access.grantRole(roleHash, grantee, await txOverrides("grant"))
  console.log(`submitted ${step.key}: ${tx.hash}`)
  const receipt = await confirmedReceipt(tx, step.label)
  recordRoleGrant(registry, {
    key: step.key,
    role: step.role,
    roleHash,
    target,
    targetKey: step.targetKey,
    grantee,
    granteeKey: step.granteeKey,
    txHash: tx.hash as `0x${string}`,
    blockNumber: receipt.blockNumber,
    status: "confirmed",
  })
  writeRegistry(registryPath, registry)
  console.log(`confirmed ${step.key}: ${tx.hash}`)
}

async function assertSufficientBalance(deployer: Signer & { address: string }, registry: ResumableRegistry) {
  const gasPrice = await ethers.provider.getGasPrice()
  const remaining = remainingSteps(registry, buildDeploySteps(ACTIVE_PRODUCTS))
  const estimate = estimatedCostWei(remaining, gasPrice)
  const required = withSafetyMargin(estimate)
  const balance = await deployer.getBalance()
  if (balance.lt(required)) {
    const shortfall = required.sub(balance)
    throw new Error(
      [
        "Insufficient GIWA deployer balance for remaining deployment steps.",
        `balance=${ethers.utils.formatEther(balance)} ETH`,
        `estimate=${ethers.utils.formatEther(estimate)} ETH`,
        `requiredWith20PercentMargin=${ethers.utils.formatEther(required)} ETH`,
        `shortfall=${ethers.utils.formatEther(shortfall)} ETH`,
      ].join(" "),
    )
  }
}

function assertNoStaleOZManifestSplit(registry: ResumableRegistry) {
  const hasRegistryState = registry.deploymentRecords.length > 0 || registry.roleGrants.length > 0
  const manifestPath = path.join(packageRoot(), ".openzeppelin/unknown-91342.json")
  if (hasRegistryState || !existsSync(manifestPath)) return

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    proxies?: unknown[]
    impls?: Record<string, unknown>
  }
  const proxyCount = manifest.proxies?.length ?? 0
  const implementationCount = Object.keys(manifest.impls ?? {}).length
  if (proxyCount === 0 && implementationCount === 0) return

  throw new Error(
    [
      "Refusing GIWA deploy: OpenZeppelin has a 91342 manifest but the Arco registry has no deployment records.",
      "The Arco registry is the source of truth for this release and stale OZ manifest addresses will not be adopted.",
      `Found ${proxyCount} manifest proxies and ${implementationCount} implementations.`,
      "Clean-reset first: rm -f packages/contracts/.openzeppelin/unknown-91342.json && npm run registry:generate:giwa",
    ].join(" "),
  )
}

async function balancePreview(deployer: Signer & { address: string }, registry: ResumableRegistry, gasPrice: BigNumber) {
  const remaining = remainingSteps(registry, buildDeploySteps(ACTIVE_PRODUCTS))
  const estimate = estimatedCostWei(remaining, gasPrice)
  const required = withSafetyMargin(estimate)
  const balance = await deployer.getBalance()
  return {
    remainingSteps: remaining.length,
    balanceWei: balance.toString(),
    balanceEth: ethers.utils.formatEther(balance),
    estimatedRemainingCostWei: estimate.toString(),
    estimatedRemainingCostEth: ethers.utils.formatEther(estimate),
    requiredWith20PercentMarginWei: required.toString(),
    requiredWith20PercentMarginEth: ethers.utils.formatEther(required),
    wouldPass: balance.gte(required),
  }
}

function proxyInitializerArgs(step: ProxyStep, registry: ResumableRegistry, admin: `0x${string}`) {
  if (step.slot === "asset") {
    const asset = requireAsset(step.assetSymbol)
    return [asset.name, asset.symbol, asset.decimals, admin]
  }
  if (step.slot === "faucet") {
    return [admin]
  }
  if (step.slot === "productToken") {
    const product = requireProduct(step.productId)
    return [product.name, product.symbol, admin]
  }
  if (step.slot === "priceFeed") {
    // Extras may override feed params (decimals stay fixed at 8); built-ins keep the
    // launch values verbatim.
    const override = step.productId ? INIT_OVERRIDES.get(step.productId) : undefined
    if (override) {
      return [
        8,
        BigNumber.from(override.feedInitialAnswer),
        override.feedHealthyDiffSeconds,
        1,
        BigNumber.from(override.feedMaxAnswer),
        BigNumber.from(override.feedMinAnswer),
        admin,
      ]
    }
    return [
      8,
      BigNumber.from("100000000"),
      3600,
      1,
      BigNumber.from("100000000000000"),
      0,
      admin,
    ]
  }

  const product = requireProduct(step.productId)
  const asset = requireAsset(product.paymentAssetSymbol)
  const productToken = addressForKey(registry, `proxy:product:${product.productId}:productToken`)
  const priceFeed = addressForKey(registry, `proxy:product:${product.productId}:priceFeed`)
  const paymentToken = addressForKey(registry, `proxy:asset:${product.paymentAssetSymbol}`)
  const paymentDecimalsBase = BigNumber.from(10).pow(asset.decimals)

  const override = INIT_OVERRIDES.get(product.productId)
  if (step.slot === "depositVault") {
    return [
      productToken,
      paymentToken,
      priceFeed,
      priceFeed,
      paymentDecimalsBase,
      override ? ethers.utils.parseUnits(override.maxSupplyCapShares, 18) : ethers.utils.parseUnits("1000000", 18),
      override ? ethers.utils.parseUnits(override.vaultMintAllowanceShares, 18) : ethers.utils.parseUnits("500000", 18),
      admin,
    ]
  }
  if (step.slot === "redemptionVault") {
    return [
      productToken,
      paymentToken,
      priceFeed,
      priceFeed,
      ethers.utils.parseUnits("1", 18),
      override ? paymentDecimalsBase.mul(BigNumber.from(override.maxRedemptionPayment)) : paymentDecimalsBase.mul(1_000_000),
      admin,
    ]
  }
  throw new Error(`Unsupported proxy slot ${step.slot}`)
}

async function txOverrides(kind: "proxy" | "grant") {
  const feeData = await ethers.provider.getFeeData()
  const gasLimit = kind === "proxy" ? BigNumber.from(5_000_000) : BigNumber.from(150_000)
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
      () => reject(new Error(`Timed out waiting for ${label} (${tx.hash}). Registry was not advanced; inspect the explorer before resuming.`)),
      TX_TIMEOUT_MS,
    )
  })
  const receipt = await Promise.race([tx.wait(1), timeout])
  if (receipt.status !== 1) throw new Error(`${label} reverted (${tx.hash})`)
  return receipt
}

// Retries a set of post-deploy chain READS (never a transaction) with exponential backoff.
// Safe because the proxy deploy is already confirmed before this runs; we are only waiting
// for a lagging RPC node to expose the freshly written EIP-1967 slot / impl bytecode.
async function readbackWithRetry<T>(readback: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= READBACK_MAX_ATTEMPTS; attempt++) {
    try {
      return await readback()
    } catch (error) {
      lastError = error
      if (attempt === READBACK_MAX_ATTEMPTS) break
      const delayMs = Math.min(READBACK_BASE_DELAY_MS * 2 ** (attempt - 1), READBACK_MAX_DELAY_MS)
      console.log(
        `post-deploy readback for ${label} not ready (attempt ${attempt}/${READBACK_MAX_ATTEMPTS}): ${
          error instanceof Error ? error.message : String(error)
        }. retrying in ${delayMs}ms`,
      )
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw lastError
}

async function codeHash(address: string): Promise<`0x${string}`> {
  const code = await ethers.provider.getCode(address)
  if (!code || code === "0x") throw new Error(`No bytecode at ${address}`)
  return ethers.utils.keccak256(code) as `0x${string}`
}

function roleId(role: RoleName): `0x${string}` {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(role)) as `0x${string}`
}

function requireHash(value: string | undefined, label: string): `0x${string}` {
  if (!value) throw new Error(`Missing tx hash for ${label}`)
  return value as `0x${string}`
}

function requireAsset(symbol: PaymentAssetSymbol | undefined) {
  const asset = PAYMENT_ASSETS.find((item) => item.symbol === symbol)
  if (!asset) throw new Error(`Unknown payment asset ${symbol}`)
  return asset
}

function requireProduct(productId: string | undefined) {
  const product = ACTIVE_PRODUCTS.find((item) => item.productId === productId)
  if (!product) throw new Error(`Unknown product ${productId}`)
  return product
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
