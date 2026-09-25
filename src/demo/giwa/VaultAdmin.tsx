import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { formatUnits } from "viem"
import { AlertCircle, CheckCircle2, ChevronDown, Loader2, Send } from "lucide-react"
import { giwaApi } from "./api"
import type { AdminAuth } from "./api"
import { pauseStateOf, vaultConfigOf } from "./catalog"
import { GIWA_CHAIN_ID } from "./config"
import { afterConfirmedReceipt, readTokenBalance, sendPreparedTransaction, toBaseUnits } from "./contracts"
import { AdminWriteGroup, useGiwaAdmin } from "./admin-context"
import { UNLIMITED_HUMAN, allowanceBelowCap, isPositiveHuman, resolveLimit, usdHint } from "./limits-helpers"
import type { GiwaCatalogItem, GiwaRedemption, HexAddress, UnsignedAdminTransaction } from "./types"
import { BrandMark } from "../components/BrandMark"
import { ISSUERS, ASSET_MANAGERS, productById } from "../data/products"
import { explorerTx } from "./wallet"

type RowPhase = "idle" | "preparing" | "signing" | "confirming" | "settling" | "completed" | "failed"
type ActionPhase = "idle" | "preparing" | "signing" | "confirming" | "done" | "failed"

function baseSymbolOf(paymentSymbol: string) {
  const base = paymentSymbol.replace(/^t/, "")
  return base === "WETH" ? "ETH" : base
}

function shortAddr(address: string | null | undefined) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—"
}

function whenLabel(value: string | null | undefined) {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function trimAmount(value: string) {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")
}

export function VaultOperationsPanel() {
  const { auth, wallet } = useGiwaAdmin()

  const catalogQuery = useQuery({ queryKey: ["giwa", "catalog", "vault-admin"], queryFn: giwaApi.catalog })
  const marketQuery = useQuery({
    queryKey: ["giwa", "market", GIWA_CHAIN_ID],
    queryFn: () => giwaApi.market(GIWA_CHAIN_ID),
    refetchInterval: 45_000,
  })
  const pendingQuery = useQuery({
    queryKey: ["giwa", "admin-pending-redemptions"],
    queryFn: () => giwaApi.admin.pendingRedemptions(auth),
    enabled: auth.ready,
    refetchInterval: 30_000,
  })

  const products = catalogQuery.data ?? []

  return (
    <div className="w-full space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <h2 className="text-lg font-semibold text-[var(--color-arco-ink)]">Vault Management</h2>
        <span className="rounded-full bg-[var(--color-arco-chip)] px-3 py-1 text-xs text-[var(--color-arco-text-soft)]">
          Direct-transfer payouts · no server signing
        </span>
      </section>

      {products.map((product) => {
        const entry = (marketQuery.data ?? []).find((row) => row.productId === product.productId)
        return (
          <VaultCard
            key={product.productId}
            product={product}
            auth={auth}
            walletAddress={wallet.address}
            navBase={entry?.navBase ?? null}
            navUsd={entry?.navUsd ?? null}
            baseUsd={entry?.baseUsd ?? null}
            pending={(pendingQuery.data?.redemptions ?? []).filter((row) => row.productId === product.productId)}
            onSettled={() => pendingQuery.refetch()}
          />
        )
      })}
    </div>
  )
}

// One editable limit row: label + unit, the current de-scaled value, a human-unit input, an
// optional "$≈" hint, and an optional one-tap helper ("Set unlimited" / "No minimum").
function LimitField({
  label,
  unit,
  current,
  value,
  onChange,
  hint,
  helper,
}: {
  label: string
  unit: string
  current: string
  value: string
  onChange: (value: string) => void
  hint: string | null
  helper?: { label: string; value: string }
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-[var(--color-arco-muted)]">
          {label} <span className="text-[var(--color-arco-text-soft)]">({unit})</span>
        </span>
        {helper && (
          <button type="button" onClick={() => onChange(helper.value)} className="text-[10px] text-[var(--color-arco-text-soft)] underline">
            {helper.label}
          </button>
        )}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px] text-[var(--color-arco-muted)]">
        <span>
          Current: <span className="tabular-nums text-[var(--color-arco-ink)]">{trimAmount(current)}</span>
        </span>
        {hint && <span className="tabular-nums">{hint}</span>}
      </div>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="decimal"
        placeholder={trimAmount(current)}
        className="mt-1 h-9 w-full rounded-md border border-[var(--color-arco-border)] px-2 tabular-nums text-sm"
      />
    </div>
  )
}

function VaultCard({
  product,
  auth,
  walletAddress,
  navBase,
  navUsd,
  baseUsd,
  pending,
  onSettled,
}: {
  product: GiwaCatalogItem
  auth: AdminAuth
  walletAddress: HexAddress | null
  navBase: number | null
  navUsd: number | null
  baseUsd: number | null
  pending: GiwaRedemption[]
  onSettled: () => void
}) {
  const paymentDecimals = product.paymentAsset?.decimals ?? 18
  const baseSymbol = baseSymbolOf(product.paymentAssetSymbol)
  // Configured admin deposit address (Vault Config) is the preferred withdraw recipient;
  // explicit input wins, connected wallet stays the final fallback.
  const configuredAdminAddress = vaultConfigOf(product).adminDepositAddress
  const legacy = productById(product.productId.toLowerCase())
  const issuer = legacy ? ISSUERS[legacy.issuer] : ISSUERS.arco
  const manager = legacy ? ASSET_MANAGERS[legacy.assetManager] : ASSET_MANAGERS.arco

  // Header pause badges from the catalog pauseState (no extra read; visible while collapsed).
  // Partial (a half-completed pause sequence) outranks the plain paused label per side.
  const pause = pauseStateOf(product)
  const pauseBadges: string[] = []
  if (pause.depositPartial) pauseBadges.push("Deposits partially paused")
  else if (pause.depositPaused) pauseBadges.push("Deposits paused")
  if (pause.withdrawPartial) pauseBadges.push("Withdrawals partially paused")
  else if (pause.withdrawPaused) pauseBadges.push("Withdrawals paused")

  // Collapsed by default (VaultConfigCard accordion precedent; each card toggles independently).
  // The body is hidden — NOT unmounted — while collapsed, so in-flight tx phases (useState) and
  // typed inputs survive a collapse→re-expand. Confirmation is promise-based
  // (afterConfirmedReceipt), never a gated query, so collapsing mid-op cannot interrupt it.
  const [expanded, setExpanded] = useState(false)

  // Data queries fire only while expanded — collapsed vaults do no RPC/API reads (the header needs
  // only catalog data). Post-receipt refresh still works collapsed: react-query's refetch() bypasses
  // `enabled`, so afterConfirmedReceipt's refreshReads lands fresh data in the cache regardless.
  const depositBalanceQuery = useQuery({
    queryKey: ["giwa", "vault-balance", "deposit", product.productId],
    queryFn: () => readTokenBalance(product.paymentAssetAddress!, product.depositVaultAddress!, paymentDecimals),
    enabled: expanded && Boolean(product.paymentAssetAddress && product.depositVaultAddress),
    refetchInterval: 30_000,
  })
  const redemptionBalanceQuery = useQuery({
    queryKey: ["giwa", "vault-balance", "redemption", product.productId],
    queryFn: () => readTokenBalance(product.paymentAssetAddress!, product.redemptionVaultAddress!, paymentDecimals),
    enabled: expanded && Boolean(product.paymentAssetAddress && product.redemptionVaultAddress),
    refetchInterval: 30_000,
  })

  const [withdrawAmount, setWithdrawAmount] = useState("")
  const [withdrawTo, setWithdrawTo] = useState("")
  const [withdrawPhase, setWithdrawPhase] = useState<ActionPhase>("idle")
  const [fundAmount, setFundAmount] = useState("")
  const [fundPhase, setFundPhase] = useState<ActionPhase>("idle")
  const [actionError, setActionError] = useState<string | null>(null)
  const [rowPhases, setRowPhases] = useState<Record<string, RowPhase>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [rowHashes, setRowHashes] = useState<Record<string, string>>({})

  // Current on-chain limits (already de-scaled to human units by the server).
  const limitsQuery = useQuery({
    queryKey: ["giwa", "vault-limits", product.productId],
    queryFn: () => giwaApi.admin.limits(auth, product.productId),
    enabled: expanded && auth.ready && Boolean(product.depositVaultAddress && product.redemptionVaultAddress),
    refetchInterval: 60_000,
  })
  const cur = limitsQuery.data?.limits
  const [depMin, setDepMin] = useState("")
  const [depCap, setDepCap] = useState("")
  const [depAllow, setDepAllow] = useState("")
  const [redMin, setRedMin] = useState("")
  const [redAllow, setRedAllow] = useState("")
  const [depLimitsPhase, setDepLimitsPhase] = useState<ActionPhase>("idle")
  const [redLimitsPhase, setRedLimitsPhase] = useState<ActionPhase>("idle")
  // Pre-fill the inputs with the current de-scaled values once loaded, and re-seed after a save's
  // refetch (idle phases only, so a background refetch never clobbers an in-progress edit).
  useEffect(() => {
    if (!cur || depLimitsPhase !== "idle" || redLimitsPhase !== "idle") return
    setDepMin(cur.deposit.minimumDeposit)
    setDepCap(cur.deposit.maxSupplyCap)
    setDepAllow(cur.deposit.vaultMintAllowance)
    setRedMin(cur.redemption.minimumRedeem)
    setRedAllow(cur.redemption.vaultRedeemAllowance)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limitsQuery.data])

  const depositBalance = depositBalanceQuery.data ?? "--"
  const redemptionBalance = redemptionBalanceQuery.data ?? "--"

  async function runAction(
    setPhase: (phase: ActionPhase) => void,
    prepare: () => Promise<{ transaction: UnsignedAdminTransaction }>,
    refresh: () => Promise<unknown>,
  ) {
    setActionError(null)
    try {
      if (!auth.ready) throw new Error("Operator token must be entered at runtime")
      if (!walletAddress) throw new Error("Connect the operator wallet first")
      setPhase("preparing")
      const { transaction } = await prepare()
      setPhase("signing")
      const hash = await sendPreparedTransaction(walletAddress, transaction)
      setPhase("confirming")
      await afterConfirmedReceipt(hash, refresh)
      setPhase("done")
    } catch (error) {
      setPhase("failed")
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  function withdrawDefaultAmount() {
    return withdrawAmount.trim() || (depositBalance !== "--" ? depositBalance : "0")
  }

  function payoutBaseAmount(row: GiwaRedemption): bigint {
    // The quote locked at requestRedeem (which the burned shares were priced against) is the
    // correct payout; shares x current NAV would mis-pay. NAV fallback only when it's missing.
    try {
      const locked = BigInt(row.lockedAssetsOut || "0")
      if (locked > 0n) return locked
    } catch {
      // fall through to the NAV fallback
    }
    if (navBase == null || navBase <= 0) throw new Error("No locked quote and no market NAV available")
    const shares = Number(formatUnits(BigInt(row.sharesIn || "0"), 18))
    return toBaseUnits((shares * navBase).toFixed(paymentDecimals), paymentDecimals)
  }

  function payoutLabel(row: GiwaRedemption): string {
    try {
      return `${trimAmount(formatUnits(payoutBaseAmount(row), paymentDecimals))} ${baseSymbol}`
    } catch {
      return "—"
    }
  }

  function setRow(requestId: string, phase: RowPhase, error?: string, hash?: string) {
    setRowPhases((current) => ({ ...current, [requestId]: phase }))
    if (error !== undefined) setRowErrors((current) => ({ ...current, [requestId]: error }))
    if (hash !== undefined) setRowHashes((current) => ({ ...current, [requestId]: hash }))
  }

  async function sendPayout(row: GiwaRedemption) {
    let claimed = false
    let hash: HexAddress | null = null
    try {
      if (!auth.ready) throw new Error("Operator token must be entered at runtime")
      if (!walletAddress) throw new Error("Connect the operator wallet first")
      const amount = payoutBaseAmount(row)
      setRow(row.requestId, "preparing", "")
      const { transaction } = await giwaApi.admin.payout(auth, row.requestId, amount.toString())
      claimed = true // the request is now SETTLING server-side
      setRow(row.requestId, "signing")
      hash = await sendPreparedTransaction(walletAddress, transaction)
      setRow(row.requestId, "confirming", undefined, hash)
      // Throws unless the receipt status is success — settlement is only recorded for a
      // verified on-chain payout.
      await afterConfirmedReceipt(hash, async () => undefined)
      setRow(row.requestId, "settling")
      await giwaApi.admin.settle(auth, row.requestId, hash)
      setRow(row.requestId, "completed")
      onSettled()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Auto-release only when no value can have moved: the signature was rejected (nothing
      // broadcast) or the receipt CONFIRMED a revert. If the transfer may have landed
      // (settle failed, ambiguous receipt error), keep SETTLING — releasing would re-open
      // the double-pay window; the operator verifies on the explorer, then Release manually.
      const safeToRelease = claimed && (!hash || message.includes("reverted"))
      if (safeToRelease) {
        try {
          await giwaApi.admin.release(auth, row.requestId)
        } catch {
          // stays SETTLING; the manual Release button below recovers it
        }
        onSettled()
      }
      setRow(
        row.requestId,
        "failed",
        safeToRelease ? message : `${message} — verify the tx on the explorer, then Release or settle manually.`,
      )
    }
  }

  async function releaseRow(row: GiwaRedemption) {
    try {
      if (!auth.ready) throw new Error("Operator token must be entered at runtime")
      await giwaApi.admin.release(auth, row.requestId)
      setRow(row.requestId, "idle", "")
      onSettled()
    } catch (error) {
      setRow(row.requestId, "failed", error instanceof Error ? error.message : String(error))
    }
  }

  const busyAction = (phase: ActionPhase) => phase === "preparing" || phase === "signing" || phase === "confirming"

  return (
    <section className="space-y-4 rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-4 shadow-[var(--shadow-control)]">
      {/* Collapsible header (whole row toggles; VaultConfigCard accordion pattern). */}
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full flex-wrap items-center justify-between gap-3 text-left"
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-lg font-semibold text-[var(--color-arco-ink)]">{product.symbol}</span>
          <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[11px] text-[var(--color-arco-text-soft)]">
            {product.paymentAssetSymbol}
          </span>
          {pauseBadges.map((badge) => (
            <span
              key={badge}
              className="rounded-[var(--radius-pill)] bg-[var(--color-arco-surface-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-arco-down)]"
            >
              {badge}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-3 text-xs text-[var(--color-arco-text-soft)]">
          {issuer && (
            <span className="inline-flex items-center gap-1.5">
              <BrandMark src={issuer.logo} label={issuer.label} size={14} /> {issuer.label}
            </span>
          )}
          {manager && (
            <span className="inline-flex items-center gap-1.5">
              <BrandMark src={manager.logo} label={manager.label} size={14} /> {manager.label}
            </span>
          )}
          <ChevronDown className={`size-4 shrink-0 text-[var(--color-arco-muted)] transition-transform ${expanded ? "rotate-180" : ""}`} />
        </div>
      </button>

      {expanded && (
        <AdminWriteGroup className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        {/* Section A — deposit-asset withdrawal */}
        <div className="rounded-[var(--radius-card)] border border-[var(--color-arco-border)] p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">Deposit vault</h3>
            <span className="tabular-nums text-sm text-[var(--color-arco-ink)]">
              {depositBalance} {product.paymentAssetSymbol}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-[var(--color-arco-muted)]">
            Pooled deposits held by {shortAddr(product.depositVaultAddress)} — withdraw via withdrawTo (admin role).
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={withdrawAmount}
              onChange={(event) => setWithdrawAmount(event.target.value)}
              placeholder={depositBalance !== "--" ? depositBalance : "amount"}
              className="h-9 w-32 rounded-md border border-[var(--color-arco-border)] px-2 tabular-nums text-sm"
            />
            <input
              value={withdrawTo}
              onChange={(event) => setWithdrawTo(event.target.value)}
              placeholder={configuredAdminAddress ?? walletAddress ?? "recipient (defaults to connected wallet)"}
              className="h-9 min-w-[200px] flex-1 rounded-md border border-[var(--color-arco-border)] px-2 font-mono text-xs"
            />
            <button
              type="button"
              disabled={busyAction(withdrawPhase)}
              onClick={() =>
                void runAction(
                  setWithdrawPhase,
                  () =>
                    giwaApi.admin.withdraw(
                      auth,
                      product.productId,
                      (withdrawTo.trim() || configuredAdminAddress || walletAddress || "") as string,
                      toBaseUnits(withdrawDefaultAmount(), paymentDecimals).toString(),
                    ),
                  () => depositBalanceQuery.refetch(),
                )
              }
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--color-arco-ink)] px-3 text-xs font-medium text-[var(--color-arco-on-dark)] disabled:opacity-50"
            >
              {busyAction(withdrawPhase) && <Loader2 className="size-3.5 animate-spin" />}
              Withdraw to admin
            </button>
            {withdrawPhase === "done" && <CheckCircle2 className="size-4 text-[var(--color-arco-up)]" />}
          </div>
        </div>

        {/* Section B — redemption-vault liquidity (instant redeem only) */}
        <div className="rounded-[var(--radius-card)] border border-[var(--color-arco-border)] p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">Redemption vault liquidity</h3>
            <span className="tabular-nums text-sm text-[var(--color-arco-ink)]">
              {redemptionBalance} {product.paymentAssetSymbol}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-[var(--color-arco-muted)]">
            Funds instant redemptions at {shortAddr(product.redemptionVaultAddress)} — pending requests are paid by
            direct transfer below, not from this balance.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={fundAmount}
              onChange={(event) => setFundAmount(event.target.value)}
              placeholder="amount"
              className="h-9 w-32 rounded-md border border-[var(--color-arco-border)] px-2 tabular-nums text-sm"
            />
            <button
              type="button"
              disabled={busyAction(fundPhase) || !fundAmount.trim()}
              onClick={() =>
                void runAction(
                  setFundPhase,
                  () =>
                    giwaApi.admin.liquidity(
                      auth,
                      product.productId,
                      toBaseUnits(fundAmount, paymentDecimals).toString(),
                    ),
                  () => redemptionBalanceQuery.refetch(),
                )
              }
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--color-arco-ink)] px-3 text-xs font-medium text-[var(--color-arco-on-dark)] disabled:opacity-50"
            >
              {busyAction(fundPhase) && <Loader2 className="size-3.5 animate-spin" />}
              Fund redemption vault
            </button>
            {fundPhase === "done" && <CheckCircle2 className="size-4 text-[var(--color-arco-up)]" />}
          </div>
        </div>
      </div>

      {/* Limits — edit per-vault caps via on-chain setLimits (one deposit tx + one redemption tx).
          Buttons stay disabled until the current limits load, so a blank field resubmits the
          CURRENT value (setLimits overwrites all fields — a stray 0 would brick the vault). */}
      <div className="rounded-[var(--radius-card)] border border-[var(--color-arco-border)] p-3">
        <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">Limits</h3>
        {!cur ? (
          <p className="mt-2 text-xs text-[var(--color-arco-muted)]">
            {limitsQuery.isError ? (
              `Could not read current limits: ${limitsQuery.error instanceof Error ? limitsQuery.error.message : String(limitsQuery.error)}`
            ) : (
              <>
                <Loader2 className="mr-1 inline size-3.5 animate-spin" />
                Loading current limits…
              </>
            )}
          </p>
        ) : (
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <div className="rounded-[var(--radius-card)] border border-[var(--color-arco-border)] p-3">
              <p className="text-xs font-medium text-[var(--color-arco-ink)]">Deposit limits</p>
              <div className="mt-3 space-y-3">
                <LimitField label="Minimum deposit" unit={product.paymentAssetSymbol} current={cur.deposit.minimumDeposit} value={depMin} onChange={setDepMin} hint={usdHint(resolveLimit(depMin, cur.deposit.minimumDeposit), baseUsd)} helper={{ label: "No minimum", value: "0" }} />
                <LimitField label="Max supply cap" unit={`${product.symbol} shares`} current={cur.deposit.maxSupplyCap} value={depCap} onChange={setDepCap} hint={usdHint(resolveLimit(depCap, cur.deposit.maxSupplyCap), navUsd)} helper={{ label: "Set unlimited", value: UNLIMITED_HUMAN }} />
                <LimitField label="Vault mint allowance" unit={`${product.symbol} shares`} current={cur.deposit.vaultMintAllowance} value={depAllow} onChange={setDepAllow} hint={usdHint(resolveLimit(depAllow, cur.deposit.vaultMintAllowance), navUsd)} helper={{ label: "Set unlimited", value: UNLIMITED_HUMAN }} />
              </div>
              {allowanceBelowCap(resolveLimit(depAllow, cur.deposit.vaultMintAllowance), resolveLimit(depCap, cur.deposit.maxSupplyCap)) && (
                <p className="mt-2 flex items-start gap-1.5 text-[11px] text-[var(--color-arco-muted)]">
                  <AlertCircle className="mt-0.5 size-3 shrink-0" /> Mint allowance is below the supply cap — allowed, but mints stop at the allowance.
                </p>
              )}
              <button
                type="button"
                onClick={() =>
                  void runAction(
                    setDepLimitsPhase,
                    () =>
                      giwaApi.admin.setDepositLimits(auth, product.productId, {
                        minimumDeposit: resolveLimit(depMin, cur.deposit.minimumDeposit),
                        maxSupplyCap: resolveLimit(depCap, cur.deposit.maxSupplyCap),
                        vaultMintAllowance: resolveLimit(depAllow, cur.deposit.vaultMintAllowance),
                      }),
                    () => limitsQuery.refetch(),
                  )
                }
                disabled={
                  busyAction(depLimitsPhase) ||
                  !isPositiveHuman(resolveLimit(depCap, cur.deposit.maxSupplyCap)) ||
                  !isPositiveHuman(resolveLimit(depAllow, cur.deposit.vaultMintAllowance))
                }
                className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--color-arco-ink)] px-3 text-xs font-medium text-[var(--color-arco-on-dark)] disabled:opacity-50"
              >
                {busyAction(depLimitsPhase) && <Loader2 className="size-3.5 animate-spin" />}
                Set deposit limits
                {depLimitsPhase === "done" && <CheckCircle2 className="size-3.5 text-[var(--color-arco-up)]" />}
              </button>
            </div>

            <div className="rounded-[var(--radius-card)] border border-[var(--color-arco-border)] p-3">
              <p className="text-xs font-medium text-[var(--color-arco-ink)]">Redemption limits</p>
              <div className="mt-3 space-y-3">
                <LimitField label="Minimum redeem" unit={`${product.symbol} shares`} current={cur.redemption.minimumRedeem} value={redMin} onChange={setRedMin} hint={usdHint(resolveLimit(redMin, cur.redemption.minimumRedeem), navUsd)} helper={{ label: "No minimum", value: "0" }} />
                <LimitField label="Vault redeem allowance" unit={product.paymentAssetSymbol} current={cur.redemption.vaultRedeemAllowance} value={redAllow} onChange={setRedAllow} hint={usdHint(resolveLimit(redAllow, cur.redemption.vaultRedeemAllowance), baseUsd)} helper={{ label: "Set unlimited", value: UNLIMITED_HUMAN }} />
              </div>
              <button
                type="button"
                onClick={() =>
                  void runAction(
                    setRedLimitsPhase,
                    () =>
                      giwaApi.admin.setRedemptionLimits(auth, product.productId, {
                        minimumRedeem: resolveLimit(redMin, cur.redemption.minimumRedeem),
                        vaultRedeemAllowance: resolveLimit(redAllow, cur.redemption.vaultRedeemAllowance),
                      }),
                    () => limitsQuery.refetch(),
                  )
                }
                disabled={busyAction(redLimitsPhase) || !isPositiveHuman(resolveLimit(redAllow, cur.redemption.vaultRedeemAllowance))}
                className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--color-arco-ink)] px-3 text-xs font-medium text-[var(--color-arco-on-dark)] disabled:opacity-50"
              >
                {busyAction(redLimitsPhase) && <Loader2 className="size-3.5 animate-spin" />}
                Set redemption limits
                {redLimitsPhase === "done" && <CheckCircle2 className="size-3.5 text-[var(--color-arco-up)]" />}
              </button>
            </div>
          </div>
        )}
      </div>

      {actionError && (
        <p className="flex items-start gap-1.5 text-xs text-[var(--color-arco-down)]">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" /> {actionError}
        </p>
      )}

      {/* Section C — user withdrawals (pending redemptions), direct transfer */}
      <div className="rounded-[var(--radius-card)] border border-[var(--color-arco-border)] p-3">
        <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">User withdrawals (pending redemptions)</h3>
        {pending.length === 0 ? (
          <p className="py-4 text-center text-xs text-[var(--color-arco-muted)]">No pending redemptions.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead>
                <tr className="text-[var(--color-arco-muted)]">
                  <th className="py-1.5 pr-3 font-normal">Address</th>
                  <th className="py-1.5 pr-3 font-normal">ID</th>
                  <th className="py-1.5 pr-3 font-normal">When</th>
                  <th className="py-1.5 pr-3 font-normal">Tokens</th>
                  <th className="py-1.5 pr-3 font-normal">NAV/share</th>
                  <th className="py-1.5 pr-3 font-normal">Payout</th>
                  <th className="py-1.5 font-normal">Action</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((row) => {
                  const phase = rowPhases[row.requestId] ?? "idle"
                  const busy = phase === "preparing" || phase === "signing" || phase === "confirming" || phase === "settling"
                  const disabled = busy || phase === "completed" || row.status !== "REQUESTED"
                  return (
                    <tr key={row.requestId} className="border-t border-[var(--color-arco-border)]">
                      <td className="py-2 pr-3 font-mono text-[var(--color-arco-ink)]" title={row.walletAddress}>
                        {shortAddr(row.walletAddress)}
                      </td>
                      <td className="py-2 pr-3 font-mono text-[var(--color-arco-ink)]">ARCO-{row.requestId}</td>
                      <td className="py-2 pr-3 text-[var(--color-arco-text-soft)]">{whenLabel(row.createdAt)}</td>
                      <td className="py-2 pr-3 tabular-nums text-[var(--color-arco-ink)]">
                        {trimAmount(formatUnits(BigInt(row.sharesIn || "0"), 18))} {product.symbol}
                      </td>
                      <td className="py-2 pr-3 tabular-nums text-[var(--color-arco-text-soft)]">
                        {navBase != null ? `${trimAmount(navBase.toFixed(6))} ${baseSymbol}` : "—"}
                      </td>
                      <td className="py-2 pr-3 tabular-nums text-[var(--color-arco-ink)]">{payoutLabel(row)}</td>
                      <td className="py-2">
                        {phase === "completed" ? (
                          <span className="inline-flex items-center gap-1 text-[var(--color-arco-up)]">
                            <CheckCircle2 className="size-3.5" /> Completed
                            {rowHashes[row.requestId] && (
                              <a
                                href={explorerTx(rowHashes[row.requestId] as HexAddress)}
                                target="_blank"
                                rel="noreferrer"
                                className="underline"
                              >
                                tx
                              </a>
                            )}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={disabled}
                              onClick={() => void sendPayout(row)}
                              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--color-arco-ink)] px-2.5 text-xs font-medium text-[var(--color-arco-on-dark)] disabled:opacity-50"
                            >
                              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                              {phase === "preparing"
                                ? "Preparing"
                                : phase === "signing"
                                  ? "Signing"
                                  : phase === "confirming"
                                    ? "Confirming"
                                    : phase === "settling"
                                      ? "Settling"
                                      : row.status === "SETTLING"
                                        ? "Settling elsewhere"
                                        : "Send TX"}
                            </button>
                            {row.status === "SETTLING" && !busy && (
                              <button
                                type="button"
                                onClick={() => void releaseRow(row)}
                                title="Revert a cancelled/failed payout to REQUESTED — only after verifying no transfer landed on the explorer"
                                className="inline-flex h-8 items-center rounded-md border border-[var(--color-arco-border)] px-2.5 text-xs font-medium text-[var(--color-arco-ink)]"
                              >
                                Release
                              </button>
                            )}
                          </span>
                        )}
                        {phase === "failed" && rowErrors[row.requestId] && (
                          <p className="mt-1 max-w-[220px] break-words text-[10px] text-[var(--color-arco-down)]">
                            {rowErrors[row.requestId]}
                          </p>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
        </AdminWriteGroup>
      )}
    </section>
  )
}
