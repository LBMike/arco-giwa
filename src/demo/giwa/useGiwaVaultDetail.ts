import { useQuery } from "@tanstack/react-query"
import { giwaApi } from "./api"
import { REQUIRED_PAYMENT_ASSET_BY_PRODUCT, vaultConfigOf } from "./catalog"
import { portfolioClearOfAcapix, remainingAcapixFallbacks, resolvePortfolioHeader, sliceToBreakdownRow } from "./display-profile"
import { readTokenBalance } from "./contracts"
import { useGiwaProductOperation } from "./useGiwaProductOperation"
import { GIWA_CHAIN_ID, GIWA_LIVE_REFETCH } from "./config"
import type { GiwaCatalogItem, HexAddress } from "./types"
import { marketApyText, navSharePrice } from "./price-policy"
import { ACAPIX_DETAIL, type DocLink } from "../data/acapix-detail"
import { productById, ASSET_MANAGERS, ISSUERS } from "../data/products"

const TOKEN_ICONS: Record<string, string> = {
  abtc: "/logos/abtc.png",
  aeth: "/logos/aeth.png",
  acapix: "/logos/aksia.svg",
  ibenji: "/logos/ibenji.svg",
  umint: "/logos/umint.svg",
}

// Vault-detail data derivation, extracted VERBATIM from ProductDetailView so the product detail
// page and the Savings page (Phase 4) share ONE source of truth and can't drift. Call it
// UNCONDITIONALLY as the consumer's first statement (Rules of Hooks) — there is no early return
// before it. The hook interleave is preserved from the original: paymentDecimals is computed
// BEFORE the redemption-balance query that depends on it, so the four hooks are NOT hoisted.
export function useGiwaVaultDetail(product: GiwaCatalogItem) {
  const panel = useGiwaProductOperation(product)

  const marketQuery = useQuery({
    queryKey: ["giwa", "market", GIWA_CHAIN_ID],
    queryFn: () => giwaApi.market(GIWA_CHAIN_ID),
    ...GIWA_LIVE_REFETCH,
  })
  const market = (marketQuery.data ?? []).find((entry) => entry.productId === product.productId) ?? null

  const historyQuery = useQuery({
    queryKey: ["giwa", "price-history", product.productId],
    queryFn: () => giwaApi.priceHistory(GIWA_CHAIN_ID, product.productId),
    ...GIWA_LIVE_REFETCH,
  })

  // APY: published rate, else implied-from-posts (mirrors the vault list). Price: live
  // posted NAV/share, shown to up to 4 decimals so near-par movement is visible.
  const apyText = marketApyText(market)
  const priceText = market?.navUsd != null ? navSharePrice(market.navUsd) : "—"
  // Performance card: registered vaults (no built-in slot) show REAL posted share-price
  // history; the 6 built-ins keep the legacy series data (real >=3 points, else projected).
  const isBuiltIn = product.productId in REQUIRED_PAYMENT_ASSET_BY_PRODUCT

  const isAcapix = product.productId === "acapix"
  const d = ACAPIX_DETAIL
  const cfg = vaultConfigOf(product)
  // Issuer / asset manager identity from legacy data; Arco Saving / aXRP (no legacy entry) → Arco/Arco.
  const legacy = productById(product.productId.toLowerCase())
  const issuerKey = legacy?.issuer ?? "arco"
  const managerKey = legacy?.assetManager ?? "arco"

  // Config-first identity/content (blank config field → legacy fallback).
  const vaultImage = cfg.vaultImageUrl ?? TOKEN_ICONS[product.productId]
  const issuerLabel = cfg.issuerName ?? ISSUERS[issuerKey]?.label ?? issuerKey
  const issuerLogo = cfg.issuerImageUrl ?? ISSUERS[issuerKey]?.logo
  const managerLabel = cfg.assetManagerName ?? ASSET_MANAGERS[managerKey]?.label ?? managerKey
  const managerLogo = cfg.assetManagerImageUrl ?? ASSET_MANAGERS[managerKey]?.logo
  const aboutParagraphs =
    cfg.about != null ? cfg.about.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean) : d.about
  const feeForCard = {
    management: cfg.feeManagementBps != null ? cfg.feeManagementBps / 100 : d.fee.management,
    performance: cfg.feePerformanceBps != null ? cfg.feePerformanceBps / 100 : d.fee.performance,
    note: d.fee.note,
  }

  const portfolioViews = { snapshot: cfg.cardSnapshot, industry: cfg.cardIndustry, exposure: cfg.cardExposure }
  const portfolioClear = portfolioClearOfAcapix(cfg)

  // Instant liquidity is LIVE (redemption-vault balance × USD rate), never stored.
  const paymentDecimals = product.paymentAsset?.decimals ?? 18
  const redemptionBalanceQuery = useQuery({
    queryKey: ["giwa", "vault-balance", "redemption", product.productId],
    queryFn: () => readTokenBalance(product.paymentAssetAddress!, product.redemptionVaultAddress!, paymentDecimals),
    enabled: Boolean(product.paymentAssetAddress && product.redemptionVaultAddress),
    refetchInterval: 30_000,
  })
  const redemptionBalance = redemptionBalanceQuery.data
  const instantLiquidityUsd =
    redemptionBalance != null && redemptionBalance !== "--" && market?.baseUsd != null
      ? Number(redemptionBalance) * market.baseUsd
      : null

  // True while ANY aCAPIX-derived value (About, fees, or an enabled portfolio view still on
  // legacy data) renders. It no longer gates a sample-content note — it only decides whether the
  // portfolio card keeps its aCAPIX legacy header (see resolvePortfolioHeader below).
  const usesAcapixFallbacks =
    remainingAcapixFallbacks({
      isAcapix,
      hasAbout: cfg.about != null,
      hasManagementFee: cfg.feeManagementBps != null,
      hasPerformanceFee: cfg.feePerformanceBps != null,
      hasInstantMintingFee: cfg.feeInstantMintingBps != null,
      hasInstantRedemptionFee: cfg.feeInstantRedemptionBps != null,
      hasPortfolio: portfolioClear,
    }).length > 0

  // Portfolio is config-first: Industry/Exposure use config slices when set else legacy;
  // Snapshot has no legacy (config-or-empty state). The card HEADER (updatedAt + note) is
  // aCAPIX legacy with no config field of its own, so it renders only while the vault still
  // leans on aCAPIX fallbacks; once a non-aCAPIX vault is fully profiled it is replaced with
  // neutral copy so no aCAPIX-derived header text survives.
  const header = resolvePortfolioHeader(usesAcapixFallbacks || isAcapix, d.portfolio)
  const portfolioForCard = {
    ...d.portfolio,
    updatedAt: header.updatedAt,
    note: header.note,
    // Config industry has its own values/AUM total — don't inherit aCAPIX's NAV total.
    total: cfg.portfolioIndustry != null ? null : d.portfolio.total,
    industry: cfg.portfolioIndustry != null ? cfg.portfolioIndustry.map(sliceToBreakdownRow) : d.portfolio.industry,
    exposure: cfg.portfolioExposure != null ? cfg.portfolioExposure.map(sliceToBreakdownRow) : d.portfolio.exposure,
    snapshot: cfg.portfolioSnapshot != null ? cfg.portfolioSnapshot.map(sliceToBreakdownRow) : [],
  }
  const addresses: Array<{ label: string; address: HexAddress | null }> = [
    { label: "Product token", address: product.productTokenAddress },
    { label: "Deposit vault", address: product.depositVaultAddress },
    { label: "Redemption vault", address: product.redemptionVaultAddress },
    { label: "Price feed", address: product.priceFeedAddress },
  ]
  // "More info" docs links are config-driven (no ACAPIX placeholders): a link renders only when
  // its slot is toggled Shown AND has a URL. Zero visible links → the Smart Contracts card fills
  // the row full-width (see the adaptive grid below).
  const docLinks: DocLink[] = (
    [
      { label: "Documentation", href: cfg.docsUrl, shown: cfg.docsShown },
      { label: "Legal Terms", href: cfg.legalUrl, shown: cfg.legalShown },
      { label: "Risks", href: cfg.risksUrl, shown: cfg.risksShown },
    ] as const
  )
    .filter((row) => row.shown && row.href != null && row.href.trim() !== "")
    .map((row) => ({ label: row.label, href: row.href as string }))
  const hasDocs = docLinks.length > 0

  return {
    panel,
    market,
    history: historyQuery.data,
    apyText,
    priceText,
    isBuiltIn,
    cfg,
    vaultImage,
    issuerLabel,
    issuerLogo,
    managerLabel,
    managerLogo,
    aboutParagraphs,
    feeForCard,
    portfolioViews,
    portfolioForCard,
    addresses,
    docLinks,
    hasDocs,
    instantLiquidityUsd,
    baseUsd: market?.baseUsd ?? null,
  }
}

// The derived detail shape — section components type their props against this so a call-site and
// a section can never drift from what the hook actually returns.
export type GiwaVaultDetail = ReturnType<typeof useGiwaVaultDetail>
