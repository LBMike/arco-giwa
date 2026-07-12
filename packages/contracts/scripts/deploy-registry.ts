import { execFileSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import path from "path"
import {
  GIWA_BLOCKSCOUT_API_URL,
  GIWA_CHAIN_ID,
  GIWA_EXPLORER_BASE_URL,
  GIWA_NAME,
  GIWA_NETWORK,
  GIWA_PUBLIC_RPC_URL,
  PAYMENT_ASSETS,
  PRODUCT_PAYMENT_MAPPINGS,
  PRODUCTS,
  type ExtendedProductPlan,
  type PaymentAssetSymbol,
  type ProductId,
  type ProxyStep,
  type RoleName,
} from "./deploy-plan"

export type AddressValue = `0x${string}` | null

export type ContractDeployment = {
  proxy: AddressValue
  implementation: AddressValue
  bytecodeHash: `0x${string}` | null
  logicalLabel?: string
  contractName?: string
  deployTxHash?: `0x${string}`
  blockNumber?: number
}

export type DeploymentRecord = {
  key: string
  logicalLabel: string
  contractName: string
  proxy: `0x${string}`
  implementation: `0x${string}`
  bytecodeHash: `0x${string}`
  deployTxHash: `0x${string}`
  blockNumber: number
}

export type RoleGrantRecord = {
  key: string
  role: RoleName
  roleHash: `0x${string}`
  target: `0x${string}`
  targetKey: string
  grantee: `0x${string}`
  granteeKey: string
  txHash: `0x${string}` | null
  blockNumber: number | null
  status: "confirmed" | "already-present"
}

export type ResumableRegistry = {
  schemaVersion: 1
  releaseId: string
  gitCommit: string
  chainId: 91342
  network: "giwa-sepolia"
  name: "GIWA Sepolia"
  nativeCurrency: {
    name: "Ether"
    symbol: "ETH"
    decimals: 18
  }
  publicRpcUrl: "https://sepolia-rpc.giwa.io"
  explorerBaseUrl: "https://sepolia-explorer.giwa.io"
  blockscoutApiUrl: "https://sepolia-explorer.giwa.io/api"
  deploymentBlock: number | null
  deployer: AddressValue
  evmVersion: "cancun" | "shanghai"
  proxyAdmin: ContractDeployment
  roles: {
    tier1DefaultAdmin: AddressValue
    tier1ProxyAdminOwner: AddressValue
    tier1Safe: AddressValue
    tier1Timelock: AddressValue
    tier2Operator: AddressValue
    pauser: AddressValue
    feedAdmin: AddressValue
    faucetAdmin: AddressValue
  }
  activationFlags: {
    deployed: boolean
    dryRun: boolean
    frontendEnabled: boolean
    indexerEnabled: boolean
    onchainAttestationRequired: boolean
  }
  assets: Array<{
    symbol: PaymentAssetSymbol
    name: string
    decimals: number
    contract: ContractDeployment
    faucet: AddressValue
    deploymentBlock: number | null
  }>
  faucet: ContractDeployment
  products: Array<{
    // string (not the closed ProductId union): 2c-2 extra products land here too.
    productId: string
    symbol: string
    name: string
    paymentAssetSymbol: PaymentAssetSymbol
    productToken: ContractDeployment
    depositVault: ContractDeployment
    redemptionVault: ContractDeployment
    priceFeed: ContractDeployment
    deploymentBlock: number | null
    activationFlags: Record<string, boolean>
  }>
  productPaymentMappings: Record<string, string>
  events: unknown
  deploymentRecords: DeploymentRecord[]
  roleGrants: RoleGrantRecord[]
}

export function registryFilePath(repoRoot: string) {
  return path.join(repoRoot, "deployments/91342/arco-giwa-preprod.json")
}

export function gitCommit(repoRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return "unknown"
  }
}

export function loadRegistry(
  filePath: string,
  deployer: `0x${string}`,
  repoRoot: string,
  evmVersion = "cancun",
  products: readonly ExtendedProductPlan[] = PRODUCTS,
) {
  const existing = existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) : {}
  return normalizeRegistry(existing, deployer, gitCommit(repoRoot), evmVersion, products)
}

export function writeRegistry(filePath: string, registry: ResumableRegistry) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`)
  renameSync(tmp, filePath)
}

export function normalizeRegistry(
  existing: Partial<ResumableRegistry>,
  deployer: `0x${string}`,
  commit: string,
  evmVersion = "cancun",
  // 2c-2: extras from GIWA_EXTRA_PRODUCTS must flow through here too, otherwise a
  // later loadRegistry would DROP a deployed extra product from the registry file.
  products: readonly ExtendedProductPlan[] = PRODUCTS,
): ResumableRegistry {
  const deploymentRecords = [...(existing.deploymentRecords ?? [])]
  const roleGrants = [...(existing.roleGrants ?? [])]
  const registry: ResumableRegistry = {
    schemaVersion: 1,
    releaseId: existing.releaseId ?? `giwa-preprod-${new Date().toISOString().slice(0, 10)}`,
    gitCommit: existing.gitCommit && existing.gitCommit !== "unknown" ? existing.gitCommit : commit,
    chainId: GIWA_CHAIN_ID,
    network: GIWA_NETWORK,
    name: GIWA_NAME,
    nativeCurrency: {
      name: "Ether",
      symbol: "ETH",
      decimals: 18,
    },
    publicRpcUrl: GIWA_PUBLIC_RPC_URL,
    explorerBaseUrl: GIWA_EXPLORER_BASE_URL,
    blockscoutApiUrl: GIWA_BLOCKSCOUT_API_URL,
    deploymentBlock: existing.deploymentBlock ?? null,
    deployer,
    evmVersion: evmVersion === "shanghai" ? "shanghai" : "cancun",
    proxyAdmin: existing.proxyAdmin ?? emptyContract(),
    roles: {
      tier1DefaultAdmin: existing.roles?.tier1DefaultAdmin ?? deployer,
      tier1ProxyAdminOwner: existing.roles?.tier1ProxyAdminOwner ?? deployer,
      tier1Safe: existing.roles?.tier1Safe ?? null,
      tier1Timelock: existing.roles?.tier1Timelock ?? null,
      tier2Operator: existing.roles?.tier2Operator ?? deployer,
      pauser: existing.roles?.pauser ?? deployer,
      feedAdmin: existing.roles?.feedAdmin ?? deployer,
      faucetAdmin: existing.roles?.faucetAdmin ?? deployer,
    },
    activationFlags: {
      deployed: false,
      dryRun: false,
      frontendEnabled: false,
      indexerEnabled: false,
      onchainAttestationRequired: false,
      ...existing.activationFlags,
    },
    assets: PAYMENT_ASSETS.map((asset) => {
      const current = existing.assets?.find((item) => item.symbol === asset.symbol)
      return {
        symbol: asset.symbol,
        name: asset.name,
        decimals: asset.decimals,
        contract: current?.contract ?? emptyContract(),
        faucet: current?.faucet ?? null,
        deploymentBlock: current?.deploymentBlock ?? null,
      }
    }),
    faucet: existing.faucet ?? emptyContract(),
    products: products.map((product) => {
      const current = existing.products?.find((item) => item.productId === product.productId || item.symbol === product.symbol)
      return {
        productId: product.productId,
        symbol: product.symbol,
        name: product.name,
        paymentAssetSymbol: product.paymentAssetSymbol,
        productToken: current?.productToken ?? emptyContract(),
        depositVault: current?.depositVault ?? emptyContract(),
        redemptionVault: current?.redemptionVault ?? emptyContract(),
        priceFeed: current?.priceFeed ?? emptyContract(),
        deploymentBlock: current?.deploymentBlock ?? null,
        activationFlags: {
          deployed: false,
          depositsEnabled: false,
          redemptionsEnabled: false,
          adminUiEnabled: false,
          ...current?.activationFlags,
        },
      }
    }),
    productPaymentMappings: {
      ...(existing.productPaymentMappings ?? PRODUCT_PAYMENT_MAPPINGS),
      ...Object.fromEntries(products.map((product) => [product.symbol, product.paymentAssetSymbol])),
    },
    events: existing.events ?? { targetEvents: [], indexedEvents: [], mismatches: [] },
    deploymentRecords,
    roleGrants,
  }

  for (const record of deploymentRecords) {
    applyDeploymentRecord(registry, record)
  }
  for (const grant of roleGrants) {
    upsertGrantRecord(registry, grant)
  }
  updateCompletionFlags(registry)
  return registry
}

export function recordProxyDeployment(
  registry: ResumableRegistry,
  step: ProxyStep,
  record: Omit<DeploymentRecord, "key" | "logicalLabel" | "contractName">,
) {
  const next: DeploymentRecord = {
    key: step.key,
    logicalLabel: step.label,
    contractName: step.contractName,
    ...record,
  }
  registry.deploymentRecords = registry.deploymentRecords.filter((item) => item.key !== step.key)
  registry.deploymentRecords.push(next)
  applyDeploymentRecord(registry, next)
  updateCompletionFlags(registry)
}

export function recordRoleGrant(registry: ResumableRegistry, grant: RoleGrantRecord) {
  upsertGrantRecord(registry, grant)
  updateCompletionFlags(registry)
}

export function addressForKey(registry: ResumableRegistry, key: string): `0x${string}` {
  if (key === "role-address:tier2Operator") return requireAddress(registry.roles.tier2Operator, key)
  if (key === "proxy:faucet") return requireAddress(registry.faucet.proxy, key)
  if (key.startsWith("proxy:asset:")) {
    const symbol = key.split(":")[2] as PaymentAssetSymbol
    return requireAddress(registry.assets.find((asset) => asset.symbol === symbol)?.contract.proxy ?? null, key)
  }
  if (key.startsWith("proxy:product:")) {
    const [, , productId, slot] = key.split(":")
    const product = registry.products.find((item) => item.productId === productId)
    if (!product) throw new Error(`Unknown product key ${key}`)
    if (slot === "productToken") return requireAddress(product.productToken.proxy, key)
    if (slot === "priceFeed") return requireAddress(product.priceFeed.proxy, key)
    if (slot === "depositVault") return requireAddress(product.depositVault.proxy, key)
    if (slot === "redemptionVault") return requireAddress(product.redemptionVault.proxy, key)
  }
  throw new Error(`Cannot resolve address for ${key}`)
}

function applyDeploymentRecord(registry: ResumableRegistry, record: DeploymentRecord) {
  if (registry.deploymentBlock === null || record.blockNumber < registry.deploymentBlock) {
    registry.deploymentBlock = record.blockNumber
  }

  if (record.key === "proxy:faucet") {
    registry.faucet = mergeDeployment(registry.faucet, record)
    for (const asset of registry.assets) {
      asset.faucet = record.proxy
    }
    return
  }

  if (record.key.startsWith("proxy:asset:")) {
    const symbol = record.key.split(":")[2] as PaymentAssetSymbol
    const asset = registry.assets.find((item) => item.symbol === symbol)
    if (!asset) throw new Error(`Unknown asset ${symbol}`)
    asset.contract = mergeDeployment(asset.contract, record)
    asset.deploymentBlock = asset.deploymentBlock ?? record.blockNumber
    return
  }

  if (record.key.startsWith("proxy:product:")) {
    const [, , productId, slot] = record.key.split(":")
    const product = registry.products.find((item) => item.productId === productId)
    if (!product) throw new Error(`Unknown product ${productId}`)
    if (slot === "productToken") product.productToken = mergeDeployment(product.productToken, record)
    if (slot === "priceFeed") product.priceFeed = mergeDeployment(product.priceFeed, record)
    if (slot === "depositVault") product.depositVault = mergeDeployment(product.depositVault, record)
    if (slot === "redemptionVault") product.redemptionVault = mergeDeployment(product.redemptionVault, record)
    product.deploymentBlock = product.deploymentBlock ?? record.blockNumber
  }
}

// products[]/assets[]/faucet are the source of truth for the CURRENT on-chain view: the
// upgrade scripts sync the live implementation AND its block there post-deploy (e.g. the
// ProductToken V2 and DepositVault withdrawTo upgrades write products[*].implementation and
// blockNumber directly). deploymentRecords[] is the immutable deploy-time log, keyed by step
// for resumability. Once a live slot carries an implementation, KEEP the whole live view;
// only populate from the deploy-time record for a slot that has none yet (fresh deploy /
// cold load). Without this guard, re-applying the historical record on every loadRegistry
// silently reverts an upgraded impl (and its block) back to deploy-time values — the bug
// that corrupted the built-in custody references during the bEQTY deploy.
function mergeDeployment(existing: ContractDeployment | undefined, record: DeploymentRecord): ContractDeployment {
  if (existing && existing.implementation) return existing
  return {
    proxy: record.proxy,
    implementation: record.implementation,
    bytecodeHash: record.bytecodeHash,
    logicalLabel: record.logicalLabel,
    contractName: record.contractName,
    deployTxHash: record.deployTxHash,
    blockNumber: record.blockNumber,
  }
}

function upsertGrantRecord(registry: ResumableRegistry, grant: RoleGrantRecord) {
  registry.roleGrants = registry.roleGrants.filter((item) => item.key !== grant.key)
  registry.roleGrants.push(grant)
}

function updateCompletionFlags(registry: ResumableRegistry) {
  const allContractsDeployed = registry.assets.every((asset) => asset.contract.proxy) &&
    Boolean(registry.faucet.proxy) &&
    registry.products.every(
      (product) =>
        product.productToken.proxy &&
        product.priceFeed.proxy &&
        product.depositVault.proxy &&
        product.redemptionVault.proxy,
    )
  if (!allContractsDeployed) {
    registry.activationFlags.deployed = false
    return
  }
  for (const product of registry.products) {
    product.activationFlags.deployed = true
  }
}

function emptyContract(): ContractDeployment {
  return {
    proxy: null,
    implementation: null,
    bytecodeHash: null,
  }
}

function requireAddress(value: AddressValue, label: string): `0x${string}` {
  if (!value) throw new Error(`Missing address for ${label}`)
  return value
}
