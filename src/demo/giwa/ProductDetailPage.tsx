import type { ReactNode } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { giwaApi } from "./api"
import { isRetiredProduct, vaultDisplayName } from "./catalog"
import { parseAumToNumber } from "./display-profile"
import { GiwaInvestPanel, GiwaNetworkIcon } from "./components"
import { GiwaInvestDock } from "./GiwaInvestDock"
import { GiwaOperationModal } from "./GiwaOperationModal"
import { useGiwaVaultDetail } from "./useGiwaVaultDetail"
import { PerformanceSection, TransparencySection, MoreInfoSection } from "./detail-sections"
import { GIWA_FUNDS_ROUTE } from "./routes"
import type { GiwaCatalogItem } from "./types"
import { BrandMark } from "../components/BrandMark"
import { SectionNav } from "../components/SectionNav"
import { MetricCard } from "../components/MetricCard"
import { AboutCard } from "../components/AboutCard"
import { listedFundById } from "./listed-funds"
import { ListedFundDetail } from "./ListedFundDetail"

export default function GiwaProductDetailPage() {
  const { id } = useParams()
  const listedFund = id ? listedFundById(id) : undefined
  if (listedFund) return <ListedFundDetail fund={listedFund} />
  return <DeployedProductDetailPage id={id} />
}

function DeployedProductDetailPage({ id }: { id: string | undefined }) {
  const catalogQuery = useQuery({ queryKey: ["giwa", "catalog"], queryFn: giwaApi.catalog })
  const products = catalogQuery.data ?? []
  // A retired vault keeps its contracts but is no longer offered, so its page reads as not found.
  const product = products.find((candidate) => candidate.productId === id && !isRetiredProduct(candidate))

  if (catalogQuery.isLoading) return <CenteredNote>Loading product…</CenteredNote>
  if (!product) {
    return (
      <div className="w-full space-y-4">
        <BackLink />
        <CenteredNote>Product not found.</CenteredNote>
      </div>
    )
  }
  return <ProductDetailView product={product} />
}

// Exported for the render-harness verification (seed the market/history queries + a
// fully-profiled product to prove config-first rendering with no disclaimer). All data derivation
// lives in useGiwaVaultDetail (shared with the Savings page); this component is now just layout.
export function ProductDetailView({ product }: { product: GiwaCatalogItem }) {
  const detail = useGiwaVaultDetail(product)

  return (
    // pb-24 (mobile only) clears the fixed Invest/Redeem bottom bar; >= lg has no bar.
    <div className="w-full pb-24 lg:pb-0">
      <BackLink />

      <header className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <BrandMark src={detail.vaultImage} label={product.symbol} size={40} />
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-[var(--color-arco-ink)]">{vaultDisplayName(product)}</h1>
            <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[11px] text-[var(--color-arco-text-soft)]">
              {product.name}
            </span>
            <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[11px] text-[var(--color-arco-text-soft)]">
              GIWA Sepolia
            </span>
          </div>
        </div>

        <div className="flex items-center gap-8">
          <Identity label="ISSUER">
            <BrandMark src={detail.issuerLogo} label={detail.issuerLabel} size={16} />
            <span className="text-sm text-[var(--color-arco-ink)]">{detail.issuerLabel}</span>
          </Identity>
          <Identity label="ASSET MANAGER">
            <BrandMark src={detail.managerLogo} label={detail.managerLabel} size={16} />
            <span className="text-sm text-[var(--color-arco-ink)]">{detail.managerLabel}</span>
          </Identity>
        </div>
      </header>

      <SectionNav />

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-10">
          <section id="overview" className="scroll-mt-[140px] space-y-5">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MetricCard label="AUM" value={detail.cfg.aum ?? "—"} />
              <MetricCard label={detail.rateCard.label} value={detail.rateCard.value} sub={detail.rateCard.sub} />
              <MetricCard label="Price" value={detail.priceText} sub="NAV / share (USD)" />
              <MetricCard label="Network">
                <GiwaNetworkIcon size={22} />
              </MetricCard>
            </div>
            {detail.aboutParagraphs.length > 0 && <AboutCard paragraphs={detail.aboutParagraphs} />}
          </section>

          <PerformanceSection market={detail.market} history={detail.history} isBuiltIn={detail.isBuiltIn} />

          <TransparencySection
            portfolio={detail.portfolioForCard}
            enabledViews={detail.portfolioViews}
            aum={parseAumToNumber(detail.cfg.aum)}
            fee={detail.feeForCard}
            feeHref={detail.feeHref}
          />

          <MoreInfoSection addresses={detail.addresses} docLinks={detail.docLinks} hasDocs={detail.hasDocs} />
        </div>

        {/* Desktop (>= lg) side panel — unchanged; hidden below lg where the dock takes over. */}
        <aside className="hidden min-w-0 lg:block">
          <GiwaInvestPanel {...detail.panel} instantLiquidityUsd={detail.instantLiquidityUsd} baseUsd={detail.baseUsd} />
        </aside>
      </div>

      {/* Mobile (< lg) — sticky Invest/Redeem bar + slide-up bottom sheet hosting the SAME panel. */}
      <GiwaInvestDock {...detail.panel} instantLiquidityUsd={detail.instantLiquidityUsd} baseUsd={detail.baseUsd} />

      {/* One transaction modal for both panels (they share one flow). */}
      <GiwaOperationModal flow={detail.panel.flow} onClose={detail.panel.onFlowClose} onRetry={detail.panel.onFlowRetry} />
    </div>
  )
}

// Header identity item (label above, right-aligned mark + value) — mirrors the legacy AcapixDetail.
function Identity({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="text-right">
      <p className="text-[10px] uppercase tracking-wide text-[var(--color-arco-muted)]">{label}</p>
      <div className="mt-1 flex items-center justify-end gap-1.5">{children}</div>
    </div>
  )
}

function BackLink() {
  return (
    <Link
      to={GIWA_FUNDS_ROUTE}
      className="inline-flex items-center gap-1 text-sm text-[var(--color-arco-muted)] hover:text-[var(--color-arco-ink)]"
    >
      <ArrowLeft className="size-4" /> Back to products
    </Link>
  )
}

function CenteredNote({ children }: { children: ReactNode }) {
  return <div className="w-full py-16 text-center text-sm text-[var(--color-arco-muted)]">{children}</div>
}
