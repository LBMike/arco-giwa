import { useContext, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useQueries, useQuery } from "@tanstack/react-query"
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
import {
  GOLD_SAVINGS_PRODUCT_ID,
  goldOwnLiquidity,
  goldQuoteShares,
  goldSavingsMarket,
  goldSavingsRoutes,
  goldSavingsVault,
  withGoldAccounts,
  withInstantCoins,
  type ArcoGoldLive,
} from "./arcogold-live"
import { ArcoGoldLiveContext, ArcoGoldLivePendingContext } from "./arcogold-live-context"
import { assetLabel } from "./asset-label"
import { tokenSymbolFor } from "./catalog"
import { AllocationTreemap } from "./AllocationTreemap"
import { paymentAssetIcon } from "./components"
import { GIWA_CHAIN_ID, GIWA_LIVE_REFETCH } from "./config"
import { readShareSupply, readTokenBalance, readZapRedeemQuote } from "./contracts"
import { SavingsSkeleton } from "./GiwaSkeleton"
import { marketApyPercent, marketApyText } from "./price-policy"
import { buildSavingsAccounts, resolveSavingsSelection, type SavingsAccount } from "./savings"
import { SavingsAccordion } from "./SavingsAccordion"
import { withBandedApy, withSeededApy } from "./savings-apy-seed"
import { chosenSavingsOption, heldCoins, heldUsd, productThroughRoute, routeFor, type SavingsAssetChoice, type SavingsRoute } from "./savings-assets"
import { reserveAssetLabel, savingsBacking, savingsDepositLabel, savingsExposure } from "./savings-backing"
import { savingsAssetCategory, savingsCategoryFromSearch } from "./savings-category"
import { usdCompact } from "./savings-format"
import { SavingsHeroCard, savingsHeroTone, type SavingsHeroTone } from "./SavingsHeroCard"
import { SavingsRoutesContext } from "./savings-routes"
import { SavingsSimulation } from "./SavingsSimulation"
import { SavingsStatsRow } from "./SavingsStatsRow"
import { SavingsTabs, savingsGoldMarks } from "./SavingsTabs"
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
  // The gold account on the live ArcoGOLD contracts (arcogold-live.ts): made from the gold deployment, in the place of
  // any gold coin the Vault Config lists. Absent (not deployed, or not read) the list is as built.
  const gold = useContext(ArcoGoldLiveContext)
  const goldPending = useContext(ArcoGoldLivePendingContext)
  const goldVault = useMemo(() => (gold !== null ? goldSavingsVault(gold) : null), [gold])
  const withGold = useMemo(
    () => withGoldAccounts(accounts, goldVault, gold, gold !== null ? marketApyText(goldSavingsMarket(gold)) : "—"),
    [accounts, goldVault, gold],
  )
  const [searchParams, setSearchParams] = useSearchParams()
  const category = savingsCategoryFromSearch(searchParams)
  const selectedAsset = searchParams.get("asset")
  const selectedAccount = searchParams.get("account")
  // The tabs show every account that can be saved today (a coming-soon Crypto Native coin is left out). The pick: an explicit enabled account or asset in the URL's category, else that
  // category's first enabled account (the sidebar's Stablecoins / Crypto Native links), else the first overall.
  const selected = useMemo<SavingsAccount | null>(() => {
    const inCategory = withGold.filter((account) => savingsAssetCategory(account.symbol) === category)
    return resolveSavingsSelection(inCategory.length > 0 ? inCategory : withGold, selectedAccount, selectedAsset)
  }, [withGold, category, selectedAccount, selectedAsset])

  // First load only: background refetches are isFetching, not isLoading, so they never re-skeleton. The first ArcoUSD
  // reads are waited for too, so the stablecoin account never opens on the vault the sArcoUSD account replaces; when
  // they keep failing the page says so (and keeps asking) instead of loading forever.
  const liveUnread = livePending && liveFailed !== null
  // A link to the Gold tab also waits for the first gold reads (data or a failure), so it does not open on another account.
  const loading = catalogQuery.isLoading || marketQuery.isLoading || (livePending && !liveUnread) || (goldPending && category === "gold")

  return (
    <div className="w-full">
      <h1 className="sr-only">Savings</h1>
      <div className="mx-auto w-full max-w-[912px]">
        {loading ? (
          <SavingsSkeleton />
        ) : liveUnread ? (
          <SavingsLoadError onRetry={liveFailed!.retry} />
        ) : withGold.length === 0 ? (
          <SavingsEmptyState />
        ) : (
          <>
            <SavingsTabs
              accounts={withGold}
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
                tone={savingsHeroTone(savingsAssetCategory(selected.symbol))}
                coinMarks={
                  // The gold account takes PAXG and XAUT: both marks beside what is available.
                  savingsAssetCategory(selected.symbol) === "gold"
                    ? savingsGoldMarks(withGold.filter((account) => account.vault?.productId === selected.vault!.productId)).map((coin) => ({ icon: coin.logo ?? undefined, symbol: coin.symbol }))
                    : undefined
                }
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
function SavingsDetail({
  vault,
  tone,
  coinMarks,
}: {
  vault: GiwaCatalogItem
  tone: SavingsHeroTone
  /** The coins the account takes, shown beside what is available when the vault has no coin picker (the gold account). */
  coinMarks?: readonly Readonly<{ icon: string | undefined; symbol: string }>[]
}) {
  // The sArcoUSD account on ArcoUSD v1 reads its figures from the Savings API, not from posted prices.
  const live = useContext(ArcoUsdLiveContext)
  const liveSavings = vault.productId === LIVE_SAVINGS_PRODUCT_ID ? (live?.savings ?? null) : null
  // The gold account on ArcoGOLD reads its figures from the gold API (no posted prices either).
  const goldLive = useContext(ArcoGoldLiveContext)
  const liveGold = vault.productId === GOLD_SAVINGS_PRODUCT_ID ? goldLive : null
  const vaultDetail = useGiwaVaultDetail(vault, { history: liveSavings === null && liveGold === null })
  const liveHistoryQuery = useQuery({
    queryKey: ["giwa", "arcousd", "savings-history"],
    queryFn: () => giwaApi.arcousd.savingsHistory(),
    enabled: liveSavings !== null,
    ...GIWA_LIVE_REFETCH,
  })
  const detail = useMemo(() => {
    if (liveGold !== null) {
      // ArcoGOLD: ounces per share at an ounce's dollars, the set rate, and its banded month of rates (savings-apy-seed.ts).
      const market = goldSavingsMarket(liveGold)
      return {
        ...vaultDetail,
        market,
        apyText: marketApyText(market),
        history: withBandedApy(undefined, vault.productId, market.apy, Math.floor(Date.now() / 1000)),
        baseUsd: liveGold.ounceUsd,
        // The gold Reserve's free PAXG: what a withdrawal in the account's own coin can take at once.
        instantLiquidityUsd: liveGold.ounceUsd !== null ? goldOwnLiquidity(liveGold) * liveGold.ounceUsd : null,
      }
    }
    if (liveSavings === null || live === null) {
      // A Crypto Native vault's APY chart: a month of rates inside its band, ending on the rate shown (savings-apy-seed.ts).
      const now = Math.floor(Date.now() / 1000)
      return { ...vaultDetail, history: withBandedApy(vaultDetail.history, vault.productId, marketApyPercent(vaultDetail.market), now) }
    }
    const market = liveSavingsMarket(liveSavings)
    const ownLiquidity = liveSavingsOwnLiquidity(live)
    return {
      ...vaultDetail,
      market,
      apyText: marketApyText(market),
      // The APY chart's month before the paid rate begins is seeded (savings-apy-seed.ts).
      history: withSeededApy(liveSavingsHistory(liveHistoryQuery.data), Math.floor(Date.now() / 1000)),
      baseUsd: 1,
      // The Reserve's free USDC: what a withdrawal in the account's own coin can take at once.
      instantLiquidityUsd: ownLiquidity,
    }
  }, [vaultDetail, liveSavings, live, liveGold, liveHistoryQuery.data, vault.productId])
  const wallet = useGiwaWallet()
  const contextRoutes = useContext(SavingsRoutesContext)
  // The gold account's XAUT comes in and goes out through the gold Zap: its route is added here, beside the others.
  const routes = useMemo<readonly SavingsRoute[]>(
    () => (liveGold !== null ? [...contextRoutes, ...goldSavingsRoutes(liveGold)] : contextRoutes),
    [contextRoutes, liveGold],
  )
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
  // Withdrawing from the gold account: a coin the Zap would not pay at once (quoteRedeem) is greyed out in the picker.
  const goldInstant = useGoldInstantCoins(liveGold, transfer === "withdraw", flowPanel.amount, panel.productBalance, choices)
  const pickerChoices = useMemo(() => withInstantCoins(choices, goldInstant), [choices, goldInstant])

  const connected = panel.phase !== "disconnected"
  const navUsd = market?.navUsd ?? null
  const shares = numberOrNull(panel.productBalance)
  const balanceUsd = shares !== null && navUsd !== null ? shares * navUsd : null
  // The gold account's own coin is one of two: without an ounce price its available gold is not one coin's balance.
  const available = liveGold !== null ? null : numberOrNull(panel.paymentBalance)
  // What a deposit can use: every coin the vault can take, when there are several; else its own coin.
  const availableUsd =
    choices !== null ? heldUsd(choices) : available !== null && detail.baseUsd !== null ? available * detail.baseUsd : null
  // The gold account shows both its marks (PAXG and XAUT) beside its available gold, whichever the wallet holds.
  const coinsHeld = coinMarks ?? (choices !== null ? heldCoins(choices).map((coin) => ({ icon: coin.logo, symbol: coin.symbol })) : undefined)
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
        // The balance's last digits keep rising at the APY shown, also between sArcoUSD distributions (when it shows the
        // distributor's cap); each read of the balance starts them again from the balance as read.
        apyPercent={apyPercent}
        onDeposit={() => openTransfer("deposit")}
        onWithdraw={() => openTransfer("withdraw")}
        // Before a wallet: the card opens the same wallet modal as the header's Connect Wallet.
        onConnect={() => void wallet.connect()}
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
        assetPicker={pickerChoices !== null && option !== null ? { choices: pickerChoices, selected: option.key, onSelect: setPicked } : undefined}
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

/**
 * On the gold account's withdraw screen: for each gold coin, whether the Zap would pay out at once (Zap.quoteRedeem's
 * `instant`), keyed by the picker's option key. Asked for the amount entered, else the whole ArcoGOLD balance, else one
 * ArcoGOLD. Null anywhere else (nothing is greyed out); a coin whose quote has not answered is not greyed out either.
 */
function useGoldInstantCoins(
  gold: ArcoGoldLive | null,
  withdrawing: boolean,
  amount: string,
  balance: string,
  choices: readonly SavingsAssetChoice[] | null,
): ReadonlyMap<string, boolean> | null {
  const active = gold !== null && withdrawing && choices !== null
  const shares = goldQuoteShares(amount, balance)
  const coins = active ? gold!.coins : []
  const quotes = useQueries({
    queries: coins.map((coin) => ({
      queryKey: ["giwa", "arcogold", "quote-redeem", gold?.zap ?? null, coin.token, shares.toString()],
      queryFn: () => readZapRedeemQuote(gold!.zap, shares, coin.token),
      enabled: active,
      staleTime: 10_000,
    })),
  })
  if (!active) return null
  const instant = new Map<string, boolean>()
  coins.forEach((coin, index) => {
    const quote = quotes[index]?.data
    if (quote !== undefined) instant.set(coin.option.key, quote.instant)
  })
  return instant
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
