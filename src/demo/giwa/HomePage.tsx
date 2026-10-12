import { useMemo, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { ArrowRight } from "lucide-react"
import { giwaApi } from "./api"
import { vaultDisplayName, vaultImageFor } from "./catalog"
import { apyLabel, productById } from "../data/products"
import { GIWA_CHAIN_ID, GIWA_LIVE_REFETCH } from "./config"
import { countLabel, fundsProductsOf, homeSavingsSummary } from "./home"
import { FundMark } from "./FundMark"
import { DEPLOYED_FUND_METRICS, listedFundsForCatalog } from "./listed-funds"
import { GIWA_FUNDS_ROUTE, GIWA_SAVINGS_ROUTE } from "./routes"
import { BrandMark } from "../components/BrandMark"
import { StocksHomeList } from "./stocks-market/StocksHomeList"

const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
const CARD = `flex h-full flex-col rounded-[var(--radius-strategy)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-6 transition-colors hover:bg-[var(--color-arco-surface-muted)] ${FOCUS}`

// Investor Home: entry cards for Savings and Funds (counts from the same catalog/market queries,
// so the cache is shared with those pages) and the Stocks list.
export default function GiwaHomePage() {
  const catalogQuery = useQuery({ queryKey: ["giwa", "catalog"], queryFn: giwaApi.catalog, ...GIWA_LIVE_REFETCH })
  const marketQuery = useQuery({
    queryKey: ["giwa", "market", GIWA_CHAIN_ID],
    queryFn: () => giwaApi.market(GIWA_CHAIN_ID),
    ...GIWA_LIVE_REFETCH,
  })
  const funds = useMemo(() => fundsProductsOf(catalogQuery.data ?? []), [catalogQuery.data])
  // The funds Arco distributes that are not deployed yet; the Funds page lists them too.
  const listedFunds = useMemo(() => listedFundsForCatalog(funds.map((product) => product.symbol)), [funds])
  const savings = useMemo(
    () => homeSavingsSummary(catalogQuery.data ?? [], marketQuery.data ?? []),
    [catalogQuery.data, marketQuery.data],
  )
  const fundRates = useMemo(() => {
    const market = new Map((marketQuery.data ?? []).map(entry => [entry.productId.toLowerCase(), entry]))
    return new Map(funds.map(product => {
      const entry = market.get(product.productId.toLowerCase())
      // Same precedence as the Funds table: published, the fund deck's rate (named by its own
      // label), legacy, then implied APY.
      const deck = entry?.apy == null ? DEPLOYED_FUND_METRICS[product.productId.toLowerCase()] : undefined
      if (deck) return [product.productId, { value: deck.metric.value, label: deck.metric.label }]
      const rate = entry?.apy ?? productById(product.productId)?.apy ?? entry?.impliedApy ?? null
      return [product.productId, { value: rate == null ? "—" : apyLabel(rate), label: "APY" }]
    }))
  }, [funds, marketQuery.data])
  // Counts remain available while the market query loads; unknown rates stay empty.
  const status = catalogQuery.isLoading ? "Loading…" : catalogQuery.isError ? "Registry unavailable" : null

  return (
    <div className="w-full min-w-0 space-y-10">
      <h1 className="text-3xl font-medium text-[var(--color-arco-ink)]">Home</h1>

      <section aria-labelledby="home-invest" className="space-y-4">
        <h2 id="home-invest" className="text-xl font-medium text-[var(--color-arco-ink)]">
          Invest
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <HomeCard to={GIWA_SAVINGS_ROUTE} title="Savings" cta="Open Savings">
            <p className="text-sm text-[var(--color-arco-text-soft)]">
              {status ??
                (savings.accounts.length === 0
                  ? "No savings accounts yet"
                  : `${countLabel(savings.accounts.length, "savings account", "savings accounts")}${
                      savings.comingSoon > 0 ? ` · ${savings.comingSoon} coming soon` : ""
                    }`)}
            </p>
            {!status && savings.accounts.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2">
                {savings.accounts.map((account) => (
                  <HomeProductChip
                    key={account.key}
                    name={account.symbol}
                    icon={<BrandMark src={account.icon ?? undefined} label={account.symbol} size={20} />}
                    apy={account.apy}
                  />
                ))}
              </ul>
            )}
          </HomeCard>
          <HomeCard to={GIWA_FUNDS_ROUTE} title="Funds" cta="Browse funds">
            <p className="text-sm text-[var(--color-arco-text-soft)]">
              {status ?? countLabel(funds.length + listedFunds.length, "product", "products")}
            </p>
            {!status && funds.length + listedFunds.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2">
                {funds.map(product => (
                  <HomeProductChip
                    key={product.productId}
                    name={vaultDisplayName(product)}
                    icon={<BrandMark src={vaultImageFor(product)} label={vaultDisplayName(product)} size={20} />}
                    apy={fundRates.get(product.productId)?.value ?? "—"}
                    rateLabel={fundRates.get(product.productId)?.label}
                  />
                ))}
                {listedFunds.map(fund => (
                  <HomeProductChip
                    key={fund.id}
                    name={fund.symbol}
                    icon={<FundMark fund={fund} size={20} />}
                    apy={fund.metric.value}
                    rateLabel={fund.metric.label}
                  />
                ))}
              </ul>
            )}
          </HomeCard>
        </div>
      </section>

      <StocksHomeList withHighlights />
    </div>
  )
}

function HomeCard({ to, title, cta, children }: { to: string; title: string; cta: string; children: ReactNode }) {
  return (
    <Link to={to} className={CARD}>
      <h3 className="text-lg font-medium text-[var(--color-arco-ink)]">{title}</h3>
      <div className="mt-2 flex-1">{children}</div>
      <span className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-arco-ink)]">
        {cta}
        <ArrowRight aria-hidden="true" className="size-4" />
      </span>
    </Link>
  )
}

function HomeProductChip({ name, icon, apy, rateLabel = "APY" }: { name: string; icon: ReactNode; apy: string; rateLabel?: string }) {
  return <li className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--color-arco-chip)] py-1 pl-1 pr-2.5 text-xs text-[var(--color-arco-chip-ink)]">
    <span aria-hidden="true" className="inline-flex shrink-0">{icon}</span>
    <span className="min-w-0 break-words">{name}</span>
    <span className={`shrink-0 font-medium tabular-nums ${apy === "—" ? "text-[var(--color-arco-text-soft)]" : "text-[var(--color-arco-up-text)]"}`}>
      {apy}<span className="sr-only"> {rateLabel}</span>
    </span>
  </li>
}
