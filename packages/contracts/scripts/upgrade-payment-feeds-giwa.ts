import { execFileSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import path from "path"
import { BigNumber, Contract, ContractReceipt, ContractTransaction, Signer, utils } from "ethers"
import { ethers, network, upgrades } from "hardhat"
import { mergeActiveProducts, registryExtraProducts } from "./deploy-plan"
import { loadRegistry, registryFilePath, writeRegistry } from "./deploy-registry"
import { EXPECTED_GIWA_DEPLOYER } from "./keystore-constants"

// Repairs the GIWA vault quotes. deploy-giwa.ts initialized every ArcoDepositVault and
// ArcoRedemptionVault with the product feed as BOTH productPriceFeed and paymentPriceFeed, so
// quoteDeposit / quoteRedeem are always 1:1 whatever the NAV. This script:
//   1. upgrades every deposit + redemption vault proxy to the implementation that adds
//      setPaymentPriceFeed(address) (DEFAULT_ADMIN_ROLE; no storage change),
//   2. deploys ONE immutable ConstantPriceFeed(1e18) (or reuses PAYMENT_CONSTANT_FEED),
//   3. calls setPaymentPriceFeed(constantFeed) on every vault whose payment feed still equals
//      its product feed.
// The product feeds publish NAV in payment-asset units (navBase), so the payment asset is
// worth exactly 1.0 of itself: a constant 1e18 is the correct payment rate for every product.
//
// Modes:
//   dry-run  (default, CONFIRM_GIWA_BROADCAST unset): read-only — validates both storage
//            layouts against the live manifest, reports per vault: current feeds, whether they
//            are equal (the bug), whether setPaymentPriceFeed already exists, the deployer's
//            DEFAULT_ADMIN_ROLE, and the planned action. No signer, no tx, no registry write.
//   broadcast (CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA): run by a human
//            with the keystore (see docs/operations/payment-feed-repair.md).
//
// Open requests are unaffected: deposit and redemption requests lock their rates/amounts at
// request time. Only NEW quotes change (to NAV pricing).

const TX_TIMEOUT_MS = 180_000
const REQUIRED_PRODUCT_COUNT = 6
const forbiddenGiwaEvmVersion = "pra" + "gue"
const DEFAULT_ADMIN_ROLE = "0x" + "00".repeat(32)
const CONSTANT_ANSWER = utils.parseUnits("1", 18)

const VAULT_ABI = [
  "function productPriceFeed() view returns (address)",
  "function paymentPriceFeed() view returns (address)",
  "function setPaymentPriceFeed(address paymentPriceFeed_)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]
const FEED_ABI = ["function getDataInBase18() view returns (uint256)"]

type VaultKind = "depositVault" | "redemptionVault"
type SetterProbe = "present" | "present-no-role" | "absent"

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
  if (process.env.DEPLOYER_PRIVATE_KEY) throw new Error("Raw private-key deployment is forbidden")
}

function ensureCancunAndNoPrague() {
  const evmVersion = process.env.GIWA_EVM_VERSION ?? "cancun"
  if (evmVersion === forbiddenGiwaEvmVersion) throw new Error("GIWA payment-feed upgrade must never use prague")
  if (evmVersion !== "cancun") throw new Error(`GIWA payment-feed upgrade requires evmVersion cancun, got ${evmVersion}`)
}

function ensureCleanTree() {
  if (process.env.ALLOW_DIRTY_GIWA_DEPLOY === "I_UNDERSTAND_DIRTY_TREE_RISK") return
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot(), encoding: "utf8" }).trim()
  if (status) {
    throw new Error(
      "Refusing GIWA broadcast from a dirty git tree. Commit/revert changes, or set ALLOW_DIRTY_GIWA_DEPLOY=I_UNDERSTAND_DIRTY_TREE_RISK for a reviewed exception.",
    )
  }
}

// The suites that exercise what this upgrade touches (vault quoting, pauses, withdrawTo, the
// payment-feed repair against a frozen copy of the live implementations, storage layouts,
// registry implementation sync). Scoped on purpose: unrelated Stocks / deploy-params suites
// have pre-existing failures that must not block — or be waved through with — a vault fix.
const PRE_UPGRADE_TESTS = [
  "test/arco-harness.test.ts",
  "test/payment-price-feed.test.ts",
  "test/price-feed-init-args.test.ts",
  "test/storage-layout.test.ts",
  "test/registry-impl-preservation.test.ts",
]

function ensureContractTestsPass() {
  const testEnv = {
    ...process.env,
    HARDHAT_NETWORK: "hardhat",
    GIWA_REQUIRE_KEYSTORE: "",
    GIWA_KEYSTORE_PASSWORD: "",
    CONFIRM_GIWA_BROADCAST: "",
  }
  console.log(`Running pre-upgrade vault tests on local hardhat network (chainId 31337): ${PRE_UPGRADE_TESTS.join(", ")}`)
  execFileSync("corepack", ["yarn", "hardhat", "test", "--network", "hardhat", ...PRE_UPGRADE_TESTS], {
    cwd: packageRoot(),
    env: testEnv,
    stdio: "inherit",
  })
}

function ensureLiveManifestContains(proxies: readonly `0x${string}`[]) {
  const filePath = manifestPath()
  if (!existsSync(filePath)) throw new Error(`Missing live GIWA OpenZeppelin manifest: ${filePath}`)
  const manifest = JSON.parse(readFileSync(filePath, "utf8")) as { proxies?: Array<{ address?: string }> }
  const known = new Set((manifest.proxies ?? []).map((proxy) => proxy.address?.toLowerCase()).filter(Boolean))
  const missing = proxies.filter((proxy) => !known.has(proxy.toLowerCase()))
  if (missing.length > 0) throw new Error(`Live GIWA OpenZeppelin manifest is missing vault proxies: ${missing.join(", ")}`)
  console.log(`Using live GIWA OpenZeppelin manifest ${filePath} with ${known.size} transparent proxy records.`)
}

// eth_call setPaymentPriceFeed(0) from the deployer: the upgraded implementation answers with
// "payment feed zero" (or a missing-role revert); the old one reverts without either reason.
async function probeSetter(proxy: `0x${string}`): Promise<SetterProbe> {
  const data = new utils.Interface(VAULT_ABI).encodeFunctionData("setPaymentPriceFeed", [ethers.constants.AddressZero])
  try {
    await ethers.provider.call({ to: proxy, from: EXPECTED_GIWA_DEPLOYER, data })
    return "present" // unreachable for address(0), kept for completeness
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("payment feed zero")) return "present"
    if (message.includes("missing role")) return "present-no-role"
    return "absent"
  }
}

type Target = {
  productId: string
  symbol: string
  kind: VaultKind
  proxy: `0x${string}`
}

async function main() {
  ensureNoRawPrivateKey()
  ensureCancunAndNoPrague()
  const broadcast = process.env.CONFIRM_GIWA_BROADCAST === "I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA"

  const chain = await ethers.provider.getNetwork()
  if (network.name !== "giwaSepolia" || chain.chainId !== 91342) {
    throw new Error(`GIWA payment-feed upgrade expected giwaSepolia chain 91342, got ${network.name} ${chain.chainId}`)
  }

  const registryPath = registryFilePath(repoRoot())
  // The built-in products plus the extras the registry already records (beqty, arcousd): without them the load replays
  // their deployment records and stops with "Unknown product", and a write would drop them from the file.
  const products = mergeActiveProducts(registryExtraProducts(JSON.parse(readFileSync(registryPath, "utf8"))), [])
  const registry = loadRegistry(registryPath, EXPECTED_GIWA_DEPLOYER as `0x${string}`, repoRoot(), "cancun", products)
  if (registry.products.length < REQUIRED_PRODUCT_COUNT) {
    throw new Error(`Expected at least ${REQUIRED_PRODUCT_COUNT} products, got ${registry.products.length}`)
  }
  const targets: Target[] = registry.products.flatMap((product) =>
    (["depositVault", "redemptionVault"] as const).map((kind) => ({
      productId: product.productId,
      symbol: product.symbol,
      kind,
      proxy: requireAddress(product[kind].proxy, `${product.symbol}.${kind}.proxy`),
    })),
  )
  ensureLiveManifestContains(targets.map((target) => target.proxy))

  const factories = {
    depositVault: await ethers.getContractFactory("ArcoDepositVault"),
    redemptionVault: await ethers.getContractFactory("ArcoRedemptionVault"),
  }

  const reuseFeed = process.env.PAYMENT_CONSTANT_FEED
  if (reuseFeed && !utils.isAddress(reuseFeed)) throw new Error("PAYMENT_CONSTANT_FEED must be an address")
  if (reuseFeed) {
    const answer = (await new Contract(reuseFeed, FEED_ABI, ethers.provider).getDataInBase18()) as BigNumber
    if (!answer.eq(CONSTANT_ANSWER)) throw new Error(`PAYMENT_CONSTANT_FEED answers ${answer.toString()}, expected 1e18`)
  }

  const plan: Array<Record<string, unknown>> = []
  for (const target of targets) {
    console.log(`validating ${target.kind} upgrade for ${target.symbol} at ${target.proxy}`)
    await upgrades.validateUpgrade(target.proxy, factories[target.kind], { kind: "transparent" })
    const vault = new Contract(target.proxy, VAULT_ABI, ethers.provider)
    const [productFeed, paymentFeed, adminRole, setter, currentImplementation] = await Promise.all([
      vault.productPriceFeed() as Promise<string>,
      vault.paymentPriceFeed() as Promise<string>,
      vault.hasRole(DEFAULT_ADMIN_ROLE, EXPECTED_GIWA_DEPLOYER) as Promise<boolean>,
      probeSetter(target.proxy),
      upgrades.erc1967.getImplementationAddress(target.proxy),
    ])
    const feedsEqual = productFeed.toLowerCase() === paymentFeed.toLowerCase()
    plan.push({
      symbol: target.symbol,
      vault: target.kind,
      proxy: target.proxy,
      currentImplementation,
      storageLayout: "compatible",
      productPriceFeed: productFeed,
      paymentPriceFeed: paymentFeed,
      paymentFeedEqualsProductFeed: feedsEqual,
      deployerHoldsDefaultAdminRole: adminRole,
      setPaymentPriceFeedProbe: setter,
      upgrade: setter === "absent" ? "upgradeProxy" : "skip (setter present)",
      setFeed: feedsEqual ? "setPaymentPriceFeed(constantFeed)" : "skip (payment feed already distinct)",
    })
  }
  const needsFeed = plan.some((entry) => entry.paymentFeedEqualsProductFeed)
  const missingRole = plan.filter((entry) => entry.paymentFeedEqualsProductFeed && !entry.deployerHoldsDefaultAdminRole)

  if (!broadcast) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          network: network.name,
          chainId: chain.chainId,
          expectedDeployer: EXPECTED_GIWA_DEPLOYER,
          storageValidation: `pass (${targets.length} proxies layout-compatible)`,
          constantFeed: reuseFeed ? `reuse ${reuseFeed}` : needsFeed ? "deploy ConstantPriceFeed(1e18)" : "not needed",
          vaultsMissingDefaultAdminRole: missingRole.map((entry) => `${entry.symbol}.${entry.vault}`),
          targets: plan,
          note: "No transactions sent. Set CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA (with the keystore) to broadcast.",
        },
        null,
        2,
      ),
    )
    return
  }

  if (missingRole.length > 0) {
    throw new Error(`Deployer lacks DEFAULT_ADMIN_ROLE on: ${missingRole.map((entry) => `${entry.symbol}.${entry.vault}`).join(", ")}`)
  }
  const [deployer] = (await ethers.getSigners()) as Array<Signer & { address: string }>
  if (!deployer) throw new Error("No signer available")
  if (deployer.address.toLowerCase() !== EXPECTED_GIWA_DEPLOYER.toLowerCase()) {
    throw new Error(`GIWA upgrade signer is ${deployer.address}; expected ${EXPECTED_GIWA_DEPLOYER}`)
  }
  ensureCleanTree()
  ensureContractTestsPass()

  // 1. Upgrades.
  let upgradedCount = 0
  for (const [index, target] of targets.entries()) {
    if (plan[index].upgrade !== "upgradeProxy") {
      console.log(`${target.symbol} ${target.kind} already exposes setPaymentPriceFeed; skipping upgradeProxy`)
      continue
    }
    console.log(`upgrading ${target.symbol} ${target.kind} proxy ${target.proxy}`)
    const upgraded = await upgrades.upgradeProxy(target.proxy, factories[target.kind], {
      kind: "transparent",
      txOverrides: await txOverrides(900_000),
    } as any)
    await upgraded.deployed()
    const receipt = await confirmedReceipt(upgraded.deployTransaction, `${target.symbol} ${target.kind} upgrade`)
    upgradedCount += 1
    const product = registry.products.find((item) => item.productId === target.productId)
    if (!product) throw new Error(`Missing registry product ${target.productId}`)
    product[target.kind].implementation = (await upgrades.erc1967.getImplementationAddress(target.proxy)) as `0x${string}`
    product[target.kind].bytecodeHash = await codeHash(product[target.kind].implementation as string)
    product[target.kind].blockNumber = receipt.blockNumber
    writeRegistry(registryPath, registry)
  }

  // 2. The constant feed (one for all vaults).
  let constantFeed = reuseFeed ?? null
  if (!constantFeed && needsFeed) {
    const factory = await ethers.getContractFactory("ConstantPriceFeed", deployer)
    const feed = await factory.deploy(CONSTANT_ANSWER, await txOverrides(400_000))
    // Logged BEFORE waiting: on a timeout the operator still has the address to resume with
    // (PAYMENT_CONSTANT_FEED=<address>) instead of deploying a second feed.
    console.log(`ConstantPriceFeed(1e18) deploying at ${feed.address} (tx ${feed.deployTransaction.hash})`)
    await confirmedReceipt(feed.deployTransaction, `ConstantPriceFeed deploy at ${feed.address}`)
    constantFeed = feed.address
    console.log(`deployed ConstantPriceFeed(1e18) at ${constantFeed}`)
  }

  // 3. Point every buggy vault at it, then read back.
  let setCount = 0
  for (const [index, target] of targets.entries()) {
    if (!plan[index].paymentFeedEqualsProductFeed || !constantFeed) continue
    const vault = new Contract(target.proxy, VAULT_ABI, deployer)
    const tx = (await vault.setPaymentPriceFeed(constantFeed, await txOverrides(150_000))) as ContractTransaction
    await confirmedReceipt(tx, `${target.symbol} ${target.kind} setPaymentPriceFeed`)
    const now = ((await vault.paymentPriceFeed()) as string).toLowerCase()
    if (now !== constantFeed.toLowerCase()) throw new Error(`${target.symbol} ${target.kind} paymentPriceFeed read-back mismatch`)
    setCount += 1
  }

  for (const product of registry.products) {
    for (const kind of ["depositVault", "redemptionVault"] as const) {
      if (!product[kind].proxy) continue
      product[kind].implementation = (await upgrades.erc1967.getImplementationAddress(product[kind].proxy as string)) as `0x${string}`
      product[kind].bytecodeHash = await codeHash(product[kind].implementation as string)
    }
  }
  writeRegistry(registryPath, registry)

  console.log(
    JSON.stringify(
      {
        status: "vault payment feeds repaired",
        network: network.name,
        chainId: chain.chainId,
        upgradedVaultCount: upgradedCount,
        paymentFeedsSet: setCount,
        constantFeed,
        registryPath,
      },
      null,
      2,
    ),
  )
}

async function txOverrides(gas: number) {
  const feeData = await ethers.provider.getFeeData()
  const gasLimit = BigNumber.from(gas)
  if (feeData.maxFeePerGas) {
    return {
      gasLimit,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? ethers.utils.parseUnits("0.001", "gwei"),
    }
  }
  return { gasLimit, gasPrice: feeData.gasPrice ?? ethers.utils.parseUnits("1", "gwei") }
}

async function confirmedReceipt(tx: ContractTransaction | undefined, label: string): Promise<ContractReceipt> {
  if (!tx) throw new Error(`Missing transaction object for ${label}`)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${label} (${tx.hash}). Inspect the explorer before resuming.`)),
      TX_TIMEOUT_MS,
    )
  })
  try {
    const receipt = await Promise.race([tx.wait(1), timeout])
    if (receipt.status !== 1) throw new Error(`${label} reverted (${tx.hash})`)
    return receipt
  } finally {
    // A pending timer would keep the script running for the rest of the timeout after its last transaction.
    clearTimeout(timer)
  }
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
