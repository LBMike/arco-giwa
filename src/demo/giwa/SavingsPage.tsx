import { useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { formatUnits } from "viem"
import { Calculator, ChartPie, Grid2x2 } from "lucide-react"
import { giwaApi } from "./api"
import { assetLabel } from "./asset-label"
import { AllocationTreemap } from "./AllocationTreemap"
import { paymentAssetIcon } from "./components"
import { GIWA_CHAIN_ID, GIWA_LIVE_REFETCH } from "./config"
import { readShareSupply } from "./contracts"
import { SavingsSkeleton } from "./GiwaSkeleton"
import { marketApyPercent } from "./price-policy"
import { buildSavingsAccounts, resolveSavingsSelection, type SavingsAccount } from "./savings"
import { SavingsAccordion } from "./SavingsAccordion"
import { SAVINGS_BACKING, reserveAssetLabel, savingsExposure } from "./savings-backing"
import { savingsAssetCategory, savingsCategoryFromSearch } from "./savings-category"
import { usdCompact } from "./savings-format"
import { SavingsHeroCard } from "./SavingsHeroCard"
import { SavingsSimulation } from "./SavingsSimulation"
import { SavingsStatsRow } from "./SavingsStatsRow"
import { SavingsTabs } from "./SavingsTabs"
import { SavingsTransferFlow, SavingsTransferStatus, type TransferLeftRunning } from "./SavingsTransferFlow"
import type { TransferMode } from "./savings-transfer"
import type { GiwaCatalogItem } from "./types"
import { useGiwaVaultDetail } from "./useGiwaVaultDetail"
import { useGiwaWallet } from "./wallet"

export default function GiwaSavingsPage() {
  const catalogQuery = useQuery({ queryKey: ["giwa", "catalog"], queryFn: giwaApi.catalog, ...GIWA_LIVE_REFETCH })
  const marketQuery = useQuery({
    queryKey: ["giwa", "market", GIWA_CHAIN_ID],
    queryFn: () => giwaApi.market(GIWA_CHAIN_ID),
    ...GIWA_LIVE_REFETCH,
  })

  // Ordered account list (pinned → AUM desc → intra-vault index); dummies kept disabled, dangling reals skipped.
  // Pure + unit-tested in savings.ts.
  const accounts = useMemo(
    () => buildSavingsAccounts(catalogQuery.data ?? [], marketQuery.data ?? []),
    [catalogQuery.data, marketQuery.data],
  )
  const [searchParams, setSearchParams] = useSearchParams()
  const category = savingsCategoryFromSearch(searchParams)
  const selectedAsset = searchParams.get("asset")
  const selectedAccount = searchParams.get("account")
  // The tabs show every account. The pick: an explicit enabled account or asset in the URL's category, else that
  // category's first enabled account (the sidebar's Stablecoins / Crypto Native links), else the first overall.
  const selected = useMemo<SavingsAccount | null>(() => {
    const inCategory = accounts.filter((account) => savingsAssetCategory(account.symbol) === category)
    return resolveSavingsSelection(inCategory.length > 0 ? inCategory : accounts, selectedAccount, selectedAsset)
  }, [accounts, category, selectedAccount, selectedAsset])

  // First load only: background refetches are isFetching, not isLoading, so they never re-skeleton.
  const loading = catalogQuery.isLoading || marketQuery.isLoading

  return (
    <div className="w-full">
      <h1 className="sr-only">Savings</h1>
      <div className="mx-auto w-full max-w-[912px]">
        {loading ? (
          <SavingsSkeleton />
        ) : accounts.length === 0 ? (
          <SavingsEmptyState />
        ) : (
          <>
            <SavingsTabs
              accounts={accounts}
              selectedKey={selected?.key ?? null}
              onSelect={(account) =>
                setSearchParams((previous) => {
                  const next = new URLSearchParams(previous)
                  next.set("category", savingsAssetCategory(account.symbol))
                  next.set("asset", account.symbol)
                  next.set("account", account.key)
                  return next
                })
              }
            />
            {selected?.vault ? (
              // Keyed by vault so switching accounts cleanly remounts the detail (stable hook count).
              <SavingsDetail key={selected.vault.productId} vault={selected.vault} />
            ) : (
              <p className="mt-6 text-center text-sm text-[var(--color-arco-muted)]">Select a savings account to continue.</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

const numberOrNull = (value: string): number | null => {
  const parsed = Number(value)
  return value.trim() !== "" && Number.isFinite(parsed) ? parsed : null
}

/** Total value locked: every share in circulation (read onchain) at the latest NAV. */
function useSavingsTvl(vault: GiwaCatalogItem, navUsd: number | null): number | null {
  const supplyQuery = useQuery({
    queryKey: ["giwa", "share-supply", vault.productId],
    queryFn: () => readShareSupply(vault.productTokenAddress!),
    enabled: Boolean(vault.productTokenAddress),
    refetchInterval: 60_000,
  })
  if (!supplyQuery.data || navUsd === null) return null
  return Number(formatUnits(supplyQuery.data.supply, supplyQuery.data.decimals)) * navUsd
}

// The selected savings account: the card, its figures, Backing / Exposure / Simulation, and the deposit and withdraw
// screens. Reads the same vault detail as the product page (useGiwaVaultDetail).
function SavingsDetail({ vault }: { vault: GiwaCatalogItem }) {
  const detail = useGiwaVaultDetail(vault)
  const wallet = useGiwaWallet()
  const [transfer, setTransfer] = useState<TransferMode | null>(null)
  // A transaction left running when the deposit / withdraw screen closed: its outcome shows under the card.
  const [leftRunning, setLeftRunning] = useState<TransferLeftRunning | null>(null)
  const { panel, market } = detail

  const connected = panel.phase !== "disconnected"
  const navUsd = market?.navUsd ?? null
  const shares = numberOrNull(panel.productBalance)
  const balanceUsd = shares !== null && navUsd !== null ? shares * navUsd : null
  const available = numberOrNull(panel.paymentBalance)
  const availableUsd = available !== null && detail.baseUsd !== null ? available * detail.baseUsd : null
  const apyPercent = marketApyPercent(market)
  const tvl = useSavingsTvl(vault, navUsd)
  const tvlText = tvl !== null ? usdCompact(tvl) : null

  const paySymbol = assetLabel(vault.paymentAssetSymbol)
  const payIcon = paymentAssetIcon(vault.paymentAssetSymbol)
  const tokenSymbol = vault.symbol
  const tokenIcon = detail.vaultImage

  function openTransfer(mode: TransferMode) {
    setLeftRunning(null)
    setTransfer(mode)
  }

  return (
    <div className="mt-3 w-full space-y-3">
      <SavingsHeroCard
        connected={connected}
        depositLabel={reserveAssetLabel(vault.paymentAssetSymbol)}
        tokenSymbol={tokenSymbol}
        tokenIcon={tokenIcon}
        paySymbol={paySymbol}
        payIcon={payIcon}
        balanceUsd={balanceUsd}
        shares={shares}
        available={available}
        availableUsd={availableUsd}
        apyPercent={apyPercent}
        onDeposit={() => openTransfer("deposit")}
        onWithdraw={() => openTransfer("withdraw")}
      />
      {leftRunning !== null && transfer === null && (
        <SavingsTransferStatus leftRunning={leftRunning} paySymbol={paySymbol} panel={panel} onDismiss={() => setLeftRunning(null)} />
      )}
      <SavingsStatsRow apyText={detail.apyText} history={detail.history} tvlText={tvlText ?? "—"} />
      <SavingsAccordion
        sections={[
          {
            id: "backing",
            title: "Backing",
            icon: <Grid2x2 className="size-4" />,
            summary: tvlText !== null ? `Backing assets: ${tvlText}` : null,
            content: (
              <AllocationTreemap
                slices={SAVINGS_BACKING}
                title="Backing assets"
                info="What stands behind every share: funds from Fidelity, UBS and Franklin Templeton, a loan book and an instant liquidity reserve."
                total={tvlText}
              />
            ),
          },
          {
            id: "exposure",
            title: "Exposure",
            icon: <ChartPie className="size-4" />,
            summary: "By asset type",
            content: (
              <AllocationTreemap
                slices={savingsExposure(vault.paymentAssetSymbol)}
                title="Exposure by asset type"
                info="The same backing grouped by the kind of asset it is held in."
                total={tvlText}
              />
            ),
          },
          {
            id: "simulation",
            title: "Simulation",
            icon: <Calculator className="size-4" />,
            summary: null,
            content: (
              <SavingsSimulation
                apyPercent={apyPercent}
                startingBalance={connected && balanceUsd !== null ? balanceUsd : 0}
                maxDeposit={connected ? availableUsd : null}
              />
            ),
          },
        ]}
      />
      <SavingsTransferFlow
        open={transfer !== null}
        mode={transfer ?? "deposit"}
        onClose={(left) => {
          setTransfer(null)
          setLeftRunning(left)
        }}
        detail={detail}
        paySymbol={paySymbol}
        payIcon={payIcon}
        tokenSymbol={tokenSymbol}
        tokenIcon={tokenIcon}
        apyPercent={apyPercent}
        apyText={detail.apyText}
        savingsUsd={balanceUsd}
        recipient={wallet.address}
      />
    </div>
  )
}

// Shown before any saving vault / accept-asset is configured (first run) so the page never looks broken.
function SavingsEmptyState() {
  return (
    <div className="rounded-[22px] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-8 text-center">
      <p className="text-sm font-medium text-[var(--color-arco-ink)]">No savings accounts yet</p>
      <p className="mt-1 text-sm text-[var(--color-arco-muted)]">Savings vaults and their accept-assets appear here once configured.</p>
    </div>
  )
}
