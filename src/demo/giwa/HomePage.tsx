import { useMemo, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { ArrowRight } from "lucide-react"
import { giwaApi } from "./api"
import { GIWA_CHAIN_ID, GIWA_LIVE_REFETCH } from "./config"
import { countLabel, fundsProductsOf, homeSavingsSummary } from "./home"
import { GIWA_FUNDS_ROUTE, GIWA_SAVINGS_ROUTE, GIWA_STOCKS_ROUTE } from "./routes"
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
  const savings = useMemo(
    () => homeSavingsSummary(catalogQuery.data ?? [], marketQuery.data ?? []),
    [catalogQuery.data, marketQuery.data],
  )
  // Counts depend on the catalog only; the market query just warms the shared cache.
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
                  <li
                    key={account.key}
                    className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-arco-chip)] py-1 pl-1 pr-2.5 text-xs text-[var(--color-arco-chip-ink)]"
                  >
                    <span aria-hidden="true" className="inline-flex">
                      <BrandMark src={account.icon ?? undefined} label={account.symbol} size={20} />
                    </span>
                    {account.symbol}
                  </li>
                ))}
              </ul>
            )}
          </HomeCard>
          <HomeCard to={GIWA_FUNDS_ROUTE} title="Funds" cta="Browse funds">
            <p className="text-sm text-[var(--color-arco-text-soft)]">
              {status ?? countLabel(funds.length, "product", "products")}
            </p>
          </HomeCard>
        </div>
      </section>

      <section aria-labelledby="home-stocks" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="home-stocks" className="text-xl font-medium text-[var(--color-arco-ink)]">
            Stocks
          </h2>
          <Link
            to={GIWA_STOCKS_ROUTE}
            className={`inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-medium text-[var(--color-arco-ink)] hover:underline ${FOCUS}`}
          >
            View all stocks
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        </div>
        <StocksHomeList />
      </section>
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
