import { execFileSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import path from "path"
import { BigNumber, Contract, ContractReceipt, ContractTransaction, Signer, utils } from "ethers"
import { ethers, network, upgrades } from "hardhat"
import { loadRegistry, registryFilePath, writeRegistry } from "./deploy-registry"
import { EXPECTED_GIWA_DEPLOYER } from "./keystore-constants"

// Upgrades the 6 GIWA ArcoDepositVault proxies to the implementation that adds
// withdrawTo(address,uint256) (admin withdrawal, DEPOSIT_VAULT_ADMIN_ROLE).
//
// Modes:
//   dry-run  (default, CONFIRM_GIWA_BROADCAST unset): read-only — validates the storage
//            layout against the live manifest, reports role + withdrawTo presence per
//            vault, prints the plan JSON. No signer, no transactions, no registry writes.
//   broadcast (CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA): full guarded
//            upgrade via the keystore deployer, mirroring upgrade-product-tokens-giwa.ts.
//
// CUSTODY NOTE: withdrawTo moves user deposits out of the vault. On mainnet the
// DEPOSIT_VAULT_ADMIN_ROLE holder and the ProxyAdmin owner MUST both be the multisig;
// this script's EOA flow is for GIWA Sepolia only.

const TX_TIMEOUT_MS = 180_000
// Minimum: the six launch vaults; 2c-registered vaults raise the count.
const REQUIRED_DEPOSIT_VAULT_COUNT = 6
const forbiddenGiwaEvmVersion = "pra" + "gue"
const DEPOSIT_VAULT_ADMIN_ROLE = utils.keccak256(utils.toUtf8Bytes("DEPOSIT_VAULT_ADMIN_ROLE"))

const PROBE_ABI = [
  "function withdrawTo(address to, uint256 amount)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]

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
    throw new Error("GIWA deposit-vault upgrade must never use prague")
  }
  if (evmVersion !== "cancun") {
    throw new Error(`GIWA deposit-vault upgrade requires evmVersion cancun, got ${evmVersion}`)
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

function ensureLiveManifestContainsDepositVaults(vaultProxies: readonly `0x${string}`[]) {
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
  const missing = vaultProxies.filter((proxy) => !manifestProxies.has(proxy.toLowerCase()))
  if (missing.length > 0) {
    throw new Error(
      `Live GIWA OpenZeppelin manifest is missing ArcoDepositVault proxies: ${missing.join(", ")}`,
    )
  }
  console.log(
    `Using live GIWA OpenZeppelin manifest ${filePath} with ${manifestProxies.size} transparent proxy records.`,
  )
}

type WithdrawToProbe = "present" | "present-no-role" | "absent"

// Existence probe for withdrawTo without broadcasting: an eth_call from the deployer.
// Success → function exists and the role is held. A "missing role" revert still proves the
// function exists (access control executed). Any other revert (fallback/function-not-found)
// → the proxy has not been upgraded yet. Cross-checked against hasRole so a missing role
// can never misclassify an upgraded vault as absent.
async function probeWithdrawTo(proxy: `0x${string}`): Promise<WithdrawToProbe> {
  const iface = new utils.Interface(PROBE_ABI)
  const data = iface.encodeFunctionData("withdrawTo", [EXPECTED_GIWA_DEPLOYER, 0])
  try {
    await ethers.provider.call({ to: proxy, from: EXPECTED_GIWA_DEPLOYER, data })
    return "present"
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("missing role")) return "present-no-role"
    return "absent"
  }
}

async function deployerHoldsVaultAdminRole(proxy: `0x${string}`): Promise<boolean> {
  const vault = new Contract(proxy, PROBE_ABI, ethers.provider)
  return (await vault.hasRole(DEPOSIT_VAULT_ADMIN_ROLE, EXPECTED_GIWA_DEPLOYER)) as boolean
}

async function main() {
  ensureNoRawPrivateKey()
  ensureCancunAndNoPrague()

  const broadcast = process.env.CONFIRM_GIWA_BROADCAST === "I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA"

  const chain = await ethers.provider.getNetwork()
  if (network.name !== "giwaSepolia" || chain.chainId !== 91342) {
    throw new Error(
      `GIWA deposit-vault upgrade expected giwaSepolia chain 91342, got ${network.name} ${chain.chainId}`,
    )
  }

  const registryPath = registryFilePath(repoRoot())
  const registry = loadRegistry(
    registryPath,
    EXPECTED_GIWA_DEPLOYER as `0x${string}`,
    repoRoot(),
    "cancun",
  )
  const targets = registry.products.map((product) => ({
    productId: product.productId,
    symbol: product.symbol,
    proxy: requireAddress(product.depositVault.proxy, `${product.symbol}.depositVault.proxy`),
  }))
  if (targets.length < REQUIRED_DEPOSIT_VAULT_COUNT) {
    throw new Error(
      `Expected at least ${REQUIRED_DEPOSIT_VAULT_COUNT} ArcoDepositVault proxies, got ${targets.length}`,
    )
  }
  ensureLiveManifestContainsDepositVaults(targets.map((target) => target.proxy))

  const ArcoDepositVaultV2 = await ethers.getContractFactory("ArcoDepositVault")

  // Storage-layout safety against the LIVE proxies + manifest. Throws (and stops the
  // run, dry or broadcast) if the new implementation is not layout-compatible.
  const plan: Array<Record<string, unknown>> = []
  for (const target of targets) {
    console.log(`validating ArcoDepositVault upgrade for ${target.symbol} at ${target.proxy}`)
    await upgrades.validateUpgrade(target.proxy, ArcoDepositVaultV2, { kind: "transparent" })

    const [probe, roleHeld, currentImplementation] = await Promise.all([
      probeWithdrawTo(target.proxy),
      deployerHoldsVaultAdminRole(target.proxy),
      upgrades.erc1967.getImplementationAddress(target.proxy),
    ])
    const alreadyUpgraded = probe === "present" || probe === "present-no-role"
    plan.push({
      symbol: target.symbol,
      proxy: target.proxy,
      currentImplementation,
      storageLayout: "compatible",
      deployerHoldsDepositVaultAdminRole: roleHeld,
      withdrawToProbe: probe,
      action: alreadyUpgraded ? "skip (withdrawTo already present)" : "upgradeProxy",
    })
  }

  if (!broadcast) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          network: network.name,
          chainId: chain.chainId,
          expectedDeployer: EXPECTED_GIWA_DEPLOYER,
          storageValidation: "pass (all 6 proxies layout-compatible)",
          targets: plan,
          note: "No transactions sent. Set CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA (with the keystore) to broadcast.",
        },
        null,
        2,
      ),
    )
    return
  }

  const [deployer] = (await ethers.getSigners()) as Array<Signer & { address: string }>
  if (!deployer) throw new Error("No signer available")
  if (deployer.address.toLowerCase() !== EXPECTED_GIWA_DEPLOYER.toLowerCase()) {
    throw new Error(`GIWA upgrade signer is ${deployer.address}; expected ${EXPECTED_GIWA_DEPLOYER}`)
  }

  ensureCleanTree()
  ensureContractTestsPass()

  let upgradedCount = 0
  for (const [index, target] of targets.entries()) {
    const entry = plan[index]
    if (entry.action !== "upgradeProxy") {
      console.log(`${target.symbol} already exposes withdrawTo (${entry.withdrawToProbe}); skipping upgradeProxy`)
      continue
    }
    console.log(`upgrading ${target.symbol} ArcoDepositVault proxy ${target.proxy}`)
    const upgraded = await upgrades.upgradeProxy(target.proxy, ArcoDepositVaultV2, {
      kind: "transparent",
      txOverrides: await txOverrides(),
    } as any)
    await upgraded.deployed()
    const receipt = await confirmedReceipt(upgraded.deployTransaction, `${target.symbol} ArcoDepositVault upgrade`)
    console.log(`confirmed ${target.symbol} ArcoDepositVault upgrade: ${upgraded.deployTransaction.hash}`)
    upgradedCount += 1

    const product = registry.products.find((item) => item.productId === target.productId)
    if (!product) throw new Error(`Missing registry product ${target.productId}`)
    product.depositVault.implementation = (await upgrades.erc1967.getImplementationAddress(target.proxy)) as `0x${string}`
    product.depositVault.bytecodeHash = await codeHash(product.depositVault.implementation)
    product.depositVault.blockNumber = receipt.blockNumber
    writeRegistry(registryPath, registry)
  }

  for (const product of registry.products) {
    if (!product.depositVault.proxy) continue
    product.depositVault.implementation = (await upgrades.erc1967.getImplementationAddress(product.depositVault.proxy)) as `0x${string}`
    product.depositVault.bytecodeHash = await codeHash(product.depositVault.implementation)
  }
  writeRegistry(registryPath, registry)

  console.log(
    JSON.stringify(
      {
        status: "deposit vaults upgraded with admin withdrawTo",
        network: network.name,
        chainId: chain.chainId,
        upgradedDepositVaultCount: upgradedCount,
        skippedCount: targets.length - upgradedCount,
        registryPath,
      },
      null,
      2,
    ),
  )
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
