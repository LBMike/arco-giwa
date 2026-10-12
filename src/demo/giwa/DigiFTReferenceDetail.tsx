import { useEffect } from "react"
import { ArrowLeft, ArrowUpRight } from "lucide-react"
import { Link } from "react-router-dom"
import { AboutCard } from "../components/AboutCard"
import { BrandMark } from "../components/BrandMark"
import { DocsLinksCard } from "../components/DocsLinksCard"
import { MetricCard } from "../components/MetricCard"
import { PortfolioCard } from "../components/PortfolioCard"
import { SectionNav } from "../components/SectionNav"
import { digiftDisplayCategory, type DigiFTReferenceAsset } from "./digift-reference-assets"
import { digiftPortfolioCardData } from "./digift-reference-portfolio"
import { DIGIFT_RESEARCH } from "./digift-reference-research"
import { DigiFTFirmMark } from "./DigiFTFirmMark"
import { DigiFTProductMark } from "./DigiFTProductMark"
import { GIWA_FUNDS_ROUTE } from "./routes"

const CARD = "rounded-[var(--radius-strategy)] bg-[var(--color-arco-surface)] p-5 shadow-[var(--shadow-control)]"

function compactAum(value: string): string {
  return value.replace(/^USD /, "$").replace(" billion", "B").replace(" million", "M")
}

export function DigiFTReferenceDetail({ asset }: { asset: DigiFTReferenceAsset }) {
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [asset.id])

  const aum = asset.aum ?? asset.aumEstimate?.value
  const research = DIGIFT_RESEARCH[asset.id]
  const portfolioForCard = digiftPortfolioCardData(research.portfolio, asset.symbol)
  const aumCaption = asset.aum ? "Source snapshot" : asset.aumEstimate?.illustrative ? "Illustrative peer proxy" : "External fund estimate"
  const benchmark = asset.metricLabel === "Benchmark"
  const sourceDocs = [
    { label: `DigiFT product overview · page ${asset.sourcePage}`, href: asset.sourceUrl },
    ...(asset.aumEstimate && asset.aumEstimate.sourceUrl !== asset.sourceUrl
      ? [{ label: asset.aumEstimate.sourceLabel, href: asset.aumEstimate.sourceUrl }]
      : []),
    ...(asset.aumEstimate?.secondarySourceUrl && asset.aumEstimate.secondarySourceLabel
      ? [{ label: asset.aumEstimate.secondarySourceLabel, href: asset.aumEstimate.secondarySourceUrl }]
      : []),
  ]
  const researchDocs = [
    ...research.facts.map((fact) => ({ label: fact.sourceLabel, href: fact.sourceUrl })),
    ...(research.portfolio ? [{ label: research.portfolio.sourceLabel, href: research.portfolio.sourceUrl }] : []),
  ]
  const docs = [...sourceDocs, ...researchDocs.filter((doc) => !sourceDocs.some((source) => source.href === doc.href))]
    .filter((doc, index, all) => all.findIndex((candidate) => candidate.href === doc.href) === index)

  return (
    <div className="w-full pb-10" data-testid="digift-reference-detail">
      <Link to={GIWA_FUNDS_ROUTE} className="inline-flex items-center gap-1 text-sm text-[var(--color-arco-muted)] hover:text-[var(--color-arco-ink)]">
        <ArrowLeft aria-hidden="true" className="size-4" /> Back to products
      </Link>

      <header className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <DigiFTProductMark asset={asset} size={40} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold text-[var(--color-arco-ink)]">{asset.symbol}</h1>
              <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[11px] text-[var(--color-arco-text-soft)]">{digiftDisplayCategory(asset)}</span>
              <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[11px] text-[var(--color-arco-text-soft)]">Reference profile</span>
            </div>
            <p className="mt-1 text-sm text-[var(--color-arco-text-soft)]">{asset.name}</p>
          </div>
        </div>
        <div className="flex items-center gap-8">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-[var(--color-arco-muted)]">Issuer</p>
            <div className="mt-1 flex items-center gap-1.5">
              <BrandMark src="/logos/DigFT.png" label="DigiFT" size={16} />
              <span className="text-sm text-[var(--color-arco-ink)]">DigiFT</span>
            </div>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-[var(--color-arco-muted)]">Asset Manager</p>
            <div className="mt-1 flex items-center gap-1.5">
              <DigiFTFirmMark asset={asset} />
              <span className="text-sm text-[var(--color-arco-ink)]">{asset.manager}</span>
            </div>
          </div>
        </div>
      </header>

      <SectionNav />
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-10">
          <section id="overview" className="scroll-mt-[140px] space-y-5">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MetricCard label="AUM" value={aum ? compactAum(aum) : "—"} sub={aumCaption} />
              <MetricCard label={asset.metricLabel} value={benchmark ? "—" : asset.metricValue} sub={benchmark ? asset.metricValue : `As of ${asset.metricAsOf ?? asset.sourceAsOf}`} />
              <MetricCard label="Price" value="—" sub="NAV / share unavailable" />
              <MetricCard label="Network" sub="Preview only">
                <img src="/logos/giwa.png" alt="GIWA" width={22} height={22} className="rounded-full object-contain" />
              </MetricCard>
            </div>
            <AboutCard paragraphs={[asset.description, `Underlying product: ${asset.underlying}`]} />
          </section>

          <section id="performance" className="scroll-mt-[140px] space-y-4">
            <h2 className="text-lg font-semibold text-[var(--color-arco-ink)]">Performance</h2>
            <div className={CARD}>
              <p className="text-xs uppercase tracking-wide text-[var(--color-arco-muted)]">{benchmark ? "Investment benchmark" : "Source-reported metric"}</p>
              <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <p className="font-mono text-2xl font-medium text-[var(--color-arco-ink)] sm:text-3xl">{asset.metricValue}</p>
                <span className="text-sm text-[var(--color-arco-text-soft)]">{asset.metricLabel}</span>
              </div>
              <p className="mt-3 text-xs text-[var(--color-arco-muted)]">{asset.metricAsOf ? `As of ${asset.metricAsOf}` : `DigiFT overview · ${asset.sourceAsOf}`}</p>
              <p className="mt-4 border-t border-[var(--color-arco-border)] pt-4 text-sm leading-6 text-[var(--color-arco-text-soft)]">
                {benchmark
                  ? "The overview states the fund objective; it does not provide a numeric return or historical price series."
                  : "This is a dated source snapshot. The overview does not provide a historical price series for this product."}
              </p>
            </div>
          </section>

          <section id="transparency" className="scroll-mt-[140px] space-y-4">
            <h2 className="text-lg font-semibold text-[var(--color-arco-ink)]">Transparency</h2>
            <div data-testid="digift-underlying-portfolio">
              <PortfolioCard
                portfolio={portfolioForCard}
                enabledViews={{ snapshot: true, industry: true, exposure: true }}
                aum={null}
                percentLabel="% of AUM"
                exposureHeading="Underlying fund exposure"
                exposureColumnLabel="Segment"
              />
              {research.portfolio && (
                <a href={research.portfolio.sourceUrl} target="_blank" rel="noreferrer noopener" className="mt-2 inline-flex items-center gap-1 text-xs text-[var(--color-arco-text-soft)] underline underline-offset-2">
                  {research.portfolio.sourceLabel} <ArrowUpRight aria-hidden="true" className="size-3" />
                </a>
              )}
            </div>
            <div className={CARD}>
              <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">Product background</h3>
              <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                <DetailField label="Underlying product" value={asset.underlying} />
                <DetailField label="Exposure" value={asset.baseAsset} />
              </dl>
              <h4 className="mt-6 border-t border-[var(--color-arco-border)] pt-5 text-xs font-medium uppercase tracking-wide text-[var(--color-arco-ink)]">Verified fund facts</h4>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2" data-testid="digift-research-facts">
                {research.facts.map((fact) => (
                  <div key={fact.label} className="rounded-[var(--radius-row)] bg-[var(--color-arco-surface-30)] p-3">
                    <dt className="text-xs text-[var(--color-arco-muted)]">{fact.label}</dt>
                    <dd className="mt-1 text-sm font-medium leading-5 text-[var(--color-arco-ink)]">{fact.value}</dd>
                    <p className="mt-2 text-[11px] text-[var(--color-arco-muted)]">{fact.scope}{fact.asOf && ` · ${fact.asOf}`}</p>
                    <a href={fact.sourceUrl} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--color-arco-text-soft)] underline underline-offset-2">
                      {fact.sourceLabel} <ArrowUpRight aria-hidden="true" className="size-3" />
                    </a>
                  </div>
                ))}
              </dl>
            </div>
            <div className={CARD}>
              <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">Fee structure</h3>
              <p className="mt-1 text-xs text-[var(--color-arco-muted)]">Terms in the DigiFT source material</p>
              <p className="mt-4 text-sm leading-6 text-[var(--color-arco-ink)]">{asset.fee}</p>
            </div>
          </section>

          <section id="more-info" className="scroll-mt-[140px] space-y-4">
            <h2 className="text-lg font-semibold text-[var(--color-arco-ink)]">More Info</h2>
            <DocsLinksCard docs={docs} />
            {asset.aumEstimate ? (
              <div className={CARD} data-testid="digift-aum-estimate">
                <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">{asset.aumEstimate.illustrative ? "Illustrative AUM basis" : "Estimated fund AUM basis"}</h3>
                <p className="mt-3 font-mono text-lg text-[var(--color-arco-ink)]">{compactAum(asset.aumEstimate.value)}</p>
                <p className="mt-2 text-sm leading-6 text-[var(--color-arco-text-soft)]">{asset.aumEstimate.basis}</p>
                {asset.aumEstimate.asOf && <p className="mt-2 text-xs text-[var(--color-arco-muted)]">Underlying observation: {asset.aumEstimate.asOf}</p>}
                <p className="mt-2 text-xs text-[var(--color-arco-muted)]">This is not token AUM or an Arco balance.</p>
              </div>
            ) : (
              <div className={CARD}>
                <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">AUM source</h3>
                <p className="mt-2 text-sm leading-6 text-[var(--color-arco-text-soft)]">{asset.aum} is reported in the DigiFT overview for the underlying fund. It is not token AUM or an Arco balance.</p>
              </div>
            )}
            <p className="text-xs leading-5 text-[var(--color-arco-muted)]">DigiFT Product Overview, pages 3 and {asset.sourcePage}. Information is dated {asset.sourceAsOf} unless a separate metric date is shown. Source figures are snapshots, not live quotes or Arco product terms.</p>
          </section>
        </div>

        <aside className="min-w-0 self-start lg:sticky lg:top-[140px]">
          <div className={CARD}>
            <p className="text-xs uppercase tracking-wide text-[var(--color-arco-muted)]">Product access</p>
            <h2 className="mt-2 text-lg font-semibold text-[var(--color-arco-ink)]">Reference profile</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--color-arco-text-soft)]">This is a read-only profile based on DigiFT product material. Arco transactions are not available for this asset.</p>
            <dl className="mt-5 space-y-0 border-t border-[var(--color-arco-border)]">
              <SidebarField label="Base asset" value="USDC · preview" />
              <SidebarField label="Liquidity" value={asset.liquidity} />
              <SidebarField label="Minimum investment in source" value={asset.minInvestment} />
              <SidebarField label="Settlement in source" value={asset.settlement} />
            </dl>
            <a href={asset.sourceUrl} target="_blank" rel="noreferrer noopener" className="mt-5 inline-flex items-center gap-1 text-sm font-medium text-[var(--color-arco-ink)] underline underline-offset-4">
              View source material <ArrowUpRight aria-hidden="true" className="size-4" />
            </a>
          </div>
        </aside>
      </div>
    </div>
  )
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-row)] bg-[var(--color-arco-surface-30)] p-3">
      <dt className="text-xs text-[var(--color-arco-muted)]">{label}</dt>
      <dd className="mt-1 text-sm font-medium leading-5 text-[var(--color-arco-ink)]">{value}</dd>
    </div>
  )
}

function SidebarField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-[var(--color-arco-border)] py-3 last:border-b-0">
      <dt className="text-xs text-[var(--color-arco-muted)]">{label}</dt>
      <dd className="text-sm font-medium leading-5 text-[var(--color-arco-ink)]">{value}</dd>
    </div>
  )
}
