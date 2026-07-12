// 2c-2 deploy-params schema — SINGLE SOURCE OF TRUTH shared by the Add-vault form
// (src/demo/giwa/AdminConfig.tsx) and the deploy harness (deploy-giwa.ts). Both sides
// validate with the same validateDeployParams so form output and harness input cannot
// drift. Dependency-free on purpose (no ethers/hardhat imports) so the vite app and
// plain node tests can import it.
//
// Knobs deliberately NOT exposed:
//   - feed decimals: fixed at 8 (the whole price stack assumes FEED_SCALE = 1e8)
//   - roles/treasury: grants always go to the tier2 operator, same as the built-ins
//   - minDeposit: the harness has never set deposit limits at deploy; that stays a
//     post-deploy ops action (setLimits), per the 2c-2 approval.
import { VAULT_CATEGORIES, isVaultCategory, type VaultCategory } from "../../../shared/vault-taxonomy"

export { VAULT_CATEGORIES }

export type DeployParamsInit = {
  maxSupplyCapShares?: string
  vaultMintAllowanceShares?: string
  maxRedemptionPayment?: string
  feedInitialAnswer?: string
  feedHealthyDiffSeconds?: number
  feedMaxAnswer?: string
  feedMinAnswer?: string
}

export type DeployParamsProduct = {
  productId: string
  symbol: string
  name: string
  paymentAssetSymbol: "tUSDC" | "tBTC" | "tXRP" | "tWETH"
  category: VaultCategory
  description?: string
  init?: DeployParamsInit
}

export type DeployParamsFile = {
  schemaVersion: 1
  products: DeployParamsProduct[]
}

// Defaults mirror the values hardcoded for the built-in products in
// deploy-giwa.ts proxyInitializerArgs — an omitted init deploys identically to launch.
export const DEPLOY_PARAMS_DEFAULTS: Required<DeployParamsInit> = {
  maxSupplyCapShares: "1000000",
  vaultMintAllowanceShares: "500000",
  maxRedemptionPayment: "1000000",
  feedInitialAnswer: "100000000", // 8-dec answer => baseline NAV 1.0
  feedHealthyDiffSeconds: 3600,
  feedMaxAnswer: "100000000000000",
  feedMinAnswer: "0",
}

export const DEPLOY_PARAMS_PAYMENT_ASSETS = ["tUSDC", "tBTC", "tXRP", "tWETH"] as const

const PRODUCT_ID_PATTERN = /^[a-z][a-z0-9]{2,15}$/
const SYMBOL_PATTERN = /^[a-zA-Z]{2,12}$/

function isPositiveIntegerString(value: unknown, allowZero = false): boolean {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false
  return allowZero || value !== "0"
}

export type DeployParamsValidation = {
  ok: boolean
  errors: string[]
  parsed: DeployParamsFile | null
}

export function validateDeployParams(
  input: unknown,
  reservedProductIds: readonly string[],
  reservedSymbols: readonly string[],
): DeployParamsValidation {
  const errors: string[] = []
  const root = input && typeof input === "object" ? (input as Record<string, unknown>) : null
  if (!root) return { ok: false, errors: ["params must be a JSON object"], parsed: null }
  if (root.schemaVersion !== 1) errors.push("schemaVersion must be 1")
  if (!Array.isArray(root.products) || root.products.length === 0) {
    errors.push("products must be a non-empty array")
    return { ok: false, errors, parsed: null }
  }

  const seenIds = new Set(reservedProductIds.map((id) => id.toLowerCase()))
  const seenSymbols = new Set(reservedSymbols.map((symbol) => symbol.toLowerCase()))
  const products: DeployParamsProduct[] = []

  root.products.forEach((entry, index) => {
    const label = `products[${index}]`
    const product = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null
    if (!product) {
      errors.push(`${label} must be an object`)
      return
    }
    const productId = product.productId
    if (typeof productId !== "string" || !PRODUCT_ID_PATTERN.test(productId)) {
      errors.push(`${label}.productId must match ${PRODUCT_ID_PATTERN}`)
    } else if (seenIds.has(productId.toLowerCase())) {
      errors.push(`${label}.productId "${productId}" duplicates an existing or reserved product`)
    } else {
      seenIds.add(productId.toLowerCase())
    }
    const symbol = product.symbol
    if (typeof symbol !== "string" || !SYMBOL_PATTERN.test(symbol)) {
      errors.push(`${label}.symbol must match ${SYMBOL_PATTERN}`)
    } else if (seenSymbols.has(symbol.toLowerCase())) {
      errors.push(`${label}.symbol "${symbol}" duplicates an existing or reserved symbol`)
    } else {
      seenSymbols.add(symbol.toLowerCase())
    }
    if (typeof product.name !== "string" || !product.name.trim() || product.name.length > 64) {
      errors.push(`${label}.name must be a 1-64 character string`)
    }
    if (!DEPLOY_PARAMS_PAYMENT_ASSETS.includes(product.paymentAssetSymbol as never)) {
      errors.push(`${label}.paymentAssetSymbol must be one of ${DEPLOY_PARAMS_PAYMENT_ASSETS.join(", ")}`)
    }
    if (!isVaultCategory(product.category)) {
      errors.push(`${label}.category must be one of ${VAULT_CATEGORIES.join(" | ")}`)
    }
    if (product.description !== undefined && (typeof product.description !== "string" || product.description.length > 500)) {
      errors.push(`${label}.description must be a string of at most 500 characters`)
    }
    const init = product.init === undefined ? {} : product.init
    if (!init || typeof init !== "object") {
      errors.push(`${label}.init must be an object when present`)
    } else {
      const overrides = init as Record<string, unknown>
      for (const key of Object.keys(overrides)) {
        if (!(key in DEPLOY_PARAMS_DEFAULTS)) errors.push(`${label}.init.${key} is not a recognised parameter`)
      }
      for (const key of ["maxSupplyCapShares", "vaultMintAllowanceShares", "maxRedemptionPayment", "feedInitialAnswer", "feedMaxAnswer"] as const) {
        if (overrides[key] !== undefined && !isPositiveIntegerString(overrides[key])) {
          errors.push(`${label}.init.${key} must be a positive integer string`)
        }
      }
      if (overrides.feedMinAnswer !== undefined && !isPositiveIntegerString(overrides.feedMinAnswer, true)) {
        errors.push(`${label}.init.feedMinAnswer must be a non-negative integer string`)
      }
      if (
        overrides.feedHealthyDiffSeconds !== undefined &&
        (typeof overrides.feedHealthyDiffSeconds !== "number" ||
          !Number.isInteger(overrides.feedHealthyDiffSeconds) ||
          overrides.feedHealthyDiffSeconds <= 0)
      ) {
        errors.push(`${label}.init.feedHealthyDiffSeconds must be a positive integer`)
      }
    }
    products.push(product as unknown as DeployParamsProduct)
  })

  if (errors.length) return { ok: false, errors, parsed: null }
  return { ok: true, errors: [], parsed: { schemaVersion: 1, products } }
}

// Validate a GIWA_EXTRA_PRODUCTS params blob and return its products, throwing on any error.
// reservedProductIds/reservedSymbols must include the built-ins AND every already-deployed
// registry extra — a params file should only declare a GENUINELY NEW vault, since prior
// extras auto-merge from the registry. A collision (id or symbol) with an existing vault is
// rejected with actionable guidance rather than silently re-deployed or deduped away.
export function parseExtraProducts(
  input: unknown,
  reservedProductIds: readonly string[],
  reservedSymbols: readonly string[],
  sourceLabel = "deploy params",
): DeployParamsProduct[] {
  const result = validateDeployParams(input, reservedProductIds, reservedSymbols)
  if (!result.ok || !result.parsed) {
    const collided = result.errors.some((error) => /duplicates an existing or reserved/.test(error))
    const guidance = collided
      ? "\nThis vault is already deployed — a new vault needs a fresh id/symbol; prior vaults auto-merge, don't re-list them."
      : ""
    throw new Error(`Invalid ${sourceLabel}:\n- ${result.errors.join("\n- ")}${guidance}`)
  }
  return result.parsed.products
}

export function resolvedInit(product: DeployParamsProduct): Required<DeployParamsInit> {
  return { ...DEPLOY_PARAMS_DEFAULTS, ...(product.init ?? {}) }
}
