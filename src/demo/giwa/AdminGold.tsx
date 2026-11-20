import type { ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { giwaApi } from "./api"
import { amountText, bpsText, shortAddress, sharePriceText, usdText, type PauseRow } from "./arcousd-admin"
import { readableError } from "./contracts"
import {
  goldApyText,
  goldCover,
  goldHeadline,
  goldReservePauseRows,
  goldVaultPauseRows,
  ounceSourceLabel,
  ouncesLabel,
  ouncesText,
} from "./gold-admin"
import { Pill, type Tone } from "./stocks-admin/ui"
import type { GiwaArcoGoldReserve, GiwaArcoGoldSavings } from "./types"
import { explorerAddress } from "./wallet"

// Admin · Gold: a read-only view of ArcoGOLD (the gold Savings account) and its Reserve. It reads the same two
// public endpoints the Savings page uses, so it needs no operator permission and sends no transaction.

const REFRESH = 30_000
const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"

export default function GiwaAdminGoldPage() {
  const savingsQuery = useQuery({
    queryKey: ["giwa", "admin-gold", "savings"],
    queryFn: () => giwaApi.arcogold.savings(),
    refetchInterval: REFRESH,
  })
  const reserveQuery = useQuery({
    queryKey: ["giwa", "admin-gold", "reserve"],
    queryFn: () => giwaApi.arcogold.reserve(),
    refetchInterval: REFRESH,
  })
  return (
    <GoldAdminView
      savings={savingsQuery.data ?? null}
      savingsLoading={savingsQuery.isLoading}
      savingsError={savingsQuery.error ? readableError(savingsQuery.error) : null}
      reserve={reserveQuery.data ?? null}
      reserveLoading={reserveQuery.isLoading}
      reserveError={reserveQuery.error ? readableError(reserveQuery.error) : null}
    />
  )
}

export function GoldAdminView({
  savings,
  savingsLoading = false,
  savingsError = null,
  reserve,
  reserveLoading = false,
  reserveError = null,
}: {
  savings: GiwaArcoGoldSavings | null
  savingsLoading?: boolean
  savingsError?: string | null
  reserve: GiwaArcoGoldReserve | null
  reserveLoading?: boolean
  reserveError?: string | null
}) {
  const vault = savings?.savings ?? null
  const reserveState = reserve?.reserve ?? null
  const headline = goldHeadline(savings)
  const cover = reserveState ? goldCover(reserveState) : null
  return (
    <div className="w-full space-y-6">
      <header className="space-y-2">
        <p className="text-xs text-[var(--color-arco-muted)]">Admin · Gold</p>
        <h1 className="text-xl font-semibold text-[var(--color-arco-ink)]">ArcoGOLD</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-arco-muted)]">
          <Pill tone={headline.tone}>{headline.label}</Pill>
          <span>{headline.detail}</span>
        </div>
        <p className="text-[11px] text-[var(--color-arco-muted)]">Read-only. This page sends no transactions; pausing and rates are not changed here.</p>
      </header>

      {savingsLoading && !savings && <LoadingNote>Reading ArcoGOLD</LoadingNote>}
      {savingsError && <ErrorLine>ArcoGOLD could not be loaded: {savingsError}</ErrorLine>}

      <section aria-label="ArcoGOLD totals" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <TotalCard
          label="Total deposits"
          value={vault ? ouncesLabel(vault.totalAssetsOunces) : null}
          sub={savings?.totalAssetsUsd ? `${usdText(savings.totalAssetsUsd)} at the ounce price` : "Ounces the vault counts"}
        />
        <TotalCard
          label="ArcoGOLD price"
          value={vault ? `${sharePriceText(vault.sharePriceHuman)} oz` : null}
          sub={savings?.sharePriceUsd != null ? `${usdText(savings.sharePriceUsd)} per ArcoGOLD` : "Ounces per 1 ArcoGOLD"}
        />
        <TotalCard
          label="Ounce price"
          value={savings?.ounceUsd != null ? usdText(savings.ounceUsd) : null}
          sub={savings?.ounceUsd != null ? ounceSourceLabel(savings.ounceUsdSource) : "No price from the rate source"}
        />
        <TotalCard label="Display rate" value={savings ? goldApyText(savings.apyPercent) : null} sub="Set in the server code, not on-chain" />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>ArcoGOLD vault</CardTitle>
            {savings && <StatusLine status={savings.status} blockNumber={vault?.blockNumber} readAt={savings.readAt} />}
          </div>
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="Deposits" value={vault ? (vault.depositsOpen ? "Open" : "Closed") : "—"} attention={vault ? !vault.depositsOpen : false} />
            <Row label="Withdrawals" value={vault ? (vault.withdrawalsOpen ? "Open" : "Closed") : "—"} attention={vault ? !vault.withdrawalsOpen : false} />
            <Row label="Seeded" value={vault ? (vault.seeded ? "Yes" : "No") : "—"} attention={vault ? !vault.seeded : false} />
            <Row label="ArcoGOLD in circulation" value={vault ? amountText(Number(vault.totalSupply) / 1e18, 4) : "—"} />
          </dl>
          <PauseList rows={vault ? goldVaultPauseRows(vault) : null} />
        </Card>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Gold Reserve</CardTitle>
            {reserve && <StatusLine status={reserve.status} blockNumber={reserveState?.blockNumber} readAt={reserve.readAt} />}
          </div>
          {reserveLoading && !reserve && <div className="mt-3"><LoadingNote>Reading the gold Reserve</LoadingNote></div>}
          {reserveError && <div className="mt-3"><ErrorLine>The gold Reserve could not be loaded: {reserveError}</ErrorLine></div>}
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="Backing" value={reserveState ? ouncesLabel(reserveState.totalBackingOunces) : "—"} />
            <Row label="Owed (ArcoXAU issued)" value={reserveState ? ouncesLabel(reserveState.totalLiabilitiesOunces) : "—"} />
            <Row label="Surplus" value={cover ? ouncesLabel(cover.surplusOunces) : "—"} attention={cover ? !cover.covered : false} />
            <Row label="Cover" value={cover ? (cover.covered ? "Fully backed" : "Under-backed") : "—"} attention={cover ? !cover.covered : false} />
          </dl>
          <PauseList rows={reserveState ? goldReservePauseRows(reserveState) : null} />
        </Card>
      </section>

      <Card>
        <CardTitle>Reserve coins</CardTitle>
        <p className="mt-1 text-[11px] text-[var(--color-arco-muted)]">Available is what an instant withdrawal can take now: the balance less what the Standard queue is owed.</p>
        <Table
          caption="Gold Reserve coins"
          head={["Coin", "Balance", "Queued", "Available", "Queue backlog", "Swap fee", "Instant fee", "Deposit", "Redeem"]}
          numeric={[1, 2, 3, 4, 5, 6]}
          empty={reserveState ? "The gold Reserve lists no coins." : "—"}
          rows={(reserveState?.assets ?? []).map((asset) => [
            <span key="symbol" className="font-medium">{asset.symbol}</span>,
            ouncesText(asset.balanceHuman),
            ouncesText(asset.queuedHuman),
            ouncesText(asset.availableHuman),
            String(asset.queueBacklog),
            bpsText(asset.swapFeeBps),
            bpsText(asset.instantFeeBps),
            <Pill key="deposit" tone={asset.depositEnabled ? "positive" : "neutral"}>{asset.depositEnabled ? "On" : "Off"}</Pill>,
            <Pill key="redeem" tone={asset.redeemEnabled ? "positive" : "neutral"}>{asset.redeemEnabled ? "On" : "Off"}</Pill>,
          ])}
        />
      </Card>

      <Card>
        <CardTitle>Contracts</CardTitle>
        <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <AddressRow label="ArcoGOLD (vault)" address={savings?.contracts?.arcoGOLD ?? null} />
          <AddressRow label="ArcoXAU (ounce unit)" address={savings?.contracts?.unit ?? reserve?.contracts?.unit ?? null} />
          <AddressRow label="Gold Reserve" address={savings?.contracts?.reserve ?? reserve?.contracts?.reserve ?? null} />
          <AddressRow label="Zap" address={savings?.contracts?.zap ?? null} />
          <AddressRow label="Lens" address={reserve?.contracts?.lens ?? null} />
        </dl>
      </Card>
    </div>
  )
}

function StatusLine({ status, blockNumber, readAt }: { status: string; blockNumber?: string; readAt: string }) {
  const tone: Tone = status === "live" ? "positive" : status === "unavailable" ? "negative" : "neutral"
  const label = status === "live" ? "Live" : status === "unavailable" ? "Unavailable" : "Not deployed"
  const read = new Date(readAt)
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-arco-muted)]">
      <Pill tone={tone}>{label}</Pill>
      {blockNumber && <span>Block {blockNumber}</span>}
      {!Number.isNaN(read.getTime()) && <span>Read {read.toLocaleTimeString("en-US")}</span>}
    </div>
  )
}

function PauseList({ rows }: { rows: PauseRow[] | null }) {
  if (!rows) return null
  return (
    <ul className="mt-4 divide-y divide-[var(--color-arco-border)] border-t border-[var(--color-arco-border)]">
      {rows.map((row) => (
        <li key={row.label} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <div>
            <p className="text-sm text-[var(--color-arco-ink)]">{row.label}</p>
            <p className="text-[11px] text-[var(--color-arco-muted)]">{row.effect}</p>
          </div>
          <Pill tone={row.paused ? "negative" : "neutral"}>{row.paused ? "Paused" : "Running"}</Pill>
        </li>
      ))}
    </ul>
  )
}

function Card({ children }: { children: ReactNode }) {
  return <div className="w-full min-w-0 rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-5 shadow-[var(--shadow-control)]">{children}</div>
}

function CardTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-semibold text-[var(--color-arco-ink)]">{children}</h2>
}

function TotalCard({ label, sub, value }: { label: string; sub: string; value: string | null }) {
  return (
    <div className="w-full min-w-0 rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-4 shadow-[var(--shadow-control)]">
      <p className="text-xs text-[var(--color-arco-muted)]">{label}</p>
      <p className="mt-1 tabular-nums text-2xl font-semibold text-[var(--color-arco-ink)]">{value ?? "—"}</p>
      <p className="mt-1 text-[11px] text-[var(--color-arco-muted)]">{sub}</p>
    </div>
  )
}

function Row({ label, value, attention = false }: { label: string; value: ReactNode; attention?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <dt className="text-[var(--color-arco-muted)]">{label}</dt>
      <dd className={`tabular-nums ${attention ? "font-medium text-[var(--color-arco-down)]" : "text-[var(--color-arco-ink)]"}`}>{value}</dd>
    </div>
  )
}

function AddressRow({ label, address }: { label: string; address: string | null }) {
  return (
    <Row
      label={label}
      value={
        address ? (
          <a
            href={explorerAddress(address)}
            target="_blank"
            rel="noreferrer"
            title={address}
            className={`font-mono text-[var(--color-arco-text-soft)] underline-offset-2 hover:underline ${FOCUS_RING}`}
          >
            {shortAddress(address)}
          </a>
        ) : (
          "—"
        )
      }
    />
  )
}

function Table({ caption, head, rows, numeric = [], empty }: { caption: string; head: string[]; rows: ReactNode[][]; numeric?: number[]; empty: string }) {
  if (rows.length === 0) return <p className="mt-3 text-sm text-[var(--color-arco-muted)]">{empty}</p>
  return (
    <div className="mt-3 w-full overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-[var(--color-arco-border)] text-[11px] text-[var(--color-arco-muted)]">
            {head.map((cell, index) => (
              <th key={cell} scope="col" className={`whitespace-nowrap px-2 py-2 font-medium ${numeric.includes(index) ? "text-right" : "text-left"}`}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-[var(--color-arco-border)] last:border-b-0">
              {row.map((cell, index) => (
                <td key={index} className={`whitespace-nowrap px-2 py-2 text-[var(--color-arco-ink)] ${numeric.includes(index) ? "text-right tabular-nums" : "text-left"}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LoadingNote({ children }: { children: ReactNode }) {
  return (
    <p className="text-sm text-[var(--color-arco-muted)]">
      <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
      {children}
    </p>
  )
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-[var(--color-arco-down)]">
      {children}
    </p>
  )
}
