import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { AlertCircle, CheckCircle2, Clock, Loader2, RefreshCw, Send, ShieldAlert } from "lucide-react"
import { giwaApi, type GiwaPriceHistoryPoint } from "./api"
import { useAdminWriteAccess } from "./admin-context"
import { useOnchainRole } from "./admin-roles"
import type { AdminAuth } from "./api"
import { GIWA_CHAIN_ID, GIWA_LIVE_REFETCH } from "./config"
import { afterConfirmedReceipt, readPriceFeedState, readShareSupply, sendPreparedTransaction } from "./contracts"
import { computeNavPrice, elapsedDays, fromAnswer, impliedAprPercent, impliedApyPercent, isStale, toAnswer, validateAnswer } from "./price-policy"
import type { GiwaCatalogItem, HexAddress, UiPhase, UnsignedAdminTransaction } from "./types"
import { explorerTx } from "./wallet"

// Below this window a weekly (7-day) update cadence risks the feed going stale between
// updates, which blocks deposits (getDataInBase18 reverts "PPF: stale").
const WEEKLY_SAFE_SECONDS = 8 * 86_400
const STALENESS_PRESETS = [7, 30, 365] as const

export function PriceFeedAdminPanel({
  product,
  auth,
  walletAddress,
  onConfirmed,
}: {
  product: GiwaCatalogItem
  auth: AdminAuth
  walletAddress: HexAddress | null
  onConfirmed?: () => void | Promise<void>
}) {
  const priceFeed = product.priceFeedAddress
  const { canWrite, readOnlyReason } = useAdminWriteAccess()
  // Posting is signed by the connected wallet; the feed checks FEED_ADMIN_ROLE itself.
  const feedRole = useOnchainRole(priceFeed ?? null, "FEED_ADMIN_ROLE", "price feed", walletAddress)
  const statusQuery = useQuery({
    queryKey: ["giwa", "price-feed", priceFeed],
    queryFn: () => readPriceFeedState(priceFeed as HexAddress),
    enabled: Boolean(priceFeed),
    refetchInterval: 30_000,
  })
  const state = statusQuery.data

  const productToken = product.productTokenAddress
  const shareQuery = useQuery({
    queryKey: ["giwa", "share-supply", productToken],
    queryFn: () => readShareSupply(productToken as HexAddress),
    enabled: Boolean(productToken),
    refetchInterval: 30_000,
  })

  // NAV-context references (display only, never block the form). Net deposit comes from the
  // operator-guarded monitoring endpoint — same queryKey as AdminMonitoring so the cache is shared.
  const monitoringQuery = useQuery({
    queryKey: ["giwa", "monitoring-vaults"],
    queryFn: () => giwaApi.monitoring.vaults(auth, GIWA_CHAIN_ID),
    enabled: auth.ready,
  })
  // Previous posted price — same queryKey as the posting-history table below and the detail page.
  const historyQuery = useQuery({
    queryKey: ["giwa", "price-history", product.productId],
    queryFn: () => giwaApi.priceHistory(GIWA_CHAIN_ID, product.productId),
    ...GIWA_LIVE_REFETCH,
  })

  const [nav, setNav] = useState("")
  const [periodDaysEdited, setPeriodDaysEdited] = useState<string | null>(null)
  const [stalenessDays, setStalenessDays] = useState("")

  const [prepared, setPrepared] = useState<UnsignedAdminTransaction | null>(null)
  const [preparedLabel, setPreparedLabel] = useState("")
  const [phase, setPhase] = useState<UiPhase>("ready")
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  const nowSeconds = Math.floor(Date.now() / 1000)
  const busy = phase === "submitting" || phase === "confirming"

  const basePrice = state ? fromAnswer(state.answer) : null
  const defaultPeriodDays = state ? Math.max(0, elapsedDays(state.updatedAt, nowSeconds)) : 0
  const periodDays = periodDaysEdited ?? (state ? trimNumber(defaultPeriodDays, 2) : "")

  // Human shares = totalSupply / 10**decimals. Both NAV and shares are in human units,
  // so token/payment-asset decimals cancel and price is "payment-asset per share".
  const sharesOutstanding = shareQuery.data ? Number(shareQuery.data.supply) / 10 ** shareQuery.data.decimals : null
  const hasShares = sharesOutstanding !== null && sharesOutstanding > 0

  // NAV-context reference values (payment-asset units; null → "—"). All are estimates: NAV totals
  // use CURRENT shares (not shares at the previous post) and history is indexer-fed.
  // Net deposit (principal) = the LAST point of the vault's CUMULATIVE net-deposit series
  // (deposits − redemptions); 0 is a real value, only a missing vault/series reads null.
  const monitoringVault = monitoringQuery.data?.vaults.find((vault) => vault.productId === product.productId) ?? null
  const netDepositSeries = monitoringVault?.trends.netDeposit ?? []
  const netDeposit = netDepositSeries.length > 0 ? netDepositSeries[netDepositSeries.length - 1] : null
  // Current NAV = current on-chain price × shares; Previous NAV = 2nd-to-last posted price × shares.
  const currentNav = basePrice !== null && sharesOutstanding !== null ? basePrice * sharesOutstanding : null
  const prevNavBase = previousNavBase(historyQuery.data?.points ?? null)
  const prevNav = prevNavBase !== null && sharesOutstanding !== null ? prevNavBase * sharesOutstanding : null
  // Can be NEGATIVE (NAV below principal = a loss) — shown signed, never clamped.
  const unrealized = currentNav !== null && netDeposit !== null ? currentNav - netDeposit : null

  const navNum = Number(nav)
  const periodNum = Number(periodDays)
  const navValid = nav.trim() !== "" && Number.isFinite(navNum) && navNum > 0
  const previewPrice = navValid && hasShares ? computeNavPrice({ nav: navNum, shares: sharesOutstanding as number }) : null
  const previewAnswer = previewPrice !== null ? toAnswer(previewPrice) : null
  const previewBounds =
    previewAnswer !== null && state ? validateAnswer(previewAnswer, { min: state.min, max: state.max }) : null
  // Implied APY/APR are derived display values; period only affects these, never the posted price.
  const impliedApy = basePrice !== null && previewPrice !== null ? impliedApyPercent({ basePrice, newPrice: previewPrice, periodDays: periodNum }) : null
  const impliedApr = basePrice !== null && previewPrice !== null ? impliedAprPercent({ basePrice, newPrice: previewPrice, periodDays: periodNum }) : null

  function baseDisabledReason(): string | null {
    if (!priceFeed) return "No price feed deployed for this product"
    if (!auth.ready) return "Enter the operator token above"
    if (!canWrite) return readOnlyReason ?? "This operator cannot prepare price updates"
    if (busy) return "A transaction is in progress"
    return null
  }

  function navDisabledReason(): string | null {
    const base = baseDisabledReason()
    if (base) return base
    if (!state) return "Waiting for on-chain status"
    if (!productToken) return "No product token deployed for this product"
    if (!shareQuery.data) return "Reading shares outstanding…"
    if (!hasShares) return "No shares outstanding yet — use Set 1:1 baseline first."
    if (!navValid) return "Enter a NAV greater than 0"
    if (previewBounds && !previewBounds.ok) return previewBounds.reason ?? "Resulting price is out of bounds"
    return null
  }

  async function runPrepare(label: string, build: () => Promise<UnsignedAdminTransaction>) {
    setError(null)
    setTxHash(null)
    setPhase("ready")
    setPrepared(null)
    try {
      if (!auth.ready) throw new Error("Enter the operator token above")
      if (!priceFeed) throw new Error("This product has no deployed price feed")
      const tx = await build()
      setPrepared(tx)
      setPreparedLabel(label)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function prepareBaseline() {
    void runPrepare(
      "Set 1:1 baseline (price 1.0)",
      async () => (await giwaApi.admin.price(auth, product.productId, toAnswer(1).toString())).transaction,
    )
  }

  function prepareNavUpdate() {
    if (previewAnswer === null || previewPrice === null) return
    void runPrepare(
      `Update ${product.symbol} price to ${formatPrice(previewPrice)} (NAV ${nav} ${product.paymentAssetSymbol} ÷ ${trimNumber(sharesOutstanding as number, 4)} shares)`,
      async () => {
        if (previewBounds && !previewBounds.ok) throw new Error(previewBounds.reason ?? "Resulting price is out of bounds")
        return (await giwaApi.admin.price(auth, product.productId, previewAnswer.toString())).transaction
      },
    )
  }

  function prepareStaleness(days: number) {
    const seconds = Math.round(days * 86_400)
    if (!Number.isFinite(seconds) || seconds <= 0) {
      setError("Enter a positive number of days for the staleness window")
      return
    }
    void runPrepare(
      `Set ${product.symbol} staleness window to ${formatDuration(seconds)}`,
      async () => (await giwaApi.admin.setHealthyDiff(auth, product.productId, String(seconds))).transaction,
    )
  }

  async function sign() {
    setError(null)
    setTxHash(null)
    try {
      if (!walletAddress) throw new Error("Connect the Tier 2 operator wallet first")
      if (!prepared) throw new Error("Prepare a transaction first")
      setPhase("submitting")
      const hash = await sendPreparedTransaction(walletAddress, prepared)
      setTxHash(hash)
      setPhase("confirming")
      await afterConfirmedReceipt(hash, () => statusQuery.refetch())
      setPrepared(null)
      setPhase("success")
      if (onConfirmed) await onConfirmed()
    } catch (err) {
      setPhase("failed")
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const stale = state ? isStale({ updatedAt: state.updatedAt, healthyDiff: state.healthyDiff, now: nowSeconds }) : false
  const healthyDiffSeconds = state ? Number(state.healthyDiff) : 0
  const stalenessTooShort = Boolean(state) && healthyDiffSeconds < WEEKLY_SAFE_SECONDS
  const navReason = navDisabledReason()
  const baseReason = baseDisabledReason()

  return (
    <section className="w-full space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs text-[var(--color-arco-muted)]">Price feed</p>
          <h2 className="mt-0.5 text-lg font-semibold text-[var(--color-arco-ink)]">
            {product.symbol} price controls
          </h2>
        </div>
        <button
          type="button"
          onClick={() => void statusQuery.refetch()}
          disabled={!priceFeed || statusQuery.isFetching}
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-arco-border)] px-3 py-1.5 text-xs text-[var(--color-arco-ink)] disabled:opacity-50"
        >
          <RefreshCw className={`size-3.5 ${statusQuery.isFetching ? "animate-spin" : ""}`} />
          Refresh status
        </button>
      </div>

      {/* ── Feature 1: status card ─────────────────────────────────────────── */}
      <Card>
        {!priceFeed ? (
          <EmptyNote>No price feed is deployed for {product.symbol} in the current registry.</EmptyNote>
        ) : statusQuery.isLoading ? (
          <EmptyNote>
            <Loader2 className="mr-2 inline size-4 animate-spin" />
            Reading on-chain price-feed status…
          </EmptyNote>
        ) : statusQuery.isError ? (
          <p className="text-sm text-[var(--color-arco-down)]">
            Could not read the price feed: {readError(statusQuery.error)}
          </p>
        ) : state ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Current price">
                <span className="tabular-nums text-2xl font-semibold text-[var(--color-arco-ink)]">{formatPrice(fromAnswer(state.answer))}</span>
                <span className="mt-0.5 block font-mono text-[11px] text-[var(--color-arco-muted)]">answer {state.answer.toString()}</span>
              </Stat>
              <Stat label="Status">
                <FreshnessChip stale={stale} />
                <span className="mt-1 block text-[11px] text-[var(--color-arco-muted)]">round #{state.roundId.toString()}</span>
              </Stat>
              <Stat label="Last updated">
                <span className="text-sm font-medium text-[var(--color-arco-ink)]">{formatAgo(Number(state.updatedAt), nowSeconds)}</span>
                <span className="mt-0.5 block text-[11px] text-[var(--color-arco-muted)]">{formatTimestamp(Number(state.updatedAt))}</span>
              </Stat>
              <Stat label="Staleness window">
                <span className="text-sm font-medium text-[var(--color-arco-ink)]">{formatDuration(healthyDiffSeconds)}</span>
                <span className="mt-0.5 block text-[11px] text-[var(--color-arco-muted)]">
                  bounds {formatPrice(fromAnswer(state.min))} – {formatPrice(fromAnswer(state.max))}
                </span>
              </Stat>
            </div>
            {stalenessTooShort && (
              <Warning>
                The staleness window is {formatDuration(healthyDiffSeconds)} — shorter than a week. Weekly updates may go
                stale and block deposits. Raise it (e.g. 365d) using the staleness control below.
              </Warning>
            )}
          </div>
        ) : null}
      </Card>

      {/* ── Feature 2 + 3: baseline and NAV update ─────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Set 1:1 baseline</CardTitle>
          <p className="mt-1 text-xs text-[var(--color-arco-text-soft)]">
            Posts price <span className="font-mono">1.0</span> (answer <span className="font-mono">100000000</span>). Use to
            initialize a feed or reset it to par. Also refreshes the timestamp, clearing any stale state.
          </p>
          <button
            type="button"
            onClick={prepareBaseline}
            disabled={Boolean(baseReason)}
            className="mt-4 inline-flex items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-arco-border)] px-4 py-2 text-sm font-medium text-[var(--color-arco-ink)] disabled:opacity-50"
          >
            Prepare baseline (1.0)
          </button>
          {baseReason && <FieldNote>{baseReason}</FieldNote>}
        </Card>

        <Card>
          <CardTitle>Update price from NAV</CardTitle>
          <p className="mt-1 text-xs text-[var(--color-arco-text-soft)]">
            <span className="font-mono">price = NAV ÷ shares outstanding</span>. Enter NAV in {product.paymentAssetSymbol}; the
            implied APY/APR below are derived from the price change (period affects the display only, not the posted price).
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <NumberField label={`NAV (${product.paymentAssetSymbol})`} value={nav} onChange={setNav} placeholder="1002000" />
            <NumberField label="Period (days)" value={periodDays} onChange={(v) => setPeriodDaysEdited(v)} placeholder="7" />
          </div>
          <div className="mt-3 rounded-[var(--radius-control)] bg-[var(--color-arco-surface-muted)] p-3">
            <PreviewRow label="Shares outstanding" value={sharesOutstanding !== null ? trimNumber(sharesOutstanding, 6) : "—"} tabular />
            <PreviewRow
              label="Net deposit (principal)"
              value={netDeposit !== null ? `${trimNumber(netDeposit, 2)} ${product.paymentAssetSymbol}` : "—"}
              tabular
            />
            <PreviewRow
              label="Current NAV"
              value={currentNav !== null ? `${trimNumber(currentNav, 2)} ${product.paymentAssetSymbol}` : "—"}
              tabular
            />
            <PreviewRow
              label="Previous NAV"
              value={prevNav !== null ? `${trimNumber(prevNav, 2)} ${product.paymentAssetSymbol}` : "—"}
              tabular
            />
            <PreviewRow
              label="Unrealized gain/loss"
              value={unrealized !== null ? `${trimNumber(unrealized, 2)} ${product.paymentAssetSymbol}` : "—"}
              tabular
            />
            <PreviewRow label="Base price" value={basePrice !== null ? formatPrice(basePrice) : "—"} />
            <PreviewRow label="New price" value={previewPrice !== null ? formatPrice(previewPrice) : "—"} strong />
            <PreviewRow label="New answer" value={previewAnswer !== null ? previewAnswer.toString() : "—"} mono />
            <PreviewRow label="Implied APY %" value={impliedApy !== null ? `${trimNumber(impliedApy, 2)}%` : "—"} />
            <PreviewRow label="Implied APR %" value={impliedApr !== null ? `${trimNumber(impliedApr, 2)}%` : "—"} />
            <p className="mt-2 text-[10px] leading-4 text-[var(--color-arco-muted)]">
              Net deposit / NAV rows are reference estimates — computed with current shares outstanding; history is indexer-fed.
            </p>
          </div>
          <button
            type="button"
            onClick={prepareNavUpdate}
            disabled={Boolean(navReason)}
            className="mt-3 inline-flex items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-arco-border)] px-4 py-2 text-sm font-medium text-[var(--color-arco-ink)] disabled:opacity-50"
          >
            Prepare price update
          </button>
          {navReason && <FieldNote>{navReason}</FieldNote>}
        </Card>
      </div>

      {/* ── Feature 4: staleness window ────────────────────────────────────── */}
      <Card>
        <CardTitle>Staleness window</CardTitle>
        <p className="mt-1 text-xs text-[var(--color-arco-text-soft)]">
          How long an update stays fresh before deposits revert. Raise it so a weekly cadence never goes stale.
          {state ? <> Current: <span className="tabular-nums">{formatDuration(healthyDiffSeconds)}</span>.</> : null}
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          {STALENESS_PRESETS.map((days) => (
            <button
              key={days}
              type="button"
              onClick={() => prepareStaleness(days)}
              disabled={Boolean(baseReason)}
              className="rounded-[var(--radius-control)] border border-[var(--color-arco-border)] px-3 py-2 text-sm text-[var(--color-arco-ink)] disabled:opacity-50"
            >
              {days}d
            </button>
          ))}
          <div className="flex items-end gap-2">
            <NumberField label="Custom (days)" value={stalenessDays} onChange={setStalenessDays} placeholder="180" />
            <button
              type="button"
              onClick={() => prepareStaleness(Number(stalenessDays))}
              disabled={Boolean(baseReason) || stalenessDays.trim() === "" || !(Number(stalenessDays) > 0)}
              className="rounded-[var(--radius-control)] border border-[var(--color-arco-border)] px-3 py-2 text-sm text-[var(--color-arco-ink)] disabled:opacity-50"
            >
              Prepare custom
            </button>
          </div>
        </div>
        {baseReason && <FieldNote>{baseReason}</FieldNote>}
      </Card>

      {/* ── Feature 5: prepared tx + sign ──────────────────────────────────── */}
      <Card>
        <CardTitle>Prepared transaction</CardTitle>
        {prepared ? (
          <div className="mt-3 rounded-[var(--radius-control)] bg-[var(--color-arco-surface-muted)] p-3 text-xs">
            <p className="font-semibold text-[var(--color-arco-ink)]">{preparedLabel}</p>
            <p className="mt-1 break-all font-mono text-[var(--color-arco-muted)]">to {prepared.to}</p>
            <p className="mt-1 text-[var(--color-arco-text-soft)]">Backend simulation: {prepared.simulation?.status ?? "not-run"}</p>
          </div>
        ) : (
          <p className="mt-3 text-sm text-[var(--color-arco-muted)]">
            No transaction prepared. Use an action above, then sign with the connected wallet.
          </p>
        )}
        <button
          type="button"
          onClick={() => void sign()}
          disabled={!prepared || !walletAddress || busy || !canWrite || feedRole.status === "missing"}
          className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-arco-ink)] px-4 py-2.5 text-sm font-medium text-[var(--color-arco-on-dark)] disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          Sign with connected wallet
        </button>
        {!walletAddress && <FieldNote>Connect the Tier 2 operator wallet to sign.</FieldNote>}
        {feedRole.status === "missing" && (
          <p role="alert" className="mt-2 text-[11px] text-[var(--color-arco-down)]" data-testid="price-feed-role-missing">
            {feedRole.message}
          </p>
        )}

        {phase !== "ready" && (
          <div className="mt-3 flex items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-arco-surface-muted)] p-3 text-sm">
            {phase === "failed" ? (
              <AlertCircle className="size-4 text-[var(--color-arco-down)]" />
            ) : phase === "success" ? (
              <CheckCircle2 className="size-4 text-[var(--color-arco-up)]" />
            ) : (
              <Loader2 className="size-4 animate-spin" />
            )}
            <span className="font-medium capitalize text-[var(--color-arco-ink)]">{phase}</span>
          </div>
        )}
        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-[var(--radius-control)] border border-[var(--color-arco-border)] p-3 text-sm text-[var(--color-arco-down)]">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}
        {txHash && (
          <a
            href={explorerTx(txHash)}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-block break-all font-mono text-xs text-[var(--color-arco-ink)] underline"
          >
            {txHash}
          </a>
        )}
      </Card>
    </section>
  )
}

/* ── presentational helpers (tokens only) ───────────────────────────────── */

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-5" style={{ boxShadow: "var(--shadow-control)" }}>
      {children}
    </div>
  )
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">{children}</h3>
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-control)] bg-[var(--color-arco-surface-muted)] p-3">
      <p className="text-xs text-[var(--color-arco-muted)]">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  )
}

function PreviewRow({ label, value, strong, mono, tabular }: { label: string; value: string; strong?: boolean; mono?: boolean; tabular?: boolean }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-sm">
      <span className="text-[var(--color-arco-text-soft)]">{label}</span>
      <span
        className={`${tabular ? "tabular-nums" : ""} ${mono ? "font-mono" : ""} ${strong ? "font-semibold" : ""} text-[var(--color-arco-ink)]`}
      >
        {value}
      </span>
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  return (
    <label className="block text-xs text-[var(--color-arco-muted)]">
      {label}
      <input
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-10 w-full rounded-[var(--radius-control)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-3 tabular-nums text-sm text-[var(--color-arco-ink)] outline-none placeholder:text-[var(--color-arco-muted)]"
      />
    </label>
  )
}

export function FreshnessChip({ stale }: { stale: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--color-arco-surface)] px-2.5 py-1 text-xs font-medium" style={{ boxShadow: "var(--shadow-control)" }}>
      <span
        className="size-2 rounded-full"
        style={{ background: stale ? "var(--color-arco-down)" : "var(--color-arco-up)" }}
      />
      <span className={stale ? "text-[var(--color-arco-down)]" : "text-[var(--color-arco-up)]"}>{stale ? "STALE" : "FRESH"}</span>
    </span>
  )
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-[var(--radius-control)] border border-[var(--color-arco-border)] p-3 text-xs text-[var(--color-arco-down)]">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </div>
  )
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-[var(--color-arco-muted)]">{children}</p>
}

function FieldNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--color-arco-muted)]">
      <Clock className="size-3" />
      {children}
    </p>
  )
}

/* ── pure display formatters ────────────────────────────────────────────── */

// The 2nd-to-last posted price (navBase) from the indexed price history — the "previous" price
// behind the current on-chain answer. Sorts ascending by t (defensive, same as buildHistoryRows);
// null with fewer than 2 posts. Lives here (not AdminPrices) to avoid a circular import — the
// panel consumes it and AdminPrices already imports from this file. Exported for tests.
export function previousNavBase(points: GiwaPriceHistoryPoint[] | null): number | null {
  if (!points || points.length < 2) return null
  const ordered = [...points].sort((a, b) => a.t - b.t)
  return ordered[ordered.length - 2].navBase
}

export function trimNumber(value: number, maxDecimals: number): string {
  return value.toFixed(maxDecimals).replace(/\.?0+$/, "")
}

export function formatPrice(price: number): string {
  const fixed = price.toFixed(8).replace(/\.?0+$/, "")
  return fixed === "" || fixed === "-0" ? "0" : fixed
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0s"
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`
  if (seconds >= 86_400) return `${(seconds / 86_400).toFixed(1)}d`
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`
  if (seconds >= 3_600) return `${(seconds / 3_600).toFixed(1)}h`
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds)}s`
}

export function formatAgo(updatedAtSeconds: number, nowSeconds: number): string {
  const delta = nowSeconds - updatedAtSeconds
  if (delta <= 0) return "just now"
  return `${formatDuration(delta)} ago`
}

export function formatTimestamp(updatedAtSeconds: number): string {
  if (!updatedAtSeconds) return "—"
  return new Date(updatedAtSeconds * 1000).toLocaleString()
}

function readError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
