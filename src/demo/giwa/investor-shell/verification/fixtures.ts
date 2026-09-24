// PREVIEW FIXTURES ONLY. Synthetic answers for the legacy GIWA API reads of ./main.tsx; never imported by product code.
// Every product, issuer and manager name is obviously preview data, and every address is a synthetic placeholder that
// holds nothing on any chain. Rates, AUM and prices are invented. Type-only imports keep this module free of app code.
import type { GiwaMarketEntry, GiwaPriceHistory } from "../../api"
import type { GiwaAcceptAsset, GiwaAsset, GiwaFeaturedCard, GiwaPortfolioSlice, GiwaProduct, GiwaVaultConfig, HexAddress } from "../../types"

export const PREVIEW_CHAIN_ID = 91342

const DAY_SECONDS = 86_400

/** Synthetic placeholder address: a small integer, zero-padded to 20 bytes. */
function placeholder(value: number): HexAddress {
  return `0x${value.toString(16).padStart(40, "0")}`
}

const FAUCET = placeholder(0xf001)
function asset(symbol: string, name: string, decimals: number, address: number): GiwaAsset {
  return { symbol, name, decimals, contract: { proxy: placeholder(address) }, faucet: FAUCET }
}
const ASSETS: Readonly<Record<string, GiwaAsset>> = {
  tUSDC: asset("tUSDC", "Preview Test USDC", 6, 0xa001),
  tWETH: asset("tWETH", "Preview Test WETH", 18, 0xa002),
  tXRP: asset("tXRP", "Preview Test XRP", 6, 0xa003),
}

/** Every field present, as the server sends it (withVaultConfigDefaults), then the preview profile. */
const CONFIG_DEFAULTS: GiwaVaultConfig = {
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

const slices = (labels: readonly string[], percents: readonly number[]): GiwaPortfolioSlice[] =>
  labels.map((label, index) => ({ label, percent: percents[index] ?? 0 }))

/** Fully profiled, so the detail page renders no aCAPIX legacy fallback content. */
function profile(name: string, overrides: Partial<GiwaVaultConfig>): GiwaVaultConfig {
  return {
    ...CONFIG_DEFAULTS,
    displayName: name,
    description: `${name} · preview fixture`,
    assetManagerName: "Preview Asset Manager",
    issuerName: "Preview Issuer",
    about: `${name} is preview fixture data for layout checks.\n\nIt is not a real product, offer, rate or holding.`,
    redemptionTimelineDays: 3,
    feeInstantMintingBps: 0,
    feeInstantRedemptionBps: 10,
    feeManagementBps: 50,
    feePerformanceBps: 0,
    portfolioSnapshot: slices(["Preview holding A", "Preview holding B", "Preview cash"], [55, 35, 10]),
    portfolioIndustry: slices(["Preview sector A", "Preview sector B"], [70, 30]),
    portfolioExposure: slices(["Preview region A", "Preview region B"], [80, 20]),
    ...overrides,
  }
}

function product(index: number, productId: string, symbol: string, paymentAssetSymbol: string, vaultConfig: GiwaVaultConfig): GiwaProduct {
  const base = 0xb000 + index * 0x10
  return {
    productId,
    symbol,
    name: `${symbol} preview token`,
    paymentAssetSymbol,
    paymentAsset: ASSETS[paymentAssetSymbol] ?? null,
    productToken: { proxy: placeholder(base + 1) },
    depositVault: { proxy: placeholder(base + 2) },
    redemptionVault: { proxy: placeholder(base + 3) },
    priceFeed: { proxy: placeholder(base + 4) },
    deploymentBlock: null,
    vaultConfig,
    pauseState: { depositPaused: false, withdrawPaused: false, depositPartial: false, withdrawPartial: false },
  }
}

function accept(symbol: string, icon: string | null, savingVaultId: string | null, sortOrder: number, apy: number | null = null): GiwaAcceptAsset {
  return { symbol, icon, apy, savingVaultId, isDummy: savingVaultId === null, sortOrder }
}

/** The raw /api/v1/evm/catalog/91342 body: 5 funds, 1 hidden fund, 3 savings vaults. */
export const PREVIEW_CATALOG: readonly GiwaProduct[] = [
  product(0, "preview-tsy-a", "pTSYA", "tUSDC", profile("Preview Treasury Fund A", { category: "U.S Treasuries", pinned: true, aum: "$120M" })),
  product(1, "preview-tsy-b", "pTSYB", "tUSDC", profile("Preview Treasury Fund B", { category: "U.S Treasuries", aum: "$64.5M" })),
  product(2, "preview-credit-a", "pCRDA", "tUSDC", profile("Preview Credit Fund A", { category: "Prime Credit", aum: "$38M" })),
  product(3, "preview-credit-b", "pCRDB", "tUSDC", profile("Preview Credit Fund B", { category: "Prime Credit", aum: "$12.4M" })),
  product(4, "preview-equity-a", "pEQA", "tUSDC", profile("Preview Equity Income Fund A", { category: "Equity Exposure", aum: "$21M" })),
  product(5, "preview-hidden", "pHID", "tUSDC", profile("Preview Hidden Fund", { category: "U.S Treasuries", hidden: true, aum: "$5M" })),
  product(6, "preview-save-usd", "pSUSD", "tUSDC", profile("Preview Savings USD", {
    kind: "saving", category: "Arco Saving", pinned: true, aum: "$80M",
    acceptAssets: [accept("USDC", "/logos/usdc.svg", "preview-save-usd", 0), accept("pEUR", null, null, 3, 2.1)],
  })),
  product(7, "preview-save-eth", "pSETH", "tWETH", profile("Preview Savings ETH", {
    kind: "saving", category: "Arco Saving", aum: "$45M", acceptAssets: [accept("ETH", "/logos/ethereum.svg", "preview-save-eth", 1)],
  })),
  product(8, "preview-save-xrp", "pSXRP", "tXRP", profile("Preview Savings XRP", {
    kind: "saving", category: "Arco Saving", aum: "$18M", acceptAssets: [accept("XRP", "/logos/XRP.png", "preview-save-xrp", 2)],
  })),
]

/** What the Funds list and the Home "Funds" card show (not hidden, not a saving vault), in catalog order. */
export const PREVIEW_FUND_IDS: readonly string[] = ["preview-tsy-a", "preview-tsy-b", "preview-credit-a", "preview-credit-b", "preview-equity-a"]
/** The Savings selector, in its order; "pEUR" is the disabled "coming soon" entry. */
export const PREVIEW_SAVINGS_SYMBOLS: readonly string[] = ["USDC", "ETH", "XRP", "pEUR"]

function market(productId: string, navBase: number, baseUsd: number, apy: number | null, impliedApy: number | null): GiwaMarketEntry {
  return { productId, navBase, baseUsd, navUsd: Math.round(navBase * baseUsd * 1e6) / 1e6, apy, impliedApy }
}

/** /api/v1/evm/market/91342: one entry per catalog product. Preview Credit Fund B has only an implied APY. */
export const PREVIEW_MARKET: readonly GiwaMarketEntry[] = [
  market("preview-tsy-a", 1.0412, 1, 4.85, 4.79),
  market("preview-tsy-b", 1.0275, 1, 4.2, 4.18),
  market("preview-credit-a", 1.0931, 1, 9.4, 9.1),
  market("preview-credit-b", 1.0154, 1, null, 7.15),
  market("preview-equity-a", 1.1208, 1, 6.3, null),
  market("preview-hidden", 1.0021, 1, 4, null),
  market("preview-save-usd", 1.0188, 1, 4.6, 4.55),
  market("preview-save-eth", 1.0062, 2400, 3.3, null),
  market("preview-save-xrp", 1.0081, 0.6, 3.5, null),
]

/** /api/v1/evm/featured/91342: shown-only and position-ordered, as the server sends them. */
export const PREVIEW_FEATURED: readonly GiwaFeaturedCard[] = [
  { id: "preview-featured-1", productId: "preview-tsy-a", about: "Preview carousel card · fixture data, not a real offer.", shown: true, position: 0 },
  { id: "preview-featured-2", productId: "preview-credit-a", about: null, shown: true, position: 1 },
]

const round6 = (value: number) => Math.round(value * 1e6) / 1e6

/** Nine weekly posts ending an hour before `nowMs` at the entry's current NAV (t in unix seconds, like the server). */
export function previewPriceHistory(productId: string, nowMs: number): GiwaPriceHistory | null {
  const entry = PREVIEW_MARKET.find((candidate) => candidate.productId === productId)
  if (!entry || entry.navBase == null) return null
  const navBase = entry.navBase
  const rate = (entry.apy ?? entry.impliedApy ?? 0) / 100
  const end = Math.floor(nowMs / 1000) - 3600
  const points = Array.from({ length: 9 }, (_, index) => {
    const daysBack = (8 - index) * 7
    const value = round6(navBase / Math.pow(1 + rate, daysBack / 365))
    return { t: end - daysBack * DAY_SECONDS, navBase: value, navUsd: entry.baseUsd != null ? round6(value * entry.baseUsd) : null }
  })
  return { productId, apy: entry.apy, points }
}

export type PreviewReply = { status: number; body: unknown }

/**
 * Answer for a legacy GIWA API request (path relative to ARCO_API_BASE, query allowed), or null when the preview has
 * no fixture for it, in which case the page blocks the request. GET only.
 */
export function previewLegacyReply(method: string, path: string, nowMs: number): PreviewReply | null {
  if (method.toUpperCase() !== "GET") return null
  const route = path.split("?")[0] ?? ""
  if (route === `/api/v1/evm/catalog/${PREVIEW_CHAIN_ID}`) return { status: 200, body: PREVIEW_CATALOG }
  if (route === `/api/v1/evm/market/${PREVIEW_CHAIN_ID}`) return { status: 200, body: PREVIEW_MARKET }
  if (route === `/api/v1/evm/featured/${PREVIEW_CHAIN_ID}`) return { status: 200, body: { cards: PREVIEW_FEATURED } }
  const history = route.match(/^\/api\/v1\/evm\/market\/91342\/([^/]+)\/history$/)
  if (history) {
    const productId = decodeURIComponent(history[1] ?? "")
    const body = previewPriceHistory(productId, nowMs)
    return body ? { status: 200, body } : { status: 404, body: { error: `Unknown productId ${productId}` } }
  }
  // Wallet-scoped reads: the preview holds no positions for any wallet.
  const wallet = route.match(/^\/api\/v1\/(activity|redemptions)\/([^/]+)$/)
  if (wallet) return /^0x[0-9a-fA-F]{40}$/.test(wallet[2] ?? "") ? { status: 200, body: [] } : { status: 400, body: { error: "Invalid wallet" } }
  return null
}
