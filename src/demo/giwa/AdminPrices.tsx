import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { giwaApi, type GiwaPriceHistoryPoint } from "./api"
import { GIWA_CHAIN_ID, GIWA_LIVE_REFETCH } from "./config"
import { readPriceFeedState, readShareSupply, type PriceFeedState } from "./contracts"
import { ProductCatalogList } from "./components"
import {
  FreshnessChip,
  PriceFeedAdminPanel,
  formatAgo,
  formatDuration,
  formatPrice,
  formatTimestamp,
  trimNumber,
} from "./PriceFeedAdminPanel"
import { fromAnswer, impliedApyPercent, isStale, SECONDS_PER_DAY } from "./price-policy"
import { useGiwaAdmin } from "./GiwaAdminLayout"
import type { GiwaCatalogItem, HexAddress } from "./types"

export default function GiwaAdminPricesPage() {
  const { operatorToken, wallet } = useGiwaAdmin()
  const queryClient = useQueryClient()
  const catalogQuery = useQuery({ queryKey: ["giwa", "catalog", "admin"], queryFn: giwaApi.catalog })
  const [selectedId, setSelectedId] = useState("acapix")

  const products = catalogQuery.data ?? []
  const selected = products.find((product) => product.productId === selectedId) ?? products[0]

  return (
    <div className="w-full space-y-6">
      <section>
        <p className="text-sm text-[var(--color-arco-muted)]">Admin · Prices</p>
        <h1 className="mt-1 text-3xl font-semibold text-[var(--color-arco-ink)]">Price updates</h1>
      </section>

      <ProductCatalogList products={products} selectedProductId={selected?.productId ?? selectedId} onSelect={setSelectedId} />

      {selected && (
        <PriceFeedAdminPanel
          key={selected.productId}
          product={selected}
          operatorToken={operatorToken}
          walletAddress={wallet.address ?? null}
          onConfirmed={async () => {
            // A NAV post confirmed. PRICE reads live on-chain (updates on the next refetch);
            // APY/history update once the indexer has the post, which lags a few seconds — so
            // invalidate now, then bridge the indexing lag with two delayed refetches.
            const productId = selected?.productId
            const refreshLiveReads = () => {
              queryClient.invalidateQueries({ queryKey: ["giwa", "catalog"] })
              queryClient.invalidateQueries({ queryKey: ["giwa", "market"] })
              if (productId) queryClient.invalidateQueries({ queryKey: ["giwa", "price-history", productId] })
            }
            refreshLiveReads()
            window.setTimeout(refreshLiveReads, 6_000)
            window.setTimeout(refreshLiveReads, 14_000)
          }}
        />
      )}

      <VaultPriceStatusSection
        products={products}
        selectedId={selected?.productId ?? selectedId}
        onSelect={setSelectedId}
      />

      {selected && <PricePostingHistorySection product={selected} />}
    </div>
  )
}

/* ── 1a: vault price-status list ─────────────────────────────────────────── */

function VaultPriceStatusSection({
  products,
  selectedId,
  onSelect,
}: {
  products: GiwaCatalogItem[]
  selectedId: string
  onSelect: (productId: string) => void
}) {
  return (
    <section className="w-full rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-5" style={{ boxShadow: "var(--shadow-control)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--color-arco-ink)]">Vault price status</h2>
        <span className="text-[11px] text-[var(--color-arco-muted)]">Click a row to load it in the price controls above</span>
      </div>
      {products.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-arco-muted)]">No products in the catalog yet.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead>
              <tr className="text-[var(--color-arco-muted)]">
                <th className="py-1.5 pr-3 font-normal">Product</th>
                <th className="py-1.5 pr-3 font-normal">Current price</th>
                <th className="py-1.5 pr-3 font-normal">Current NAV</th>
                <th className="py-1.5 pr-3 font-normal">Last updated</th>
                <th className="py-1.5 pr-3 font-normal">Status</th>
                <th className="py-1.5 font-normal">Staleness window</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <PriceStatusRow
                  key={product.productId}
                  product={product}
                  selected={product.productId === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function PriceStatusRow({
  product,
  selected,
  onSelect,
}: {
  product: GiwaCatalogItem
  selected: boolean
  onSelect: (productId: string) => void
}) {
  const priceFeed = product.priceFeedAddress
  // Same queryKey as PriceFeedAdminPanel's status query, so the cache is shared and the
  // selected product's row and the panel above stay in sync (and refresh together).
  const stateQuery = useQuery({
    queryKey: ["giwa", "price-feed", priceFeed],
    queryFn: () => readPriceFeedState(priceFeed as HexAddress),
    enabled: Boolean(priceFeed),
    refetchInterval: 30_000,
  })
  // Shares for the Current NAV column — same queryKey as the panel's supply read (shared cache,
  // one on-chain read per token). Token-less like the rest of the table (pure on-chain read).
  const productToken = product.productTokenAddress
  const shareQuery = useQuery({
    queryKey: ["giwa", "share-supply", productToken],
    queryFn: () => readShareSupply(productToken as HexAddress),
    enabled: Boolean(productToken),
    refetchInterval: 30_000,
  })
  const shares = shareQuery.data ? Number(shareQuery.data.supply) / 10 ** shareQuery.data.decimals : null
  return (
    <PriceStatusRowView
      product={product}
      shares={shares}
      state={stateQuery.data ?? null}
      loading={Boolean(priceFeed) && stateQuery.isLoading}
      error={stateQuery.isError ? (stateQuery.error instanceof Error ? stateQuery.error.message : String(stateQuery.error)) : null}
      nowSeconds={Math.floor(Date.now() / 1000)}
      selected={selected}
      onSelect={onSelect}
    />
  )
}

export function PriceStatusRowView({
  product,
  state,
  shares,
  loading,
  error,
  nowSeconds,
  selected,
  onSelect,
}: {
  product: GiwaCatalogItem
  state: PriceFeedState | null
  // Human shares outstanding for the Current NAV column; null/omitted → "—".
  shares?: number | null
  loading?: boolean
  error?: string | null
  nowSeconds: number
  selected?: boolean
  onSelect?: (productId: string) => void
}) {
  const stale = state ? isStale({ updatedAt: state.updatedAt, healthyDiff: state.healthyDiff, now: nowSeconds }) : false
  return (
    <tr
      onClick={() => onSelect?.(product.productId)}
      className={`cursor-pointer border-t border-[var(--color-arco-border)] ${selected ? "bg-[var(--color-arco-surface-muted)]" : ""}`}
    >
      <td className="py-2 pr-3">
        <span className="font-semibold text-[var(--color-arco-ink)]">{product.symbol}</span>
        <span className="ml-2 rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[11px] text-[var(--color-arco-text-soft)]">
          {product.paymentAssetSymbol}
        </span>
      </td>
      {!product.priceFeedAddress ? (
        <td colSpan={5} className="py-2 text-[var(--color-arco-muted)]">
          No price feed deployed
        </td>
      ) : loading ? (
        <td colSpan={5} className="py-2 text-[var(--color-arco-muted)]">
          <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
          Reading on-chain status…
        </td>
      ) : error ? (
        <td colSpan={5} className="py-2 text-[var(--color-arco-down)]">
          {error}
        </td>
      ) : state ? (
        <>
          <td className="py-2 pr-3">
            <span className="tabular-nums font-semibold text-[var(--color-arco-ink)]">{formatPrice(fromAnswer(state.answer))}</span>
            <span className="block font-mono text-[10px] text-[var(--color-arco-muted)]">answer {state.answer.toString()}</span>
          </td>
          <td className="py-2 pr-3 tabular-nums text-[var(--color-arco-ink)]">
            {shares != null ? `${trimNumber(fromAnswer(state.answer) * shares, 2)} ${product.paymentAssetSymbol}` : "—"}
          </td>
          <td className="py-2 pr-3">
            <span className="text-[var(--color-arco-ink)]">{formatAgo(Number(state.updatedAt), nowSeconds)}</span>
            <span className="block text-[10px] text-[var(--color-arco-muted)]">{formatTimestamp(Number(state.updatedAt))}</span>
          </td>
          <td className="py-2 pr-3">
            <FreshnessChip stale={stale} />
          </td>
          <td className="py-2 text-[var(--color-arco-ink)]">{formatDuration(Number(state.healthyDiff))}</td>
        </>
      ) : null}
    </tr>
  )
}

/* ── 1c: price posting history ───────────────────────────────────────────── */

export type PriceHistoryRow = { t: number; navBase: number; impliedApy: number | null }

// The APY shown is IMPLIED by the on-chain NAV change between consecutive posts
// (impliedApyPercent over the elapsed period). If we later want the operator's exact
// entered APY at post time, that needs a small off-chain post-log — out of scope now.
export function buildHistoryRows(points: GiwaPriceHistoryPoint[]): PriceHistoryRow[] {
  const ordered = [...points].sort((a, b) => a.t - b.t)
  const rows = ordered.map((point, index) => {
    const prev = index > 0 ? ordered[index - 1] : null
    const impliedApy = prev
      ? impliedApyPercent({
          basePrice: prev.navBase,
          newPrice: point.navBase,
          periodDays: (point.t - prev.t) / SECONDS_PER_DAY,
        })
      : null
    return { t: point.t, navBase: point.navBase, impliedApy }
  })
  return rows.reverse()
}

function PricePostingHistorySection({ product }: { product: GiwaCatalogItem }) {
  // Same queryKey as ProductDetailPage's history query — shared cache. The endpoint is
  // built from indexed PriceUpdated events, so it is empty until the indexer has run.
  const historyQuery = useQuery({
    queryKey: ["giwa", "price-history", product.productId],
    queryFn: () => giwaApi.priceHistory(GIWA_CHAIN_ID, product.productId),
    ...GIWA_LIVE_REFETCH,
  })
  return (
    <PriceHistoryTable
      symbol={product.symbol}
      paymentAssetSymbol={product.paymentAssetSymbol}
      points={historyQuery.data?.points ?? null}
      loading={historyQuery.isLoading}
      error={historyQuery.isError ? (historyQuery.error instanceof Error ? historyQuery.error.message : String(historyQuery.error)) : null}
    />
  )
}

export function PriceHistoryTable({
  symbol,
  paymentAssetSymbol,
  points,
  loading,
  error,
}: {
  symbol: string
  paymentAssetSymbol: string
  points: GiwaPriceHistoryPoint[] | null
  loading?: boolean
  error?: string | null
}) {
  const rows = points ? buildHistoryRows(points) : []
  return (
    <section className="w-full rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-5" style={{ boxShadow: "var(--shadow-control)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--color-arco-ink)]">Price posting history</h2>
        <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[11px] text-[var(--color-arco-text-soft)]">
          {symbol}
        </span>
      </div>
      {loading ? (
        <p className="mt-3 text-sm text-[var(--color-arco-muted)]">
          <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
          Loading price history…
        </p>
      ) : error ? (
        <p className="mt-3 text-sm text-[var(--color-arco-down)]">Could not load the price history: {error}</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-arco-muted)]">No price updates recorded yet.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-xs">
            <thead>
              <tr className="text-[var(--color-arco-muted)]">
                <th className="py-1.5 pr-3 font-normal">Date/time</th>
                <th className="py-1.5 pr-3 font-normal">NAV ({paymentAssetSymbol})</th>
                <th className="py-1.5 font-normal">Implied APY</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.t} className="border-t border-[var(--color-arco-border)]">
                  <td className="py-2 pr-3 text-[var(--color-arco-ink)]">{formatTimestamp(row.t)}</td>
                  <td className="py-2 pr-3 tabular-nums text-[var(--color-arco-ink)]">{formatPrice(row.navBase)}</td>
                  <td className="py-2 tabular-nums text-[var(--color-arco-ink)]">
                    {row.impliedApy !== null ? `${trimNumber(row.impliedApy, 2)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
