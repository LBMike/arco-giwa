import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { AlertCircle } from "lucide-react"
import { giwaApi } from "./api"
import { vaultConfigOf } from "./catalog"
import { GIWA_CHAIN_ID, GIWA_LIVE_REFETCH } from "./config"
import {
  GIWA_EMPTY_FILTERS,
  GiwaCatalogTable,
  GiwaFeaturedCarousel,
  GiwaFilterBar,
  GiwaStrategyCards,
  applyGiwaFilters,
  applyReferenceFilters,
  type GiwaCategory,
  type GiwaFilters,
} from "./components"
import { giwaProductPath } from "./routes"
import { nextSort } from "./sort"
import { ProductsSkeleton } from "./GiwaSkeleton"
import { referenceAssetsForList } from "./digift-reference-assets"

export default function GiwaInvestorPage() {
  const navigate = useNavigate()
  const catalogQuery = useQuery({ queryKey: ["giwa", "catalog"], queryFn: giwaApi.catalog, ...GIWA_LIVE_REFETCH })
  const marketQuery = useQuery({
    queryKey: ["giwa", "market", GIWA_CHAIN_ID],
    queryFn: () => giwaApi.market(GIWA_CHAIN_ID),
    ...GIWA_LIVE_REFETCH,
  })
  // Admin-managed hero carousel selection (shown-only, ordered from the server). Refetches on
  // the shared live policy so operator edits flow through.
  const featuredQuery = useQuery({ queryKey: ["giwa", "featured"], queryFn: giwaApi.featured, ...GIWA_LIVE_REFETCH })
  const [sort, setSort] = useState<{ key: "aum" | "apy"; dir: "asc" | "desc" }>({ key: "aum", dir: "desc" })
  const [filters, setFilters] = useState<GiwaFilters>(GIWA_EMPTY_FILTERS)

  // `hidden` is investor-UI declutter (keep WIP vaults out of the public list), NOT an
  // access-control boundary — the catalog endpoint still returns hidden vaults and the
  // admin Vault Config page shows them.
  // Excludes hidden vaults (investor declutter) AND saving vaults (kind="saving" → they live on
  // the Savings page only, never in Products).
  const products = useMemo(
    () => (catalogQuery.data ?? []).filter((product) => !vaultConfigOf(product).hidden && vaultConfigOf(product).kind !== "saving"),
    [catalogQuery.data],
  )
  const filteredProducts = useMemo(() => applyGiwaFilters(products, filters), [filters, products])
  // Every DigiFT reference product not already deployed: the risk cards count these per tier.
  const referenceAssets = useMemo(() => referenceAssetsForList(products.map((product) => product.symbol)), [products])
  const referenceRows = useMemo(
    () => applyReferenceFilters(referenceAssetsForList(products.map((product) => product.symbol), filters.search), filters),
    [products, filters],
  )
  // Real market APY per product (e.g. aCAPIX 11.58%); null for products without a published rate,
  // in which case the table falls back to the legacy apyLabel.
  const apyByProductId = useMemo(
    () => Object.fromEntries((marketQuery.data ?? []).map((entry) => [entry.productId.toLowerCase(), entry.apy])),
    [marketQuery.data],
  )
  // Implied APY from indexed price history — gap-filler for vaults with neither a published
  // rate nor a legacy profile (e.g. newly-registered vaults); null with <2 posts.
  const impliedApyByProductId = useMemo(
    () => Object.fromEntries((marketQuery.data ?? []).map((entry) => [entry.productId.toLowerCase(), entry.impliedApy])),
    [marketQuery.data],
  )

  function patchFilters(patch: Partial<GiwaFilters>) {
    setFilters((current) => ({ ...current, ...patch }))
  }

  // Strategy cards and the Category dropdown share the (now multi-select) category filter, so a card
  // click toggles its category in/out of the array via the functional updater (no stale closure).
  function toggleCategory(category: GiwaCategory) {
    setFilters((current) => ({
      ...current,
      category: current.category.includes(category)
        ? current.category.filter((entry) => entry !== category)
        : [...current.category, category],
    }))
  }

  // First-load only: react-query isLoading is true just for the initial fetch (no cached data).
  // Background refetches under GIWA_LIVE_REFETCH are isFetching, not isLoading, so they never re-skeleton.
  if (catalogQuery.isLoading) return <ProductsSkeleton />

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-3xl font-semibold text-[var(--color-arco-ink)]">Products</h1>
      </section>

      <GiwaFeaturedCarousel cards={featuredQuery.data ?? []} catalog={products} />
      <GiwaStrategyCards products={products} referenceAssets={referenceAssets} active={filters.category} onToggle={toggleCategory} />

      {catalogQuery.isError && <ErrorBox title="Registry unavailable" message={catalogQuery.error.message} />}

      <section className="space-y-4">
        <h2 className="pl-1 text-lg font-medium text-[var(--color-arco-ink)]">All Funds</h2>
        <GiwaFilterBar products={products} filters={filters} onChange={patchFilters} />
        <div className="pt-2">
          <GiwaCatalogTable
            rows={filteredProducts}
            referenceRows={referenceRows}
            selectedProductId=""
            sortKey={sort.key}
            sortDir={sort.dir}
            onSort={(key) => setSort((current) => nextSort(current, key))}
            onSelect={(productId) => navigate(giwaProductPath(productId))}
            apyByProductId={apyByProductId}
            impliedApyByProductId={impliedApyByProductId}
          />
        </div>
      </section>
    </div>
  )
}

function ErrorBox({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      <div className="flex items-center gap-2 font-semibold">
        <AlertCircle className="size-4" />
        {title}
      </div>
      <p className="mt-1">{message}</p>
    </div>
  )
}
