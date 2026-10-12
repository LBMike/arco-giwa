import { GiwaPerformanceCard } from "./PerformanceCard"
import { SmartContractsCard } from "./SmartContractsCard"
import { PortfolioCard } from "../components/PortfolioCard"
import { FeeStructureCard } from "../components/FeeStructureCard"
import { DocsLinksCard } from "../components/DocsLinksCard"
import type { GiwaVaultDetail } from "./useGiwaVaultDetail"

// The three reusable vault-detail sections, extracted VERBATIM from ProductDetailView so the
// Savings page (Phase 4) renders the exact same Performance / Transparency / More-Info blocks.
// Props are typed against the hook's return so a section can't drift from what it's fed. Overview
// (About) is intentionally NOT extracted — the Savings page omits it.

export function PerformanceSection({
  market,
  history,
  isBuiltIn,
}: {
  market: GiwaVaultDetail["market"]
  history: GiwaVaultDetail["history"]
  isBuiltIn: GiwaVaultDetail["isBuiltIn"]
}) {
  return (
    <section id="performance" className="scroll-mt-[140px] space-y-4">
      <h2 className="text-lg font-semibold text-[var(--color-arco-ink)]">Performance</h2>
      <GiwaPerformanceCard market={market} history={history} isBuiltIn={isBuiltIn} />
    </section>
  )
}

export function TransparencySection({
  portfolio,
  enabledViews,
  aum,
  fee,
  feeHref = null,
  stacked,
}: {
  portfolio: GiwaVaultDetail["portfolioForCard"]
  enabledViews: GiwaVaultDetail["portfolioViews"]
  aum: number | null
  fee: GiwaVaultDetail["feeForCard"]
  feeHref?: string | null
  // Narrow-container callers (Savings 505px) force the stacked donut+table layout. Omitted on the
  // product page => PortfolioCard defaults to false => byte-identical.
  stacked?: boolean
}) {
  // The portfolio card shows only with at least one view that has a breakdown.
  const hasPortfolio = enabledViews.snapshot || enabledViews.industry || enabledViews.exposure
  return (
    <section id="transparency" className="scroll-mt-[140px] space-y-4">
      <h2 className="text-lg font-semibold text-[var(--color-arco-ink)]">Transparency</h2>
      {hasPortfolio && (
        <PortfolioCard portfolio={portfolio} enabledViews={enabledViews} aum={aum} percentLabel="% of AUM" stacked={stacked} />
      )}
      <FeeStructureCard fee={fee} href={feeHref} />
    </section>
  )
}

export function MoreInfoSection({
  addresses,
  docLinks,
  hasDocs,
  stacked,
}: {
  addresses: GiwaVaultDetail["addresses"]
  docLinks: GiwaVaultDetail["docLinks"]
  hasDocs: GiwaVaultDetail["hasDocs"]
  // Narrow-container callers (Savings 505px) force single-column: md: (768px viewport) would
  // otherwise cram Smart Contracts | Docs into ~244px each (labels/addresses wrap). Omitted on
  // the product page => keeps the original `${hasDocs ? "md:grid-cols-2" : ""}` output exactly.
  stacked?: boolean
}) {
  return (
    <section id="more-info" className="scroll-mt-[140px] space-y-4">
      <h2 className="text-lg font-semibold text-[var(--color-arco-ink)]">More Info</h2>
      {/* Adaptive: 2-col only with ≥1 visible docs link; else Smart Contracts (w-full) fills
          the row. DocsLinksCard is omitted entirely at zero docs — it has no empty state. */}
      <div className={`grid grid-cols-1 gap-4 ${!stacked && hasDocs ? "md:grid-cols-2" : ""}`}>
        <SmartContractsCard rows={addresses} />
        {hasDocs && <DocsLinksCard docs={docLinks} />}
      </div>
    </section>
  )
}
