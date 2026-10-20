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

// Vaults no longer offered to investors. Their contracts stay live and the admin console still
// manages them, but the investor app leaves them out everywhere: funds list, home, search, the
// featured carousel and the product page.
const RETIRED_PRODUCT_IDS = new Set(["acapix"])

export function isRetiredProduct(product: Pick<GiwaCatalogItem, "productId">): boolean {
  return RETIRED_PRODUCT_IDS.has(product.productId.toLowerCase())
}

// Config accessor with defaults for products whose catalog entry has no vaultConfig
// (older server responses): visible, not pinned, all card views on.
export function vaultConfigOf(product: Pick<GiwaCatalogItem, "vaultConfig">): GiwaVaultConfig {
  return { ...VAULT_CONFIG_DEFAULTS, ...(product.vaultConfig ?? {}) }
}

// Tokens the app presents under another symbol and mark than their contract's own. The arcoUSD Savings vault's
// share grows in price with the yield, so it is shown as the savings token sArcoUSD, with that token's mark. The
// contract keeps its symbol (arcoUSD): wallets and explorers still show that one.
const PRESENTED_TOKENS: Readonly<Record<string, Readonly<{ symbol: string; image: string }>>> = {
  arcousd: { symbol: "sArcoUSD", image: "/logos/sarcousd.png" },
  // The ArcoUSD v1 sArcoUSD account that takes the arcoUSD vault's place on the Savings page (arcousd-live.ts).
  sarcousd: { symbol: "sArcoUSD", image: "/logos/sarcousd.png" },
}

const presentedToken = (product: Pick<GiwaCatalogItem, "productId">) => PRESENTED_TOKENS[product.productId.toLowerCase()]

/** A product token's symbol as customers see it: the contract's own, or the one it is presented as (sArcoUSD). */
export function tokenSymbolFor(product: Pick<GiwaCatalogItem, "productId" | "symbol">): string {
  return presentedToken(product)?.symbol ?? product.symbol
}

// Config-first vault logo: admin-set image, else the legacy per-product icon, else undefined
// (letter fallback). A token presented under another symbol shows that token's mark ahead of both.
// Shared by the vault list, holdings, and the portfolio Activity feed so their vault identity
// resolves identically and can't drift.
export function vaultImageFor(product: Pick<GiwaCatalogItem, "productId" | "vaultConfig">): string | undefined {
  return presentedToken(product)?.image ?? vaultConfigOf(product).vaultImageUrl ?? tokenIcon(product.productId)
}

// Config-first vault name: admin displayName, else the token's symbol as customers see it.
export function vaultDisplayName(product: Pick<GiwaCatalogItem, "productId" | "symbol" | "vaultConfig">): string {
  return vaultConfigOf(product).displayName ?? tokenSymbolFor(product)
}

const PAUSE_STATE_DEFAULTS: GiwaPauseState = {
  depositPaused: false,
  withdrawPaused: false,
  depositPartial: false,
  withdrawPartial: false,
  depositVaultPaused: false,
  withdrawVaultPaused: false,
}

// Pause accessor with unpaused defaults for older server responses.
export function pauseStateOf(product: Pick<GiwaCatalogItem, "pauseState">): GiwaPauseState {
  return { ...PAUSE_STATE_DEFAULTS, ...(product.pauseState ?? {}) }
}

// Admin view: the live read (GET /api/v1/admin/pause-state) wins over the cached catalog snapshot.
export function livePauseStateOf(
  product: Pick<GiwaCatalogItem, "productId" | "pauseState">,
  live: Record<string, Partial<GiwaPauseState>> | null | undefined,
): GiwaPauseState {
  const fresh = live?.[product.productId]
  return fresh ? { ...PAUSE_STATE_DEFAULTS, ...fresh } : pauseStateOf(product)
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
