import { useQuery } from "@tanstack/react-query"
import { giwaApi } from "./api"
import { REQUIRED_PAYMENT_ASSET_BY_PRODUCT, vaultConfigOf } from "./catalog"
import { sliceToBreakdownRow } from "./display-profile"
import { readTokenBalance } from "./contracts"
import { useGiwaProductOperation } from "./useGiwaProductOperation"
import { GIWA_CHAIN_ID, GIWA_LIVE_REFETCH } from "./config"
import type { GiwaCatalogItem, HexAddress } from "./types"
import { marketApyText, navSharePrice } from "./price-policy"
import { DEPLOYED_FUND_METRICS, metricCaption } from "./listed-funds"
import { rateLabel } from "./fund-categories"
import type { DocLink } from "../data/acapix-detail"
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
  // Overview rate card: a rate the operator published wins; otherwise the issuer's latest figure
  // from the fund deck, with what it measures and its date underneath; otherwise the APY implied
  // by posted prices. The Funds table reads the same order. Equity funds call it a return.
  const deckMetric = market?.apy == null ? DEPLOYED_FUND_METRICS[product.productId.toLowerCase()]?.metric : undefined
  const rateTitle = rateLabel(vaultConfigOf(product).category)
  const rateCard = deckMetric
    ? { label: rateTitle, value: deckMetric.value, sub: metricCaption(deckMetric) }
    : { label: rateTitle, value: apyText, sub: undefined }
  const priceText = market?.navUsd != null ? navSharePrice(market.navUsd) : "—"
  // Performance card: registered vaults (no built-in slot) show REAL posted share-price
  // history; the 6 built-ins keep the legacy series data (real >=3 points, else projected).
  const isBuiltIn = product.productId in REQUIRED_PAYMENT_ASSET_BY_PRODUCT

  const cfg = vaultConfigOf(product)
  // Issuer / asset manager identity from legacy data; Arco Saving / aXRP (no legacy entry) → Arco/Arco.
  const legacy = productById(product.productId.toLowerCase())
  const issuerKey = legacy?.issuer ?? "arco"
  const managerKey = legacy?.assetManager ?? "arco"

  // Config-first identity/content (blank config field → legacy identity). Content the vault has not
  // set (About, fees, portfolio) stays empty: no other product's copy or figures fill the gap.
  const vaultImage = cfg.vaultImageUrl ?? TOKEN_ICONS[product.productId]
  const issuerLabel = cfg.issuerName ?? ISSUERS[issuerKey]?.label ?? issuerKey
  const issuerLogo = cfg.issuerImageUrl ?? ISSUERS[issuerKey]?.logo
  const managerLabel = cfg.assetManagerName ?? ASSET_MANAGERS[managerKey]?.label ?? managerKey
  const managerLogo = cfg.assetManagerImageUrl ?? ASSET_MANAGERS[managerKey]?.logo
  const aboutParagraphs =
    cfg.about != null ? cfg.about.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean) : []
  const feeForCard = {
    management: cfg.feeManagementBps != null ? cfg.feeManagementBps / 100 : null,
    performance: cfg.feePerformanceBps != null ? cfg.feePerformanceBps / 100 : null,
    note: "Annual fees of the underlying fund",
  }

  // A portfolio view shows when the operator enabled it AND set its breakdown.
  const snapshotRows = cfg.portfolioSnapshot != null ? cfg.portfolioSnapshot.map(sliceToBreakdownRow) : []
  const industryRows = cfg.portfolioIndustry != null ? cfg.portfolioIndustry.map(sliceToBreakdownRow) : []
  const exposureRows = cfg.portfolioExposure != null ? cfg.portfolioExposure.map(sliceToBreakdownRow) : []
  const portfolioViews = {
    snapshot: cfg.cardSnapshot && snapshotRows.length > 0,
    industry: cfg.cardIndustry && industryRows.length > 0,
    exposure: cfg.cardExposure && exposureRows.length > 0,
  }

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

  // The breakdowns carry their own values/AUM total, so the donut total falls back to the AUM.
  const portfolioForCard = {
    updatedAt: "—",
    note: "Allocations reflect the latest published breakdown.",
    total: null,
    industry: industryRows,
    exposure: exposureRows,
    snapshot: snapshotRows,
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
  // The fee card's "Read more" points at the vault's documentation link when it is shown.
  const feeHref = docLinks.find((doc) => doc.label === "Documentation")?.href ?? null

  return {
    panel,
    market,
    history: historyQuery.data,
    apyText,
    rateCard,
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
    feeHref,
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
