import { execFileSync } from "child_process"
import path from "path"
import { BigNumber, Contract, ContractReceipt, ContractTransaction, Signer, utils } from "ethers"
import { ethers, network } from "hardhat"
import { gitCommit, loadRegistry, registryFilePath } from "./deploy-registry"
import { EXPECTED_GIWA_DEPLOYER } from "./keystore-constants"
import {
  arcoUSDRegistryPath,
  defaultArcoUSDRegistry,
  loadArcoUSDRegistry,
  writeArcoUSDRegistry,
  type Address,
} from "./arcousd/arcousd-registry"
import { planArcoUSDDeployment, runArcoUSDDeployment, type CoreRefs } from "./arcousd/deploy-steps"

// Deploys ArcoUSD v1 on GIWA Sepolia (docs/specs/arcousd-v1.md, docs/operations/arcousd-deploy.md):
// tUSDT + tRLUSD test assets, ArcoUSD, ArcoUSDReserve, ArcoUSDReserveLens, ArcoRouter; Reserve
// mint/burn roles and the Router's SETTLER_ROLE; reserve assets (tUSDC/tUSDT/tRLUSD, with swap fees
// and minQueued); uMINT and iBENJI as MMF strategies; faucet drips for the new test assets;
// product-token greenlisting of the Reserve when enforced; the fund deposit vaults the Router may
// buy into.
// It does NOT allocate to MMF (operator step, after the B5 payment-feed repair) and never touches
// existing contracts beyond those grants/configs.
//
// Modes:
//   dry-run (default): read-only plan + preflight role checks. No signer, no tx, no file write.
//   broadcast (CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA, with the keystore):
//            resumable — every step is recorded in deployments/91342/arcousd-giwa.json as it
//            confirms, and a re-run skips what the registry and the chain already show done.

const TX_TIMEOUT_MS = 180_000
const forbiddenGiwaEvmVersion = "pra" + "gue"
const ROLE = (name: string) => utils.keccak256(utils.toUtf8Bytes(name))
const ACCESS_ABI = ["function hasRole(bytes32 role, address account) view returns (bool)"]
const DEPOSIT_VAULT_ABI = ["function paymentToken() view returns (address)"]
const PRE_DEPLOY_TESTS = [
  "test/arcousd-token.test.ts",
  "test/arcousd-reserve.test.ts",
  "test/arcousd-router.test.ts",
  "test/arcousd-deploy.test.ts",
  "test/storage-layout.test.ts",
]

function repoRoot() {
  return path.resolve(__dirname, "../../..")
}

function packageRoot() {
  return path.resolve(__dirname, "..")
}

function ensureNoRawPrivateKey() {
  if (process.env.DEPLOYER_PRIVATE_KEY) throw new Error("Raw private-key deployment is forbidden")
}

function ensureCancunAndNoPrague() {
  const evmVersion = process.env.GIWA_EVM_VERSION ?? "cancun"
  if (evmVersion === forbiddenGiwaEvmVersion) throw new Error("GIWA ArcoUSD deploy must never use prague")
  if (evmVersion !== "cancun") throw new Error(`GIWA ArcoUSD deploy requires evmVersion cancun, got ${evmVersion}`)
}

function ensureCleanTree() {
  if (process.env.ALLOW_DIRTY_GIWA_DEPLOY === "I_UNDERSTAND_DIRTY_TREE_RISK") return
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot(), encoding: "utf8" }).trim()
  if (status) {
    throw new Error(
      "Refusing GIWA broadcast from a dirty git tree. Commit the ArcoUSD registry progress (deployments/91342/arcousd-giwa.json), the OpenZeppelin manifest (packages/contracts/.openzeppelin/unknown-91342.json) and any other changes first, or set ALLOW_DIRTY_GIWA_DEPLOY=I_UNDERSTAND_DIRTY_TREE_RISK for a reviewed exception.",
    )
  }
}

function ensureContractTestsPass() {
  console.log(`Running pre-deploy ArcoUSD tests on the local hardhat network: ${PRE_DEPLOY_TESTS.join(", ")}`)
  execFileSync("corepack", ["yarn", "hardhat", "test", "--network", "hardhat", ...PRE_DEPLOY_TESTS], {
    cwd: packageRoot(),
    env: { ...process.env, HARDHAT_NETWORK: "hardhat", GIWA_REQUIRE_KEYSTORE: "", GIWA_KEYSTORE_PASSWORD: "", CONFIRM_GIWA_BROADCAST: "" },
    stdio: "inherit",
  })
}

function coreRefs(): CoreRefs {
  const registry = loadRegistry(registryFilePath(repoRoot()), EXPECTED_GIWA_DEPLOYER as Address, repoRoot(), "cancun")
  const usdc = registry.assets.find((asset) => asset.symbol === "tUSDC")
  if (!usdc?.contract.proxy) throw new Error("Core registry has no tUSDC proxy")
  if (!registry.faucet.proxy) throw new Error("Core registry has no faucet proxy")
  const products: CoreRefs["products"] = {}
  for (const product of registry.products) {
    if (!product.depositVault.proxy || !product.redemptionVault.proxy || !product.productToken.proxy) continue
    products[product.productId] = {
      depositVault: product.depositVault.proxy,
      redemptionVault: product.redemptionVault.proxy,
      productToken: product.productToken.proxy,
    }
  }
  return {
    admin: EXPECTED_GIWA_DEPLOYER as Address,
    faucet: registry.faucet.proxy,
    assets: { tUSDC: { address: usdc.contract.proxy, decimals: usdc.decimals } },
    products,
  }
}

async function preflight(core: CoreRefs, strategyProducts: string[], routerProducts: string[]) {
  const checks: Record<string, boolean> = {}
  const faucet = new Contract(core.faucet, ACCESS_ABI, ethers.provider)
  checks.deployerIsFaucetAdmin = await faucet.hasRole(ROLE("FAUCET_ADMIN_ROLE"), EXPECTED_GIWA_DEPLOYER)
  for (const productId of strategyProducts) {
    const token = new Contract(core.products[productId].productToken, ACCESS_ABI, ethers.provider)
    checks[`deployerIsGreenlistOperator:${productId}`] = await token.hasRole(ROLE("GREENLIST_OPERATOR_ROLE"), EXPECTED_GIWA_DEPLOYER)
  }
  // The Router can only buy into vaults paid in a Reserve asset (core tUSDC on GIWA).
  const reserveAssets = new Set(Object.values(core.assets).map((asset) => asset.address.toLowerCase()))
  for (const productId of routerProducts) {
    const vault = new Contract(core.products[productId].depositVault, DEPOSIT_VAULT_ABI, ethers.provider)
    checks[`routerVaultPaysReserveAsset:${productId}`] = reserveAssets.has(String(await vault.paymentToken()).toLowerCase())
  }
  const balance = await ethers.provider.getBalance(EXPECTED_GIWA_DEPLOYER)
  return { checks, deployerBalanceEth: utils.formatEther(balance) }
}

async function main() {
  ensureNoRawPrivateKey()
  ensureCancunAndNoPrague()
  const broadcast = process.env.CONFIRM_GIWA_BROADCAST === "I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA"
  const chain = await ethers.provider.getNetwork()
  if (network.name !== "giwaSepolia" || chain.chainId !== 91342) {
    throw new Error(`ArcoUSD deploy expected giwaSepolia chain 91342, got ${network.name} ${chain.chainId}`)
  }

  const core = coreRefs()
  const filePath = arcoUSDRegistryPath(repoRoot())
  const registry = loadArcoUSDRegistry(filePath, () =>
    defaultArcoUSDRegistry(91342, "giwa-sepolia", gitCommit(repoRoot())),
  )
  const plan = planArcoUSDDeployment(registry, core)
  const checks = await preflight(
    core,
    registry.strategies.map((strategy) => strategy.productId),
    registry.routerVaults.map((vault) => vault.productId),
  )

  if (!broadcast) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          network: network.name,
          chainId: chain.chainId,
          deployer: EXPECTED_GIWA_DEPLOYER,
          registryFile: filePath,
          params: registry.params,
          reserveAssets: registry.reserveAssets.map(({ symbol, decimals, minQueued, instantFeeBps, swapFeeBps }) => ({
            symbol,
            decimals,
            minQueued,
            instantFeeBps,
            swapFeeBps,
          })),
          strategies: registry.strategies.map(({ productId, maxAllocation }) => ({ productId, maxAllocation, ...core.products[productId] })),
          routerVaults: registry.routerVaults.map(({ productId, configured }) => ({
            productId,
            configured,
            depositVault: core.products[productId].depositVault,
          })),
          preflight: checks,
          pendingSteps: plan,
          note: "No transactions sent. MMF allocation is NOT part of this script and must wait for the B5 payment-feed repair. Set CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA (with the keystore) to broadcast.",
        },
        null,
        2,
      ),
    )
    return
  }

  const failed = Object.entries(checks.checks).filter(([, ok]) => !ok).map(([name]) => name)
  if (failed.length) throw new Error(`Preflight failed: ${failed.join(", ")}`)
  const [signer] = (await ethers.getSigners()) as Array<Signer & { address: string }>
  if (!signer) throw new Error("No signer available")
  if (signer.address.toLowerCase() !== EXPECTED_GIWA_DEPLOYER.toLowerCase()) {
    throw new Error(`GIWA signer is ${signer.address}; expected ${EXPECTED_GIWA_DEPLOYER}`)
  }
  ensureCleanTree()
  ensureContractTestsPass()

  const result = await runArcoUSDDeployment({
    signer,
    registry,
    core,
    save: (next) => writeArcoUSDRegistry(filePath, next),
    log: (message) => console.log(message),
    txOverrides,
    confirm: confirmedReceipt,
  })
  console.log(
    JSON.stringify(
      {
        status: "ArcoUSD deployed",
        registryFile: filePath,
        arcoUSD: result.arcoUSD.proxy,
        reserve: result.reserve.proxy,
        lens: result.lens.address,
        router: result.router.proxy,
        routerVaults: result.routerVaults,
        testAssets: result.testAssets.map((asset) => ({ symbol: asset.symbol, proxy: asset.contract.proxy })),
        strategies: result.strategies,
        deploymentBlock: result.deploymentBlock,
      },
      null,
      2,
    ),
  )
}

async function txOverrides(kind: "deploy" | "call") {
  const feeData = await ethers.provider.getFeeData()
  const gasLimit = BigNumber.from(kind === "deploy" ? 6_000_000 : 400_000)
  if (feeData.maxFeePerGas) {
    return {
      gasLimit,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? ethers.utils.parseUnits("0.001", "gwei"),
    }
  }
  return { gasLimit, gasPrice: feeData.gasPrice ?? ethers.utils.parseUnits("1", "gwei") }
}

async function confirmedReceipt(tx: ContractTransaction, label: string): Promise<ContractReceipt> {
  console.log(`submitted ${label}: ${tx.hash}`)
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(
            `Timed out waiting for ${label} (${tx.hash}). Check the explorer, commit the registry progress, then re-run: confirmed steps are skipped and a pending deploy is settled by its receipt, not redeployed.`,
          ),
        ),
      TX_TIMEOUT_MS,
    )
  })
  const receipt = await Promise.race([tx.wait(1), timeout])
  if (receipt.status !== 1) throw new Error(`${label} reverted (${tx.hash})`)
  return receipt
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
