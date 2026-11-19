import { execFileSync } from "child_process"
import { existsSync } from "fs"
import path from "path"
import { BigNumber, Contract, ContractReceipt, ContractTransaction, Signer, utils } from "ethers"
import { ethers, network } from "hardhat"
import { gitCommit, registryFilePath } from "./deploy-registry"
import { EXPECTED_GIWA_DEPLOYER } from "./keystore-constants"
import type { Address } from "./arcousd/arcousd-registry"
import { loadCoreRefs } from "./arcousd/core-refs"
import {
  arcoGoldParamsPath,
  arcoGoldRegistryPath,
  loadArcoGoldParams,
  loadArcoGoldRegistry,
  paramsDrift,
  registryFromParams,
  writeArcoGoldRegistry,
  type ArcoGoldRegistry,
} from "./arcogold/arcogold-registry"
import {
  planArcoGoldDeployment,
  runArcoGoldDeployment,
  type GoldCoreRefs,
} from "./arcogold/deploy-steps"

// Deploys the ArcoGOLD savings stack on GIWA Sepolia (docs/operations/arcogold-deploy.md):
// tPAXG (18 dec) + tXAUT (6 dec) test assets with faucet drips; the internal gold ounce unit
// ArcoXAU (ArcoUSDNamed); a gold ArcoUSDReserve proxy (MINTER/BURNER on ArcoXAU) accepting both at
// 1 token = 1 ounce, depeg-checked against a 1.0 ConstantPriceFeed, no fees, no MMF; a Lens;
// ArcoGOLD (SArcoUSDNamed, ERC-4626 over ArcoXAU); an ArcoSavingsZap; and the 1-share seed.
// Parameters: deploy-params/arcogold.json (used for a fresh registry; once a broadcast started the
// registry file is the source of truth and the dry-run reports any drift). No savings distributor.
// It never touches the ArcoUSD stack; on the core it only configures the faucet for the new assets.
//
// Modes:
//   preview (--network hardhat): the plan from the params file + registry file. No chain reads.
//   dry-run (--network giwaSepolia, default): plan + read-only preflight. No signer, no tx, no file write.
//   broadcast (giwaSepolia, CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA, with the
//            keystore): resumable — every step is recorded in deployments/91342/arcogold-giwa.json
//            as it confirms, and a re-run skips what the registry and the chain already show done.

const TX_TIMEOUT_MS = 180_000
const forbiddenGiwaEvmVersion = "pra" + "gue"
const ROLE = (name: string) => utils.keccak256(utils.toUtf8Bytes(name))
const ACCESS_ABI = ["function hasRole(bytes32 role, address account) view returns (bool)"]
const PRE_DEPLOY_TESTS = [
  "test/arcogold.test.ts",
  "test/arcogold-deploy.test.ts",
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
  if (evmVersion === forbiddenGiwaEvmVersion)
    throw new Error("GIWA ArcoGOLD deploy must never use prague")
  if (evmVersion !== "cancun")
    throw new Error(`GIWA ArcoGOLD deploy requires evmVersion cancun, got ${evmVersion}`)
}

function ensureCleanTree() {
  if (process.env.ALLOW_DIRTY_GIWA_DEPLOY === "I_UNDERSTAND_DIRTY_TREE_RISK") return
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: repoRoot(),
    encoding: "utf8",
  }).trim()
  if (status) {
    throw new Error(
      "Refusing GIWA broadcast from a dirty git tree. Commit the ArcoGOLD registry progress (deployments/91342/arcogold-giwa.json), the OpenZeppelin manifest (packages/contracts/.openzeppelin/unknown-91342.json) and any other changes first, or set ALLOW_DIRTY_GIWA_DEPLOY=I_UNDERSTAND_DIRTY_TREE_RISK for a reviewed exception.",
    )
  }
}

function ensureContractTestsPass() {
  console.log(
    `Running pre-deploy ArcoGOLD tests on the local hardhat network: ${PRE_DEPLOY_TESTS.join(", ")}`,
  )
  execFileSync(
    "corepack",
    ["yarn", "hardhat", "test", "--network", "hardhat", ...PRE_DEPLOY_TESTS],
    {
      cwd: packageRoot(),
      env: {
        ...process.env,
        HARDHAT_NETWORK: "hardhat",
        GIWA_REQUIRE_KEYSTORE: "",
        GIWA_KEYSTORE_PASSWORD: "",
        CONFIRM_GIWA_BROADCAST: "",
      },
      stdio: "inherit",
    },
  )
}

function goldCore(): GoldCoreRefs {
  const core = loadCoreRefs(
    registryFilePath(repoRoot()),
    EXPECTED_GIWA_DEPLOYER as Address,
    repoRoot(),
  )
  return { admin: core.admin, faucet: core.faucet }
}

function loadState(chainId: number, networkName: string) {
  const params = loadArcoGoldParams(arcoGoldParamsPath(packageRoot()))
  const filePath = arcoGoldRegistryPath(repoRoot())
  const registry = loadArcoGoldRegistry(filePath, () =>
    registryFromParams(params, chainId, networkName, gitCommit(repoRoot())),
  )
  return { params, filePath, registry, drift: paramsDrift(registry, params) }
}

function summary(registry: ArcoGoldRegistry) {
  return {
    unit: {
      name: registry.unit.name,
      symbol: registry.unit.symbol,
      proxy: registry.unit.contract.proxy,
    },
    savings: {
      name: registry.savings.name,
      symbol: registry.savings.symbol,
      vestingPeriod: registry.savings.params.vestingPeriod,
      seedAsset: registry.savings.seedAsset,
      seeded: registry.savings.seeded,
    },
    reserveParams: registry.params,
    pegFeed: {
      answerBase18: registry.pegFeed.answerBase18,
      maxDepegBps: registry.pegFeed.maxDepegBps,
    },
    testAssets: registry.testAssets.map(({ symbol, decimals, faucet }) => ({
      symbol,
      decimals,
      faucet,
    })),
    reserveAssets: registry.reserveAssets.map(
      ({ symbol, decimals, instantFeeBps, swapFeeBps, depositCap, minQueued }) => ({
        symbol,
        decimals,
        instantFeeBps,
        swapFeeBps,
        depositCap,
        minQueued,
      }),
    ),
  }
}

async function preflight(core: GoldCoreRefs, registry: ArcoGoldRegistry) {
  const checks: Record<string, boolean> = {}
  const faucet = new Contract(core.faucet, ACCESS_ABI, ethers.provider)
  checks.deployerIsFaucetAdmin = await faucet.hasRole(
    ROLE("FAUCET_ADMIN_ROLE"),
    EXPECTED_GIWA_DEPLOYER,
  )
  // The seed asset is minted by the deployer as its admin; if it already exists, the deployer must still hold MINTER on it.
  const seed = registry.testAssets.find((asset) => asset.symbol === registry.savings.seedAsset)
  if (!registry.savings.seeded && seed?.contract.proxy && !seed.contract.pending) {
    const token = new Contract(seed.contract.proxy, ACCESS_ABI, ethers.provider)
    checks.deployerCanMintSeedAsset = await token.hasRole(
      ROLE("MINTER_ROLE"),
      EXPECTED_GIWA_DEPLOYER,
    )
  }
  const balance = await ethers.provider.getBalance(EXPECTED_GIWA_DEPLOYER)
  return { checks, deployerBalanceEth: utils.formatEther(balance) }
}

async function main() {
  ensureNoRawPrivateKey()
  ensureCancunAndNoPrague()
  const broadcast = process.env.CONFIRM_GIWA_BROADCAST === "I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA"
  const chain = await ethers.provider.getNetwork()

  if (network.name === "hardhat") {
    // Preview: no chain reads at all (the in-process hardhat chain has none of GIWA's contracts).
    if (broadcast) throw new Error("Broadcast is only possible on --network giwaSepolia")
    const core = goldCore()
    const { filePath, registry, drift } = loadState(91342, "giwa-sepolia")
    console.log(
      JSON.stringify(
        {
          mode: "preview",
          network: network.name,
          deployer: EXPECTED_GIWA_DEPLOYER,
          faucet: core.faucet,
          registryFile: filePath,
          registryExists: existsSync(filePath),
          paramsDrift: drift,
          ...summary(registry),
          pendingSteps: planArcoGoldDeployment(registry),
          note: "Preview only: nothing read from or sent to any chain, no file written. Run with --network giwaSepolia for the dry-run with on-chain preflight.",
        },
        null,
        2,
      ),
    )
    return
  }

  if (network.name !== "giwaSepolia" || chain.chainId !== 91342) {
    throw new Error(
      `ArcoGOLD deploy expected giwaSepolia chain 91342 (or hardhat for preview), got ${network.name} ${chain.chainId}`,
    )
  }
  const core = goldCore()
  const { filePath, registry, drift } = loadState(chain.chainId, "giwa-sepolia")
  const plan = planArcoGoldDeployment(registry)
  const checks = await preflight(core, registry)

  if (!broadcast) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          network: network.name,
          chainId: chain.chainId,
          deployer: EXPECTED_GIWA_DEPLOYER,
          faucet: core.faucet,
          registryFile: filePath,
          paramsDrift: drift,
          ...summary(registry),
          preflight: checks,
          pendingSteps: plan,
          note: "No transactions sent. Set CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA (with the keystore) to broadcast.",
        },
        null,
        2,
      ),
    )
    return
  }

  if (drift.length) {
    throw new Error(
      `deploy-params/arcogold.json differs from the registry in progress (${drift.join(", ")}). The registry wins once a deploy started: revert the params edit, or review a separate change.`,
    )
  }
  const failed = Object.entries(checks.checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
  if (failed.length) throw new Error(`Preflight failed: ${failed.join(", ")}`)
  const [signer] = (await ethers.getSigners()) as Array<Signer & { address: string }>
  if (!signer) throw new Error("No signer available")
  if (signer.address.toLowerCase() !== EXPECTED_GIWA_DEPLOYER.toLowerCase()) {
    throw new Error(`GIWA signer is ${signer.address}; expected ${EXPECTED_GIWA_DEPLOYER}`)
  }
  ensureCleanTree()
  ensureContractTestsPass()

  const result = await runArcoGoldDeployment({
    signer,
    registry,
    core,
    save: (next) => writeArcoGoldRegistry(filePath, next),
    log: (message) => console.log(message),
    txOverrides,
    confirm: confirmedReceipt,
  })
  console.log(
    JSON.stringify(
      {
        status: "ArcoGOLD deployed",
        registryFile: filePath,
        unit: result.unit.contract.proxy,
        reserve: result.reserve.proxy,
        lens: result.lens.address,
        pegFeed: result.pegFeed.address,
        vault: result.savings.vault.proxy,
        zap: result.savings.zap.address,
        seeded: result.savings.seeded,
        testAssets: result.testAssets.map((asset) => ({
          symbol: asset.symbol,
          proxy: asset.contract.proxy,
        })),
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
      maxPriorityFeePerGas:
        feeData.maxPriorityFeePerGas ?? ethers.utils.parseUnits("0.001", "gwei"),
    }
  }
  return { gasLimit, gasPrice: feeData.gasPrice ?? ethers.utils.parseUnits("1", "gwei") }
}

async function confirmedReceipt(tx: ContractTransaction, label: string): Promise<ContractReceipt> {
  console.log(`submitted ${label}: ${tx.hash}`)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Timed out waiting for ${label} (${tx.hash}). Check the explorer, commit the registry progress, then re-run: confirmed steps are skipped and a pending deploy is settled by its receipt, not redeployed.`,
          ),
        ),
      TX_TIMEOUT_MS,
    )
  })
  try {
    const receipt = await Promise.race([tx.wait(1), timeout])
    if (receipt.status !== 1) throw new Error(`${label} reverted (${tx.hash})`)
    return receipt
  } finally {
    clearTimeout(timer)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
