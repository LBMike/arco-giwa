import { useMemo } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { giwaApi } from "./api"
import { GIWA_CHAIN_ID, GIWA_LIVE_REFETCH } from "./config"
import { useGiwaVaultDetail } from "./useGiwaVaultDetail"
import { GiwaInvestPanel } from "./components"
import { PerformanceSection, TransparencySection, MoreInfoSection } from "./detail-sections"
import { parseAumToNumber } from "./display-profile"
import { marketApyPercent } from "./price-policy"
import { buildSavingsAccounts, resolveSavingsSelection, type SavingsAccount } from "./savings"
import { SAVINGS_CATEGORIES, savingsAssetCategory, savingsCategoryFromSearch, savingsCategoryPath } from "./savings-category"
import { SavingsAccountSelector } from "./SavingsAccountSelector"
import { SavingsSkeleton } from "./GiwaSkeleton"
import type { GiwaCatalogItem } from "./types"

export default function GiwaSavingsPage() {
  const catalogQuery = useQuery({ queryKey: ["giwa", "catalog"], queryFn: giwaApi.catalog, ...GIWA_LIVE_REFETCH })
  const marketQuery = useQuery({
    queryKey: ["giwa", "market", GIWA_CHAIN_ID],
    queryFn: () => giwaApi.market(GIWA_CHAIN_ID),
    ...GIWA_LIVE_REFETCH,
  })

  // Ordered selector list (pinned → AUM desc → intra-vault index); dummies kept disabled, dangling
  // reals skipped. Pure + unit-tested in savings.ts.
  const allAccounts = useMemo(
    () => buildSavingsAccounts(catalogQuery.data ?? [], marketQuery.data ?? []),
    [catalogQuery.data, marketQuery.data],
  )
  const [searchParams, setSearchParams] = useSearchParams()
  const category = savingsCategoryFromSearch(searchParams)
  const accounts = useMemo(() => allAccounts.filter(account => savingsAssetCategory(account.symbol) === category), [allAccounts, category])
  const selectedAsset = searchParams.get("asset")
  const selectedAccount = searchParams.get("account")
  // Resolve the active account: an explicit enabled pick, else the default (first enabled). Falls
  // back to the default when the picked key drops out of the list (config change / stale key).
  const selected = useMemo<SavingsAccount | null>(() => {
    return resolveSavingsSelection(accounts, selectedAccount, selectedAsset)
  }, [accounts, selectedAccount, selectedAsset])

  // First-load only (no cached data yet). Distinguishing loading from empty fixes the bug where
  // the page flashed "No savings accounts yet" before the catalog/market arrived. Background
  // refetches under GIWA_LIVE_REFETCH are isFetching, not isLoading, so they never re-skeleton.
  const loading = catalogQuery.isLoading || marketQuery.isLoading

  return (
    <div className="w-full">
      <SavingsHero />
      <div className="mx-auto mt-8 w-full max-w-[505px] space-y-8">
        <nav aria-label="Savings categories" className="flex gap-2 rounded-full bg-[var(--color-arco-chip)] p-1">
          {SAVINGS_CATEGORIES.map(item => <Link key={item.id} to={savingsCategoryPath(item.id)} aria-current={category === item.id ? "page" : undefined}
            className={`flex min-h-11 flex-1 items-center justify-center rounded-full px-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)] ${category === item.id ? "bg-[var(--color-arco-surface)] text-[var(--color-arco-ink)]" : "text-[var(--color-arco-text-soft)]"}`}>
            {item.label}
          </Link>)}
        </nav>
        {loading ? (
          <SavingsSkeleton />
        ) : accounts.length === 0 ? (
          <SavingsEmptyState categoryLabel={SAVINGS_CATEGORIES.find(item => item.id === category)!.label} />
        ) : (
          <>
            <SavingsAccountSelector
              accounts={accounts}
              selectedKey={selected?.key ?? null}
              onSelect={(account) => setSearchParams(previous => { const next = new URLSearchParams(previous); next.set("category", category); next.set("asset", account.symbol); next.set("account", account.key); return next })}
            />
            {selected?.vault ? (
              // Keyed by vault so switching assets cleanly remounts the detail (stable hook count).
              <SavingsDetail key={selected.vault.productId} vault={selected.vault} acceptAssetIcon={selected.icon} />
            ) : (
              <p className="text-center text-sm text-[var(--color-arco-muted)]">Select a savings account to continue.</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// Full-width (container-width) hero band. Title + subtitle are Figma-verbatim (node 369:3874); the
// subtitle copy reads oddly ("…yield and when you deposit…") — flagged for separate copy review.
function SavingsHero() {
  return (
    <section className="relative overflow-hidden rounded-[8px]">
      <img
        src="/savings-hero-bg.png"
        alt=""
        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
      />
      <div className="relative flex flex-col items-center px-6 py-12 text-center">
        <h1 className="text-[72px] font-medium leading-[1.05] text-[var(--color-arco-ink)]">Savings</h1>
        <p className="mt-2 max-w-[720px] text-[21px] leading-[1.5] text-[var(--color-arco-ink)] opacity-40">
          Earn institution-grade yield and when you deposit your ETH, XRP and USD with Arco.
        </p>
      </div>
    </section>
  )
}

// The selected saving vault's operations + read-only sections — the SAME reused components as the
// product detail page, MINUS Overview/About (Savings shows only Performance/Transparency/More Info).
// Consumes useGiwaVaultDetail unchanged (product detail stays byte-identical).
function SavingsDetail({ vault, acceptAssetIcon }: { vault: GiwaCatalogItem; acceptAssetIcon: string | null }) {
  const detail = useGiwaVaultDetail(vault)
  return (
    <div className="w-full space-y-10">
      {/* flow (non-sticky): single-column Savings — a sticky panel would pin here and block scroll to the footer. */}
      <GiwaInvestPanel
        {...detail.panel}
        instantLiquidityUsd={detail.instantLiquidityUsd}
        baseUsd={detail.baseUsd}
        variant="flow"
        savings={{ apyText: detail.apyText, apyPercent: marketApyPercent(detail.market), acceptAssetIcon }}
      />
      <PerformanceSection market={detail.market} history={detail.history} isBuiltIn={detail.isBuiltIn} />
      <TransparencySection
        portfolio={detail.portfolioForCard}
        enabledViews={detail.portfolioViews}
        aum={parseAumToNumber(detail.cfg.aum)}
        fee={detail.feeForCard}
        stacked
      />
      <MoreInfoSection addresses={detail.addresses} docLinks={detail.docLinks} hasDocs={detail.hasDocs} stacked />
    </div>
  )
}

// Shown before any saving vault / accept-asset is configured (first run) so the page never looks broken.
function SavingsEmptyState({ categoryLabel }: { categoryLabel: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-8 text-center">
      <p className="text-sm font-medium text-[var(--color-arco-ink)]">No {categoryLabel} savings accounts yet</p>
      <p className="mt-1 text-sm text-[var(--color-arco-muted)]">
        Savings vaults and their accept-assets appear here once configured.
      </p>
    </div>
  )
}
