import { useContext, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { formatUnits } from "viem"
import { Calculator, ChartPie, Grid2x2 } from "lucide-react"
import { giwaApi } from "./api"
import {
  LIVE_SAVINGS_PRODUCT_ID,
  liveSavingsHistory,
  liveSavingsMarket,
  liveSavingsOwnLiquidity,
  liveSavingsVault,
  REPLACED_SAVINGS_PRODUCT_ID,
} from "./arcousd-live"
import { ArcoUsdLiveContext, ArcoUsdLiveFailedContext, ArcoUsdLivePendingContext } from "./arcousd-live-context"
import { assetLabel } from "./asset-label"
import { tokenSymbolFor } from "./catalog"
import { AllocationTreemap } from "./AllocationTreemap"
import { paymentAssetIcon } from "./components"
import { GIWA_CHAIN_ID, GIWA_LIVE_REFETCH } from "./config"
import { readShareSupply, readTokenBalance } from "./contracts"
import { SavingsSkeleton } from "./GiwaSkeleton"
import { marketApyPercent, marketApyText } from "./price-policy"
import { buildSavingsAccounts, resolveSavingsSelection, type SavingsAccount } from "./savings"
import { SavingsAccordion } from "./SavingsAccordion"
import { chosenSavingsOption, heldCoins, heldUsd, productThroughRoute, routeFor } from "./savings-assets"
import { reserveAssetLabel, savingsBacking, savingsDepositLabel, savingsExposure } from "./savings-backing"
import { savingsAssetCategory, savingsCategoryFromSearch } from "./savings-category"
import { usdCompact } from "./savings-format"
import { SavingsHeroCard, type SavingsHeroTone } from "./SavingsHeroCard"
import { SavingsRoutesContext } from "./savings-routes"
import { SavingsSimulation } from "./SavingsSimulation"
import { SavingsStatsRow } from "./SavingsStatsRow"
import { SavingsTabs } from "./SavingsTabs"
import { SavingsTransferFlow, SavingsTransferStatus, type TransferLeftRunning } from "./SavingsTransferFlow"
import type { TransferMode } from "./savings-transfer"
import type { GiwaCatalogItem } from "./types"
import { useGiwaProductOperation } from "./useGiwaProductOperation"
import { useGiwaVaultDetail } from "./useGiwaVaultDetail"
import { useSavingsAssetChoices } from "./useSavingsAssetChoices"
import { useGiwaWallet } from "./wallet"

export default function GiwaSavingsPage() {
  const catalogQuery = useQuery({ queryKey: ["giwa", "catalog"], queryFn: giwaApi.catalog, ...GIWA_LIVE_REFETCH })
  const marketQuery = useQuery({
    queryKey: ["giwa", "market", GIWA_CHAIN_ID],
    queryFn: () => giwaApi.market(GIWA_CHAIN_ID),
    ...GIWA_LIVE_REFETCH,
  })

  // On the live ArcoUSD v1 contracts the sArcoUSD account takes the arcoUSD vault's place (arcousd-live.ts): the same
  // tabs, its own contracts and figures. The arcoUSD vault keeps its product page.
  const live = useContext(ArcoUsdLiveContext)
  const livePending = useContext(ArcoUsdLivePendingContext)
  const liveFailed = useContext(ArcoUsdLiveFailedContext)
  const liveVault = useMemo(() => {
    const base = (catalogQuery.data ?? []).find((product) => product.productId === REPLACED_SAVINGS_PRODUCT_ID)
    return live !== null && base !== undefined ? liveSavingsVault(base, live) : null
  }, [live, catalogQuery.data])

  // Ordered account list (pinned → AUM desc → intra-vault index); dummies kept disabled, dangling reals skipped.
  // Pure + unit-tested in savings.ts.
  const accounts = useMemo(() => {
    const built = buildSavingsAccounts(catalogQuery.data ?? [], marketQuery.data ?? [])
    if (liveVault === null || live?.savings == null) return built
    const apy = marketApyText(liveSavingsMarket(live.savings))
    return built.map((account) => (account.vault?.productId === REPLACED_SAVINGS_PRODUCT_ID ? { ...account, vault: liveVault, apy } : account))
  }, [catalogQuery.data, marketQuery.data, liveVault, live])
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

  // First load only: background refetches are isFetching, not isLoading, so they never re-skeleton. The first ArcoUSD
  // reads are waited for too, so the stablecoin account never opens on the vault the sArcoUSD account replaces; when
  // they keep failing the page says so (and keeps asking) instead of loading forever.
  const liveUnread = livePending && liveFailed !== null
  const loading = catalogQuery.isLoading || marketQuery.isLoading || (livePending && !liveUnread)

  return (
    <div className="w-full">
      <h1 className="sr-only">Savings</h1>
      <div className="mx-auto w-full max-w-[912px]">
        {loading ? (
          <SavingsSkeleton />
        ) : liveUnread ? (
          <SavingsLoadError onRetry={liveFailed!.retry} />
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
              <SavingsDetail
                key={selected.vault.productId}
                vault={selected.vault}
                tone={savingsAssetCategory(selected.symbol) === "crypto-native" ? "cream" : "blue"}
              />
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
function SavingsDetail({ vault, tone }: { vault: GiwaCatalogItem; tone: SavingsHeroTone }) {
  // The sArcoUSD account on ArcoUSD v1 reads its figures from the Savings API, not from posted prices.
  const live = useContext(ArcoUsdLiveContext)
  const liveSavings = vault.productId === LIVE_SAVINGS_PRODUCT_ID ? (live?.savings ?? null) : null
  const vaultDetail = useGiwaVaultDetail(vault, { history: liveSavings === null })
  const liveHistoryQuery = useQuery({
    queryKey: ["giwa", "arcousd", "savings-history"],
    queryFn: () => giwaApi.arcousd.savingsHistory(),
    enabled: liveSavings !== null,
    ...GIWA_LIVE_REFETCH,
  })
  const detail = useMemo(() => {
    if (liveSavings === null || live === null) return vaultDetail
    const market = liveSavingsMarket(liveSavings)
    const ownLiquidity = liveSavingsOwnLiquidity(live)
    return {
      ...vaultDetail,
      market,
      apyText: marketApyText(market),
      history: liveSavingsHistory(liveHistoryQuery.data),
      baseUsd: 1,
      // The Reserve's free USDC: what a withdrawal in the account's own coin can take at once.
      instantLiquidityUsd: ownLiquidity,
    }
  }, [vaultDetail, liveSavings, live, liveHistoryQuery.data])
  const wallet = useGiwaWallet()
  const routes = useContext(SavingsRoutesContext)
  const [transfer, setTransfer] = useState<TransferMode | null>(null)
  // A transaction left running when the deposit / withdraw screen closed: its outcome shows under the card.
  const [leftRunning, setLeftRunning] = useState<TransferLeftRunning | null>(null)
  // The coin picked on the deposit / withdraw screen (the stablecoin account); null keeps the vault's own.
  const [picked, setPicked] = useState<string | null>(null)
  const { panel, market } = detail

  // The coin deposits pay with and withdrawals pay out in: the one picked while the vault can take it (its own coin, or
  // one it has a route for), else its own. Through a route the screen runs on the route's coin and contracts.
  const option = chosenSavingsOption(vault, routes, picked)
  const route = option !== null ? routeFor(routes, vault, option.key) : null
  const flowProduct = useMemo(() => (option !== null && route !== null ? productThroughRoute(vault, option, route) : vault), [vault, option, route])
  // The deposit / withdraw screen's own operation, on that coin (the card keeps reading the vault's own, `panel`).
  const flowPanel = useGiwaProductOperation(flowProduct)
  // A route's instant liquidity is its own redemption reserve, in its coin.
  // (An ArcoUSD v1 route states its own: the Reserve's free buffer in its coin, or no limit for ArcoUSD.)
  const routeReserveQuery = useQuery({
    queryKey: ["giwa", "vault-balance", "redemption", vault.productId, route?.redemptionVault ?? null],
    queryFn: () => readTokenBalance(route!.token, route!.redemptionVault, option!.decimals),
    enabled: route !== null && option !== null && route.instantLiquidity === undefined,
    refetchInterval: 30_000,
  })
  const choices = useSavingsAssetChoices(vault, routes, wallet.address, detail.baseUsd)

  const connected = panel.phase !== "disconnected"
  const navUsd = market?.navUsd ?? null
  const shares = numberOrNull(panel.productBalance)
  const balanceUsd = shares !== null && navUsd !== null ? shares * navUsd : null
  const available = numberOrNull(panel.paymentBalance)
  // What a deposit can use: every coin the vault can take, when there are several; else its own coin.
  const availableUsd =
    choices !== null ? heldUsd(choices) : available !== null && detail.baseUsd !== null ? available * detail.baseUsd : null
  const coinsHeld = choices !== null ? heldCoins(choices).map((coin) => ({ icon: coin.logo, symbol: coin.symbol })) : undefined
  const flowLiquidityUsd =
    route === null
      ? detail.instantLiquidityUsd
      : route.instantLiquidity !== undefined
        ? route.instantLiquidity !== null && detail.baseUsd !== null
          ? route.instantLiquidity * detail.baseUsd
          : null
        : routeReserveQuery.data != null && detail.baseUsd !== null
          ? Number(routeReserveQuery.data) * detail.baseUsd
          : null
  const apyPercent = marketApyPercent(market)
  // The balance grows at the rate being paid: between distributions sArcoUSD shows the distributor's cap, which it is
  // not earning yet.
  const accrualApyPercent = liveSavings !== null ? liveSavings.paidApyPercent : apyPercent
  const tvl = useSavingsTvl(vault, navUsd)
  const tvlText = tvl !== null ? usdCompact(tvl) : null

  const paySymbol = assetLabel(vault.paymentAssetSymbol)
  const payIcon = paymentAssetIcon(vault.paymentAssetSymbol)
  // The coin the deposit / withdraw screen uses (the vault's own unless another was picked).
  const flowPaySymbol = option?.symbol ?? paySymbol
  // The savings token as customers know it (the arcoUSD vault's share is sArcoUSD), with its mark.
  const tokenSymbol = tokenSymbolFor(vault)
  const tokenIcon = detail.vaultImage
  // The Backing tiles with their details; the instant reserve is held in this account's own coin.
  const backing = savingsBacking({ symbol: reserveAssetLabel(vault.paymentAssetSymbol), icon: payIcon ?? null })

  function openTransfer(mode: TransferMode) {
    setLeftRunning(null)
    setTransfer(mode)
  }

  return (
    <div className="mt-3 w-full space-y-3">
      <SavingsHeroCard
        connected={connected}
        depositLabel={savingsDepositLabel(vault.paymentAssetSymbol)}
        tokenSymbol={tokenSymbol}
        tokenIcon={tokenIcon}
        paySymbol={paySymbol}
        payIcon={payIcon}
        balanceUsd={balanceUsd}
        shares={shares}
        available={available}
        availableUsd={availableUsd}
        availableCoins={coinsHeld}
        apyPercent={accrualApyPercent}
        onDeposit={() => openTransfer("deposit")}
        onWithdraw={() => openTransfer("withdraw")}
        tone={tone}
      />
      {leftRunning !== null && transfer === null && (
        <SavingsTransferStatus leftRunning={leftRunning} paySymbol={flowPaySymbol} panel={flowPanel} onDismiss={() => setLeftRunning(null)} />
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
                slices={backing}
                title="Backing assets"
                info="What stands behind every share: funds from Fidelity, UBS and Franklin Templeton, a loan book and an instant liquidity reserve."
                total={tvlText}
                totalUsd={tvl}
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
        detail={{ ...detail, panel: flowPanel, instantLiquidityUsd: flowLiquidityUsd }}
        paySymbol={flowPaySymbol}
        payIcon={option?.logo ?? payIcon}
        payChain={option?.chain ?? "giwa"}
        assetPicker={choices !== null && option !== null ? { choices, selected: option.key, onSelect: setPicked } : undefined}
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
function SavingsLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-[22px] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-8 text-center">
      <p className="text-sm font-medium text-[var(--color-arco-ink)]">Savings could not be loaded</p>
      <p className="mt-1 text-sm text-[var(--color-arco-muted)]">We keep checking. Try again in a moment.</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-arco-border)] px-4 py-2 text-sm font-medium text-[var(--color-arco-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
      >
        Try again
      </button>
    </div>
  )
}

function SavingsEmptyState() {
  return (
    <div className="rounded-[22px] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-8 text-center">
      <p className="text-sm font-medium text-[var(--color-arco-ink)]">No savings accounts yet</p>
      <p className="mt-1 text-sm text-[var(--color-arco-muted)]">Savings vaults and their accept-assets appear here once configured.</p>
    </div>
  )
}
