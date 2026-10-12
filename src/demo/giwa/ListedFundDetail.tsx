import { useEffect, type ReactNode } from "react"
import { ArrowLeft, ArrowUpRight, ExternalLink } from "lucide-react"
import { Link } from "react-router-dom"
import { AboutCard } from "../components/AboutCard"
import { BrandMark } from "../components/BrandMark"
import { DocsLinksCard } from "../components/DocsLinksCard"
import { FeeStructureCard } from "../components/FeeStructureCard"
import { MetricCard } from "../components/MetricCard"
import { PortfolioCard } from "../components/PortfolioCard"
import { SectionNav } from "../components/SectionNav"
import { GiwaNetworkIcon } from "./components"
import { FirmMark, FundMark } from "./FundMark"
import { ListedFundInvestPanel } from "./ListedFundInvestPanel"
import { listedFundPortfolio } from "./listed-fund-portfolio"
import { formatAsOf, type ListedFund } from "./listed-funds"
import { GIWA_FUNDS_ROUTE } from "./routes"

const CARD = "rounded-[var(--radius-strategy)] bg-[var(--color-arco-surface)] p-5 shadow-[var(--shadow-control)]"
const CHIP = "rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[11px] text-[var(--color-arco-text-soft)]"

// Product page for a listed fund, built like the deployed vault page (ProductDetailView): the same
// header, section nav, overview, performance, transparency and more-info blocks, and the invest
// panel with the action reading "Coming soon".
export function ListedFundDetail({ fund }: { fund: ListedFund }) {
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [fund.id])

  const portfolio = listedFundPortfolio(fund)
  const asOf = (iso: string) => `As of ${formatAsOf(iso)}`

  return (
    <div className="w-full pb-10" data-testid="listed-fund-detail">
      <Link to={GIWA_FUNDS_ROUTE} className="inline-flex items-center gap-1 text-sm text-[var(--color-arco-muted)] hover:text-[var(--color-arco-ink)]">
        <ArrowLeft aria-hidden="true" className="size-4" /> Back to products
      </Link>

      <header className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <FundMark fund={fund} size={40} />
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-[var(--color-arco-ink)]">{fund.symbol}</h1>
            <span className={CHIP}>{fund.name}</span>
            <span className={CHIP}>GIWA</span>
          </div>
        </div>
        <div className="flex items-center gap-8">
          <Identity label="ISSUER">
            <BrandMark src={fund.issuer.logo} label={fund.issuer.name} size={16} />
            <span className="text-sm text-[var(--color-arco-ink)]">{fund.issuer.name}</span>
          </Identity>
          <Identity label="ASSET MANAGER">
            <FirmMark party={fund.manager} size={16} />
            <span className="text-sm text-[var(--color-arco-ink)]">{fund.manager.name}</span>
          </Identity>
        </div>
      </header>

      <SectionNav />

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-10">
          <section id="overview" className="scroll-mt-[140px] space-y-5">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MetricCard label={fund.aum.label ?? "AUM"} value={fund.aum.value} sub={asOf(fund.aum.asOf)} />
              <MetricCard label={fund.metric.label} value={fund.metric.value} sub={asOf(fund.metric.asOf)} />
              {fund.price ? (
                <MetricCard label="Price" value={fund.price} sub="NAV / share (USD)" />
              ) : (
                <MetricCard label="Liquidity" value="Daily" sub="Dealing at NAV" />
              )}
              <MetricCard label="Network">
                <GiwaNetworkIcon size={22} />
              </MetricCard>
            </div>
            <AboutCard paragraphs={[...fund.about]} />
          </section>

          <section id="performance" className="scroll-mt-[140px] space-y-4">
            <h2 className="text-lg font-semibold text-[var(--color-arco-ink)]">Performance</h2>
            <div className={CARD}>
              <p className="text-xs uppercase tracking-wide text-[var(--color-arco-muted)]">{fund.metric.label}</p>
              <p className="mt-3 font-mono text-2xl font-medium text-[var(--color-arco-ink)] sm:text-3xl">{fund.metric.value}</p>
              <p className="mt-2 text-xs text-[var(--color-arco-muted)]">{asOf(fund.metric.asOf)}</p>
              <p className="mt-4 border-t border-[var(--color-arco-border)] pt-4 text-sm leading-6 text-[var(--color-arco-text-soft)]">{fund.metricNote}</p>
            </div>
          </section>

          <section id="transparency" className="scroll-mt-[140px] space-y-4">
            <h2 className="text-lg font-semibold text-[var(--color-arco-ink)]">Transparency</h2>
            {portfolio && (
              <PortfolioCard
                portfolio={portfolio.card}
                enabledViews={portfolio.enabledViews}
                aum={fund.aum.usd}
                percentLabel="% of fund"
                exposureHeading={portfolio.exposureHeading}
                exposureColumnLabel="Segment"
              />
            )}
            <FeeStructureCard fee={fund.fees} href={fund.docs[0]?.href ?? null} />
            <div className={CARD}>
              <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">Product terms</h3>
              <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                <Term label="Underlying" value={fund.underlying} />
                <Term label="Exposure" value={fund.exposure} />
                <Term label="Liquidity" value={fund.liquidity} />
                <Term label="Minimum investment" value={fund.minInvestment} />
                <Term label="Settlement" value={fund.settlement} />
                <Term label="Fees" value={fund.fees.note} />
              </dl>
              {fund.facts.length > 0 && (
                <>
                  <h4 className="mt-6 border-t border-[var(--color-arco-border)] pt-5 text-xs font-medium uppercase tracking-wide text-[var(--color-arco-ink)]">Fund facts</h4>
                  <dl className="mt-3 grid gap-3 sm:grid-cols-2" data-testid="listed-fund-facts">
                    {fund.facts.map((fact) => (
                      <div key={fact.label} className="rounded-[var(--radius-row)] bg-[var(--color-arco-surface-30)] p-3">
                        <dt className="text-xs text-[var(--color-arco-muted)]">{fact.label}</dt>
                        <dd className="mt-1 text-sm font-medium leading-5 text-[var(--color-arco-ink)]">{fact.value}</dd>
                        <a href={fact.sourceUrl} target="_blank" rel="noreferrer noopener" className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--color-arco-text-soft)] underline underline-offset-2">
                          {fact.sourceLabel}
                          {fact.asOf && ` · ${formatAsOf(fact.asOf)}`}
                          <ArrowUpRight aria-hidden="true" className="size-3" />
                        </a>
                      </div>
                    ))}
                  </dl>
                </>
              )}
            </div>
          </section>

          <section id="more-info" className="scroll-mt-[140px] space-y-4">
            <h2 className="text-lg font-semibold text-[var(--color-arco-ink)]">More Info</h2>
            <div className={`grid grid-cols-1 gap-4 ${fund.docs.length > 0 ? "md:grid-cols-2" : ""}`}>
              <TokenCard fund={fund} />
              {fund.docs.length > 0 && <DocsLinksCard docs={[...fund.docs]} />}
            </div>
          </section>
        </div>

        <aside className="min-w-0">
          <ListedFundInvestPanel fund={fund} />
        </aside>
      </div>
    </div>
  )
}

// The token as issued today: platform, its own chain and contract, and its GIWA status.
function TokenCard({ fund }: { fund: ListedFund }) {
  const { token } = fund
  const rows: Array<{ label: string; value: ReactNode }> = [
    { label: "Issued on", value: token.platform },
    { label: token.networks.length > 1 ? "Original networks" : "Original network", value: token.networks.length > 0 ? token.networks.join(", ") : "Not published" },
    {
      label: "Contract",
      value:
        token.contract && token.explorerUrl ? (
          <a href={token.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-[var(--color-arco-ink)] underline">
            {`${token.contract.slice(0, 6)}…${token.contract.slice(-4)}`}
            <ExternalLink className="size-3" />
          </a>
        ) : (
          <span className="font-mono text-xs text-[var(--color-arco-muted)]">—</span>
        ),
    },
    { label: "On GIWA", value: "Coming soon" },
  ]
  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-arco-surface)]" style={{ boxShadow: "var(--shadow-control)" }}>
      <div className="flex items-center justify-between border-b border-[var(--color-arco-border)] px-4 py-3">
        <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">Token</h3>
        <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-1 text-xs text-[var(--color-arco-text-soft)]">
          <GiwaNetworkIcon size={14} />
          GIWA
        </span>
      </div>
      <dl>
        {rows.map((row, index) => (
          <div key={row.label} className={`flex items-center justify-between gap-3 px-4 py-3 ${index > 0 ? "border-t border-[var(--color-arco-border)]" : ""}`}>
            <dt className="text-sm text-[var(--color-arco-text-soft)]">{row.label}</dt>
            <dd className="text-right text-sm text-[var(--color-arco-ink)]">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function Identity({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="text-right">
      <p className="text-[10px] uppercase tracking-wide text-[var(--color-arco-muted)]">{label}</p>
      <div className="mt-1 flex items-center justify-end gap-1.5">{children}</div>
    </div>
  )
}

function Term({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-row)] bg-[var(--color-arco-surface-30)] p-3">
      <dt className="text-xs text-[var(--color-arco-muted)]">{label}</dt>
      <dd className="mt-1 text-sm font-medium leading-5 text-[var(--color-arco-ink)]">{value}</dd>
    </div>
  )
}
