import { BigNumber, utils } from "ethers"

export type PaymentAssetSymbol = "tUSDC" | "tBTC" | "tXRP" | "tWETH"
export type ProductId = "acapix" | "ibenji" | "umint" | "abtc" | "axrp" | "aeth"
export type ProductSymbol = "aCAPIX" | "iBENJI" | "uMINT" | "aBTC" | "aXRP" | "aETH"
export type ContractSlot =
  | "asset"
  | "faucet"
  | "productToken"
  | "priceFeed"
  | "depositVault"
  | "redemptionVault"

export type PaymentAssetPlan = {
  readonly symbol: PaymentAssetSymbol
  readonly name: string
  readonly decimals: number
}

export type ProductPlan = {
  readonly productId: ProductId
  readonly symbol: ProductSymbol
  readonly name: string
  readonly paymentAssetSymbol: PaymentAssetSymbol
}

// 2c-2: extra products from a GIWA_EXTRA_PRODUCTS params file share the built-in plan
// shape but carry open string ids/symbols (validated by deploy-params.ts before use).
export type ExtendedProductPlan = {
  readonly productId: string
  readonly symbol: string
  readonly name: string
  readonly paymentAssetSymbol: PaymentAssetSymbol
}

export type ProxyStep = {
  readonly type: "proxy"
  readonly key: string
  readonly slot: ContractSlot
  readonly label: string
  readonly contractName: string
  readonly estimateGas: BigNumber
  readonly assetSymbol?: PaymentAssetSymbol
  readonly productId?: string
}

export type GrantStep = {
  readonly type: "grant"
  readonly key: string
  readonly label: string
  readonly role: RoleName
  readonly targetKey: string
  readonly granteeKey: string
  readonly estimateGas: BigNumber
  readonly productId?: string
  readonly assetSymbol?: PaymentAssetSymbol
}

export type DeployStep = ProxyStep | GrantStep

export type RoleName =
  | "MINTER_ROLE"
  | "BURNER_ROLE"
  | "GREENLIST_OPERATOR_ROLE"
  | "PAUSER_ROLE"
  | "DEPOSIT_VAULT_ADMIN_ROLE"
  | "REDEMPTION_VAULT_ADMIN_ROLE"
  | "FEED_ADMIN_ROLE"

export type StepCompletionView = {
  readonly deploymentRecords?: readonly { readonly key?: string }[]
  readonly roleGrants?: readonly { readonly key?: string }[]
}

export const REGISTRY_OUTPUT_PATH = "deployments/91342/arco-giwa-preprod.json"
export const GIWA_CHAIN_ID = 91342
export const GIWA_NETWORK = "giwa-sepolia"
export const GIWA_NAME = "GIWA Sepolia"
export const GIWA_PUBLIC_RPC_URL = "https://sepolia-rpc.giwa.io"
export const GIWA_EXPLORER_BASE_URL = "https://sepolia-explorer.giwa.io"
export const GIWA_BLOCKSCOUT_API_URL = "https://sepolia-explorer.giwa.io/api"
export const BALANCE_SAFETY_MARGIN_BPS = 12_000

export const PAYMENT_ASSETS: readonly PaymentAssetPlan[] = [
  { symbol: "tUSDC", name: "Test USDC", decimals: 6 },
  { symbol: "tBTC", name: "Test BTC", decimals: 8 },
  { symbol: "tXRP", name: "Test XRP", decimals: 6 },
  { symbol: "tWETH", name: "Test WETH", decimals: 18 },
]

export const PRODUCTS: readonly ProductPlan[] = [
  { productId: "acapix", symbol: "aCAPIX", name: "Arco CAPIX", paymentAssetSymbol: "tUSDC" },
  { productId: "ibenji", symbol: "iBENJI", name: "Arco BENJI", paymentAssetSymbol: "tUSDC" },
  { productId: "umint", symbol: "uMINT", name: "Arco MINT", paymentAssetSymbol: "tUSDC" },
  { productId: "abtc", symbol: "aBTC", name: "Arco BTC", paymentAssetSymbol: "tBTC" },
  { productId: "axrp", symbol: "aXRP", name: "Arco XRP", paymentAssetSymbol: "tXRP" },
  { productId: "aeth", symbol: "aETH", name: "Arco ETH", paymentAssetSymbol: "tWETH" },
]

export const PRODUCT_PAYMENT_MAPPINGS: Record<ProductSymbol, PaymentAssetSymbol> =
  Object.fromEntries(PRODUCTS.map((product) => [product.symbol, product.paymentAssetSymbol])) as Record<
    ProductSymbol,
    PaymentAssetSymbol
  >

export const GAS_ESTIMATES = {
  transparentProxyWithImplementation: BigNumber.from(2_800_000),
  roleGrant: BigNumber.from(55_000),
}

export function assetKey(symbol: PaymentAssetSymbol) {
  return `proxy:asset:${symbol}`
}

export function faucetKey() {
  return "proxy:faucet"
}

export function productKey(productId: string, slot: "productToken" | "priceFeed" | "depositVault" | "redemptionVault") {
  return `proxy:product:${productId}:${slot}`
}

export function tier2Key() {
  return "role-address:tier2Operator"
}

export function grantKey(targetKey: string, role: RoleName, granteeKey: string) {
  return `grant:${targetKey}:${role}:${granteeKey}`
}

// 2c-2: extra products already recorded in the registry file (productId not among the 6
// built-ins). Read from the RAW registry BEFORE normalizeRegistry so a previously-deployed
// extra is included in ACTIVE_PRODUCTS — otherwise normalizeRegistry replays that extra's
// deploymentRecords and throws "Unknown product" (registry.products would omit it). The raw
// registry products[] carries { productId, symbol, name, paymentAssetSymbol } per product,
// which is exactly ExtendedProductPlan.
export function registryExtraProducts(rawRegistry: unknown): ExtendedProductPlan[] {
  const builtinIds = new Set(PRODUCTS.map((product) => product.productId))
  const products = rawRegistry && typeof rawRegistry === "object" ? (rawRegistry as { products?: unknown }).products : undefined
  if (!Array.isArray(products)) return []
  const extras: ExtendedProductPlan[] = []
  for (const entry of products) {
    if (!entry || typeof entry !== "object") continue
    const { productId, symbol, name, paymentAssetSymbol } = entry as Record<string, unknown>
    if (typeof productId !== "string" || builtinIds.has(productId)) continue
    if (typeof symbol !== "string" || typeof name !== "string" || typeof paymentAssetSymbol !== "string") {
      throw new Error(`Registry extra "${productId}" is missing symbol/name/paymentAssetSymbol — cannot rebuild its deploy plan`)
    }
    extras.push({ productId, symbol, name, paymentAssetSymbol: paymentAssetSymbol as PaymentAssetSymbol })
  }
  return extras
}

// Final ACTIVE_PRODUCTS for a run: built-ins + already-recorded registry extras + new
// params-file extras, deduped by productId (first wins). Dedup is a defensive net — the new
// params file is separately validated to reject any collision with an existing vault.
export function mergeActiveProducts(
  registryExtras: readonly ExtendedProductPlan[],
  paramsExtras: readonly ExtendedProductPlan[],
): ExtendedProductPlan[] {
  const seen = new Set<string>()
  const merged: ExtendedProductPlan[] = []
  for (const product of [...PRODUCTS, ...registryExtras, ...paramsExtras]) {
    if (seen.has(product.productId)) continue
    seen.add(product.productId)
    merged.push(product)
  }
  return merged
}

export function buildDeploySteps(products: readonly ExtendedProductPlan[] = PRODUCTS): DeployStep[] {
  const steps: DeployStep[] = []

  for (const asset of PAYMENT_ASSETS) {
    steps.push(proxyStep(assetKey(asset.symbol), "asset", asset.symbol, "TestAssetToken", {
      assetSymbol: asset.symbol,
    }))
  }

  steps.push(proxyStep(faucetKey(), "faucet", "test-asset-faucet", "TestAssetFaucet"))

  for (const asset of PAYMENT_ASSETS) {
    steps.push(grantStep(assetKey(asset.symbol), "MINTER_ROLE", faucetKey(), {
      label: `${asset.symbol}: grant faucet MINTER_ROLE`,
      assetSymbol: asset.symbol,
    }))
  }

  for (const product of products) {
    steps.push(proxyStep(productKey(product.productId, "productToken"), "productToken", product.symbol, "ProductToken", {
      productId: product.productId,
    }))
    steps.push(grantStep(productKey(product.productId, "productToken"), "GREENLIST_OPERATOR_ROLE", tier2Key(), {
      label: `${product.symbol}: grant Tier 2 GREENLIST_OPERATOR_ROLE`,
      productId: product.productId,
    }))
  }

  for (const product of products) {
    steps.push(proxyStep(productKey(product.productId, "priceFeed"), "priceFeed", `${product.symbol}-price-feed`, "ProductPriceFeed", {
      productId: product.productId,
    }))
    steps.push(grantStep(productKey(product.productId, "priceFeed"), "FEED_ADMIN_ROLE", tier2Key(), {
      label: `${product.symbol}: grant Tier 2 FEED_ADMIN_ROLE`,
      productId: product.productId,
    }))
  }

  for (const product of products) {
    steps.push(
      proxyStep(
        productKey(product.productId, "depositVault"),
        "depositVault",
        `${product.symbol}-deposit-vault`,
        "ArcoDepositVault",
        { productId: product.productId },
      ),
    )
    steps.push(grantStep(productKey(product.productId, "productToken"), "MINTER_ROLE", productKey(product.productId, "depositVault"), {
      label: `${product.symbol}: grant deposit vault MINTER_ROLE`,
      productId: product.productId,
    }))
    steps.push(grantStep(productKey(product.productId, "depositVault"), "DEPOSIT_VAULT_ADMIN_ROLE", tier2Key(), {
      label: `${product.symbol}: grant Tier 2 DEPOSIT_VAULT_ADMIN_ROLE`,
      productId: product.productId,
    }))
    steps.push(grantStep(productKey(product.productId, "depositVault"), "PAUSER_ROLE", tier2Key(), {
      label: `${product.symbol}: grant Tier 2 deposit vault PAUSER_ROLE`,
      productId: product.productId,
    }))
  }

  for (const product of products) {
    steps.push(
      proxyStep(
        productKey(product.productId, "redemptionVault"),
        "redemptionVault",
        `${product.symbol}-redemption-vault`,
        "ArcoRedemptionVault",
        { productId: product.productId },
      ),
    )
    steps.push(grantStep(productKey(product.productId, "productToken"), "BURNER_ROLE", productKey(product.productId, "redemptionVault"), {
      label: `${product.symbol}: grant redemption vault BURNER_ROLE`,
      productId: product.productId,
    }))
    steps.push(grantStep(productKey(product.productId, "redemptionVault"), "REDEMPTION_VAULT_ADMIN_ROLE", tier2Key(), {
      label: `${product.symbol}: grant Tier 2 REDEMPTION_VAULT_ADMIN_ROLE`,
      productId: product.productId,
    }))
    steps.push(grantStep(productKey(product.productId, "redemptionVault"), "PAUSER_ROLE", tier2Key(), {
      label: `${product.symbol}: grant Tier 2 redemption vault PAUSER_ROLE`,
      productId: product.productId,
    }))
  }

  return steps
}

export function isStepComplete(registry: StepCompletionView, step: DeployStep) {
  const records = step.type === "proxy" ? registry.deploymentRecords : registry.roleGrants
  return Boolean(records?.some((record) => record.key === step.key))
}

export function remainingSteps(registry: StepCompletionView, steps: readonly DeployStep[] = buildDeploySteps()) {
  return steps.filter((step) => !isStepComplete(registry, step))
}

export function estimateGasForSteps(steps: readonly DeployStep[]) {
  return steps.reduce((total, step) => total.add(step.estimateGas), BigNumber.from(0))
}

export function estimatedCostWei(steps: readonly DeployStep[], gasPriceWei: BigNumber) {
  return estimateGasForSteps(steps).mul(gasPriceWei)
}

export function withSafetyMargin(costWei: BigNumber) {
  return costWei.mul(BALANCE_SAFETY_MARGIN_BPS).div(10_000)
}

export function deploymentPreview(
  adminAddress: string,
  gasPriceWei: BigNumber,
  registry: StepCompletionView = {},
  products: readonly ExtendedProductPlan[] = PRODUCTS,
) {
  const steps = buildDeploySteps(products)
  const remaining = remainingSteps(registry, steps)
  const estimatedGas = estimateGasForSteps(steps)
  const remainingGas = estimateGasForSteps(remaining)
  const roughEthCostWei = estimatedCostWei(steps, gasPriceWei)
  const remainingCostWei = estimatedCostWei(remaining, gasPriceWei)
  const remainingCostWithMarginWei = withSafetyMargin(remainingCostWei)

  return {
    registryPath: REGISTRY_OUTPUT_PATH,
    resumability: {
      totalSteps: steps.length,
      completedSteps: steps.length - remaining.length,
      remainingSteps: remaining.length,
      writes: "live deploy writes the registry after every confirmed proxy deployment and role grant",
    },
    simulatedAdmin: {
      tier1DefaultAdmin: adminAddress,
      tier1ProxyAdminOwner: adminAddress,
      tier2Operator: adminAddress,
      note: "GIWA testnet dry-run uses the simulated signer for Tier 1 and Tier 2. Mainnet profile must replace this with Safe + timelock.",
    },
    contractCounts: {
      paymentTokens: PAYMENT_ASSETS.length,
      faucet: 1,
      productTokens: products.length,
      depositVaults: products.length,
      redemptionVaults: products.length,
      priceFeeds: products.length,
      proxyDeploymentCount: steps.filter((step) => step.type === "proxy").length,
      roleGrantCount: steps.filter((step) => step.type === "grant").length,
    },
    orderedSteps: steps.map((step) => ({
      key: step.key,
      type: step.type,
      label: step.label,
      contractName: step.type === "proxy" ? step.contractName : undefined,
      role: step.type === "grant" ? step.role : undefined,
      status: isStepComplete(registry, step) ? "already-complete" : "pending",
    })),
    productPaymentMappings: Object.fromEntries(products.map((product) => [product.symbol, product.paymentAssetSymbol])),
    estimatedGas: estimatedGas.toString(),
    remainingGas: remainingGas.toString(),
    gasPriceWei: gasPriceWei.toString(),
    gasPriceGwei: utils.formatUnits(gasPriceWei, "gwei"),
    roughEthCostWei: roughEthCostWei.toString(),
    roughEthCostEth: utils.formatEther(roughEthCostWei),
    remainingCostWei: remainingCostWei.toString(),
    remainingCostEth: utils.formatEther(remainingCostWei),
    remainingCostWithMarginWei: remainingCostWithMarginWei.toString(),
    remainingCostWithMarginEth: utils.formatEther(remainingCostWithMarginWei),
    balanceSafetyMarginBps: BALANCE_SAFETY_MARGIN_BPS,
  }
}

function proxyStep(
  key: string,
  slot: ContractSlot,
  label: string,
  contractName: string,
  extra: Pick<ProxyStep, "assetSymbol" | "productId"> = {},
): ProxyStep {
  return {
    type: "proxy",
    key,
    slot,
    label,
    contractName,
    estimateGas: GAS_ESTIMATES.transparentProxyWithImplementation,
    ...extra,
  }
}

function grantStep(
  targetKey: string,
  role: RoleName,
  granteeKey: string,
  extra: Pick<GrantStep, "label" | "assetSymbol" | "productId">,
): GrantStep {
  return {
    type: "grant",
    key: grantKey(targetKey, role, granteeKey),
    targetKey,
    granteeKey,
    role,
    label: extra.label,
    estimateGas: GAS_ESTIMATES.roleGrant,
    assetSymbol: extra.assetSymbol,
    productId: extra.productId,
  }
}
