import { tokenIcon } from "../data/products"
import type { GiwaCatalogItem, GiwaPauseState, GiwaVaultConfig } from "./types"

const VAULT_CONFIG_DEFAULTS: GiwaVaultConfig = {
  displayName: null,
  category: null,
  description: null,
  adminDepositAddress: null,
  cardSnapshot: true,
  cardIndustry: true,
  cardExposure: true,
  pinned: false,
  hidden: false,
  kind: "product",
  assetManagerName: null,
  issuerName: null,
  about: null,
  aum: null,
  redemptionTimelineDays: null,
  feeInstantMintingBps: null,
  feeInstantRedemptionBps: null,
  feeManagementBps: null,
  feePerformanceBps: null,
  vaultImageUrl: null,
  assetManagerImageUrl: null,
  issuerImageUrl: null,
  // shown defaults true; the null URL keeps each docs link hidden until an operator sets one.
  docsUrl: null,
  legalUrl: null,
  risksUrl: null,
  docsShown: true,
  legalShown: true,
  risksShown: true,
  portfolioSnapshot: null,
  portfolioIndustry: null,
  portfolioExposure: null,
  acceptAssets: null,
}

// Config accessor with defaults for products whose catalog entry has no vaultConfig
// (older server responses): visible, not pinned, all card views on.
export function vaultConfigOf(product: Pick<GiwaCatalogItem, "vaultConfig">): GiwaVaultConfig {
  return { ...VAULT_CONFIG_DEFAULTS, ...(product.vaultConfig ?? {}) }
}

// Config-first vault logo: admin-set image, else the legacy per-product icon, else undefined
// (letter fallback). Shared by the vault list, holdings, and the portfolio Activity feed so
// their vault identity resolves identically and can't drift.
export function vaultImageFor(product: Pick<GiwaCatalogItem, "productId" | "vaultConfig">): string | undefined {
  return vaultConfigOf(product).vaultImageUrl ?? tokenIcon(product.productId)
}

// Config-first vault name: admin displayName, else the product symbol.
export function vaultDisplayName(product: Pick<GiwaCatalogItem, "symbol" | "vaultConfig">): string {
  return vaultConfigOf(product).displayName ?? product.symbol
}

const PAUSE_STATE_DEFAULTS: GiwaPauseState = {
  depositPaused: false,
  withdrawPaused: false,
  depositPartial: false,
  withdrawPartial: false,
}

// Pause accessor with unpaused defaults for older server responses.
export function pauseStateOf(product: Pick<GiwaCatalogItem, "pauseState">): GiwaPauseState {
  return { ...PAUSE_STATE_DEFAULTS, ...(product.pauseState ?? {}) }
}

export type GiwaProductId =
  | "acapix"
  | "ibenji"
  | "umint"
  | "abtc"
  | "axrp"
  | "aeth"

export type GiwaPaymentAssetSymbol = "tUSDC" | "tBTC" | "tXRP" | "tWETH"

export const REQUIRED_PAYMENT_ASSET_BY_PRODUCT: Record<
  GiwaProductId,
  GiwaPaymentAssetSymbol
> = {
  acapix: "tUSDC",
  ibenji: "tUSDC",
  umint: "tUSDC",
  abtc: "tBTC",
  axrp: "tXRP",
  aeth: "tWETH",
}

export function assertRequiredPaymentAsset(product: Pick<GiwaCatalogItem, "productId" | "paymentAssetSymbol">) {
  const expected = REQUIRED_PAYMENT_ASSET_BY_PRODUCT[product.productId as GiwaProductId]
  if (!expected) return
  if (product.paymentAssetSymbol !== expected) {
    throw new Error(`${product.productId} must use ${expected}; registry returned ${product.paymentAssetSymbol}`)
  }
}
